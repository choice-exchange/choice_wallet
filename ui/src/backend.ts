// The UI's only way out. Each platform passes its own Backend to `mount`: the extension's
// talks to its service worker, the desktop app's will call its Rust side. Nothing in this
// package may use `chrome.*` or any other platform API directly (its tsconfig loads no
// platform types, so the type check fails if one creeps in).

import { createContext, useContext } from "react";

import type { DeviceRequest, DeviceSignature, Reply, Result, UiRequest } from "./protocol";

/** Where a Ledger operation is waiting, for the screen to say what to do. */
export type LedgerStep = "connect" | "unlock" | "open_app" | "confirm" | "working";

/** A Ledger, on platforms that can reach one. Its keys never leave it: the host asks for
 *  public keys and signatures, and the vault checks every signature it returns. */
export interface LedgerHost {
  /** Ask for the device (the browser's chooser; needs a click, in a tab). */
  pair(): Promise<void>;
  /** Public keys for these paths, from the Cosmos app, without showing them. */
  publicKeys(paths: string[], onStep?: (s: LedgerStep) => void): Promise<{ path: string; public_key: string; address: string }[]>;
  /** Show the address at `path` on the device, to compare with the screen. */
  show(path: string, onStep?: (s: LedgerStep) => void): Promise<void>;
  /** Sign what the vault gave, on the device. */
  sign(req: DeviceRequest, onStep?: (s: LedgerStep) => void): Promise<DeviceSignature>;
}

export interface Backend {
  /** Ask the host. Rejects only if the host can't be reached. */
  send<R extends UiRequest>(request: R): Promise<Result<Reply<R>>>;
  /** Put text on the clipboard. */
  copy(text: string): Promise<void>;
  /** Open an https link (a block explorer) outside the wallet. */
  openLink(url: string): void;
  /** A Ledger, where the platform can reach one. */
  ledger?: LedgerHost;
  /** Open the wallet's Ledger screen where pairing works (the extension: a tab, since the
   *  device chooser closes a popup). */
  openLedgerPage?(): void;
}

export const BackendContext = createContext<Backend | null>(null);

export function useBackend(): Backend {
  const b = useContext(BackendContext);
  if (!b) throw new Error("no Backend: render the UI through mount()");
  return b;
}
