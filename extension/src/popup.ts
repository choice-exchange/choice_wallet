// The toolbar popup: the shared UI, talking to this extension's service worker.

import { mount, type Backend } from "@choice-wallet/ui";

const backend: Backend = {
  send(request) {
    return chrome.runtime.sendMessage(request);
  },
  copy(text) {
    return navigator.clipboard.writeText(text);
  },
};

mount(document.getElementById("root"), backend);
