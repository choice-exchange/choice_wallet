// Ethereum sites (EIP-1193, found through EIP-6963): accounts, the network, reads passed
// to the user's own endpoints, and transactions and messages to sign.

import { ChainError, isObject, MIN_GAS_PRICE, NETWORKS, type NetworkId } from "@choice-wallet/chain";
import type { AccountInfo } from "@choice-wallet/ui/protocol";

import { CHAIN_DISCONNECTED, INVALID_PARAMS, no, quantity, UNAUTHORIZED, UNRECOGNIZED_CHAIN, UNSUPPORTED, type DappReply, type SiteCore } from "./shared";

/** Read-only JSON-RPC methods passed to the user's own EVM endpoints. */
const READS = new Set([
  "eth_blockNumber",
  "eth_call",
  "eth_estimateGas",
  "eth_feeHistory",
  "eth_gasPrice",
  "eth_getBalance",
  "eth_getBlockByHash",
  "eth_getBlockByNumber",
  "eth_getCode",
  "eth_getLogs",
  "eth_getStorageAt",
  "eth_getTransactionByHash",
  "eth_getTransactionCount",
  "eth_getTransactionReceipt",
  "eth_maxPriorityFeePerGas",
  "eth_syncing",
  "web3_clientVersion",
]);

/** Methods that would sign something the wallet can't show (raw hashes, old typed data). */
const REFUSED: Record<string, string> = {
  eth_sign: "eth_sign signs a raw hash, which can't be shown. Use personal_sign or eth_signTypedData_v4.",
  eth_signTransaction: "Signing without sending isn't supported. Use eth_sendTransaction.",
  eth_signTypedData: "Use eth_signTypedData_v4.",
  eth_signTypedData_v1: "Use eth_signTypedData_v4.",
  eth_signTypedData_v3: "Use eth_signTypedData_v4.",
};

/** Gas a dapp's EVM transaction may use, at most (Injective charges the whole limit). */
const EVM_MAX_GAS = 10_000_000n;

