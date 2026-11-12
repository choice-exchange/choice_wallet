// Ethereum sites (EIP-1193, found through EIP-6963): accounts, the chain, reads passed to
// the user's own endpoints, and transactions and messages to sign.
//
// Each site is on one EVM chain at a time, its own (Injective's EVM side until it asks for
// another): any EVM chain the wallet lists on the network in use. Switching between them is
// the site's to make (nothing is signed by it, and every request names its chain in the
// approval window); moving the whole wallet between mainnet and the test networks asks first.

import { addedKey, chainByKey, ChainError, chainList, checkAddedChain, erc20Meta, evmDenom, isObject, MIN_GAS_PRICE, NETWORKS, type AnyChain, type EvmRpc, type NetworkId } from "@choice-wallet/chain";
import type { AccountInfo, NewChain, TokenInfo } from "@choice-wallet/ui/protocol";

import { cleanName } from "../addedchains";
import { CHAIN_DISCONNECTED, INVALID_PARAMS, MAX_ARBITRARY, MAX_TYPED, no, quantity, UNAUTHORIZED, UNRECOGNIZED_CHAIN, UNSUPPORTED, type DappReply, type Named, type SiteCore } from "./shared";

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

  /** The EVM chain a site is on, on this network: its own pick, Injective's EVM side until
   *  then. */
  async function siteChain(origin: string, network: NetworkId): Promise<AnyChain> {
    const { site_chains } = (await h.local.get(["site_chains"])) as { site_chains?: Record<string, Partial<Record<NetworkId, string>>> };
    const c = chainByKey(network, site_chains?.[origin]?.[network]);
    return c && c.kind !== "solana" ? c : chainByKey(network, "injective")!;
  }

  /** Picks are saved one at a time, each on the map as it is in its turn, so two sites
   *  switching at once both keep theirs. */
  let chainTurn: Promise<unknown> = Promise.resolve();
  function setSiteChain(origin: string, network: NetworkId, key: string): Promise<void> {
    const turn = chainTurn.then(async () => {
      const { site_chains } = (await h.local.get(["site_chains"])) as { site_chains?: Record<string, Partial<Record<NetworkId, string>>> };
      await h.local.set({ site_chains: { ...(site_chains ?? {}), [origin]: { ...(site_chains?.[origin] ?? {}), [network]: key } } });
    });
    chainTurn = turn.catch(() => {});
    return turn;
  }

  /** A client for a site's chain, on the user's endpoints. */
  const rpcFor = (network: NetworkId, c: AnyChain): Promise<EvmRpc> => (c.kind === "injective" ? h.sender.evm(network) : h.sender.chainRpc(network, c.key));

  /** The EVM accounts a site sees: the account while connected and unlocked, else none. */
  async function evmAccounts(origin: string): Promise<string[]> {
    if (!(await isConnected(origin))) return [];
    const u = await h.unlocked();
    const network = await h.network();
    const a = u?.account.addresses[(await siteChain(origin, network)).caip2];
    return a ? [a.toLowerCase()] : [];
  }

  /** The wallet's chain (and network) a chain ID names, if it's one of its EVM chains. */
  function chainOfId(chainId: unknown): { network: NetworkId; chain: AnyChain } | null {
    if (typeof chainId !== "string" || !/^0x[0-9a-fA-F]{1,16}$/.test(chainId)) return null;
    const n = Number(BigInt(chainId));
    for (const network of ["mainnet", "testnet"] as NetworkId[]) {
      const c = chainList(network).find((x) => x.kind !== "solana" && x.chainId === n);
      if (c) return { network, chain: c };
    }
    return null;
  }

  async function switchTo(origin: string, chainId: unknown): Promise<DappReply> {
    const to = chainOfId(chainId);
    if (!to) {
      const names = chainList("mainnet").filter((c) => c.kind !== "solana").map((c) => `${c.name} (${c.chainId})`);
      return no(UNRECOGNIZED_CHAIN, `Choice Wallet doesn't know that chain. It has ${names.join(", ")}, and their test networks.`);
    }
    if (!(await isConnected(origin))) return no(UNAUTHORIZED, "Connect first.");
    const net = await h.network();
    if (to.network === net) {
      await setSiteChain(origin, net, to.chain.key);
      h.notify();
      return { result: null };
    }
    return ask(
      {
        approve: async () => {
          await h.setNetwork(to.network);
          await setSiteChain(origin, to.network, to.chain.key);
          h.notify();
          return { result: null };
        },
      },
      { origin, network: net, kind: "switch", to: to.network, toChain: to.chain.key },
    );
  }

  /** A site asks to add a chain the wallet doesn't have (EIP-3085). The user sees it as it
   *  would be added: chainlist.org's details where the list has the chain (the site's name
   *  shown beside them if it differs), the site's otherwise, on the network in use. Approved,
   *  it joins the list once its endpoints answer as its chain ID, and the site moves to it.
   *  The site's icon is never used. */
  async function addChain(origin: string, p: Record<string, unknown>): Promise<DappReply> {
    if (!(await isConnected(origin))) return no(UNAUTHORIZED, "Connect first.");
    const id = p["chainId"];
    if (typeof id !== "string" || !/^0x[0-9a-fA-F]{1,16}$/.test(id)) return no(INVALID_PARAMS, "chainId must be a hex number.");
    const chainId = Number(BigInt(id));
    const coin = isObject(p["nativeCurrency"]) ? p["nativeCurrency"] : {};
    // The vault reads amounts at 18 decimals on an added chain: another count would show
    // the wrong amounts.
    if (coin["decimals"] !== 18) return no(INVALID_PARAMS, "Choice Wallet adds chains whose coin has 18 decimals.");
    const strings = (v: unknown) => (Array.isArray(v) ? v.filter((u): u is string => typeof u === "string") : []);
    const siteName = typeof p["chainName"] === "string" ? cleanName(p["chainName"]) : "";
    const listed = await h.chains.listed(chainId);
    if (listed && listed.decimals !== 18) return no(INVALID_PARAMS, "Choice Wallet adds chains whose coin has 18 decimals.");
    const net = await h.network();
    const siteExplorer = strings(p["blockExplorerUrls"]).find((u) => /^https:\/\//.test(u));
    const chain: NewChain = listed
      ? { chainId, name: listed.name, symbol: listed.symbol, rpc: listed.rpc.slice(0, 4), ...(listed.explorer ? { explorer: listed.explorer } : {}), testnet: listed.testnet }
      : {
          chainId,
          name: siteName,
          symbol: typeof coin["symbol"] === "string" ? coin["symbol"] : "",
          rpc: strings(p["rpcUrls"]).filter((u) => /^https:\/\//.test(u)).slice(0, 4),
          ...(siteExplorer ? { explorer: siteExplorer } : {}),
          testnet: net === "testnet",
        };
    const why = checkAddedChain(chain);
    if (why) return no(INVALID_PARAMS, why);
    if (chain.rpc.length === 0) return no(INVALID_PARAMS, "rpcUrls needs an https endpoint.");
    const to: NetworkId = chain.testnet ? "testnet" : "mainnet";
    return ask(
      {
        check: async () => {
          const r = await h.chains.add(chain);
          return r.ok || r.error.code === "exists" ? { ok: true, result: null } : r;
        },
        approve: async () => {
          if (to !== net) await h.setNetwork(to);
          await setSiteChain(origin, to, addedKey(chainId));
          h.notify();
          return { result: null };
        },
      },
      { origin, network: net, kind: "add_chain", chain, ...(listed ? { listed } : {}), ...(listed && siteName && siteName.toLowerCase() !== listed.name.toLowerCase() ? { siteName } : {}) },
    );
  }

  /** The dapp's transaction with the wallet's own nonce, gas and fees. Injective charges
   *  gas limit × max fee per gas, so the wallet sets both and ignores the dapp's. An
   *  estimate that fails stops the request: a failing tx on Injective still pays its whole
   *  gas limit. */
  async function fillEvmTx(network: NetworkId, chain: AnyChain, from: string, tx: Record<string, unknown>) {
    const rpc = await rpcFor(network, chain);
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
    const [nonce, block, tip, held] = await rpc.batch([
      { method: "eth_getTransactionCount", params: [from, "pending"] },
      { method: "eth_getBlockByNumber", params: ["latest", false] },
      { method: "eth_maxPriorityFeePerGas", params: [] },
      { method: "eth_getBalance", params: [from, "latest"] },
    ]);
    const q = (v: unknown, what: string): bigint => {
      if (typeof v !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(v)) throw new ChainError(-1, `the node returned no ${what}`);
      return BigInt(v);
    };
    const tipped = typeof tip === "string" ? q(tip, "tip") : 0n;
    let maxFee: bigint;
    let priority: bigint;
    if (chain.kind === "injective") {
      // Injective charges gas limit × max fee per gas: the price is kept near the floor.
      const base = isObject(block) ? q(block["baseFeePerGas"], "base fee") : MIN_GAS_PRICE;
      const baseFee = base < MIN_GAS_PRICE ? MIN_GAS_PRICE : base > MIN_GAS_PRICE * 1000n ? MIN_GAS_PRICE * 1000n : base;
      priority = tipped > baseFee ? baseFee : tipped;
      maxFee = baseFee + priority;
    } else {
      // Elsewhere what is used is paid: room for the base fee to double, plus the tip.
      const base = isObject(block) ? q(block["baseFeePerGas"], "base fee") : 0n;
      priority = tipped;
      maxFee = base * 2n + priority;
    }
    const call = { from, to, value: quantity(value), data };
    const used = q(await rpc.call("eth_estimateGas", [call]), "gas estimate");
    let gas = (used * 12n) / 10n + 1n;
    if (gas < 21_000n) gas = 21_000n;
    if (gas > EVM_MAX_GAS) throw new ChainError(-1, "The gas estimate looks wrong. Try another endpoint.");
    return {
      tx: {
        type: "0x2",
        chainId: quantity(BigInt(chain.chainId!)),
        from,
        to,
        value: quantity(value),
        data,
        nonce: quantity(q(nonce, "nonce")),
        gas: quantity(gas),
        maxFeePerGas: quantity(maxFee),
        maxPriorityFeePerGas: quantity(priority),
      },
      held: typeof held === "string" ? q(held, "balance") : null,
      checkedBy: new URL(rpc.pool.current).host,
    };
  }

  /** On another EVM chain than Injective's: what the review shows amounts in (its coin, its
   *  USDC, the token a call is to) and what the rules weigh them against. */
  async function elsewhere(chain: AnyChain, rpc: EvmRpc, to: string | null, held: bigint | null) {
    const coin = `native:${chain.caip2}`;
    const usdc = `usdc:${chain.caip2}`;
    const tokens: Record<string, TokenInfo> = {
      [coin]: { denom: coin, symbol: chain.native.symbol, name: chain.native.symbol, decimals: chain.native.decimals, known: true, chain: chain.caip2 },
      ...(chain.added ? {} : { [usdc]: { denom: usdc, symbol: "USDC", name: "USD Coin", decimals: 6, known: true, chain: chain.caip2 } }),
    };
    if (to && (chain.added || to.toLowerCase() !== chain.usdc.toLowerCase())) {
      const meta = await erc20Meta(rpc, to).catch(() => null);
      if (meta) tokens[evmDenom(to)] = { denom: evmDenom(to), symbol: meta.symbol, name: meta.symbol, decimals: meta.decimals, known: false, chain: chain.caip2 };
    }
    return { tokens, context: { balances: held === null ? {} : { native: held.toString() }, symbols: { native: chain.native.symbol } } };
  }

  async function evmSign(origin: string, method: string, params: unknown): Promise<DappReply> {
    const network = await h.network();
    const net = NETWORKS[network];
    const chain = await siteChain(origin, network);
    const list = Array.isArray(params) ? params : [];
    // Locked (or watch-only): one answer for every signature request, before any address is
    // compared, so a site can't test a guess at the account while it is locked.
    if (!(await h.unlocked())) return no(UNAUTHORIZED, "Choice Wallet is locked, or this account can't sign. Unlock it, then ask again.");
    const me = async () => (await h.unlocked())?.account.addresses[chain.caip2] ?? "";
    /** The account the site named: only it signs, whichever account is in use at review. */
    const named = (a: unknown): Named => ({ address: String(a).toLowerCase(), of: (acc) => (acc.addresses[chain.caip2] ?? acc.addresses[net.evm])?.toLowerCase() });
    const mine = async (a: unknown) => typeof a === "string" && a !== "" && (await isConnected(origin)) && a.toLowerCase() === (await evmAccountsAny()).toLowerCase();
    // The account in use's address, from storage, for checks made while locked. A
    // watch-only account has nothing to sign with, so it matches nothing.
    async function evmAccountsAny(): Promise<string> {
      const { accounts, active_account } = (await h.local.get(["accounts", "active_account"])) as { accounts?: AccountInfo[]; active_account?: number };
      const a = accounts?.[typeof active_account === "number" ? active_account : 0] ?? accounts?.[0];
      return a && a.account.derivation !== "watch" ? (a.addresses[chain.caip2] ?? a.addresses[net.evm] ?? "") : "";
    }

    if (method === "eth_sendTransaction") {
      const tx = list[0];
      if (!isObject(tx)) return no(INVALID_PARAMS, "eth_sendTransaction takes a transaction object.");
      if (!(await mine(tx["from"]))) return no(UNAUTHORIZED, "The transaction's from isn't this wallet's connected account.");
      if (tx["chainId"] !== undefined && chainOfId(tx["chainId"])?.chain.caip2 !== chain.caip2) return no(CHAIN_DISCONNECTED, `This site is on ${chain.name}. Switch chains first.`);
      if (typeof tx["to"] !== "string") return no(INVALID_PARAMS, "Contract creation isn't supported.");
      return sign(
        origin,
        "evm_transaction",
        async () => {
          const filled = await fillEvmTx(network, chain, await me(), tx);
          const request = { evm_transaction: { chain: chain.caip2, tx: filled.tx } };
          if (chain.kind === "injective") return { request, checkedBy: filled.checkedBy };
          const extra = await elsewhere(chain, await rpcFor(network, chain), filled.tx.to, filled.held);
          return { request, checkedBy: filled.checkedBy, tokens: extra.tokens, context: extra.context };
        },
        async (signed) => {
          const hash = String(signed["hash"]).toLowerCase();
          try {
            await (await rpcFor(network, chain)).call("eth_sendRawTransaction", [signed["raw"]]);
          } catch (e) {
            if (!(e instanceof ChainError && /already known|already imported|known transaction/i.test(e.message))) throw e;
          }
          if (chain.kind === "injective") h.sender.broadcasted(network, hash, (await h.unlocked())?.account.addresses[net.cosmos] ?? "");
          else await h.sender.chainSent(network, chain.key, await me(), hash);
          return hash;
        },
        named(tx["from"]),
      );
    }
    if (method === "personal_sign") {
      const [message, address] = list;
      if (typeof message !== "string") return no(INVALID_PARAMS, "personal_sign takes [message, address].");
      if (message.length > 2 * MAX_ARBITRARY + 2) return no(INVALID_PARAMS, `personal_sign takes at most ${MAX_ARBITRARY} bytes.`);
      if (!(await mine(address))) return no(UNAUTHORIZED, "personal_sign: that address isn't this wallet's connected account.");
      return sign(
        origin,
        "evm_personal_sign",
        async () => ({ request: { evm_personal_sign: { chain: chain.caip2, signer: await me(), message } } }),
        async (signed) => signed["signature"],
        named(address),
      );
    }
    // eth_signTypedData_v4
    const [address, typed] = list;
    if (!(await mine(address))) return no(UNAUTHORIZED, "eth_signTypedData_v4: that address isn't this wallet's connected account.");
    if (typeof typed !== "string" && !isObject(typed)) return no(INVALID_PARAMS, "eth_signTypedData_v4 takes [address, typed data].");
    if ((typeof typed === "string" ? typed : JSON.stringify(typed)).length > MAX_TYPED) return no(INVALID_PARAMS, `Typed data is limited to ${MAX_TYPED / 1024} KiB.`);
    return sign(
      origin,
      "evm_typed_data",
      async () => ({ request: { evm_typed_data: { chain: chain.caip2, signer: await me(), typed_data: typed } } }),
      async (signed) => signed["signature"],
      named(address),
    );
  }

  /** An EVM method's answer, or null when it isn't one. */
  async function handle(origin: string, method: string, params: unknown): Promise<DappReply | null> {
    const network = await h.network();
    switch (method) {
      case "eth_chainId":
        return { result: quantity(BigInt((await siteChain(origin, network)).chainId!)) };
      case "net_version":
        return { result: String((await siteChain(origin, network)).chainId) };
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
        // A chain the wallet has (built in or added) is a switch; another is added first.
        if (method === "wallet_addEthereumChain" && !chainOfId(p["chainId"])) return addChain(origin, p);
        return switchTo(origin, p["chainId"]);
      }
      case "eth_sendTransaction":
      case "personal_sign":
      case "eth_signTypedData_v4":
        return evmSign(origin, method, params);
    }
    if (REFUSED[method]) return no(UNSUPPORTED, REFUSED[method]);
    if (READS.has(method)) return { result: await (await rpcFor(network, await siteChain(origin, network))).call(method, Array.isArray(params) ? params : []) };
    return null;
  }

  return { handle };
}
