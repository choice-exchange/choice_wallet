// The UI's only way out. Each platform passes its own Backend to `mount`: the extension's
// talks to its service worker, the desktop app's will call its Rust side. Nothing in this
// package may use `chrome.*` or any other platform API directly (its tsconfig loads no
// platform types, so the type check fails if one creeps in).

import { createContext, useContext } from "react";

import type { Reply, Result, UiRequest } from "./protocol";

export interface Backend {
  /** Ask the host. Rejects only if the host can't be reached. */
  send<R extends UiRequest>(request: R): Promise<Result<Reply<R>>>;
  /** Put text on the clipboard. */
  copy(text: string): Promise<void>;
  /** Open an https link (a block explorer) outside the wallet. */
  openLink(url: string): void;
}

export const BackendContext = createContext<Backend | null>(null);

export function useBackend(): Backend {
  const b = useContext(BackendContext);
  if (!b) throw new Error("no Backend: render the UI through mount()");
  return b;
}
