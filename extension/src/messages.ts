// Messages between the extension's own pages (popup, later the approval window) and the
// service worker. Web pages and content scripts can't send these: the service worker only
// accepts them from its own extension pages.

import type { AccountInfo, Result } from "./vault";

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

export type UiResponse<T = unknown> = Result<T>;
