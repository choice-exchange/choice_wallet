// EVM transactions as the Cosmos side indexes them. On Injective an EVM transaction is a
// Cosmos transaction holding one `MsgEthereumTx`, so the same tx index that serves the
// rest of Activity has them, from the user's own endpoints:
//
// - the message carries the signed transaction itself (`raw`, 0x hex) and its sender
//   (`from`, base64 bytes), so the call is read from what was signed, failed or not;
// - the result (`tx_response.data`, a protobuf `TxMsgData`) holds a
//   `MsgEthereumTxResponse` with the EVM hash and the logs, where ERC20 transfers live;
// - a transaction that reverted has a nonzero code and no result, and its EVM hash is in
//   the log line (`{"tx_hash":"0x…",…}`).
//
// Shapes recorded 2026-11-09 from both networks' LCDs.

export const EVM_MSG = "/injective.evm.v1.MsgEthereumTx";
const EVM_RESPONSE = "/injective.evm.v1.MsgEthereumTxResponse";

/** keccak256("Transfer(address,address,uint256)") and ("Approval(address,address,uint256)"). */
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const APPROVAL = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";

export interface EvmLog {
  /** The contract that emitted it, lowercase. */
  address: string;
  /** Lowercase 0x words. */
  topics: string[];
  /** 0x hex. */
  data: string;
}

/** What an EVM transaction asked for, from its signed bytes. */
export interface EvmCall {
  /** The signer, lowercase. */
  from: string;
  /** Lowercase; null for a contract creation. */
  to: string | null;
  value: bigint;
  /** Calldata, 0x hex. */
  input: string;
}

export type Erc20Event =
  | { kind: "transfer"; token: string; from: string; to: string; amount: bigint }
  | { kind: "approval"; token: string; owner: string; spender: string; amount: bigint };

const hexOf = (b: Uint8Array) => `0x${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}`;
function bytesOf(hex: string): Uint8Array | null {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(h)) return null;
  return Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
}
const toInt = (b: Uint8Array) => (b.length === 0 ? 0n : BigInt(hexOf(b)));

// -- protobuf, just enough to read the result --

type Field = { n: number; varint?: bigint; bytes?: Uint8Array };

/** A message's fields in order; throws on anything malformed. */
function fields(b: Uint8Array): Field[] {
  const out: Field[] = [];
  let i = 0;
  const varint = (): bigint => {
    let x = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      if (i >= b.length) throw new RangeError("truncated varint");
      const c = b[i++]!;
      x |= BigInt(c & 0x7f) << shift;
      if (!(c & 0x80)) return x;
    }
    throw new RangeError("varint too long");
  };
  while (i < b.length) {
    const key = varint();
    const n = Number(key >> 3n);
    const wire = Number(key & 7n);
    if (wire === 0) out.push({ n, varint: varint() });
    else if (wire === 2) {
      const len = Number(varint());
      if (i + len > b.length) throw new RangeError("truncated field");
      out.push({ n, bytes: b.subarray(i, i + len) });
      i += len;
    } else if (wire === 1) i += 8;
    else if (wire === 5) i += 4;
    else throw new RangeError(`wire type ${wire}`);
    if (i > b.length) throw new RangeError("truncated field");
  }
  return out;
}
const text = (b: Uint8Array | undefined) => (b ? new TextDecoder().decode(b) : "");

/** The EVM results in a transaction's `data`: its hash and logs. Empty for anything else,
 *  or if `data` doesn't read as a `TxMsgData`. */
export function evmResults(dataHex: string): { hash: string; logs: EvmLog[] }[] {
  const b = bytesOf(dataHex);
  if (!b || b.length === 0) return [];
  try {
    const out: { hash: string; logs: EvmLog[] }[] = [];
    for (const f of fields(b)) {
      // TxMsgData: msg_responses (2) are Anys; the older data (1) is MsgData {msg_type, data}.
      if (!f.bytes || (f.n !== 1 && f.n !== 2)) continue;
      const any = fields(f.bytes);
      const type = text(any.find((x) => x.n === 1)?.bytes);
      const value = any.find((x) => x.n === 2)?.bytes;
      if (!value || (type !== EVM_RESPONSE && type !== EVM_MSG)) continue;
      let hash = "";
      const logs: EvmLog[] = [];
      for (const g of fields(value)) {
        if (g.n === 1) hash = text(g.bytes).toLowerCase();
        if (g.n === 2 && g.bytes) {
          const log = fields(g.bytes);
          const address = text(log.find((x) => x.n === 1)?.bytes).toLowerCase();
          const topics = log.filter((x) => x.n === 2).map((x) => text(x.bytes).toLowerCase());
          const data = hexOf(log.find((x) => x.n === 3)?.bytes ?? new Uint8Array());
          if (/^0x[0-9a-f]{40}$/.test(address) && topics.every((t) => /^0x[0-9a-f]{64}$/.test(t))) logs.push({ address, topics, data });
        }
      }
      if (/^0x[0-9a-f]{64}$/.test(hash)) out.push({ hash, logs });
    }
    return out;
  } catch {
    return [];
  }
}

