// Content script, in the extension's isolated world: carries a page's requests (from
// ./inpage.ts) to the service worker, and the worker's "something changed" back. It adds
// nothing to a request: the worker learns the page's origin from the browser, and only the
// top frame of a tab gets this script.

import { MAX_REQUEST } from "./limits";

const TO_RELAY = "choice-wallet:relay";
const TO_PAGE = "choice-wallet:page";

type Reply = { result?: unknown; error?: { code: number; message: string } };

const gone = { code: 4900, message: "Choice Wallet isn't available here. Reload the page." };

window.addEventListener("message", (e: MessageEvent) => {
  // Only this window's own messages: never a frame's, never another window's.
  if (e.source !== window || typeof e.data !== "object" || e.data === null) return;
  const { target, id, method, params } = e.data as { target?: unknown; id?: unknown; method?: unknown; params?: unknown };
  if (target !== TO_RELAY || typeof id !== "number" || typeof method !== "string") return;
  const answer = (r: Reply) => window.postMessage({ target: TO_PAGE, id, ...("error" in r && r.error ? { error: r.error } : { result: r.result }) }, "/");
  // Too large is refused here, before the browser copies it into the worker.
  let size: number;
  try {
    size = JSON.stringify({ method, params }).length;
  } catch {
    return answer({ error: { code: -32602, message: "The request can't be read." } });
  }
  if (size > MAX_REQUEST) return answer({ error: { code: -32602, message: "Request too large." } });
  try {
    chrome.runtime.sendMessage({ method, params }).then(
      (r: Reply | undefined) => answer(r ?? { error: gone }),
      () => answer({ error: gone }),
    );
  } catch {
    // The extension was reloaded or removed under this page.
    answer({ error: gone });
  }
});

chrome.runtime.onMessage.addListener((message: unknown, sender) => {
  if (sender.id === chrome.runtime.id && typeof message === "object" && message !== null && (message as { choice?: unknown }).choice === "changed") {
    window.postMessage({ target: TO_PAGE, event: "changed" }, "/");
  }
});
