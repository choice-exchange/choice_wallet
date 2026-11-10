// Service worker: hosts the vault (Rust compiled to WASM), answers the extension's own
// pages, and answers web pages through the content script (./relay.ts), each by the origin
// the browser reports. Listeners are registered synchronously, as MV3 requires; requests
// wait for the WASM module inside the handler, since top-level await isn't allowed in
// service workers.
//
// The worker also wakes once a minute for the background watcher (./host/watch.ts), when
// notifications are on. Most wakes need no key, so the vault's WASM is compiled only when
// a request first calls it.

import init, { handle } from "choice-wallet-vault-glue";
import { explorerTxUrl, isNetworkId, NETWORKS } from "@choice-wallet/chain";

import { createService, dappOrigin, fromOwnPage, type Store } from "./host/service";
import { callVault } from "./host/vault";

let ready: Promise<unknown> | null = null;
const vaultReady = () => (ready ??= init({ module_or_path: chrome.runtime.getURL("vault/choice_wallet_wasm_bg.wasm") }));
const AUTO_LOCK = "auto-lock";
const WATCH = "watch";
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

/** Whether the toolbar popup is open: it shows what happens itself. */
async function popupOpen(): Promise<boolean> {
  try {
    return (await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.POPUP] })).length > 0;
  } catch {
    return false;
  }
}

function scheduleWatch(on: boolean) {
  if (on) void chrome.alarms.create(WATCH, { periodInMinutes: 1, delayInMinutes: 1 });
  else void chrome.alarms.clear(WATCH);
}

const service = createService({
  async vault(method, params) {
    await vaultReady();
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
  refresh() {
    // The wallet's own pages only (no listener open is fine).
    chrome.runtime.sendMessage({ choice: "refresh" }).catch(() => {});
  },
  async showNotice(n) {
    if (await popupOpen()) return false;
    try {
      await chrome.notifications.create(n.id, { type: "basic", iconUrl: chrome.runtime.getURL("icons/icon-128.png"), title: n.title, message: n.message, priority: 0 });
      return true;
    } catch {
      return false; // notifications blocked for the browser, say
    }
  },
  badge(text) {
    void chrome.action.setBadgeText({ text });
    if (text) void chrome.action.setBadgeBackgroundColor({ color: "#fdc70c" });
  },
  scheduleWatch,
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
  if (alarm.name === WATCH) void service.watch();
});

// The watcher's alarm, as the setting says (alarms can be lost with the browser's profile
// or on an update; this puts it back on every start of the worker).
void service.watching().then(async (on) => {
  const have = await chrome.alarms.get(WATCH);
  if (on && !have) scheduleWatch(true);
  if (!on && have) scheduleWatch(false);
});

// A notification opens the wallet; where the browser can't open the popup from here, the
// transaction on the explorer instead.
chrome.notifications.onClicked.addListener((id) => {
  void chrome.notifications.clear(id);
  void (async () => {
    try {
      const w = await chrome.windows.getLastFocused();
      if (w.id !== undefined) await chrome.windows.update(w.id, { focused: true });
      await chrome.action.openPopup(w.id !== undefined ? { windowId: w.id } : undefined);
    } catch {
      const [net, hash] = id.split("|");
      if (isNetworkId(net) && hash && /^(0x)?[0-9a-fA-F]{64}$/.test(hash)) void chrome.tabs.create({ url: explorerTxUrl(NETWORKS[net], hash) });
    }
  })();
});
