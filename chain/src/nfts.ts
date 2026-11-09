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

export type NftStandard = "cw721" | "erc721";
export type Nft = { tokenId: string; name: string; uri: string | null };
export type NftCollection = {
  /** `inj1…` (CW721) or checksumless lowercase `0x…` (ERC721). */
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
/** Metadata looked up per collection (names): the rest show as their IDs. */
const MAX_INFO = 60;
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
  for (const address of candidates) {
    const info = await cw721Info(lcd, address);
    if (!info) continue;
    const held = await cw721Tokens(lcd, address, owner);
    if (!held || (held.ids.length === 0 && !added.includes(address))) continue;
    const items: Nft[] = [];
    for (const [i, id] of held.ids.entries()) items.push(i < MAX_INFO ? await cw721Nft(lcd, address, id) : { tokenId: id, name: "", uri: null });
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
  const out: NftCollection[] = [];
  for (const [address, named] of byCollection) {
    // An added collection that enumerates: what it says this owner holds.
    const [bal, name, symbol] = await rpc.batch([call(address, `0x70a08231${word(owner)}`), call(address, "0x06fdde03"), call(address, "0x95d89b41")]);
    const count = typeof bal === "string" && /^0x[0-9a-fA-F]{1,64}$/.test(bal) ? BigInt(bal) : 0n;
    if (added.some((a) => a.toLowerCase() === address) && count > 0n) {
      const n = Number(count > BigInt(MAX_PER_COLLECTION) ? BigInt(MAX_PER_COLLECTION) : count);
      const r = await rpc.batch(Array.from({ length: n }, (_, i) => call(address, `0x2f745c59${word(owner)}${u256(BigInt(i))}`)));
      for (const x of r) if (typeof x === "string" && /^0x[0-9a-fA-F]{64}$/.test(x)) named.add(BigInt(x).toString());
    }
    const ids = [...named].filter((id) => UINT.test(id)).slice(0, MAX_PER_COLLECTION);
    if (ids.length === 0) continue;
    // Held now: ownerOf says so (Blockscout's history can't).
    const owners = await rpc.batch(ids.map((id) => call(address, `0x6352211e${u256(BigInt(id))}`)));
    const held = ids.filter((_, i) => ownerOf(owners[i]) === me);
    if (held.length === 0) continue;
    const uris = await rpc.batch(held.slice(0, MAX_INFO).map((id) => call(address, `0xc87b56dd${u256(BigInt(id))}`)));
    out.push({
      address,
      standard: "erc721",
      name: abiText(name, 40),
      symbol: abiText(symbol, 12),
      items: held.map((tokenId, i) => ({ tokenId, name: "", uri: i < uris.length ? safeUri(abiText(uris[i], 2048)) : null })),
      more: count > BigInt(held.length) && count > BigInt(MAX_PER_COLLECTION),
    });
  }
  return out;
}
