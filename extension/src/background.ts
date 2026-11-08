// Service worker: hosts the vault (Rust compiled to WASM) and answers the extension's own
// pages. Listeners are registered synchronously, as MV3 requires; requests wait for the
// WASM module inside the handler, since top-level await isn't allowed in service workers.

import init, { handle } from "choice-wallet-vault-glue";

import { createService, fromOwnPage, type Store } from "./service";
import { callVault } from "./vault";

const ready = init({ module_or_path: chrome.runtime.getURL("vault/choice_wallet_wasm_bg.wasm") });
const AUTO_LOCK = "auto-lock";

function store(area: chrome.storage.StorageArea): Store {
  return {
    get: (keys) => area.get(keys),
    set: (items) => area.set(items),
    remove: (keys) => area.remove(keys),
  };
}

const service = createService({
  async vault(method, params) {
    await ready;
    return callVault(handle, method, params);
  },
  local: store(chrome.storage.local),
  session: store(chrome.storage.session),
  scheduleLock(minutes) {
    void chrome.alarms.create(AUTO_LOCK, { delayInMinutes: minutes });
  },
  cancelLock() {
    void chrome.alarms.clear(AUTO_LOCK);
  },
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!fromOwnPage(sender, chrome.runtime.id)) return false;
  service.handle(message).then(sendResponse, (e: unknown) =>
    sendResponse({ ok: false, error: { code: "internal", message: String(e) } }),
  );
  return true; // respond asynchronously
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AUTO_LOCK) void service.lock();
});
