// A Ledger over WebHID, through Ledger's Device Management Kit, for the wallet's pages: the
// popup, approval windows and the Ledger tab. The service worker never loads it.
//
// - Cosmos transactions go through Ledger's Cosmos app (its signer kit): amino JSON with the
//   `inj` prefix. Under coin type 60 the app hashes with keccak256 and derives Ethereum-style
//   addresses, as Injective does, and it signs there only in Expert mode.
// - EVM transactions and `personal_sign` messages go through the Ethereum app, with its two
//   signing APDUs written here (SIGN_TX 0x04, SIGN_PERSONAL_MESSAGE 0x08). Ledger's Ethereum
//   signer kit isn't used: it brings ethers and a context module that sends each transaction
//   to Ledger's servers for display data, which Injective EVM isn't in anyway, so a contract
//   call is blind-signed either way.
// - Solana transactions go through the Solana app, also written here (GET_PUBKEY 0x05,
//   SIGN_MESSAGE 0x06): a key per account at Ledger Live's `m/44'/501'/n'`, and its
//   signature over the transaction's message.
//
// Nothing here is trusted: the vault checks every signature against the account's key and
// the exact bytes it decoded, and drops anything else.

import {
  DeviceActionStatus,
  DeviceManagementKitBuilder,
  OpenAppDeviceAction,
  UserInteractionRequired,
  type DeviceManagementKit,
  type DeviceSessionId,
  type DiscoveredDevice,
} from "@ledgerhq/device-management-kit";
import { SignerCosmosBuilder } from "@ledgerhq/device-signer-kit-cosmos";
import { webHidIdentifier, webHidTransportFactory } from "@ledgerhq/device-transport-kit-web-hid";
import type { LedgerHost, LedgerStep } from "@choice-wallet/ui";
import type { DeviceRequest, DeviceSignature } from "@choice-wallet/ui/protocol";
import { filter, firstValueFrom, timeout, type Observable, type Subscription } from "rxjs";

const HRP = "inj";
/** Data bytes in one APDU. */
const CHUNK = 255;
/** How long to look for an already paired device before saying it isn't there. */
const FIND_MS = 4000;

/** Something the user can act on: a locked device, the wrong app, a setting to change. */
export class LedgerError extends Error {}

/** Status words, as Ledger's apps and OS answer them, in words. */
const STATUS: Record<string, string> = {
  "6985": "Rejected on the Ledger.",
  "6986": "Rejected on the Ledger.",
  "5501": "Rejected on the Ledger.",
  "5515": "Unlock your Ledger, then try again.",
  "6984": "The Ledger's Cosmos app refused it. In its settings, turn on Expert mode: Injective needs it.",
  "6a80": "In the Ledger's Ethereum app settings, turn on Blind signing, then try again.",
  "6807": "Install the app on the Ledger with Ledger Live first.",
  "6d00": "Open the right app on the Ledger.",
  "6e00": "Open the right app on the Ledger.",
  "6e01": "Open the right app on the Ledger.",
  "6511": "Open the right app on the Ledger.",
};

/** The Solana app's own answers, where they differ from the table above. */
const SOLANA_STATUS: Record<string, string> = {
  "6808": "In the Ledger's Solana app settings, turn on Blind signing, then try again.",
  "6a80": "The Ledger's Solana app couldn't read this. Update it with Ledger Live, then try again.",
  "6a81": "The Ledger's Solana app couldn't read this. Update it with Ledger Live, then try again.",
  "6a82": "The Ledger's Solana app couldn't read this. Update it with Ledger Live, then try again.",
  "6a83": "The Ledger's Solana app couldn't read this. Update it with Ledger Live, then try again.",
};
/** The Solana app's chunk flags: more chunks follow; this one continues the last. */
const P2_MORE = 0x02;
const P2_EXTEND = 0x01;

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
function bytes(h: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/i.test(h)) throw new LedgerError("Not hex.");
  return Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
}

