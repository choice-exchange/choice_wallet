// What the site handlers share (./index.ts puts them together): the page's answers and
// error codes, the host, a waiting request, and the encodings pages send.

import { base64ToBytes, bytesToHex, type NetworkId } from "@choice-wallet/chain";
import type { AccountInfo, DappRequest, DappReview, DeviceRequest, Result } from "@choice-wallet/ui/protocol";

import type { createSender } from "../send";
import type { Store } from "../service";
import type { createSolana } from "../solana";

export type Sender = ReturnType<typeof createSender>;

/** An answer to the page: EIP-1193's shape. */
export type DappReply = { result: unknown } | { error: { code: number; message: string } };

// EIP-1193 and JSON-RPC error codes.
export const USER_REJECTED = 4001;
export const UNAUTHORIZED = 4100;
export const UNSUPPORTED = 4200;
export const CHAIN_DISCONNECTED = 4901;
export const UNRECOGNIZED_CHAIN = 4902;
export const INVALID_PARAMS = -32602;
export const INTERNAL = -32603;
export const PENDING = -32002;

export const no = (code: number, message: string): DappReply => ({ error: { code, message } });

/** The most data `signArbitrary` signs (the vault's own limit). */
export const MAX_ARBITRARY = 64 * 1024;

export interface DappHost {
  vault<T>(method: string, params?: unknown): Promise<Result<T>>;
  local: Store;
  sender: Sender;
  solana: ReturnType<typeof createSolana>;
  network(): Promise<NetworkId>;
  setNetwork(n: NetworkId): Promise<void>;
  /** The account in use, its wallet's sealed secret and ID, and the unlock key, while
   *  unlocked and it can sign; else null. */
  unlocked(): Promise<{ account: AccountInfo; secret: string; wallet: string; key: string } | null>;
  /** Open the approval window for request `id`; its window ID, to notice it closing. */
  openWindow(id: string): Promise<number | undefined>;
  /** Tell every page that its view (accounts, chain) may have changed. */
  notify(): void;
}

export type Prepared = { request: unknown; digest: string; confirm: string | null; blocked: boolean };

export interface Waiting {
  req: DappRequest;
  resolve: (r: DappReply) => void;
  windowId?: number;
  /** connect and switch: what approving does, and the page's answer. */
  approve?: () => Promise<DappReply>;
  /** sign: build the vault request (fresh, at review time). `tokens` and `context` replace
   *  what the review would read from Injective (a Solana transaction's own). */
  build?: (account: AccountInfo) => Promise<{
    request: unknown;
    checkedBy?: string;
    simulation?: DappReview["simulation"];
    tokens?: DappReview["tokens"];
    context?: Record<string, unknown>;
  }>;
  /** sign: what to hand the page once signed. */
  finish?: (signed: Record<string, unknown>) => Promise<unknown>;
  /** sign, on a Ledger: what the device was handed, waiting for its signature. */
  device?: { request: DeviceRequest; publicKey: string };
  prepared?: Prepared;
}

export type Grants = Record<string, { since: number; approvals?: number }>;

export const quantity = (n: bigint) => `0x${n.toString(16)}`;
export const bytesHex = (s: string) => /^(0x)?([0-9a-fA-F]{2})*$/.test(s);
export const b64 = (hex: string) => {
  let bin = "";
  for (let i = 0; i < hex.length; i += 2) bin += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  return btoa(bin);
};
/** Base64 to hex, or null if it isn't base64. */
export const fromB64 = (s: unknown): string | null => {
  if (typeof s !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4 !== 0) return null;
  return bytesToHex(base64ToBytes(s));
};

/** What a chain's handler uses from the shared part. */
export interface SiteCore {
  h: DappHost;
  isConnected(origin: string): Promise<boolean>;
  /** Connect (asking the user if need be), then answer with `then`. */
  connect(origin: string, then: () => Promise<DappReply>): Promise<DappReply>;
  ask(w: Omit<Waiting, "req" | "resolve">, req: Omit<DappRequest, "id">): Promise<DappReply>;
  sign(origin: string, method: string, build: NonNullable<Waiting["build"]>, finish: NonNullable<Waiting["finish"]>): Promise<DappReply>;
  disconnect(origin: unknown): Promise<unknown>;
}
