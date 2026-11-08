// Service worker: hosts the vault (Rust compiled to WASM), answers the extension's own
// pages, and answers web pages through the content script (./relay.ts), each by the origin
// the browser reports. Listeners are registered synchronously, as MV3 requires; requests
// wait for the WASM module inside the handler, since top-level await isn't allowed in
// service workers.

import init, { handle } from "choice-wallet-vault-glue";

import { createService, dappOrigin, fromOwnPage, type Store } from "./service";
import { callVault } from "./vault";

const ready = init({ module_or_path: chrome.runtime.getURL("vault/choice_wallet_wasm_bg.wasm") });
const AUTO_LOCK = "auto-lock";
/** The approval window: the popup's own size, plus the window's frame. */
const APPROVAL = { width: 376, height: 668 };
/** A page's request, as JSON, at most this long. */
const MAX_REQUEST = 1_000_000;

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
  fetch: (input, init) => fetch(input, init),
  scheduleLock(minutes) {
    void chrome.alarms.create(AUTO_LOCK, { delayInMinutes: minutes });
  },
  cancelLock() {
    void chrome.alarms.clear(AUTO_LOCK);
  },
  async openWindow(id) {
    // Top right of the window the user is in, like the toolbar popup.
    const near = await chrome.windows.getLastFocused().catch(() => undefined);
    const place =
      near?.left !== undefined && near.top !== undefined && near.width !== undefined
        ? { left: Math.max(0, near.left + near.width - APPROVAL.width - 16), top: near.top + 72 }
        : {};
    const w = await chrome.windows.create({ url: chrome.runtime.getURL(`popup.html?approve=${id}`), type: "popup", focused: true, ...APPROVAL, ...place });
    return w?.id;
  },
  notify() {
    // Pages ask again for what they may see; nothing about other sites goes out.
    void chrome.tabs.query({}).then((tabs) => {
      for (const t of tabs) if (t.id !== undefined) chrome.tabs.sendMessage(t.id, { choice: "changed" }).catch(() => {});
    });
  },
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (fromOwnPage(sender, chrome.runtime.id)) {
    service.handle(message).then(sendResponse, (e: unknown) =>
      sendResponse({ ok: false, error: { code: "internal", message: String(e) } }),
    );
    return true; // respond asynchronously
  }
  const origin = dappOrigin(sender, chrome.runtime.id);
  if (!origin) return false;
  if (JSON.stringify(message ?? null).length > MAX_REQUEST) {
    sendResponse({ error: { code: -32602, message: "Request too large." } });
    return false;
  }
  service.dapp(origin, message).then(sendResponse, (e: unknown) => sendResponse({ error: { code: -32603, message: String(e) } }));
  return true;
});

chrome.windows.onRemoved.addListener((windowId) => service.windowClosed(windowId));

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AUTO_LOCK) void service.lock();
});
