// Sites: what a web page may ask of the wallet, and the approvals it waits for. Chrome-free,
// so it runs under test; the service worker passes in how to open an approval window.
//
// - A site's origin comes from the browser (the content script's sender), never the page.
// - Connecting is a grant per origin, kept in local storage until the user disconnects.
//   A site that isn't connected sees no account; a locked wallet shows none to anyone.
// - Anything that signs or changes the wallet waits for an approval window. The window
//   shows the vault's decode of exactly what will be signed (prepared when the window asks,
//   so the nonce and fee are fresh), and approving names that decode's digest. A request
//   is answered once; closing the window rejects it.
// - Requests live in this worker's memory. If the worker stops, they fail, and the site
//   can ask again.

import {
  balanceChanges,
  ChainError,
  cosmosTxHash,
  isObject,
  MIN_GAS_PRICE,
  NETWORKS,
  Unreachable,
  type Coin,
  type NetworkId,
} from "@choice-wallet/chain";
import type { AccountInfo, Connection, CosmosDisplay, DappRequest, DappReview, Result, Risk } from "@choice-wallet/ui/protocol";

import { displayDenoms, type createSender } from "./send";
import type { Store } from "./service";

type Sender = ReturnType<typeof createSender>;

/** An answer to the page: EIP-1193's shape. */
export type DappReply = { result: unknown } | { error: { code: number; message: string } };

// EIP-1193 and JSON-RPC error codes.
export const USER_REJECTED = 4001;
export const UNAUTHORIZED = 4100;
export const UNSUPPORTED = 4200;
export const CHAIN_DISCONNECTED = 4901;
export const UNRECOGNIZED_CHAIN = 4902;
export const INVALID_PARAMS = -32602;
export const INTERNAL = -32603;
export const PENDING = -32002;

const no = (code: number, message: string): DappReply => ({ error: { code, message } });
const fail = (code: string, message: string): Result<never> => ({ ok: false, error: { code, message } });

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

/** Requests waiting at once: in all, and per site. */
const MAX_WAITING = 10;
const MAX_PER_SITE = 3;
/** Gas a dapp's EVM transaction may use, at most (Injective charges the whole limit). */
const EVM_MAX_GAS = 10_000_000n;

export interface DappHost {
  vault<T>(method: string, params?: unknown): Promise<Result<T>>;
  local: Store;
  sender: Sender;
  network(): Promise<NetworkId>;
  setNetwork(n: NetworkId): Promise<void>;
  /** The account, keystore and unlock key while unlocked; else null. */
  unlocked(): Promise<{ account: AccountInfo; keystore: string; key: string } | null>;
  /** Open the approval window for request `id`; its window ID, to notice it closing. */
  openWindow(id: string): Promise<number | undefined>;
  /** Tell every page that its view (accounts, chain) may have changed. */
  notify(): void;
}

type Prepared = { request: unknown; digest: string; confirm: string | null; blocked: boolean };

interface Waiting {
  req: DappRequest;
  resolve: (r: DappReply) => void;
  windowId?: number;
  /** connect and switch: what approving does, and the page's answer. */
  approve?: () => Promise<DappReply>;
  /** sign: build the vault request (fresh, at review time). */
  build?: (account: AccountInfo) => Promise<{ request: unknown; checkedBy?: string; simulation?: DappReview["simulation"] }>;
  /** sign: what to hand the page once signed. */
  finish?: (signed: Record<string, unknown>) => Promise<unknown>;
  prepared?: Prepared;
}

type Grants = Record<string, { since: number; approvals?: number }>;

const quantity = (n: bigint) => `0x${n.toString(16)}`;
const bytesHex = (s: string) => /^(0x)?([0-9a-fA-F]{2})*$/.test(s);
const b64 = (hex: string) => {
  let bin = "";
  for (let i = 0; i < hex.length; i += 2) bin += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  return btoa(bin);
};

