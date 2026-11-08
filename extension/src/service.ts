// The service worker's logic, without `chrome.*`, so it runs under test.
//
// - The encrypted keystore and the public account list live in local storage.
// - While unlocked, the unlock key (Argon2id output, opens only this keystore) lives in
//   session storage, which Chrome keeps in memory and clears on browser restart or
//   extension update. Locking deletes it.
// - The vault is stateless: every call that needs a key gets the keystore and unlock key
//   from here. UI pages never see either.

import type { NewSecret, Status, UiRequest, UiResponse } from "./messages";
import type { AccountInfo, Result } from "./vault";

/** A key-value store: `chrome.storage.local` / `.session`, or a map in tests. */
export interface Store {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}

export interface Deps {
  vault<T>(method: string, params?: unknown): Promise<Result<T>>;
  local: Store;
  session: Store;
  /** (Re)start the auto-lock timer. */
  scheduleLock(minutes: number): void;
  cancelLock(): void;
}

/** Minutes without activity before the wallet locks itself. */
export const AUTO_LOCK_MINUTES = 15;

const err = (code: string, message: string): UiResponse<never> => ({ ok: false, error: { code, message } });

export function createService(d: Deps) {
  async function keystore(): Promise<{ keystore?: string; kind?: Status["kind"]; accounts?: AccountInfo[] }> {
    return (await d.local.get(["keystore", "kind", "accounts"])) as never;
  }

  async function unlockKey(): Promise<string | undefined> {
    const { unlock_key } = await d.session.get(["unlock_key"]);
    return typeof unlock_key === "string" ? unlock_key : undefined;
  }

  async function status(): Promise<Status> {
    const ks = await keystore();
    const unlocked = Boolean(ks.keystore) && (await unlockKey()) !== undefined;
    return {
      hasWallet: Boolean(ks.keystore),
      unlocked,
      kind: ks.kind ?? null,
      accounts: unlocked ? (ks.accounts ?? []) : [],
    };
  }

  /** Remember the unlock key and the account list, and start the auto-lock timer. */
  async function opened(keystoreHex: string, kind: NonNullable<Status["kind"]>, key: string): Promise<UiResponse<Status>> {
    const account = kind === "mnemonic" ? { derivation: "default", index: 0 } : { derivation: "imported" };
    const r = await d.vault<{ accounts: AccountInfo[] }>("accounts", {
      keystore: keystoreHex,
      unlock_key: key,
      accounts: [account],
    });
    if (!r.ok) return r;
    await d.session.set({ unlock_key: key });
    await d.local.set({ accounts: r.result.accounts });
    d.scheduleLock(AUTO_LOCK_MINUTES);
    return { ok: true, result: await status() };
  }

  async function create(secret: NewSecret, password: string): Promise<UiResponse<Status>> {
    if ((await keystore()).keystore) return err("exists", "A wallet already exists on this device.");
    const made = await d.vault<{ keystore: string; kind: "mnemonic" | "private_key" }>("create_keystore", { secret, password });
    if (!made.ok) return made;
    const unlocked = await d.vault<{ unlock_key: string }>("unlock", { keystore: made.result.keystore, password });
    if (!unlocked.ok) return unlocked;
    await d.local.set({ keystore: made.result.keystore, kind: made.result.kind });
    return opened(made.result.keystore, made.result.kind, unlocked.result.unlock_key);
  }

  async function unlock(password: string): Promise<UiResponse<Status>> {
    const ks = await keystore();
    if (!ks.keystore || !ks.kind) return err("no_wallet", "There is no wallet on this device yet.");
    const r = await d.vault<{ unlock_key: string }>("unlock", { keystore: ks.keystore, password });
    if (!r.ok) return r;
    return opened(ks.keystore, ks.kind, r.result.unlock_key);
  }

  async function lock(): Promise<UiResponse<Status>> {
    await d.session.remove(["unlock_key"]);
    d.cancelLock();
    return { ok: true, result: await status() };
  }

  /** Handle one request from an extension page. */
  async function handle(req: unknown): Promise<UiResponse> {
    const r = req as UiRequest;
    switch (r?.type) {
      case "status": {
        const s = await status();
        if (s.unlocked) d.scheduleLock(AUTO_LOCK_MINUTES);
        return { ok: true, result: s };
      }
      case "generate":
        return d.vault("generate_mnemonic", { words: r.words });
      case "create":
        return create(r.secret, r.password);
      case "unlock":
        return unlock(r.password);
      case "lock":
        return lock();
      default:
        return err("bad_request", "Unknown request.");
    }
  }

  return { handle, lock, status };
}

/** Whether a message comes from one of this extension's own pages: never a web page or a
 *  content script, whose sender is the page it runs in. */
export function fromOwnPage(sender: { id?: string; origin?: string; url?: string }, extensionId: string): boolean {
  const origin = `chrome-extension://${extensionId}`;
  return sender.id === extensionId && sender.origin === origin && (sender.url ?? "").startsWith(`${origin}/`);
}
