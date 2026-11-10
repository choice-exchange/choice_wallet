// Chains the user adds beside the built-in ones (chain/src/chains.ts `AddedChain`), kept in
// local storage as `added_chains`. Before each request the service sets them into the chain
// list, so every lookup finds them.
//
// A chain is found on chainlist.org's list (its name, coin, endpoints with how much each
// tracks, explorer, and DefiLlama's name, which prices its coin and has its logo), or entered
// by hand. Either way each endpoint must answer as that chain ID before it's kept, and the
// logo is fetched once, from DefiLlama (or ethereum-lists' icon on IPFS), and kept as a small
// data URL: nothing is fetched to show it. A site's own icon is never used.

import {
  addedChains,
  addedKey,
  CHAINS,
  checkAddedChain,
  bytesToBase64,
  EvmRpc,
  isObject,
  MAX_ADDED_CHAINS,
  MAX_CHAIN_ID,
  Pool,
  setAddedChains,
  type AddedChain,
  type Fetch,
  type NetworkId,
} from "@choice-wallet/chain";
import type { ListedChain, Result } from "@choice-wallet/ui/protocol";

import type { Store } from "./service";
import { fail } from "./util";

/** chainlist.org's list: every EVM chain it knows, with its endpoints' tracking. */
export const DIRECTORY = "https://chainlist.org/rpcs.json";
/** DefiLlama's chain logos, by its name for the chain. */
export const LLAMA_ICONS = "https://icons.llamao.fi/icons/chains/rsz_";
/** ethereum-lists' icon records, by the list's icon name: an IPFS address and format. */
export const ICON_RECORDS = "https://raw.githubusercontent.com/ethereum-lists/chains/master/_data/icons/";
export const IPFS_GATEWAY = "https://ipfs.io/ipfs/";

/** The list is fetched again after this long. */
const DIRECTORY_TTL_MS = 6 * 60 * 60_000;
/** Search results shown. */
const RESULTS = 8;
/** Endpoints kept per chain, and checked when it's added. */
const MAX_RPC = 6;
/** A logo's image as fetched, and as kept. */
const MAX_IMAGE = 256 * 1024;
const MAX_LOGO = 64 * 1024;
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/svg+xml"];

export interface AddedChainsDeps {
  fetch: Fetch;
  local: Store;
  /** An image made 64 pixels square, as a PNG data URL (null if it can't be read). Absent:
   *  small images are kept as they came. */
  resize?(bytes: Uint8Array, type: string): Promise<string | null>;
  now?: () => number;
}

