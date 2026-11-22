// NFTs: CW721 collections on the Cosmos side, ERC721s on Injective EVM.
//
// Indexer suggests, chain confirms. Collections to look at come from the node's tx index
// (CW721 events that name the account: `wasm.recipient` for transfers and sends,
// `wasm.owner` for mints), from Blockscout's ERC721 transfers for the 0x address, and from
// collections the user adds. What the account holds is then asked of each contract
// directly: CW721 `tokens { owner }` page by page until a short page (a query with the
// default page size silently drops the rest), ERC721 `ownerOf` for each token named, and
// `tokenOfOwnerByIndex` for an enumerable collection added by hand. Names, symbols and
// metadata are the collection creator's words, cleaned like token names.

import { word, type EvmRpc } from "./evm.ts";
import type { EvmIndex } from "./evmindex.ts";
import type { IndexedTx, Lcd } from "./lcd.ts";
import { ChainError, Down, isObject, Unreachable } from "./pool.ts";
import { cleanText } from "./tokens.ts";

export type NftStandard = "cw721" | "erc721" | "erc1155";
/** `amount`: how many of it are held (ERC1155 only). */
export type Nft = { tokenId: string; name: string; uri: string | null; amount?: string };
export type NftCollection = {
  /** `inj1…` (CW721) or checksumless lowercase `0x…` (ERC721, ERC1155). */
  address: string;
  standard: NftStandard;
  name: string;
  symbol: string;
  items: Nft[];
  /** More are held than were listed. */
  more: boolean;
};

/** cw721-base's largest page. */
export const CW721_PAGE = 100;
/** NFTs listed per collection, and collections looked at. */
export const MAX_PER_COLLECTION = 500;
export const MAX_COLLECTIONS = 40;
/** NFTs whose metadata (a CW721's on-chain name, every NFT's metadata link) is looked up, per
 *  kind of collection across the account: every one an ordinary account holds. It was 60 per
 *  collection, which left a wallet's 61st NFT on with no link; the cap now only keeps an account
 *  sprayed with junk collections from making the list huge or slow. Past it, an NFT shows as
 *  its ID. */
const MAX_INFO = 2_000;
/** CW721 `nft_info` queries in flight at once. */
const INFO_PARALLEL = 8;
/** EVM collections checked at once: each step is one batch request, and a public endpoint takes
 *  0.3 to 0.6 s to answer one, so a wallet of 8 collections took 15 s one at a time. */
const COLLECTIONS_PARALLEL = 4;

/** `f` over `xs`, at most `n` at a time; the answers in `xs`'s order. */
async function mapLimited<T, R>(xs: readonly T[], n: number, f: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(xs.length);
  let next = 0;
  const worker = async () => {
    while (next < xs.length) {
      const i = next++;
      out[i] = await f(xs[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, xs.length) }, worker));
  return out;
}
/** Transactions read from each index query. */
const INDEX_LOOK = 100;

const CW721_ACTIONS = new Set(["transfer_nft", "send_nft", "mint"]);
const CONTRACT = /^inj1[02-9ac-hj-np-z]{38,58}$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const UINT = /^[0-9]{1,78}$/;

/** A token ID as the wallet will name it: 1 to 256 characters, no control characters. */
export function isTokenId(id: unknown): id is string {
  return typeof id === "string" && id.length > 0 && id.length <= 256 && !/\p{Cc}/u.test(id);
}

/** CW721 collections the tx index says moved an NFT to `owner` or minted one for it. */
export async function cw721Candidates(lcd: Lcd, owner: string): Promise<string[]> {
  const found = new Set<string>();
  const read = (txs: IndexedTx[]) => {
    for (const tx of txs) {
      if (tx.code !== 0) continue;
      for (const e of tx.events) {
        if (e.type !== "wasm") continue;
        const a = new Map(e.attributes.map((x) => [x.key, x.value]));
        const contract = a.get("_contract_address") ?? "";
        if (CW721_ACTIONS.has(a.get("action") ?? "") && (a.get("recipient") === owner || a.get("owner") === owner) && CONTRACT.test(contract)) found.add(contract);
      }
    }
  };
  for (const q of [`wasm.recipient='${owner}'`, `wasm.owner='${owner}'`]) {
    try {
      read((await lcd.searchTxs(q, 1, INDEX_LOOK)).txs);
    } catch (e) {
      // A node whose index can't answer this query isn't a reason to show nothing.
      if (!(e instanceof Down || e instanceof Unreachable || e instanceof ChainError)) throw e;
    }
  }
  return [...found];
}

/** A CW721's name and symbol, or null if `contract` doesn't answer like one. */
export async function cw721Info(lcd: Lcd, contract: string): Promise<{ name: string; symbol: string } | null> {
  const r = await lcd.smart(contract, { contract_info: {} });
  if (!isObject(r) || typeof r["name"] !== "string" || typeof r["symbol"] !== "string") return null;
  return { name: cleanText(r["name"], 40), symbol: cleanText(r["symbol"], 12) };
}

