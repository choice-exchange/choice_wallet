// Choice Wallet's UI, shared by every platform. A platform renders it with `mount` and its
// own Backend, and adds the CSS that fixes its window size (if any).

/// <reference path="./assets.d.ts" />
import "./styles.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { ApproveView } from "./Approve";
import { BackendContext, type Backend } from "./backend";

export type { Backend } from "./backend";

/** Render the wallet UI into `root`: the wallet, or (with `approve`) the approval window
 *  for that site request. */
export function mount(root: HTMLElement | null, backend: Backend, opts: { approve?: string } = {}): void {
  if (!root) throw new Error("mount: no root element");
  createRoot(root).render(
    <StrictMode>
      <BackendContext value={backend}>{opts.approve ? <ApproveView id={opts.approve} /> : <App />}</BackendContext>
    </StrictMode>,
  );
}
