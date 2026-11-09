// Choice Wallet's UI, shared by every platform. A platform renders it with `mount` and its
// own Backend, and adds the CSS that fixes its window size (if any).

/// <reference path="./assets.d.ts" />
import "./styles.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { ApproveView } from "./Approve";
import { BackendContext, type Backend } from "./backend";
import { LedgerAddView } from "./Ledger";

export type { Backend, LedgerHost, LedgerStep } from "./backend";

/** Render the wallet UI into `root`: the wallet, or (with `approve`) the approval window
 *  for that site request, or (with `ledger`) the page that adds a Ledger's accounts. */
export function mount(root: HTMLElement | null, backend: Backend, opts: { approve?: string; ledger?: boolean } = {}): void {
  if (!root) throw new Error("mount: no root element");
  createRoot(root).render(
    <StrictMode>
      <BackendContext value={backend}>{opts.approve ? <ApproveView id={opts.approve} /> : opts.ledger ? <LedgerAddView /> : <App />}</BackendContext>
    </StrictMode>,
  );
}