// -- RLP, just enough to read a signed transaction --

type Rlp = Uint8Array | Rlp[];

function rlp(b: Uint8Array): Rlp {
  const [item, end] = rlpAt(b, 0);
  if (end !== b.length) throw new RangeError("trailing bytes");
  return item;
}
function rlpAt(b: Uint8Array, i: number): [Rlp, number] {
  if (i >= b.length) throw new RangeError("truncated");
  const p = b[i]!;
  const len = (at: number, n: number) => {
    if (n > 4 || at + n > b.length) throw new RangeError("bad length");
    return Number(toInt(b.subarray(at, at + n)));
  };
  if (p < 0x80) return [b.subarray(i, i + 1), i + 1];
  if (p < 0xb8) return slice(b, i + 1, p - 0x80);
  if (p < 0xc0) {
    const n = p - 0xb7;
    return slice(b, i + 1 + n, len(i + 1, n));
  }
  const [start, size] = p < 0xf8 ? [i + 1, p - 0xc0] : [i + 1 + (p - 0xf7), len(i + 1, p - 0xf7)];
  const end = start + size;
  if (end > b.length) throw new RangeError("truncated list");
  const items: Rlp[] = [];
  let j = start;
  while (j < end) {
    const [x, next] = rlpAt(b, j);
    items.push(x);
    j = next;
  }
  if (j !== end) throw new RangeError("bad list");
  return [items, end];
}
function slice(b: Uint8Array, at: number, n: number): [Rlp, number] {
  if (at + n > b.length) throw new RangeError("truncated string");
  return [b.subarray(at, at + n), at + n];
}

/** The call a `MsgEthereumTx` (as the LCD shows it) signed, or null if it doesn't read as
 *  one. Legacy, EIP-2930 and EIP-1559 transactions; nothing else runs on Injective. */
export function evmCall(message: Record<string, unknown>): EvmCall | null {
  if (message["@type"] !== EVM_MSG || typeof message["raw"] !== "string" || typeof message["from"] !== "string") return null;
  const raw = bytesOf(message["raw"]);
  let from: string;
  try {
    from = hexOf(Uint8Array.from(atob(message["from"]), (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
  if (!raw || raw.length === 0 || !/^0x[0-9a-f]{40}$/.test(from)) return null;
  try {
    const type = raw[0]! < 0x7f ? raw[0]! : null;
    if (type !== null && type !== 1 && type !== 2) return null;
    const list = rlp(type === null ? raw : raw.subarray(1));
    if (!Array.isArray(list)) return null;
    // [nonce, gasPrice, gas, to, value, data, …]; typed ones start with chainId, and 1559
    // has two fee fields where the others have one.
    const at = type === null ? 3 : type === 1 ? 4 : 5;
    const [to, value, input] = [list[at], list[at + 1], list[at + 2]];
    if (!(to instanceof Uint8Array) || !(value instanceof Uint8Array) || !(input instanceof Uint8Array)) return null;
    if (to.length !== 0 && to.length !== 20) return null;
    return { from, to: to.length === 0 ? null : hexOf(to), value: toInt(value), input: hexOf(input) };
  } catch {
    return null;
  }
}

/** A reverted transaction's EVM hash, from its log line. */
export function failedEvmHash(rawLog: string): string | null {
  const m = /"tx_hash":"(0x[0-9a-fA-F]{64})"/.exec(rawLog);
  return m ? m[1]!.toLowerCase() : null;
}

/** An ERC20 `Transfer` or `Approval`, or null for any other log (an ERC721 `Transfer` has
 *  a third indexed topic and no data, so it isn't read as one). */
export function erc20Event(log: EvmLog): Erc20Event | null {
  if (log.topics.length !== 3 || !/^0x[0-9a-f]{64}$/.test(log.data)) return null;
  const addr = (t: string) => (/^0x0{24}[0-9a-f]{40}$/.test(t) ? `0x${t.slice(26)}` : null);
  const a = addr(log.topics[1]!);
  const b = addr(log.topics[2]!);
  if (!a || !b) return null;
  const amount = BigInt(log.data);
  if (log.topics[0] === TRANSFER) return { kind: "transfer", token: log.address, from: a, to: b, amount };
  if (log.topics[0] === APPROVAL) return { kind: "approval", token: log.address, owner: a, spender: b, amount };
  return null;
}

/** An ERC20 `transfer(to, amount)` call's recipient, from calldata. */
export function transferRecipient(input: string): string | null {
  const m = /^0xa9059cbb0{24}([0-9a-f]{40})[0-9a-f]{64}$/.exec(input.toLowerCase());
  return m ? `0x${m[1]}` : null;
}