/** What may be stored, read back: anything else is dropped. */
function storedChain(v: unknown): AddedChain | null {
  if (!isObject(v) || checkAddedChain(v as { chainId: unknown; name: unknown; symbol: unknown })) return null;
  const rpc = v["rpc"];
  if (!Array.isArray(rpc) || rpc.length === 0 || rpc.length > MAX_RPC || !rpc.every((u) => typeof u === "string" && /^https?:\/\//.test(u))) return null;
  if (typeof v["testnet"] !== "boolean") return null;
  const explorer = v["explorer"];
  const logo = v["logo"];
  const llama = v["llama"];
  if (explorer !== undefined && !(typeof explorer === "string" && /^https:\/\/[^\s"<>]+$/.test(explorer))) return null;
  if (logo !== undefined && !(typeof logo === "string" && /^data:image\/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(logo) && logo.length <= MAX_LOGO * 2)) return null;
  if (llama !== undefined && !(typeof llama === "string" && /^[a-z0-9-]{1,40}$/.test(llama))) return null;
  return {
    chainId: v["chainId"] as number,
    name: v["name"] as string,
    symbol: v["symbol"] as string,
    rpc: rpc as string[],
    testnet: v["testnet"],
    ...(explorer ? { explorer: explorer as string } : {}),
    ...(logo ? { logo: logo as string } : {}),
    ...(llama ? { llama: llama as string } : {}),
  };
}

/** A name as the list writes it, made one the wallet keeps: letters, numbers and a little
 *  punctuation, at most 32 characters. */
export function cleanName(s: string): string {
  return s.replace(/[^\p{L}\p{N} .()'_-]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 32).trim();
}

/** An endpoint from the list the wallet can use: https, no key to fill in. */
function usable(u: string): boolean {
  return /^https:\/\/[^\s"<>{}$]+$/.test(u) && !/API_KEY|<|INFURA|ALCHEMY/i.test(u);
}

/** One entry of chainlist.org's list, checked (it's a third party's file): null if it isn't
 *  a chain the wallet could add. */
export function listedChain(e: unknown): ListedChain | null {
  if (!isObject(e)) return null;
  const chainId = e["chainId"];
  if (typeof chainId !== "number" || !Number.isSafeInteger(chainId) || chainId < 1 || chainId > MAX_CHAIN_ID) return null;
  if (e["status"] === "deprecated") return null;
  const coin = isObject(e["nativeCurrency"]) ? e["nativeCurrency"] : {};
  // "BNB Smart Chain Mainnet" is "BNB Smart Chain": the test networks are listed apart.
  const full = typeof e["name"] === "string" ? cleanName(e["name"]) : "";
  const name = full.replace(/ Mainnet$/i, "").length >= 3 ? full.replace(/ Mainnet$/i, "") : full;
  const symbol = typeof coin["symbol"] === "string" ? coin["symbol"].replace(/[^A-Za-z0-9.]/g, "").slice(0, 8) : "";
  if (!name || !symbol) return null;
  // The endpoints that track least first, as the list says.
  const order = (t: unknown) => (t === "none" ? 0 : t === "limited" ? 1 : t === undefined ? 2 : 3);
  const rpcs = (Array.isArray(e["rpc"]) ? e["rpc"] : [])
    .map((r) => (typeof r === "string" ? { url: r, tracking: undefined } : isObject(r) && typeof r["url"] === "string" ? { url: r["url"], tracking: r["tracking"] } : null))
    .filter((r): r is { url: string; tracking: unknown } => r !== null && usable(r.url))
    .sort((a, b) => order(a.tracking) - order(b.tracking));
  const rpc = [...new Set(rpcs.map((r) => r.url.replace(/\/+$/, "")))].slice(0, MAX_RPC);
  const explorers = (Array.isArray(e["explorers"]) ? e["explorers"] : []).filter(isObject);
  const explorer = explorers.map((x) => x["url"]).find((u): u is string => typeof u === "string" && /^https:\/\/[^\s"<>]+$/.test(u));
  const slug = e["chainSlug"];
  const icon = e["icon"];
  const flags = Array.isArray(e["redFlags"]) ? e["redFlags"].filter((f): f is string => typeof f === "string" && /^[A-Za-z]{1,40}$/.test(f)) : [];
  const tvl = e["tvl"];
  return {
    chainId,
    name,
    symbol,
    decimals: typeof coin["decimals"] === "number" ? coin["decimals"] : 0,
    testnet: e["isTestnet"] === true || (e["isTestnet"] === undefined && /testnet|sepolia|goerli|holesky|devnet/i.test(name)),
    rpc,
    ...(explorer ? { explorer: explorer.replace(/\/+$/, "") } : {}),
    ...(typeof slug === "string" && /^[a-z0-9-]{1,40}$/.test(slug) ? { llama: slug } : {}),
    ...(typeof icon === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(icon) ? { icon } : {}),
    flags,
    ...(typeof tvl === "number" && Number.isFinite(tvl) && tvl > 0 ? { tvl } : {}),
  };
}

export function createAddedChains(d: AddedChainsDeps) {
  const now = d.now ?? Date.now;
  let directory: { at: number; list: Promise<ListedChain[]> } | null = null;

  /** Read the added chains from storage into the chain list. */
  async function load(): Promise<readonly AddedChain[]> {
    const { added_chains } = await d.local.get(["added_chains"]);
    const list = (Array.isArray(added_chains) ? added_chains : []).map(storedChain).filter((a): a is AddedChain => a !== null);
    setAddedChains(list);
    return addedChains();
  }

  async function save(list: AddedChain[]): Promise<void> {
    await d.local.set({ added_chains: list });
    setAddedChains(list);
  }

  /** chainlist.org's list, kept for a few hours while the service worker runs. */
  function list(): Promise<ListedChain[]> {
    if (directory && now() - directory.at < DIRECTORY_TTL_MS) return directory.list;
    const p = (async () => {
      const res = await d.fetch(DIRECTORY, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`chainlist.org answered ${res.status}`);
      const body: unknown = await res.json();
      if (!Array.isArray(body)) throw new Error("not a list");
      return body.map(listedChain).filter((c): c is ListedChain => c !== null);
    })();
    directory = { at: now(), list: p };
    p.catch(() => {
      directory = null;
    });
    return p;
  }

  /** A chain on the list by ID, if the list can be read. */
  async function listed(chainId: number): Promise<ListedChain | undefined> {
    try {
      return (await list()).find((c) => c.chainId === chainId);
    } catch {
      return undefined;
    }
  }

  /** Chains on the list matching a name or chain ID: those on this network's side (an exact
   *  ID whichever side), the busiest first. Built-in chains, and coins that aren't 18
   *  decimals (the vault reads amounts at 18 there), aren't offered. */
  async function search(network: NetworkId, query: unknown): Promise<Result<ListedChain[]>> {
    const q = typeof query === "string" ? query.trim().toLowerCase() : "";
    if (q.length === 0 || q.length > 40) return fail("bad_request", "Enter a name or chain ID.");
    let all: ListedChain[];
    try {
      all = await list();
    } catch {
      return fail("unreachable", "Couldn't reach chainlist.org. Enter the chain yourself.");
    }
    const builtIn = new Set([...CHAINS.mainnet, ...CHAINS.testnet].map((c) => c.chainId));
    const offered = all.filter((c) => !builtIn.has(c.chainId) && c.decimals === 18 && c.rpc.length > 0);
    const id = /^[0-9]{1,16}$/.test(q) ? Number(q) : null;
    const testnet = network === "testnet";
    const rank = (c: ListedChain) => {
      if (c.chainId === id) return 0;
      if (c.testnet !== testnet) return -1;
      const n = c.name.toLowerCase();
      return n === q ? 1 : n.startsWith(q) ? 2 : n.includes(q) ? 3 : -1;
    };
    const found = offered
      .map((c) => ({ c, r: rank(c) }))
      .filter((x) => x.r >= 0)
      .sort((a, b) => a.r - b.r || (b.c.tvl ?? 0) - (a.c.tvl ?? 0) || a.c.name.localeCompare(b.c.name))
      .slice(0, RESULTS)
      .map((x) => x.c);
    return { ok: true, result: found };
  }

  /** An image at `url`, as a data URL small enough to keep, or undefined. */
  async function image(url: string): Promise<string | undefined> {
    try {
      const res = await d.fetch(url, { signal: AbortSignal.timeout(10_000) });
      const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      if (!res.ok || !IMAGE_TYPES.includes(type)) return undefined;
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length === 0 || bytes.length > MAX_IMAGE) return undefined;
      if (type !== "image/svg+xml" && d.resize) return (await d.resize(bytes, type)) ?? undefined;
      return bytes.length <= MAX_LOGO ? `data:${type};base64,${bytesToBase64(bytes)}` : undefined;
    } catch {
      return undefined;
    }
  }

  /** The chain's logo: DefiLlama's, else ethereum-lists' icon (from IPFS). */
  async function logo(c: ListedChain | undefined): Promise<string | undefined> {
    if (!c) return undefined;
    if (c.llama) {
      const got = await image(`${LLAMA_ICONS}${c.llama}.jpg`);
      if (got) return got;
    }
    if (!c.icon) return undefined;
    try {
      const res = await d.fetch(`${ICON_RECORDS}${c.icon}.json`, { signal: AbortSignal.timeout(10_000) });
      const body: unknown = res.ok ? await res.json() : null;
      const first = Array.isArray(body) && isObject(body[0]) ? body[0] : null;
      const cid = typeof first?.["url"] === "string" ? /^ipfs:\/\/([A-Za-z0-9]{46,64})$/.exec(first["url"])?.[1] : undefined;
      return cid ? await image(`${IPFS_GATEWAY}${cid}`) : undefined;
    } catch {
      return undefined;
    }
  }

  /** Add a chain: from the list (the UI fills the form from a result, the user may change it)
   *  or by hand. Each endpoint must answer as its chain ID; those that don't are dropped. */
  async function add(input: unknown): Promise<Result<AddedChain>> {
    if (!isObject(input)) return fail("bad_request", "Not a chain.");
    const why = checkAddedChain(input as { chainId: unknown; name: unknown; symbol: unknown });
    if (why) return fail("invalid", why);
    const chainId = input["chainId"] as number;
    const name = (input["name"] as string).trim();
    const symbol = input["symbol"] as string;
    const current = [...(await load())];
    const same = current.find((a) => a.chainId === chainId);
    if (same) return fail("exists", `${same.name} is already on the list.`);
    if (current.length >= MAX_ADDED_CHAINS) return fail("too_many", `At most ${MAX_ADDED_CHAINS} added chains.`);
    if (typeof input["testnet"] !== "boolean") return fail("bad_request", "Say whether it's a test network.");
    const raw = input["rpc"];
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_RPC || !raw.every((u) => typeof u === "string")) return fail("invalid_endpoint", "Enter its RPC address.");
    let urls: readonly string[];
    try {
      urls = new Pool(raw as string[], { fetch: d.fetch, identify: async () => {} }).urls;
    } catch (e) {
      return fail("invalid_endpoint", e instanceof Error ? `${e.message[0]?.toUpperCase()}${e.message.slice(1)}.` : "Invalid endpoint.");
    }
    let explorer: string | undefined;
    if (input["explorer"] !== undefined && input["explorer"] !== "") {
      const x = input["explorer"];
      let u: URL | null = null;
      try {
        u = typeof x === "string" ? new URL(x.trim()) : null;
      } catch {
        u = null;
      }
      if (!u || u.protocol !== "https:" || u.username || u.password) return fail("invalid", "The explorer must be an https address.");
      explorer = `${u.origin}${u.pathname}`.replace(/\/+$/, "");
    }
    // Each endpoint, asked once: kept if it serves this chain.
    const answered = await Promise.all(
      urls.map(async (url) => {
        try {
          await new EvmRpc({ evmChainId: chainId }, [url], d.fetch, 8_000).call("eth_blockNumber");
          return url;
        } catch {
          return null;
        }
      }),
    );
    const rpc = answered.filter((u): u is string => u !== null);
    if (rpc.length === 0) return fail("unreachable", `No endpoint answered as chain ${chainId}.`);
    const onList = await listed(chainId);
    const icon = await logo(onList);
    const chain: AddedChain = {
      chainId,
      name,
      symbol,
      rpc,
      testnet: input["testnet"],
      ...(explorer ? { explorer } : {}),
      ...(icon ? { logo: icon } : {}),
      ...(onList?.llama ? { llama: onList.llama } : {}),
    };
    await save([...current, chain]);
    return { ok: true, result: chain };
  }

  /** Remove an added chain, with its endpoint settings and what the wallet kept for it; a
   *  site on it goes back to Injective's EVM side. */
  async function remove(chainId: unknown): Promise<Result<null>> {
    const current = [...(await load())];
    const gone = current.find((a) => a.chainId === chainId);
    if (!gone) return fail("bad_request", "Not an added chain.");
    const key = addedKey(gone.chainId);
    const net: NetworkId = gone.testnet ? "testnet" : "mainnet";
    const s = (await d.local.get(["chain_endpoints", "chain_history", "chain_sent", "site_chains", "chain"])) as {
      chain_endpoints?: Partial<Record<NetworkId, Record<string, string[]>>>;
      chain_history?: Partial<Record<NetworkId, Record<string, string[]>>>;
      chain_sent?: Record<string, string[]>;
      site_chains?: Record<string, Partial<Record<NetworkId, string>>>;
      chain?: unknown;
    };
    const without = (all: Partial<Record<NetworkId, Record<string, string[]>>> | undefined) => {
      const mine = { ...(all?.[net] ?? {}) };
      delete mine[key];
      return { ...(all ?? {}), [net]: mine };
    };
    const sites = Object.fromEntries(
      Object.entries(s.site_chains ?? {}).map(([origin, picks]) => {
        const next = { ...picks };
        if (next[net] === key) delete next[net];
        return [origin, next];
      }),
    );
    const sent = Object.fromEntries(Object.entries(s.chain_sent ?? {}).filter(([id]) => !id.startsWith(`${net} ${key} `)));
    await d.local.set({
      chain_endpoints: without(s.chain_endpoints),
      chain_history: without(s.chain_history),
      chain_sent: sent,
      site_chains: sites,
      ...(s.chain === key ? { chain: "injective" } : {}),
    });
    await save(current.filter((a) => a !== gone));
    return { ok: true, result: null };
  }

  return { load, search, listed, add, remove };
}