/** The token IDs `owner` holds in a CW721, every page; `more` when the cap cut it short.
 *  Null if the contract doesn't answer `tokens`. */
export async function cw721Tokens(lcd: Lcd, contract: string, owner: string, max = MAX_PER_COLLECTION): Promise<{ ids: string[]; more: boolean } | null> {
  const ids: string[] = [];
  let after: string | undefined;
  for (;;) {
    const r = await lcd.smart(contract, { tokens: { owner, limit: CW721_PAGE, ...(after === undefined ? {} : { start_after: after }) } });
    if (!isObject(r) || !Array.isArray(r["tokens"])) return ids.length ? { ids, more: true } : null;
    const page = (r["tokens"] as unknown[]).filter(isTokenId);
    for (const id of page) {
      if (ids.length >= max) return { ids, more: true };
      if (!ids.includes(id)) ids.push(id);
    }
    // A short page is the last; a page that repeats itself would loop.
    if (page.length < CW721_PAGE || page.at(-1) === after) return { ids, more: false };
    after = page.at(-1);
  }
}

/** What a CW721 says about one NFT: a name from its on-chain metadata, and its URI. */
export async function cw721Nft(lcd: Lcd, contract: string, tokenId: string): Promise<Nft> {
  const r = await lcd.smart(contract, { nft_info: { token_id: tokenId } });
  const uri = isObject(r) && typeof r["token_uri"] === "string" ? safeUri(r["token_uri"]) : null;
  const ext = isObject(r) && isObject(r["extension"]) ? r["extension"] : null;
  const name = ext && typeof ext["name"] === "string" ? cleanText(ext["name"], 60) : "";
  return { tokenId, name, uri };
}

/** A metadata link the wallet may show as text (never loaded): https or ipfs only. */
function safeUri(u: string): string | null {
  const s = u.trim();
  return s.length <= 2048 && /^(https:\/\/|ipfs:\/\/)[^\s]+$/.test(s) ? s : null;
}

/** Every CW721 collection of `owner`'s, from the index and the user's list. */
export async function cw721Collections(lcd: Lcd, owner: string, added: readonly string[]): Promise<NftCollection[]> {
  const candidates = [...new Set([...added.filter((a) => CONTRACT.test(a)), ...(await cw721Candidates(lcd, owner))])].slice(0, MAX_COLLECTIONS);
  const out: NftCollection[] = [];
  let budget = MAX_INFO;
  for (const address of candidates) {
    const info = await cw721Info(lcd, address);
    if (!info) continue;
    const held = await cw721Tokens(lcd, address, owner);
    if (!held || (held.ids.length === 0 && !added.includes(address))) continue;
    const items: Nft[] = held.ids.map((id) => ({ tokenId: id, name: "", uri: null }));
    const look = held.ids.slice(0, budget);
    budget -= look.length;
    for (let i = 0; i < look.length; i += INFO_PARALLEL) {
      const got = await Promise.all(
        look.slice(i, i + INFO_PARALLEL).map((id) =>
          // A token the contract won't describe still shows, by its ID.
          cw721Nft(lcd, address, id).catch((e: unknown) => {
            if (e instanceof ChainError) return { tokenId: id, name: "", uri: null };
            throw e;
          }),
        ),
      );
      got.forEach((n, j) => (items[i + j] = n));
    }
    out.push({ address, standard: "cw721", ...info, items, more: held.more });
  }
  return out;
}

const call = (to: string, data: string) => ({ method: "eth_call", params: [{ to, data }, "latest"] });
const u256 = (n: bigint) => n.toString(16).padStart(64, "0");
/** An ABI `string` return, or "" if it isn't one. */
function abiText(r: unknown, max: number): string {
  if (typeof r !== "string" || !/^0x[0-9a-fA-F]*$/.test(r) || r.length < 130) return "";
  const len = Number(BigInt(`0x${r.slice(66, 130)}`));
  if (len > 4096 || r.length < 130 + 2 * len) return "";
  const bytes = Uint8Array.from(r.slice(130, 130 + 2 * len).match(/../g) ?? [], (h) => parseInt(h, 16));
  return cleanText(new TextDecoder().decode(bytes), max);
}
const ownerOf = (r: unknown) => (typeof r === "string" && /^0x0{24}[0-9a-fA-F]{40}$/.test(r) ? `0x${r.slice(26).toLowerCase()}` : null);

/** ERC721 collections of `owner`'s: tokens Blockscout says came in, checked with `ownerOf`,
 *  and enumerable collections the user added (`tokenOfOwnerByIndex`). */
