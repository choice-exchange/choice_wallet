// Choice Wallet's UI, shared by every platform. A platform renders it with `mount` and its
// own Backend, and adds the CSS that fixes its window size (if any).

/// <reference path="./css.d.ts" />
import "./styles.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { BackendContext, type Backend } from "./backend";

export type { Backend } from "./backend";

/** Render the wallet UI into `root`. */
export function mount(root: HTMLElement | null, backend: Backend): void {
  if (!root) throw new Error("mount: no root element");
  createRoot(root).render(
    <StrictMode>
      <BackendContext value={backend}>
        <App />
      </BackendContext>
    </StrictMode>,
  );
}
