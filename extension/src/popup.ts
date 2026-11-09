// The toolbar popup (and a site's approval window, `popup.html?approve=<id>`): the shared
// UI, talking to this extension's service worker.

import { mount, type Backend, type LedgerHost } from "@choice-wallet/ui";

// The Ledger kit is most of this page's code, and most users never plug one in: it loads
// (a separate file, ./ledger.ts and its packages) the first time a Ledger is asked for.
let ledger: Promise<LedgerHost> | null = null;
const device = () => (ledger ??= import("./ledger").then((m) => m.createLedger()));
const lazyLedger: LedgerHost = {
  pair: async () => (await device()).pair(),
  publicKeys: async (paths, onStep) => (await device()).publicKeys(paths, onStep),
  show: async (path, onStep) => (await device()).show(path, onStep),
  sign: async (req, onStep) => (await device()).sign(req, onStep),
};

const backend: Backend = {
  send(request) {
    return chrome.runtime.sendMessage(request);
  },
  copy(text) {
    return navigator.clipboard.writeText(text);
  },
  openLink(url) {
    if (url.startsWith("https://")) void chrome.tabs.create({ url });
  },
  // WebHID reaches a Ledger from the wallet's pages; picking one needs a tab, since the
  // browser's device chooser closes the popup.
  ...("hid" in navigator ? { ledger: lazyLedger } : {}),
  openLedgerPage() {
    void chrome.tabs.create({ url: chrome.runtime.getURL("popup.html?ledger=add") });
  },
  onRefresh(listener) {
    const on = (message: unknown, sender: chrome.runtime.MessageSender) => {
      if (sender.id === chrome.runtime.id && (message as { choice?: unknown } | null)?.choice === "refresh") listener();
    };
    chrome.runtime.onMessage.addListener(on);
    return () => chrome.runtime.onMessage.removeListener(on);
  },
};

const params = new URLSearchParams(location.search);
const approve = params.get("approve");
mount(
  document.getElementById("root"),
  backend,
  approve && /^[0-9a-f]{32}$/.test(approve) ? { approve } : params.get("ledger") === "add" ? { ledger: true } : {},
);
