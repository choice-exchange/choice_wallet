// Dev builds only: the real service worker, plus a DEV badge on the toolbar icon and the
// reopening of a wallet tab that a dev reload closed (see ./page.ts).

import "../background";

void chrome.action.setBadgeText({ text: "DEV" });
void chrome.action.setBadgeBackgroundColor({ color: "#fdc70c" });

chrome.runtime.onInstalled.addListener(() => {
  void chrome.storage.local.get(["dev_reopen"]).then(({ dev_reopen }) => {
    if (typeof dev_reopen !== "string" || !dev_reopen.startsWith(chrome.runtime.getURL(""))) return;
    void chrome.storage.local.remove(["dev_reopen"]);
    void chrome.tabs.create({ url: dev_reopen });
  });
});
