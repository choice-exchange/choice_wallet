// Service worker: hosts the vault (Rust compiled to WASM), answers the extension's own
// pages, and answers web pages through the content script (./relay.ts), each by the origin
// the browser reports. Listeners are registered synchronously, as MV3 requires; requests
// wait for the WASM module inside the handler, since top-level await isn't allowed in
// service workers.
//
// The worker also wakes once a minute for the background watcher (./host/watch.ts), when
// notifications are on. Most wakes need no key, so the vault's WASM is compiled only when
// a request first calls it.

import init, { handle, resetVault } from "choice-wallet-vault-glue";
import { bytesToBase64, explorerTxUrl, imageSize, isNetworkId, LOGO_SIDE, MAX_IMAGE_SIDE, NETWORKS } from "@choice-wallet/chain";

import { createService, dappOrigin, fromOwnPage, type Store } from "./host/service";
import { callVault } from "./host/vault";
import { MAX_REQUEST } from "./limits";
import { notifyConnected } from "./notify";

// Content scripts never read the wallet's storage (the vault, sealed secrets, grants,
// endpoints): only the extension's own pages and this worker.
void chrome.storage.local.setAccessLevel({ accessLevel: chrome.storage.AccessLevel.TRUSTED_CONTEXTS }).catch(() => {});

let ready: Promise<unknown> | null = null;
const vaultReady = () => (ready ??= init({ module_or_path: chrome.runtime.getURL("vault/choice_wallet_wasm_bg.wasm") }));
const AUTO_LOCK = "auto-lock";
const WATCH = "watch";
const CLEAR_CLIPBOARD = "clear-clipboard";
/** The approval window: the popup's own size, plus the window's frame. */
const APPROVAL = { width: 376, height: 668 };

function store(area: chrome.storage.StorageArea): Store {
  return {
    get: (keys) => area.get(keys),
    set: (items) => area.set(items),
    remove: (keys) => area.remove(keys),
    keys: async () => Object.keys(await area.get(null)),
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
    try {
      return callVault(handle, method, params);
    } catch (e) {
      // A trap: that instance may be broken for good. The next call gets a fresh one.
      if (e instanceof WebAssembly.RuntimeError) {
        resetVault();
        ready = null;
      }
      throw e;
    }
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
  notify(also) {
    // Pages ask again for what they may see; nothing about other sites goes out. Only
    // connected sites' tabs (and `also`, a site just disconnected) are told (./notify.ts).
    void notifyConnected(
      {
        connected: async () => Object.keys(((await chrome.storage.local.get(["connections"])) as { connections?: Record<string, unknown> }).connections ?? {}),
        tabs: async () => (await chrome.tabs.query({})).flatMap((t) => (t.id === undefined ? [] : [t.id])),
        originOf: async (tab) => {
          const o: unknown = await chrome.tabs.sendMessage(tab, { choice: "origin" }, { frameId: 0 });
          return typeof o === "string" ? o : null;
        },
        tell: (tab) => void chrome.tabs.sendMessage(tab, { choice: "changed" }, { frameId: 0 }).catch(() => {}),
      },
      also,
    ).catch(() => {});
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
  resizeImage,
  clearClipboardLater() {
    // An alarm, not a timer: it fires though this worker sleeps, and the popup that copied
    // the key is gone by then.
    void chrome.alarms.create(CLEAR_CLIPBOARD, { delayInMinutes: 0.5 });
  },
});

/** Take whatever is on the clipboard off it, through an offscreen page (./clear.ts): a worker
 *  has no clipboard. The page says when it's done, then it's closed. */
async function clearClipboard() {
  // One a worker left open, stopped mid-clear, goes first.
  await chrome.offscreen.closeDocument().catch(() => {});
  let on: ((message: unknown, sender: chrome.runtime.MessageSender) => void) | undefined;
  const done = new Promise<void>((resolve) => {
    on = (message, sender) => {
      if (fromOwnPage(sender, chrome.runtime.id) && (message as { choice?: unknown } | null)?.choice === "clipboard_cleared") resolve();
    };
    chrome.runtime.onMessage.addListener(on);
    setTimeout(resolve, 5_000);
  });
  try {
    await chrome.offscreen.createDocument({ url: "clear.html", reasons: [chrome.offscreen.Reason.CLIPBOARD], justification: "Take a copied private key off the clipboard." });
    await done;
  } catch {
    // Offscreen pages refused: nothing more to do here.
  } finally {
    if (on) chrome.runtime.onMessage.removeListener(on);
  }
  await chrome.offscreen.closeDocument().catch(() => {});
}

/** An added chain's logo, drawn 64 pixels square and kept as a PNG: small to store, and only
 *  pixels (whatever the image came as). Only a PNG, JPEG or WebP whose header declares a
 *  sane size is decoded (run-2 NV1); the caller checks this too. */
async function resizeImage(bytes: Uint8Array): Promise<string | null> {
  try {
    const head = imageSize(bytes);
    if (!head || head.width > MAX_IMAGE_SIDE || head.height > MAX_IMAGE_SIDE) return null;
    const size = LOGO_SIDE;
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: head.type }), { resizeWidth: size, resizeHeight: size, resizeQuality: "high" });
    const canvas = new OffscreenCanvas(size, size);
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, size, size);
    bitmap.close();
    const png = new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
    return `data:image/png;base64,${bytesToBase64(png)}`;
  } catch {
    return null;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // The clipboard page's word that it's done, for clearClipboard's own listener.
  if ((message as { choice?: unknown } | null)?.choice === "clipboard_cleared") return false;
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
  if (alarm.name === CLEAR_CLIPBOARD) void clearClipboard();
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
