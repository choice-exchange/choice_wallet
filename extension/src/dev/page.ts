// Dev builds only (`npm run dev`; never in dist/). Polls the build stamp: a new UI reloads
// this page; a new service worker, vault or manifest reloads the whole extension, which
// closes this page, so a page open in a tab asks the worker to reopen it.

const STAMP = chrome.runtime.getURL("dev-build.json");
let last: { page: string; worker: string } | null = null;

setInterval(() => {
  void (async () => {
    try {
      const now = (await (await fetch(STAMP, { cache: "no-store" })).json()) as { page: string; worker: string };
      if (last && now.worker !== last.worker) {
        if (await chrome.tabs.getCurrent()) await chrome.storage.local.set({ dev_reopen: location.href });
        chrome.runtime.reload();
      } else if (last && now.page !== last.page) {
        location.reload();
      }
      last = now;
    } catch {
      // Mid-build: try again next tick.
    }
  })();
}, 1000);