/** The kit wants paths without `m/`. Only Injective's coin type, five levels. */
function kitPath(path: string): string {
  const m = /^m\/(44'\/60'\/\d+'\/\d+\/\d+)$/.exec(path);
  if (!m) throw new LedgerError(`Not an Injective path: ${path}`);
  return m[1]!;
}

/** `[count][u32 big-endian]…`, as the Ethereum and Solana apps read a path. */
function serialPath(parts: string[]): Uint8Array {
  const out = new Uint8Array(1 + 4 * parts.length);
  out[0] = parts.length;
  const view = new DataView(out.buffer);
  parts.forEach((p, i) => view.setUint32(1 + 4 * i, (parseInt(p, 10) | (p.endsWith("'") ? 0x80000000 : 0)) >>> 0));
  return out;
}

const ethPath = (path: string) => serialPath(kitPath(path).split("/"));

/** A Solana account's path: Ledger Live's `m/44'/501'/n'`. */
const isSolanaPath = (path: string) => /^m\/44'\/501'\/\d{1,9}'$/.test(path);
function solanaPath(path: string): Uint8Array {
  if (!isSolanaPath(path)) throw new LedgerError(`Not a Solana path: ${path}`);
  return serialPath(path.slice(2).split("/"));
}

/** A thrown or returned DMK error, in words. */
function deviceError(e: unknown): LedgerError {
  if (e instanceof LedgerError) return e;
  const seen = new Set<unknown>();
  const find = (x: unknown): string | null => {
    if (!x || typeof x !== "object" || seen.has(x)) return null;
    seen.add(x);
    const o = x as Record<string, unknown>;
    for (const k of ["errorCode", "statusCode"]) {
      const v = o[k];
      if (typeof v === "string" && /^[0-9a-f]{4}$/i.test(v)) return v.toLowerCase();
      if (v instanceof Uint8Array && v.length === 2) return hex(v);
    }
    const tag = typeof o["_tag"] === "string" ? o["_tag"] : "";
    if (/Locked/i.test(tag)) return "5515";
    if (/Refused|Rejected/i.test(tag)) return "6985";
    for (const k of ["error", "originalError", "cause"]) {
      const v = find(o[k]);
      if (v) return v;
    }
    return null;
  };
  const code = find(e);
  if (code && STATUS[code]) return new LedgerError(STATUS[code]);
  const msg = e instanceof Error ? e.message : typeof e === "object" && e && "message" in e ? String((e as { message: unknown }).message) : String(e);
  if (/NotFoundError|No device selected/i.test(msg)) return new LedgerError("No Ledger was picked.");
  return new LedgerError(code ? `The Ledger answered ${code}.` : `The Ledger didn't answer: ${msg}`);
}

function stepOf(i: unknown): LedgerStep {
  switch (i) {
    case UserInteractionRequired.UnlockDevice:
      return "unlock";
    case UserInteractionRequired.ConfirmOpenApp:
      return "open_app";
    case UserInteractionRequired.SignTransaction:
    case UserInteractionRequired.SignPersonalMessage:
    case UserInteractionRequired.VerifyAddress:
      return "confirm";
    default:
      return "working";
  }
}

type Action<T> = {
  observable: Observable<
    | { status: DeviceActionStatus.Pending; intermediateValue: { requiredUserInteraction: unknown } }
    | { status: DeviceActionStatus.Completed; output: T }
    | { status: DeviceActionStatus.Error; error: unknown }
    | { status: DeviceActionStatus.Stopped }
    | { status: DeviceActionStatus.NotStarted }
  >;
};

/** A device action's output, reporting what the device waits for along the way. */
function run<T>(action: Action<T>, onStep?: (s: LedgerStep) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let sub: Subscription | undefined;
    let done = false;
    const finish = (settle: () => void) => {
      if (done) return;
      done = true;
      settle();
      sub?.unsubscribe();
    };
    sub = action.observable.subscribe({
      next(s) {
        if (s.status === DeviceActionStatus.Pending) {
          if (!done) onStep?.(stepOf(s.intermediateValue?.requiredUserInteraction));
        } else if (s.status === DeviceActionStatus.Completed) finish(() => resolve(s.output));
        else if (s.status === DeviceActionStatus.Error) finish(() => reject(deviceError(s.error)));
        else if (s.status === DeviceActionStatus.Stopped) finish(() => reject(new LedgerError("Stopped.")));
      },
      error: (e: unknown) => finish(() => reject(deviceError(e))),
    });
    // It may have finished before `subscribe` returned.
    if (done) sub.unsubscribe();
  });
}