export function createDapps(h: DappHost) {
  const waiting = new Map<string, Waiting>();

  async function grants(): Promise<Grants> {
    const { connections } = (await h.local.get(["connections"])) as { connections?: Grants };
    return connections ?? {};
  }

  async function isConnected(origin: string): Promise<boolean> {
    return (await grants())[origin] !== undefined;
  }

  /** The EVM accounts a site sees: the account while connected and unlocked, else none. */
  async function evmAccounts(origin: string): Promise<string[]> {
    if (!(await isConnected(origin))) return [];
    const u = await h.unlocked();
    const a = u?.account.addresses[NETWORKS[await h.network()].evm];
    return a ? [a.toLowerCase()] : [];
  }

  /** Put a request in front of the user. Resolves when they answer or close the window. */
  async function ask(w: Omit<Waiting, "req" | "resolve">, req: Omit<DappRequest, "id">): Promise<DappReply> {
    const site = [...waiting.values()].filter((x) => x.req.origin === req.origin);
    if (waiting.size >= MAX_WAITING || site.length >= MAX_PER_SITE) return no(PENDING, "Too many requests are waiting. Answer them in the wallet first.");
    if (req.kind !== "sign" && site.some((x) => x.req.kind === req.kind)) return no(PENDING, "A request like this is already waiting in the wallet.");
    const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
    return new Promise<DappReply>((resolve) => {
      const entry: Waiting = { ...w, req: { ...req, id }, resolve };
      waiting.set(id, entry);
      h.openWindow(id).then(
        (windowId) => {
          if (windowId !== undefined) entry.windowId = windowId;
        },
        () => settle(id, no(INTERNAL, "The wallet couldn't open its approval window.")),
      );
    });
  }

  function settle(id: string, reply: DappReply) {
    const w = waiting.get(id);
    if (!w) return;
    waiting.delete(id);
    w.resolve(reply);
  }

  async function connect(origin: string, then: () => Promise<DappReply>): Promise<DappReply> {
    if ((await isConnected(origin)) && (await h.unlocked())) return then();
    return ask(
      {
        approve: async () => {
          const all = await grants();
          await h.local.set({ connections: { ...all, [origin]: all[origin] ?? { since: Date.now() } } });
          h.notify();
          return then();
        },
      },
      { origin, network: await h.network(), kind: "connect" },
    );
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

  /** A signature request: checked now, built and decoded when the window asks. */
  async function sign(
    origin: string,
    method: string,
    build: NonNullable<Waiting["build"]>,
    finish: NonNullable<Waiting["finish"]>,
  ): Promise<DappReply> {
    if (!(await isConnected(origin))) return no(UNAUTHORIZED, "Connect to Choice Wallet first.");
    return ask({ build, finish }, { origin, network: await h.network(), kind: "sign", method });
  }

  // -- EVM --

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
    // The account's address, from storage, for checks made while locked.
    async function evmAccountsAny(): Promise<string> {
      const { accounts } = (await h.local.get(["accounts"])) as { accounts?: AccountInfo[] };
      return accounts?.[0]?.addresses[net.evm] ?? "";
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

  // -- Cosmos (window.choice) --

  async function cosmos(origin: string, method: string, p: Record<string, unknown>): Promise<DappReply> {
    const network = await h.network();
    const net = NETWORKS[network];
    const wrongChain = (id: unknown) => id !== net.chainId;
    const chainNote = `Choice Wallet is on ${net.name} (${net.chainId}).`;

    if (method === "choice_enable") {
      const ids = Array.isArray(p["chainIds"]) ? p["chainIds"] : [p["chainIds"]];
      if (ids.length === 0 || ids.some(wrongChain)) return no(CHAIN_DISCONNECTED, chainNote);
      return connect(origin, async () => ({ result: null }));
    }
    if (wrongChain(p["chainId"])) return no(CHAIN_DISCONNECTED, chainNote);
    if (!(await isConnected(origin))) return no(UNAUTHORIZED, "Call enable first.");
    const u = await h.unlocked();
    if (!u && method === "choice_getKey") return no(UNAUTHORIZED, "Choice Wallet is locked.");

    if (method === "choice_getKey") {
      const a = u!.account;
      const evmAddr = a.addresses[net.evm] ?? "";
      return {
        result: {
          name: "Account 1",
          algo: "ethsecp256k1",
          pubKey: a.public_key,
          address: evmAddr.slice(2).toLowerCase(),
          bech32Address: a.addresses[net.cosmos],
          ethereumHexAddress: evmAddr,
          isNanoLedger: false,
          isKeystone: false,
        },
      };
    }
    if (method === "choice_sendTx") {
      const tx = p["tx"];
      if (typeof tx !== "string" || !bytesHex(tx) || tx.length < 4) return no(INVALID_PARAMS, "sendTx takes the signed tx bytes.");
      const hex = tx.replace(/^0x/, "");
      const hash = await cosmosTxHash(hex);
      await (await h.sender.lcd(network)).broadcast(hex, hash);
      return { result: hash };
    }
    const { accounts } = (await h.local.get(["accounts"])) as { accounts?: AccountInfo[] };
    const account = accounts?.[0];
    if (!account || p["signer"] !== account.addresses[net.cosmos]) return no(UNAUTHORIZED, "The signer isn't this wallet's connected account.");
    const pubkey = account.public_key;
    const signature = (sig: unknown) => ({ pub_key: { type: "tendermint/PubKeySecp256k1", value: b64(pubkey) }, signature: b64(String(sig)) });

    if (method === "choice_signDirect") {
      const doc = p["signDoc"];
      if (!isObject(doc) || typeof doc["bodyBytes"] !== "string" || typeof doc["authInfoBytes"] !== "string" || !bytesHex(doc["bodyBytes"]) || !bytesHex(doc["authInfoBytes"])) {
        return no(INVALID_PARAMS, "signDirect takes { bodyBytes, authInfoBytes, chainId, accountNumber }.");
      }
      if (wrongChain(doc["chainId"])) return no(CHAIN_DISCONNECTED, chainNote);
      const accountNumber = String(doc["accountNumber"] ?? "");
      if (!/^[0-9]{1,20}$/.test(accountNumber)) return no(INVALID_PARAMS, "signDirect: accountNumber must be an integer.");
      const body = doc["bodyBytes"].replace(/^0x/, "");
      const auth = doc["authInfoBytes"].replace(/^0x/, "");
      return sign(
        origin,
        "cosmos_direct",
        async () => {
          const request = { cosmos_direct: { chain: net.cosmos, signer: pubkey, body_bytes: body, auth_info_bytes: auth, account_number: accountNumber } };
          return { request, ...(await simulate(network, account, body, auth)) };
        },
        async (signed) => signature(signed["signature"]),
      );
    }
    if (method === "choice_signAmino") {
      const doc = p["signDoc"];
      if (!isObject(doc)) return no(INVALID_PARAMS, "signAmino takes a StdSignDoc.");
      if (wrongChain(doc["chain_id"])) return no(CHAIN_DISCONNECTED, chainNote);
      return sign(
        origin,
        "cosmos_amino",
        async () => ({ request: { cosmos_amino: { chain: net.cosmos, signer: pubkey, sign_doc: doc } } }),
        async (signed) => signature(signed["signature"]),
      );
    }
    return no(UNSUPPORTED, `${method} isn't supported.`);
  }

  /** Simulate a dapp's Cosmos tx (unsigned) for what it would move. A failure is shown, not
   *  thrown: the user decides. */
  async function simulate(network: NetworkId, account: AccountInfo, body: string, auth: string): Promise<{ checkedBy: string; simulation: DappReview["simulation"] }> {
    const client = await h.sender.lcd(network);
    // TxRaw { body_bytes = 1, auth_info_bytes = 2, signatures = 3: one empty }.
    const len = (n: number) => {
      const out: number[] = [];
      do {
        let b = n & 0x7f;
        n >>>= 7;
        if (n) b |= 0x80;
        out.push(b);
      } while (n);
      return out.map((b) => b.toString(16).padStart(2, "0")).join("");
    };
    const raw = `0a${len(body.length / 2)}${body}12${len(auth.length / 2)}${auth}1a00`;
    try {
      const { events } = await client.simulateEvents(raw);
      const me = account.addresses[NETWORKS[network].cosmos] ?? "";
      const feeEvent = events.find((e) => e.type === "tx" && e.attributes.some((a) => a.key === "fee"));
      const fee = (feeEvent?.attributes.find((a) => a.key === "fee")?.value ?? "").split(",").flatMap((c) => {
        const m = /^([0-9]+)([a-zA-Z][a-zA-Z0-9/:._-]{2,127})$/.exec(c.trim());
        return m ? [{ denom: m[2]!, amount: m[1]! }] : [];
      });
      return { checkedBy: new URL(client.pool.current).host, simulation: { ok: true, changes: balanceChanges(events, me, fee).changes } };
    } catch (e) {
      if (e instanceof ChainError) return { checkedBy: new URL(client.pool.current).host, simulation: { ok: false, error: e.message } };
      throw e;
    }
  }

  /** Handle one message from a page, at `origin`. */
  async function handle(origin: string, msg: unknown): Promise<DappReply> {
    if (!isObject(msg) || typeof msg["method"] !== "string") return no(INVALID_PARAMS, "Not a request.");
    const method = msg["method"];
    const params = msg["params"];
    const network = await h.network();
    const net = NETWORKS[network];
    try {
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
        case "choice_enable":
        case "choice_getKey":
        case "choice_signDirect":
        case "choice_signAmino":
        case "choice_sendTx":
          return cosmos(origin, method, isObject(params) ? params : {});
      }
      if (REFUSED[method]) return no(UNSUPPORTED, REFUSED[method]);
      if (READS.has(method)) return { result: await (await h.sender.evm(network)).call(method, Array.isArray(params) ? params : []) };
      return no(UNSUPPORTED, `${method} isn't supported.`);
    } catch (e) {
      if (e instanceof ChainError) return no(INTERNAL, e.message);
      if (e instanceof Unreachable) return no(INTERNAL, "Couldn't reach the network.");
      if (e instanceof RangeError) return no(INVALID_PARAMS, e.message);
      throw e;
    }
  }

  // -- The approval window's side --

  function request(id: unknown): Result<DappRequest> {
    const w = typeof id === "string" ? waiting.get(id) : undefined;
    return w ? { ok: true, result: w.req } : fail("not_found", "This request is no longer open.");
  }

  async function review(id: unknown): Promise<Result<DappReview>> {
    const w = typeof id === "string" ? waiting.get(id) : undefined;
    if (!w) return fail("not_found", "This request is no longer open.");
    if (!w.build) return fail("bad_request", "Nothing to review.");
    const u = await h.unlocked();
    if (!u) return fail("locked", "Unlock the wallet first.");
    const network = w.req.network;
    if (network !== (await h.network())) return fail("network", "The wallet changed network. Ask the site again.");
    try {
      const built = await w.build(u.account);
      const all = await grants();
      const context = await reviewContext(network, u.account, w.req.origin, (all[w.req.origin]?.approvals ?? 0) > 0);
      const d = await h.vault<{ digest: string; display: DappReview["display"]; risk: Risk }>("decode", { request: built.request, context });
      if (!d.ok) return d;
      const { digest, display, risk } = d.result;
      w.prepared = { request: built.request, digest, confirm: risk.confirm ?? null, blocked: risk.level === "blocked" };
      const tokens = await h.sender.tokensFor(network, reviewDenoms(network, display, built.simulation?.ok ? built.simulation.changes : []));
      return { ok: true, result: { digest, display, risk, tokens, checkedBy: built.checkedBy ?? "", ...(built.simulation ? { simulation: built.simulation } : {}) } };
    } catch (e) {
      if (e instanceof RangeError) return fail("bad_request", e.message);
      return h.sender.chainFailure(e);
    }
  }

  async function reviewContext(network: NetworkId, account: AccountInfo, origin: string, known: boolean) {
    const net = NETWORKS[network];
    const balances: Record<string, string> = {};
    try {
      const me = account.addresses[net.cosmos]!;
      for (const c of await (await h.sender.lcd(network)).balances(me)) balances[c.denom] = c.amount;
      if (balances["inj"]) balances["native"] = balances["inj"];
    } catch (e) {
      if (!(e instanceof Unreachable || e instanceof ChainError)) throw e;
    }
    return { origin, origin_known: known, balances };
  }

  async function answer(id: unknown, approve: unknown, digest: unknown, confirm: unknown): Promise<Result<{ done: true; hash?: string }>> {
    const w = typeof id === "string" ? waiting.get(id) : undefined;
    if (!w) return fail("not_found", "This request is no longer open.");
    if (approve !== true) {
      settle(w.req.id, no(USER_REJECTED, "The user rejected the request."));
      return { ok: true, result: { done: true } };
    }
    const u = await h.unlocked();
    if (!u) return fail("locked", "Unlock the wallet first.");
    if (w.approve) {
      const reply = await w.approve();
      settle(w.req.id, reply);
      return { ok: true, result: { done: true } };
    }
    const p = w.prepared;
    if (!p || p.digest !== digest) return fail("not_approved", "This request changed. Review it again.");
    if (p.blocked) return fail("blocked", "The wallet won't sign this.");
    if (p.confirm && (typeof confirm === "string" ? confirm.trim() : "") !== p.confirm) return fail("confirm", `Type ${p.confirm} to continue.`);
    // Answered once: from here the request is the page's, whatever happens.
    waiting.delete(w.req.id);
    const signed = await h.vault<Record<string, unknown>>("sign", { keystore: u.keystore, unlock_key: u.key, account: u.account.account, request: p.request, digest: p.digest });
    if (!signed.ok) {
      w.resolve(no(INTERNAL, signed.error.message));
      return signed;
    }
    try {
      const result = await w.finish!(signed.result);
      const all = await grants();
      const g = all[w.req.origin];
      if (g) await h.local.set({ connections: { ...all, [w.req.origin]: { ...g, approvals: (g.approvals ?? 0) + 1 } } });
      w.resolve({ result });
      return { ok: true, result: { done: true, ...(typeof result === "string" && result.startsWith("0x") && result.length === 66 ? { hash: result } : {}) } };
    } catch (e) {
      const r = e instanceof ChainError || e instanceof Unreachable ? h.sender.chainFailure(e) : fail("internal", String(e));
      w.resolve(no(INTERNAL, r.ok ? "failed" : r.error.message));
      return r;
    }
  }

  async function connections(): Promise<Result<Connection[]>> {
    const all = await grants();
    return { ok: true, result: Object.entries(all).map(([origin, g]) => ({ origin, since: g.since })).sort((a, b) => b.since - a.since) };
  }

  async function disconnect(origin: unknown): Promise<Result<Connection[]>> {
    if (typeof origin !== "string") return fail("bad_request", "Which site?");
    const all = await grants();
    delete all[origin];
    await h.local.set({ connections: all });
    h.notify();
    return connections();
  }

  /** The window for a request closed: an unanswered request is rejected. */
  function windowClosed(windowId: number) {
    for (const w of [...waiting.values()]) if (w.windowId === windowId) settle(w.req.id, no(USER_REJECTED, "The user closed the request."));
  }

  return { handle, request, review, answer, connections, disconnect, windowClosed };
}

/** The tokens an approval screen names: what a Cosmos tx moves, what simulation says moves,
 *  the fee, and an EVM transfer's token. */
function reviewDenoms(network: NetworkId, display: DappReview["display"], changes: readonly Coin[]): string[] {
  const out = new Set<string>(changes.map((c) => c.denom));
  out.add(NETWORKS[network].feeDenom);
  const d = display as Record<string, unknown>;
  if (d["kind"] === "cosmos_direct" || d["kind"] === "cosmos_amino") for (const dn of displayDenoms(network, display as CosmosDisplay)) out.add(dn);
  if (d["kind"] === "evm_transaction" && isObject(d["call"]) && d["call"]["type"] === "erc20_transfer" && typeof d["to"] === "string") out.add(`evm:${d["to"].toLowerCase()}`);
  const injTx = d["injective_tx"];
  if (isObject(injTx) && Array.isArray(injTx["messages"])) {
    const fee = isObject(injTx["fee"]) && Array.isArray(injTx["fee"]["amount"]) ? (injTx["fee"]["amount"] as Coin[]) : [];
    for (const dn of displayDenoms(network, { kind: "", chain: "", signer: "", memo: "", fee: { amount: fee, gas_limit: "0", granter: null, payer: null }, messages: injTx["messages"] as CosmosDisplay["messages"] })) out.add(dn);
  }
  return [...out];
}