export function createEvmSite(core: SiteCore) {
  const { h, isConnected, connect, ask, sign, disconnect } = core;

  /** The EVM accounts a site sees: the account while connected and unlocked, else none. */
  async function evmAccounts(origin: string): Promise<string[]> {
    if (!(await isConnected(origin))) return [];
    const u = await h.unlocked();
    const a = u?.account.addresses[NETWORKS[await h.network()].evm];
    return a ? [a.toLowerCase()] : [];
  }

  /** The network a chain ID names, if it's one of the wallet's. */
  function networkOfEvm(chainId: unknown): NetworkId | null {
    if (typeof chainId !== "string" || !/^0x[0-9a-fA-F]{1,16}$/.test(chainId)) return null;
    const n = Number(BigInt(chainId));
    return (Object.values(NETWORKS).find((x) => x.evmChainId === n)?.id as NetworkId | undefined) ?? null;
  }

  async function switchTo(origin: string, to: NetworkId | null): Promise<DappReply> {
    if (!to) return no(UNRECOGNIZED_CHAIN, "Choice Wallet only knows Injective (1776) and Injective testnet (1439).");
    const net = await h.network();
    if (to === net) return { result: null };
    if (!(await isConnected(origin))) return no(UNAUTHORIZED, "Connect first.");
    return ask(
      {
        approve: async () => {
          await h.setNetwork(to);
          h.notify();
          return { result: null };
        },
      },
      { origin, network: net, kind: "switch", to },
    );
  }

  /** The dapp's transaction with the wallet's own nonce, gas and fees. Injective charges
   *  gas limit × max fee per gas, so the wallet sets both and ignores the dapp's. An
   *  estimate that fails stops the request: a failing tx on Injective still pays its whole
   *  gas limit. */
  async function fillEvmTx(network: NetworkId, from: string, tx: Record<string, unknown>) {
    const net = NETWORKS[network];
    const rpc = await h.sender.evm(network);
    const hexOr = (v: unknown, what: string, fallback: string) => {
      if (v === undefined || v === null) return fallback;
      if (typeof v !== "string" || !/^0x[0-9a-fA-F]*$/.test(v)) throw new RangeError(`${what} must be hex`);
      return v;
    };
    const v = hexOr(tx["value"], "value", "0x0");
    const value = BigInt(v === "0x" ? "0x0" : v);
    const data = hexOr(tx["data"] ?? tx["input"], "data", "0x").toLowerCase();
    if (data.length % 2 !== 0) throw new RangeError("data must be whole bytes");
    if (typeof tx["to"] !== "string") throw new RangeError("contract creation isn't supported");
    const to = tx["to"].toLowerCase();
    const [nonce, block, tip] = await rpc.batch([
      { method: "eth_getTransactionCount", params: [from, "pending"] },
      { method: "eth_getBlockByNumber", params: ["latest", false] },
      { method: "eth_maxPriorityFeePerGas", params: [] },
    ]);
    const q = (v: unknown, what: string): bigint => {
      if (typeof v !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(v)) throw new ChainError(-1, `the node returned no ${what}`);
      return BigInt(v);
    };
    const base = isObject(block) ? q(block["baseFeePerGas"], "base fee") : MIN_GAS_PRICE;
    const baseFee = base < MIN_GAS_PRICE ? MIN_GAS_PRICE : base > MIN_GAS_PRICE * 1000n ? MIN_GAS_PRICE * 1000n : base;
    const tipped = typeof tip === "string" ? q(tip, "tip") : 0n;
    const priority = tipped > baseFee ? baseFee : tipped;
    const call = { from, to, value: quantity(value), data };
    const used = q(await rpc.call("eth_estimateGas", [call]), "gas estimate");
    let gas = (used * 12n) / 10n + 1n;
    if (gas < 21_000n) gas = 21_000n;
    if (gas > EVM_MAX_GAS) throw new ChainError(-1, "The gas estimate looks wrong. Try another endpoint.");
    return {
      tx: {
        type: "0x2",
        chainId: quantity(BigInt(net.evmChainId)),
        from,
        to,
        value: quantity(value),
        data,
        nonce: quantity(q(nonce, "nonce")),
        gas: quantity(gas),
        maxFeePerGas: quantity(baseFee + priority),
        maxPriorityFeePerGas: quantity(priority),
      },
      checkedBy: new URL(rpc.pool.current).host,
    };
  }

  async function evmSign(origin: string, method: string, params: unknown): Promise<DappReply> {
    const network = await h.network();
    const net = NETWORKS[network];
    const list = Array.isArray(params) ? params : [];
    const me = async () => (await h.unlocked())?.account.addresses[net.evm] ?? "";
    const mine = async (a: unknown) => typeof a === "string" && (await isConnected(origin)) && a.toLowerCase() === (await evmAccountsAny()).toLowerCase();
    // The account in use's address, from storage, for checks made while locked. A
    // watch-only account has nothing to sign with, so it matches nothing.
    async function evmAccountsAny(): Promise<string> {
      const { accounts, active_account } = (await h.local.get(["accounts", "active_account"])) as { accounts?: AccountInfo[]; active_account?: number };
      const a = accounts?.[typeof active_account === "number" ? active_account : 0] ?? accounts?.[0];
      return a && a.account.derivation !== "watch" ? (a.addresses[net.evm] ?? "") : "";
    }

    if (method === "eth_sendTransaction") {
      const tx = list[0];
      if (!isObject(tx)) return no(INVALID_PARAMS, "eth_sendTransaction takes a transaction object.");
      if (!(await mine(tx["from"]))) return no(UNAUTHORIZED, "The transaction's from isn't this wallet's connected account.");
      if (tx["chainId"] !== undefined && networkOfEvm(tx["chainId"]) !== network) return no(CHAIN_DISCONNECTED, `The wallet is on ${net.name}.`);
      if (typeof tx["to"] !== "string") return no(INVALID_PARAMS, "Contract creation isn't supported.");
      return sign(
        origin,
        "evm_transaction",
        async () => {
          const filled = await fillEvmTx(network, await me(), tx);
          return { request: { evm_transaction: { chain: net.evm, tx: filled.tx } }, checkedBy: filled.checkedBy };
        },
        async (signed) => {
          const hash = String(signed["hash"]).toLowerCase();
          try {
            await (await h.sender.evm(network)).call("eth_sendRawTransaction", [signed["raw"]]);
          } catch (e) {
            if (!(e instanceof ChainError && /already known|already imported|known transaction/i.test(e.message))) throw e;
          }
          h.sender.broadcasted(network, hash, (await h.unlocked())?.account.addresses[net.cosmos] ?? "");
          return hash;
        },
      );
    }
    if (method === "personal_sign") {
      const [message, address] = list;
      if (typeof message !== "string") return no(INVALID_PARAMS, "personal_sign takes [message, address].");
      if (!(await mine(address))) return no(UNAUTHORIZED, "personal_sign: that address isn't this wallet's connected account.");
      return sign(
        origin,
        "evm_personal_sign",
        async () => ({ request: { evm_personal_sign: { chain: net.evm, signer: await me(), message } } }),
        async (signed) => signed["signature"],
      );
    }
    // eth_signTypedData_v4
    const [address, typed] = list;
    if (!(await mine(address))) return no(UNAUTHORIZED, "eth_signTypedData_v4: that address isn't this wallet's connected account.");
    if (typeof typed !== "string" && !isObject(typed)) return no(INVALID_PARAMS, "eth_signTypedData_v4 takes [address, typed data].");
    return sign(
      origin,
      "evm_typed_data",
      async () => ({ request: { evm_typed_data: { chain: net.evm, signer: await me(), typed_data: typed } } }),
      async (signed) => signed["signature"],
    );
  }

  /** An EVM method's answer, or null when it isn't one. */
  async function handle(origin: string, method: string, params: unknown): Promise<DappReply | null> {
    const network = await h.network();
    const net = NETWORKS[network];
    switch (method) {
      case "eth_chainId":
        return { result: quantity(BigInt(net.evmChainId)) };
      case "net_version":
        return { result: String(net.evmChainId) };
      case "eth_accounts":
        return { result: await evmAccounts(origin) };
      case "eth_requestAccounts":
        return connect(origin, async () => ({ result: await evmAccounts(origin) }));
      case "wallet_requestPermissions":
        return connect(origin, async () => ({ result: [{ parentCapability: "eth_accounts", invoker: origin }] }));
      case "wallet_getPermissions": {
        const accounts = await evmAccounts(origin);
        return { result: accounts.length ? [{ parentCapability: "eth_accounts", invoker: origin, caveats: [{ type: "restrictReturnedAccounts", value: accounts }] }] : [] };
      }
      case "wallet_revokePermissions":
        await disconnect(origin);
        return { result: null };
      case "wallet_switchEthereumChain":
      case "wallet_addEthereumChain": {
        const p = Array.isArray(params) && isObject(params[0]) ? params[0] : {};
        return switchTo(origin, networkOfEvm(p["chainId"]));
      }
      case "eth_sendTransaction":
      case "personal_sign":
      case "eth_signTypedData_v4":
        return evmSign(origin, method, params);
    }
    if (REFUSED[method]) return no(UNSUPPORTED, REFUSED[method]);
    if (READS.has(method)) return { result: await (await h.sender.evm(network)).call(method, Array.isArray(params) ? params : []) };
    return null;
  }

  return { handle };
}
