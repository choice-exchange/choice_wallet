// The toolbar popup (and a site's approval window, `popup.html?approve=<id>`): the shared
// UI, talking to this extension's service worker.

import { mount, type Backend } from "@choice-wallet/ui";

import { createLedger } from "./ledger";

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
  ...("hid" in navigator ? { ledger: createLedger() } : {}),
  openLedgerPage() {
    void chrome.tabs.create({ url: chrome.runtime.getURL("popup.html?ledger=add") });
  },
};

const params = new URLSearchParams(location.search);
const approve = params.get("approve");
mount(
  document.getElementById("root"),
  backend,
  approve && /^[0-9a-f]{32}$/.test(approve) ? { approve } : params.get("ledger") === "add" ? { ledger: true } : {},
);
