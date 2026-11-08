// The toolbar popup (and a site's approval window, `popup.html?approve=<id>`): the shared
// UI, talking to this extension's service worker.

import { mount, type Backend } from "@choice-wallet/ui";

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
};

const approve = new URLSearchParams(location.search).get("approve");
mount(document.getElementById("root"), backend, approve && /^[0-9a-f]{32}$/.test(approve) ? { approve } : {});
