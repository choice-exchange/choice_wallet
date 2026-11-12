// The content script that carries a page's requests to the worker, on a stand-in window and
// extension API.

import assert from "node:assert/strict";
import { test } from "node:test";

type Listener = (e: { source: unknown; data: unknown }) => void;

// Hardening: an oversized request was refused only in the worker, after the browser had
// copied it there.
test("the relay refuses an oversized request before it reaches the worker", async () => {
  const listeners: Listener[] = [];
  const posted: { id?: number; error?: { code: number } }[] = [];
  const sent: unknown[] = [];
  const win = { addEventListener: (_: string, f: Listener) => void listeners.push(f), postMessage: (m: never) => void posted.push(m) };
  Object.assign(globalThis, {
    window: win,
    chrome: { runtime: { id: "x", sendMessage: async (m: unknown) => (sent.push(m), { result: "0x6f0" }), onMessage: { addListener() {} } } },
  });
  await import("../src/relay");
  const ask = (id: number, method: string, params?: unknown) => listeners[0]!({ source: win, data: { target: "choice-wallet:relay", id, method, params } });

  ask(1, "personal_sign", ["0x" + "00".repeat(600_000), "0x0"]);
  ask(2, "eth_chainId");
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(sent, [{ method: "eth_chainId", params: undefined }]);
  assert.deepEqual(
    posted.map((m) => [m.id, m.error?.code]),
    [
      [1, -32602],
      [2, undefined],
    ],
  );
});
