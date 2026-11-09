// The address book: recipients the user saved, in local storage with the rest of the
// wallet. The vault's `addresses` checks each one (an Injective account) and gives both
// its forms. With the user's own accounts, the book goes into every send's risk context:
// a recipient from it is named, one that only looks like it (address poisoning) is flagged,
// and a saved memo has to be on the send.
//
// Exchanges credit deposits to a shared address by their memo. Besides memos saved here,
// the wallet reads the recipient's latest deposits on the user's endpoint before a send
// (`takesMemos`): if most carry a memo, from many senders, a send without one is red.

import { DEPOSITS_LOOKED_AT, NETWORKS, takesMemos, cleanText, type Lcd, type NetworkId } from "@choice-wallet/chain";
import type { AccountInfo, Contact, RecipientCheck, Result } from "@choice-wallet/ui/protocol";

import type { Store } from "./service";
import { isWatch } from "./wallets";

export const MAX_CONTACTS = 200;
/** Injective's `max_memo_characters` (256 on mainnet and testnet, 2026-11-09). The chain
 *  counts bytes. */
export const MAX_MEMO_BYTES = 256;
const MAX_NAME = 40;
/** How long a recipient's deposit pattern is believed. */
const MEMO_CACHE_MS = 10 * 60_000;
/** A deposit check the endpoint doesn't answer in this long is left out of the review. */
const MEMO_CHECK_MS = 4000;

const fail = (code: string, message: string): Result<never> => ({ ok: false, error: { code, message } });

/** What the risk rules take: `Contact` and `memo_addresses` in `choice-wallet-policy`. */
export type RiskFacts = { address_book: { address: string; name: string; memo?: string; mine?: true; rescue?: true }[]; memo_addresses: string[] };

export interface ContactDeps {
  vault<T>(method: string, params?: unknown): Promise<Result<T>>;
  local: Store;
  lcd(network: NetworkId): Promise<Lcd>;
  /** The user's own accounts. */
  accounts(): Promise<AccountInfo[]>;
  /** The rescue address set for the account in use (inj1), if any. */
  rescue?(): Promise<string | null>;
}

/** A memo as the user typed it: trimmed, with no control characters, short enough for the chain. */
export function memoFrom(v: unknown): string | null {
  if (v === undefined) return "";
  if (typeof v !== "string") return null;
  const m = v.trim();
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(m) || new TextEncoder().encode(m).length > MAX_MEMO_BYTES) return null;
  return m;
}

function wellFormed(c: unknown): c is Contact {
  const x = c as Record<string, unknown> | null;
  return (
    typeof x === "object" &&
    x !== null &&
    ["id", "name", "address", "evm", "memo"].every((k) => typeof x[k] === "string") &&
    /^[0-9a-f]{16}$/.test(x["id"] as string)
  );
}

