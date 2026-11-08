// EVM transactions as Injective's LCD returns them (shapes recorded 2026-11-09 on both
// networks), built here from parts: the signed transaction (RLP, `raw` as 0x hex), the
// sender (`from`, base64), and the result (`data`, a protobuf TxMsgData holding a
// MsgEthereumTxResponse with the logs). Shared by the chain and extension tests.

const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const APPROVAL = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";
export const EVM_MSG = "/injective.evm.v1.MsgEthereumTx";

const enc = new TextEncoder();
const hexBytes = (h: string) => Uint8Array.from((h.replace(/^0x/, "").match(/../g) ?? []), (x) => parseInt(x, 16));
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) {
    out.set(p, i);
    i += p.length;
  }
  return out;
};
const intBytes = (n: bigint) => (n === 0n ? new Uint8Array() : hexBytes(n.toString(16).padStart(Math.ceil(n.toString(16).length / 2) * 2, "0")));
export const word = (a: string) => `0x${a.replace(/^0x/, "").toLowerCase().padStart(64, "0")}`;

// -- protobuf --
function varint(n: bigint): Uint8Array {
  const out: number[] = [];
  do {
    let b = Number(n & 0x7fn);
    n >>= 7n;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return Uint8Array.from(out);
}
const pbBytes = (field: number, b: Uint8Array) => cat(varint(BigInt((field << 3) | 2)), varint(BigInt(b.length)), b);
const pbInt = (field: number, n: bigint) => cat(varint(BigInt(field << 3)), varint(n));

export type Log = { address: string; topics: string[]; data: string };

/** `tx_response.data` (hex) for an EVM transaction that ran. */
export function resultData(hash: string, logs: Log[], height = 1n): string {
  const encLog = (l: Log) =>
    cat(pbBytes(1, enc.encode(l.address)), ...l.topics.map((t) => pbBytes(2, enc.encode(t))), pbBytes(3, hexBytes(l.data)), pbInt(4, height));
  const response = cat(pbBytes(1, enc.encode(hash)), ...logs.map((l) => pbBytes(2, encLog(l))), pbBytes(3, hexBytes(word("1"))), pbInt(5, 35149n));
  const any = cat(pbBytes(1, enc.encode("/injective.evm.v1.MsgEthereumTxResponse")), pbBytes(2, response));
  return toHex(pbBytes(2, any)).toUpperCase();
}

export const transferLog = (token: string, from: string, to: string, amount: bigint): Log => ({
  address: token.toLowerCase(),
  topics: [TRANSFER, word(from), word(to)],
  data: word(amount.toString(16)),
});
export const approvalLog = (token: string, owner: string, spender: string, amount: bigint): Log => ({
  address: token.toLowerCase(),
  topics: [APPROVAL, word(owner), word(spender)],
  data: word(amount.toString(16)),
});

// -- RLP --
type R = Uint8Array | R[];
function rlp(x: R): Uint8Array {
  const head = (short: number, long: number, len: number) => {
    if (len < 56) return Uint8Array.of(short + len);
    const l = intBytes(BigInt(len));
    return cat(Uint8Array.of(long + l.length), l);
  };
  if (x instanceof Uint8Array) return x.length === 1 && x[0]! < 0x80 ? x : cat(head(0x80, 0xb7, x.length), x);
  const body = cat(...x.map(rlp));
  return cat(head(0xc0, 0xf7, body.length), body);
}

/** A signed transaction's bytes as the LCD shows them (`raw`): 0x hex. The signature is
 *  filler, as the wallet reads but never checks it. */
export function rawTx(tx: { type?: 0 | 1 | 2; to: string | null; value?: bigint; input?: string; chainId?: bigint }): string {
  const to = tx.to ? hexBytes(tx.to) : new Uint8Array();
  const value = intBytes(tx.value ?? 0n);
  const input = hexBytes(tx.input ?? "0x");
  const sig = [intBytes(1n), hexBytes("11".repeat(32)), hexBytes("22".repeat(32))];
  const chain = intBytes(tx.chainId ?? 1776n);
  const n = (v: bigint) => intBytes(v);
  if (tx.type === 0) return `0x${toHex(rlp([n(3n), n(160_000_000n), n(21_000n), to, value, input, ...sig]))}`;
  if (tx.type === 1) return `0x01${toHex(rlp([chain, n(3n), n(160_000_000n), n(21_000n), to, value, input, [], ...sig]))}`;
  return `0x02${toHex(rlp([chain, n(3n), n(0n), n(160_000_000n), n(21_000n), to, value, input, [], ...sig]))}`;
}

/** The message as the LCD renders it. */
export const ethMessage = (from: string, raw: string) => ({
  "@type": EVM_MSG,
  data: null,
  size: 0,
  deprecated_hash: "",
  deprecated_from: "",
  from: btoa(String.fromCharCode(...hexBytes(from))),
  raw,
});

/** ERC20 `transfer(to, amount)` calldata. */
export const transferCall = (to: string, amount: bigint) => `0xa9059cbb${word(to).slice(2)}${word(amount.toString(16)).slice(2)}`;
