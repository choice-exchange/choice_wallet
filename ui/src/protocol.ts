// The contract between the UI and its host: what the UI may ask for and what comes back.
// Every host answers these: the extension's service worker now, the desktop app's Rust
// side later. The UI never sees the keystore or the unlock key, only what's below.

/** The vault's and the host's error shape. */
export type HostError = { code: string; message: string };
export type Result<T> = { ok: true; result: T } | { ok: false; error: HostError };

/** An account as the vault's `accounts` lists it. */
export type AccountInfo = {
  account: { derivation: "default" | "ledger_live"; index: number } | { derivation: "imported" };
  public_key: string;
  /** Address per CAIP-2 chain ID. */
  addresses: Record<string, string>;
};

export type NewSecret = { mnemonic: string } | { private_key: string };

export type UiRequest =
  | { type: "status" }
  | { type: "generate"; words: 12 | 24 }
  | { type: "create"; secret: NewSecret; password: string }
  | { type: "unlock"; password: string }
  | { type: "lock" };

export type Status = {
  hasWallet: boolean;
  unlocked: boolean;
  kind: "mnemonic" | "private_key" | null;
  /** Only while unlocked. */
  accounts: AccountInfo[];
};

/** What each request returns. */
export type Replies = {
  status: Status;
  generate: { phrase: string };
  create: Status;
  unlock: Status;
  lock: Status;
};

export type Reply<R extends UiRequest> = Replies[R["type"]];