export function createContacts(d: ContactDeps) {
  async function list(): Promise<Contact[]> {
    const { address_book } = await d.local.get(["address_book"]);
    return Array.isArray(address_book) ? address_book.filter(wellFormed) : [];
  }

  /** Both forms of an Injective account address, or null if it isn't one. */
  async function forms(address: unknown): Promise<{ inj: string; evm: string } | null> {
    if (typeof address !== "string" || address.length > 128) return null;
    const r = await d.vault<{ addresses: Record<string, string> }>("addresses", { address });
    if (!r.ok) return null;
    const inj = r.result.addresses[NETWORKS.mainnet.cosmos];
    const evm = r.result.addresses[NETWORKS.mainnet.evm];
    return inj && evm ? { inj, evm: evm.toLowerCase() } : null;
  }

  /** The user's account at this address (one the wallet signs for), by name. */
  async function mine(inj: string): Promise<string | undefined> {
    return (await d.accounts()).find((a) => !isWatch(a) && Object.values(a.addresses).includes(inj))?.name;
  }

  async function save(req: { id?: unknown; name?: unknown; address?: unknown; memo?: unknown }): Promise<Result<Contact[]>> {
    const name = typeof req.name === "string" ? cleanText(req.name, MAX_NAME + 1) : "";
    if (!name) return fail("bad_request", "Give it a name.");
    if (name.length > MAX_NAME) return fail("bad_request", `Names are at most ${MAX_NAME} characters.`);
    const memo = memoFrom(req.memo);
    if (memo === null) return fail("bad_request", `A memo is at most ${MAX_MEMO_BYTES} characters, on one line.`);
    const f = await forms(req.address);
    if (!f) return fail("invalid_address", "That isn't an Injective address (inj1… or 0x…).");
    const own = await mine(f.inj);
    if (own) return fail("already_saved", `That's your account ${own}.`);
    const all = await list();
    const editing = req.id === undefined ? null : all.find((c) => c.id === req.id);
    if (req.id !== undefined && !editing) return fail("not_found", "That contact is gone.");
    const twin = all.find((c) => c.address === f.inj && c.id !== editing?.id);
    if (twin) return fail("already_saved", `Already saved as ${twin.name}.`);
    if (!editing && all.length >= MAX_CONTACTS) return fail("too_many", `At most ${MAX_CONTACTS} contacts.`);
    const contact: Contact = { id: editing?.id ?? newId(), name, address: f.inj, evm: f.evm, memo };
    const next = editing ? all.map((c) => (c.id === editing.id ? contact : c)) : [...all, contact];
    next.sort((a, b) => a.name.localeCompare(b.name));
    await d.local.set({ address_book: next });
    return { ok: true, result: next };
  }

  async function remove(id: unknown): Promise<Result<Contact[]>> {
    const all = await list();
    const next = all.filter((c) => c.id !== id);
    if (next.length === all.length) return fail("not_found", "That contact is gone.");
    await d.local.set({ address_book: next });
    return { ok: true, result: next };
  }

  const memoCache = new Map<string, { at: number; value: boolean }>();
  /** Whether an address's latest deposits mostly carry a memo. False when the endpoint
   *  can't say in time: the review then goes on without the fact. */
  async function takesMemo(network: NetworkId, inj: string): Promise<boolean> {
    const key = `${network} ${inj}`;
    const hit = memoCache.get(key);
    if (hit && Date.now() - hit.at < MEMO_CACHE_MS) return hit.value;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const txs = await Promise.race([
        (await d.lcd(network)).received(inj, DEPOSITS_LOOKED_AT),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), MEMO_CHECK_MS);
        }),
      ]);
      if (txs === null) return false;
      const value = takesMemos(txs, inj);
      memoCache.set(key, { at: Date.now(), value });
      return value;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /** What the send form shows about a recipient before the review. */
  async function check(network: NetworkId, to: unknown): Promise<Result<RecipientCheck>> {
    const f = await forms(typeof to === "string" ? to.trim() : to);
    if (!f) return { ok: true, result: { takesMemo: false } };
    const own = await mine(f.inj);
    if (own) return { ok: true, result: { mine: own, takesMemo: false } };
    const contact = (await list()).find((c) => c.address === f.inj);
    if (contact?.memo) return { ok: true, result: { contact, takesMemo: true } };
    return { ok: true, result: { ...(contact ? { contact } : {}), takesMemo: await takesMemo(network, f.inj) } };
  }

  /** The address book and the user's accounts for the risk rules, and whether `recipient`
   *  (if any) takes deposits with a memo. */
  async function facts(network: NetworkId, recipient: string | null): Promise<RiskFacts> {
    const net = NETWORKS[network];
    const address_book: RiskFacts["address_book"] = (await list()).map((c) => ({ address: c.address, name: c.name, ...(c.memo ? { memo: c.memo } : {}) }));
    // Accounts this wallet can sign for are the user's; a watched one is named like a contact.
    for (const a of await d.accounts()) {
      const addr = a.addresses[net.cosmos];
      if (addr) address_book.push({ address: addr, name: a.name, ...(isWatch(a) ? {} : { mine: true as const }) });
      // Its Solana address, a key of its own (from the same phrase).
      const sol = a.addresses[net.solana.caip2];
      if (sol) address_book.push({ address: sol, name: a.name, ...(isWatch(a) ? {} : { mine: true as const }) });
    }
    // The rescue address: the user's, even when it isn't an account here.
    const rescue = await d.rescue?.();
    if (rescue) {
      const known = address_book.find((c) => c.address === rescue);
      if (known) known.rescue = true;
      else address_book.push({ address: rescue, name: "", rescue: true });
    }
    const memo_addresses: string[] = [];
    if (recipient) {
      const f = await forms(recipient);
      const settled = f && address_book.some((c) => c.address === f.inj && (c.mine || c.memo));
      if (f && !settled && (await takesMemo(network, f.inj))) memo_addresses.push(f.inj);
    }
    return { address_book, memo_addresses };
  }

  return { list, save, remove, check, facts };
}

function newId(): string {
  const b = crypto.getRandomValues(new Uint8Array(8));
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}