export function createLedger(): LedgerHost {
  let dmk: DeviceManagementKit | null = null;
  let session: DeviceSessionId | null = null;
  let app: "cosmos" | "ethereum" | "solana" | null = null;

  const kit = () => (dmk ??= new DeviceManagementKitBuilder().addTransport(webHidTransportFactory).build());

  async function open(device: DiscoveredDevice): Promise<DeviceSessionId> {
    session = await kit().connect({ device, sessionRefresherOptions: { isRefresherDisabled: true } });
    app = null;
    return session;
  }

  /** A session with the device: the open one, else a paired device the browser lets this
   *  page see (no chooser outside a click). */
  async function connect(onStep?: (s: LedgerStep) => void): Promise<DeviceSessionId> {
    const k = kit();
    if (session && k.listConnectedDevices().some((d) => d.sessionId === session)) return session;
    session = null;
    onStep?.("connect");
    let list: DiscoveredDevice[];
    try {
      list = await firstValueFrom(
        k.listenToAvailableDevices({ transport: webHidIdentifier }).pipe(
          filter((l) => l.length > 0),
          timeout({ first: FIND_MS }),
        ),
      );
    } catch {
      throw new LedgerError("Connect your Ledger and unlock it. If it's new to this browser, add it from Accounts first.");
    }
    return open(list[0]!);
  }

  async function cosmos(onStep?: (s: LedgerStep) => void) {
    const sessionId = await connect(onStep);
    const skipOpenApp = app === "cosmos";
    app = "cosmos";
    return { signer: new SignerCosmosBuilder({ dmk: kit(), sessionId }).build(), skipOpenApp };
  }

  async function apdu(sessionId: DeviceSessionId, data: Uint8Array, status?: Record<string, string>): Promise<Uint8Array> {
    const r = await kit().sendApdu({ sessionId, apdu: data });
    const sw = hex(r.statusCode);
    if (sw === "9000") return r.data;
    const said = status?.[sw];
    throw said ? new LedgerError(said) : deviceError({ errorCode: sw });
  }

  /** A session with `name` open on the device (asking to open it unless it already is). */
  async function openApp(name: "Ethereum" | "Solana", onStep?: (s: LedgerStep) => void): Promise<DeviceSessionId> {
    const sessionId = await connect(onStep);
    const id = name === "Ethereum" ? "ethereum" : "solana";
    if (app !== id) {
      await run(kit().executeDeviceAction({ sessionId, deviceAction: new OpenAppDeviceAction({ input: { appName: name } }) }) as Action<unknown>, onStep);
      app = id;
    }
    return sessionId;
  }

  /** One Solana app instruction, its data in chunks: every chunk but the last says more
   *  follow, every one but the first that it continues. `onLast` runs before the last. */
  async function solanaCall(sessionId: DeviceSessionId, ins: number, p1: number, data: Uint8Array, onLast?: () => void): Promise<Uint8Array> {
    let p2 = 0;
    for (let at = 0; ; ) {
      const chunk = data.subarray(at, at + CHUNK);
      at += chunk.length;
      const more = at < data.length;
      if (!more) onLast?.();
      const a = new Uint8Array(5 + chunk.length);
      a.set([0xe0, ins, p1, p2 | (more ? P2_MORE : 0), chunk.length]);
      a.set(chunk, 5);
      const out = await apdu(sessionId, a, SOLANA_STATUS);
      if (!more) return out;
      p2 |= P2_EXTEND;
    }
  }

  /** GET_PUBKEY on the Solana app: the account's 32-byte key; `confirm` shows its address on
   *  the device and waits for the user. */
  async function solanaKey(sessionId: DeviceSessionId, path: string, confirm: boolean, onStep?: (s: LedgerStep) => void): Promise<string> {
    const out = await solanaCall(sessionId, 0x05, confirm ? 0x01 : 0x00, solanaPath(path), confirm ? () => onStep?.("confirm") : undefined);
    if (out.length !== 32) throw new LedgerError("The Ledger's answer wasn't a Solana key.");
    return hex(out);
  }

  /** SIGN_MESSAGE on the Solana app: one signer's path, then the transaction's message; its
   *  64-byte signature comes back. */
  async function solana(req: DeviceRequest, onStep?: (s: LedgerStep) => void): Promise<DeviceSignature> {
    if (req.kind !== "transaction") throw new LedgerError("The Ledger's Solana app signs transactions only here.");
    const sessionId = await openApp("Solana", onStep);
    const path = solanaPath(req.path);
    const message = bytes(req.payload);
    const data = new Uint8Array(1 + path.length + message.length);
    data[0] = 1;
    data.set(path, 1);
    data.set(message, 1 + path.length);
    const out = await solanaCall(sessionId, 0x06, 0x01, data, () => onStep?.("confirm"));
    if (out.length !== 64) throw new LedgerError("The Ledger's answer wasn't a signature.");
    return { signature: hex(out), format: "rs" };
  }

  /** SIGN_TX or SIGN_PERSONAL_MESSAGE on the Ethereum app: `v || r || s` comes back. */
  async function ethereum(req: DeviceRequest, onStep?: (s: LedgerStep) => void): Promise<DeviceSignature> {
    const sessionId = await openApp("Ethereum", onStep);
    const payload = bytes(req.payload);
    const path = ethPath(req.path);
    const ins = req.kind === "message" ? 0x08 : 0x04;
    const head = new Uint8Array(path.length + (ins === 0x08 ? 4 : 0));
    head.set(path);
    if (ins === 0x08) new DataView(head.buffer).setUint32(path.length, payload.length);
    const data = new Uint8Array(head.length + payload.length);
    data.set(head);
    data.set(payload, head.length);
    let out: Uint8Array = new Uint8Array();
    for (let i = 0; i < data.length; i += CHUNK) {
      const chunk = data.subarray(i, i + CHUNK);
      if (i + CHUNK >= data.length) onStep?.("confirm");
      const a = new Uint8Array(5 + chunk.length);
      a.set([0xe0, ins, i === 0 ? 0x00 : 0x80, 0x00, chunk.length]);
      a.set(chunk, 5);
      out = await apdu(sessionId, a);
    }
    if (out.length !== 65) throw new LedgerError("The Ledger's answer wasn't a signature.");
    return { signature: hex(out.subarray(1)), format: "rs" };
  }

  return {
    async pair() {
      const k = kit();
      let device: DiscoveredDevice;
      try {
        device = await firstValueFrom(k.startDiscovering({ transport: webHidIdentifier }));
      } catch (e) {
        throw deviceError(e);
      } finally {
        void k.stopDiscovering();
      }
      await open(device);
    },
    async publicKeys(paths, onStep) {
      const out: { path: string; public_key: string; address: string }[] = [];
      for (const path of paths) {
        const { signer, skipOpenApp } = await cosmos(onStep);
        const r = await run(signer.getAddress(kitPath(path), HRP, { checkOnDevice: false, skipOpenApp: skipOpenApp || out.length > 0 }) as Action<{ publicKey: Uint8Array; address: string }>, onStep);
        out.push({ path, public_key: hex(r.publicKey), address: r.address });
      }
      return out;
    },
    async solanaKeys(paths, onStep) {
      const out: { path: string; public_key: string }[] = [];
      const sessionId = await openApp("Solana", onStep);
      onStep?.("working");
      for (const path of paths) out.push({ path, public_key: await solanaKey(sessionId, path, false) });
      return out;
    },
    async show(path, onStep) {
      if (isSolanaPath(path)) {
        await solanaKey(await openApp("Solana", onStep), path, true, onStep);
        return;
      }
      const { signer, skipOpenApp } = await cosmos(onStep);
      await run(signer.getAddress(kitPath(path), HRP, { checkOnDevice: true, skipOpenApp }) as Action<unknown>, onStep);
    },
    async sign(req, onStep) {
      if (req.app === "ethereum") return ethereum(req, onStep);
      if (req.app === "solana") return solana(req, onStep);
      const { signer, skipOpenApp } = await cosmos(onStep);
      const sig = await run(signer.signTransaction(kitPath(req.path), HRP, bytes(req.payload), { skipOpenApp }) as Action<Uint8Array>, (s) => onStep?.(s === "working" ? "confirm" : s));
      return { signature: hex(sig), format: "der" };
    },
  };
}
