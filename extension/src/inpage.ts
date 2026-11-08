// What web pages see, injected into the page's own world: an EIP-1193 provider for the EVM
// side, announced through EIP-6963 (it never touches window.ethereum), and window.choice
// for the Cosmos side, in Keplr's shape. It holds nothing secret and decides nothing: each
// request goes to the service worker through ./relay.ts, and the worker answers by the
// origin the browser reports, asking the user in its own window where it must.

import icon from "../../ui/src/assets/choice-mark.svg";

const TO_RELAY = "choice-wallet:relay";
const TO_PAGE = "choice-wallet:page";

(() => {
  // Taken now, before any page script runs, so the page can't swap them out under us.
  const post = window.postMessage.bind(window);
  const listen = window.addEventListener.bind(window);
  const dispatch = window.dispatchEvent.bind(window);
  const Uint8 = Uint8Array;

  class ProviderRpcError extends Error {
    readonly code: number;
    constructor(code: number, message: string) {
      super(message);
      this.code = code;
    }
  }

  let next = 0;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();

  function call(method: string, params?: unknown): Promise<unknown> {
    const id = ++next;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      post({ target: TO_RELAY, id, method, params }, "*");
    });
  }

  // -- EIP-1193 --

  type Listener = (...args: unknown[]) => void;
  const listeners = new Map<string, Set<Listener>>();
  const emit = (event: string, ...args: unknown[]) => {
    for (const fn of listeners.get(event) ?? []) {
      try {
        fn(...args);
      } catch {
        // A page's listener failing is the page's business.
      }
    }
  };
  let chainId: string | null = null;
  let accounts: string[] = [];
  let watching = false;

  /** Ask again what this page sees, and say what changed. */
  async function refresh(quiet = false) {
    try {
      const [c, a] = (await Promise.all([call("eth_chainId"), call("eth_accounts")])) as [string, string[]];
      if (c !== chainId) {
        const first = chainId === null;
        chainId = c;
        if (first) emit("connect", { chainId: c });
        else if (!quiet) emit("chainChanged", c);
      }
      if (JSON.stringify(a) !== JSON.stringify(accounts)) {
        accounts = a;
        if (!quiet) emit("accountsChanged", a);
      }
    } catch {
      // The wallet isn't reachable; the next request will say so.
    }
  }
  /** Track changes once the page uses the provider (not on every page load). */
  function watch() {
    if (watching) return;
    watching = true;
    void refresh(true);
  }

  const provider = Object.freeze({
    isChoice: true,
    async request(args: { method: string; params?: unknown }): Promise<unknown> {
      if (typeof args !== "object" || args === null || typeof args.method !== "string") {
        throw new ProviderRpcError(-32602, "request takes { method, params }.");
      }
      watch();
      const result = await call(args.method, args.params);
      if (args.method === "eth_requestAccounts" || args.method === "eth_accounts") {
        const a = result as string[];
        if (JSON.stringify(a) !== JSON.stringify(accounts)) {
          accounts = a;
          emit("accountsChanged", a);
        }
      }
      return result;
    },
    on(event: string, fn: Listener) {
      watch();
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(fn);
      return provider;
    },
    removeListener(event: string, fn: Listener) {
      listeners.get(event)?.delete(fn);
      return provider;
    },
  });

  // -- EIP-6963 --

  const detail = Object.freeze({
    info: Object.freeze({ uuid: crypto.randomUUID(), name: "Choice Wallet", icon, rdns: "exchange.choice.wallet" }),
    provider,
  });
  const announce = () => dispatch(new CustomEvent("eip6963:announceProvider", { detail }));
  listen("eip6963:requestProvider", announce);
  announce();

  // -- window.choice: the Cosmos side, Keplr's shape --

  const hex = (b: unknown): string => {
    if (b instanceof Uint8) return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    throw new ProviderRpcError(-32602, "Expected bytes (a Uint8Array).");
  };
  const bytes = (h: string) => Uint8.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
  type Doc = { bodyBytes?: Uint8Array; authInfoBytes?: Uint8Array; chainId?: string; accountNumber?: { toString(): string } | bigint | number };
  type Key = { pubKey: string; address: string; bech32Address: string; [k: string]: unknown };

  const choice = {
    async enable(chainIds: string | string[]): Promise<void> {
      await call("choice_enable", { chainIds: Array.isArray(chainIds) ? chainIds : [chainIds] });
    },
    async getKey(chainId: string) {
      const k = (await call("choice_getKey", { chainId })) as Key;
      return { ...k, pubKey: bytes(k.pubKey), address: bytes(k.address) };
    },
    async signDirect(chainId: string, signer: string, signDoc: Doc) {
      const signature = await call("choice_signDirect", {
        chainId,
        signer,
        signDoc: { bodyBytes: hex(signDoc.bodyBytes), authInfoBytes: hex(signDoc.authInfoBytes), chainId: signDoc.chainId, accountNumber: String(signDoc.accountNumber ?? "") },
      });
      return { signed: signDoc, signature };
    },
    async signAmino(chainId: string, signer: string, signDoc: unknown) {
      const signature = await call("choice_signAmino", { chainId, signer, signDoc });
      return { signed: signDoc, signature };
    },
    async sendTx(chainId: string, tx: Uint8Array, mode?: string): Promise<Uint8Array> {
      return bytes((await call("choice_sendTx", { chainId, tx: hex(tx), mode })) as string);
    },
    getOfflineSigner(chainId: string) {
      return {
        getAccounts: async () => {
          const k = await choice.getKey(chainId);
          return [{ address: k.bech32Address, algo: "ethsecp256k1", pubkey: k.pubKey }];
        },
        signDirect: (signer: string, doc: Doc) => choice.signDirect(chainId, signer, doc),
      };
    },
    getOfflineSignerOnlyAmino(chainId: string) {
      return {
        getAccounts: () => choice.getOfflineSigner(chainId).getAccounts(),
        signAmino: (signer: string, doc: unknown) => choice.signAmino(chainId, signer, doc),
      };
    },
    async getOfflineSignerAuto(chainId: string) {
      return choice.getOfflineSigner(chainId);
    },
    ethereum: provider,
  };

  listen("message", (e: MessageEvent) => {
    if (e.source !== window || typeof e.data !== "object" || e.data === null || e.data.target !== TO_PAGE) return;
    if (e.data.event === "changed") {
      if (watching) void refresh();
      dispatch(new Event("choice_keystorechange"));
      return;
    }
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    if (e.data.error) p.reject(new ProviderRpcError(Number(e.data.error.code), String(e.data.error.message)));
    else p.resolve(e.data.result);
  });

  try {
    Object.defineProperty(window, "choice", { value: Object.freeze(choice), writable: false, configurable: false, enumerable: true });
  } catch {
    // Something else took the name first; EIP-6963 still finds us.
  }
})();