export async function erc721Collections(rpc: EvmRpc, index: EvmIndex | null, owner: string, added: readonly string[]): Promise<NftCollection[]> {
  const me = owner.toLowerCase();
  const byCollection = new Map<string, Set<string>>();
  for (const a of added) if (EVM_ADDRESS.test(a)) byCollection.set(a.toLowerCase(), new Set());
  if (index) {
    for (const t of await index.nftTransfers(owner)) {
      const c = t.contract.toLowerCase();
      if (!byCollection.has(c) && byCollection.size >= MAX_COLLECTIONS) continue;
      byCollection.set(c, (byCollection.get(c) ?? new Set()).add(t.tokenId));
    }
  }
  let budget = MAX_INFO;
  const found = await mapLimited([...byCollection], COLLECTIONS_PARALLEL, async ([address, named]): Promise<NftCollection | null> => {
    // An added collection that enumerates: what it says this owner holds.
    const [bal, name, symbol] = await rpc.batch([call(address, `0x70a08231${word(owner)}`), call(address, "0x06fdde03"), call(address, "0x95d89b41")]);
    const count = typeof bal === "string" && /^0x[0-9a-fA-F]{1,64}$/.test(bal) ? BigInt(bal) : 0n;
    if (added.some((a) => a.toLowerCase() === address) && count > 0n) {
      const n = Number(count > BigInt(MAX_PER_COLLECTION) ? BigInt(MAX_PER_COLLECTION) : count);
      const r = await rpc.batch(Array.from({ length: n }, (_, i) => call(address, `0x2f745c59${word(owner)}${u256(BigInt(i))}`)));
      for (const x of r) if (typeof x === "string" && /^0x[0-9a-fA-F]{64}$/.test(x)) named.add(BigInt(x).toString());
    }
    const ids = [...named].filter((id) => UINT.test(id)).slice(0, MAX_PER_COLLECTION);
    if (ids.length === 0) return null;
    // Held now: ownerOf says so (Blockscout's history can't).
    const owners = await rpc.batch(ids.map((id) => call(address, `0x6352211e${u256(BigInt(id))}`)));
    const held = ids.filter((_, i) => ownerOf(owners[i]) === me);
    if (held.length === 0) return null;
    const look = held.slice(0, budget);
    budget -= look.length;
    const uris = await rpc.batch(look.map((id) => call(address, `0xc87b56dd${u256(BigInt(id))}`)));
    return {
      address,
      standard: "erc721",
      name: abiText(name, 40),
      symbol: abiText(symbol, 12),
      items: held.map((tokenId, i) => ({ tokenId, name: "", uri: i < uris.length ? safeUri(abiText(uris[i], 2048)) : null })),
      more: count > BigInt(held.length) && count > BigInt(MAX_PER_COLLECTION),
    };
  });
  return found.filter((c): c is NftCollection => c !== null);
}

/** The ERC1155 tokens `owner` holds on an EVM chain: the index names what was ever sent to it,
 *  `balanceOf` says what is held now, `uri` (with its `{id}`) where the metadata is. */
export async function erc1155Collections(rpc: EvmRpc, index: EvmIndex | null, owner: string): Promise<NftCollection[]> {
  if (!index) return [];
  const byCollection = new Map<string, Set<string>>();
  for (const t of await index.nft1155Transfers(owner)) {
    if (!byCollection.has(t.contract) && byCollection.size >= MAX_COLLECTIONS) continue;
    byCollection.set(t.contract, (byCollection.get(t.contract) ?? new Set()).add(t.tokenId));
  }
  let budget = MAX_INFO;
  const found = await mapLimited([...byCollection], COLLECTIONS_PARALLEL, async ([address, named]): Promise<NftCollection | null> => {
    const ids = [...named].filter((id) => UINT.test(id)).slice(0, MAX_PER_COLLECTION);
    const balances = await rpc.batch(ids.map((id) => call(address, `0x00fdd58e${word(owner)}${u256(BigInt(id))}`)));
    const held = ids.flatMap((id, i) => {
      const b = balances[i];
      const n = typeof b === "string" && /^0x[0-9a-fA-F]{1,64}$/.test(b) ? BigInt(b) : 0n;
      return n > 0n ? [{ id, n }] : [];
    });
    if (held.length === 0) return null;
    const look = held.slice(0, budget);
    budget -= look.length;
    const [name, symbol, ...uris] = await rpc.batch([call(address, "0x06fdde03"), call(address, "0x95d89b41"), ...look.map((h) => call(address, `0x0e89341c${u256(BigInt(h.id))}`))]);
    return {
      address,
      standard: "erc1155",
      name: abiText(name, 40),
      symbol: abiText(symbol, 12),
      items: held.map((h, i) => {
        // ERC1155's metadata URI names the token as {id}: 64 lowercase hex digits.
        const raw = i < uris.length ? abiText(uris[i], 2048).replace("{id}", BigInt(h.id).toString(16).padStart(64, "0")) : "";
        return { tokenId: h.id, name: "", uri: raw ? safeUri(raw) : null, amount: h.n.toString() };
      }),
      more: false,
    };
  });
  return found.filter((c): c is NftCollection => c !== null);
}
