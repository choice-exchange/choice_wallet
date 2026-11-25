// Cosmos sites (`window.choice`, Keplr's shape): enable, the key, signDirect, signAmino,
// ADR-036 arbitrary data, and broadcasting a signed transaction.

import { balanceChanges, bytesToHex, ChainError, cosmosTxHash, isObject, NETWORKS, Unconfirmed, Unreachable, type Coin, type Lcd, type NetworkId, type TxEvent } from "@choice-wallet/chain";
import type { AccountInfo, DappReview } from "@choice-wallet/ui/protocol";

import { b64, bytesHex, CHAIN_DISCONNECTED, fromB64, INVALID_PARAMS, MAX_ARBITRARY, no, UNAUTHORIZED, UNSUPPORTED, type DappReply, type SiteCore } from "./shared";

/** The Cosmos methods a site may call once connected. */
const METHODS = new Set(["choice_getKey", "choice_sendTx", "choice_signDirect", "choice_signAmino", "choice_signArbitrary", "choice_verifyArbitrary"]);

export function createCosmosSite(core: SiteCore) {
  const { h, isConnected, connect, sign } = core;
  /** Signatures this wallet gave sites lately (hex): a site's broadcast carrying one is the
   *  account's own transaction, followed and named as it; any other is the site's. */
  const given: string[] = [];
  const gave = (sig: unknown) => {
    given.push(String(sig).toLowerCase());
    if (given.length > 50) given.shift();
  };

  async function cosmos(origin: string, method: string, p: Record<string, unknown>): Promise<DappReply> {
    const network = await h.network();
    const net = NETWORKS[network];
    const wrongChain = (id: unknown) => id !== net.chainId;
    const chainNote = `Choice Wallet is on ${net.name} (${net.chainId}).`;

    if (method === "choice_enable") {
      const ids = Array.isArray(p["chainIds"]) ? p["chainIds"] : [p["chainIds"]];
      if (ids.length === 0 || ids.some(wrongChain)) return no(CHAIN_DISCONNECTED, chainNote);
      return connect(origin, async () => ({ result: null }));
    }
    if (!METHODS.has(method)) return no(UNSUPPORTED, `${method} isn't supported.`);
    if (wrongChain(p["chainId"])) return no(CHAIN_DISCONNECTED, chainNote);
    if (!(await isConnected(origin))) return no(UNAUTHORIZED, "Call enable first.");
    // Null while locked, and for a watch-only account: neither can sign.
    const u = await h.unlocked();
    // Locked (or watch-only): one answer for everything that reads or compares the account
    // (sendTx needs none), before the signer or a key is compared, so a site can't test a
    // guess at the account while it is locked (run-2 C8: verifyArbitrary did).
    if (!u && method !== "choice_sendTx") return no(UNAUTHORIZED, "Choice Wallet is locked, or this account can't sign. Unlock it, then ask again.");

    if (method === "choice_getKey") {
      const a = u!.account;
      const evmAddr = a.addresses[net.evm] ?? "";
      return {
        result: {
          // Not the user's label for the account: a site has no need of it.
          name: "Choice Wallet",
          algo: "ethsecp256k1",
          pubKey: a.public_key,
          address: evmAddr.slice(2).toLowerCase(),
          bech32Address: a.addresses[net.cosmos],
          ethereumHexAddress: evmAddr,
          // Keplr's flag: a site then asks for amino signatures, which a Ledger can give.
          isNanoLedger: a.account.derivation === "ledger",
          isKeystone: false,
        },
      };
    }
    if (method === "choice_sendTx") {
      const tx = p["tx"];
      if (typeof tx !== "string" || !bytesHex(tx) || tx.length < 4) return no(INVALID_PARAMS, "sendTx takes the signed tx bytes.");
      const hex = tx.replace(/^0x/, "");
      const hash = await cosmosTxHash(hex);
      try {
        await (await h.sender.lcd(network)).broadcast(hex, hash);
      } catch (e) {
        // Sent, and its answer lost (run-5): followed, and the site gets its hash.
        if (!(e instanceof Unconfirmed)) throw e;
      }
      // Followed (and named in notices) only when the account signed it here.
      const mine = txRawSignatures(hex).some((s) => given.includes(s));
      const me = (await h.unlocked())?.account.addresses[net.cosmos];
      if (mine && me) h.sender.broadcasted(network, hash, me);
      return { result: hash };
    }
    // The account in use, as unlocked (not the list's first: another account, or a
    // Ledger's, signs for itself).
    const account = u!.account;
    if (p["signer"] !== account.addresses[net.cosmos]) return no(UNAUTHORIZED, "The signer isn't this wallet's connected account.");
    const pubkey = account.public_key;
    /** The account the request's signer is: only it answers, whichever account is in use at
     *  review, so a switch shows as the wrong account before approval, not as a failed signature. */
    const named = { address: account.addresses[net.cosmos] ?? "", of: (a: AccountInfo) => a.addresses[net.cosmos] };
    const signature = (sig: unknown) => {
      gave(sig);
      return { pub_key: { type: "tendermint/PubKeySecp256k1", value: b64(pubkey) }, signature: b64(String(sig)) };
    };

    if (method === "choice_signDirect") {
      const doc = p["signDoc"];
      if (!isObject(doc) || typeof doc["bodyBytes"] !== "string" || typeof doc["authInfoBytes"] !== "string" || !bytesHex(doc["bodyBytes"]) || !bytesHex(doc["authInfoBytes"])) {
        return no(INVALID_PARAMS, "signDirect takes { bodyBytes, authInfoBytes, chainId, accountNumber }.");
      }
      if (wrongChain(doc["chainId"])) return no(CHAIN_DISCONNECTED, chainNote);
      const accountNumber = String(doc["accountNumber"] ?? "");
      if (!/^[0-9]{1,20}$/.test(accountNumber)) return no(INVALID_PARAMS, "signDirect: accountNumber must be an integer.");
      const body = doc["bodyBytes"].replace(/^0x/, "");
      const auth = doc["authInfoBytes"].replace(/^0x/, "");
      return sign(
        origin,
        network,
        "cosmos_direct",
        async () => {
          const request = { cosmos_direct: { chain: net.cosmos, signer: pubkey, body_bytes: body, auth_info_bytes: auth, account_number: accountNumber } };
          return { request, ...(await simulate(network, account, body, auth)) };
        },
        async (signed) => signature(signed["signature"]),
        named,
      );
    }
    if (method === "choice_signAmino") {
      const doc = p["signDoc"];
      if (!isObject(doc)) return no(INVALID_PARAMS, "signAmino takes a StdSignDoc.");
      if (wrongChain(doc["chain_id"])) return no(CHAIN_DISCONNECTED, chainNote);
      return sign(
        origin,
        network,
        "cosmos_amino",
        async () => ({ request: { cosmos_amino: { chain: net.cosmos, signer: pubkey, sign_doc: doc } } }),
        async (signed) => signature(signed["signature"]),
        named,
      );
    }
    if (method === "choice_signArbitrary" || method === "choice_verifyArbitrary") {
      const data = p["data"];
      if (typeof data !== "string" || !bytesHex(data) || data.replace(/^0x/, "").length > 2 * MAX_ARBITRARY) return no(INVALID_PARAMS, `${method.slice(7)} takes the data as bytes, at most ${MAX_ARBITRARY} of them.`);
      const dataHex = data.replace(/^0x/, "");
      if (method === "choice_signArbitrary") {
        return sign(
          origin,
          network,
          "cosmos_arbitrary",
          async () => ({ request: { cosmos_arbitrary: { chain: net.cosmos, signer: pubkey, data: dataHex } } }),
          async (signed) => signature(signed["signature"]),
          named,
        );
      }
      // verifyArbitrary: whether a signature of `data` is this account's (Keplr's checks).
      const sig = p["signature"];
      const pk = isObject(sig) && isObject(sig["pub_key"]) ? fromB64(sig["pub_key"]["value"]) : null;
      const rs = isObject(sig) ? fromB64(sig["signature"]) : null;
      if (pk === null || rs === null) return no(INVALID_PARAMS, "verifyArbitrary takes a StdSignature.");
      if (pk !== pubkey) return no(INVALID_PARAMS, "That signature's key isn't this account's.");
      const r = await h.vault<{ valid: boolean }>("verify_arbitrary", { chain: net.cosmos, address: account.addresses[net.cosmos], data: dataHex, public_key: pk, signature: rs });
      if (!r.ok) return no(INVALID_PARAMS, r.error.message);
      return { result: r.result.valid };
    }
    return no(UNSUPPORTED, `${method} isn't supported.`);
  }

  /** Simulate a dapp's Cosmos tx (unsigned) for what it would move. A failure is shown, not
   *  thrown: the user decides. */
  async function simulate(network: NetworkId, account: AccountInfo, body: string, auth: string): Promise<{ checkedBy: string; simulation: DappReview["simulation"] }> {
    const client = await h.sender.lcd(network);
    // TxRaw { body_bytes = 1, auth_info_bytes = 2, signatures = 3: one empty }.
    const len = (n: number) => {
      const out: number[] = [];
      do {
        let b = n & 0x7f;
        n >>>= 7;
        if (n) b |= 0x80;
        out.push(b);
      } while (n);
      return bytesToHex(Uint8Array.from(out));
    };
    const raw = `0a${len(body.length / 2)}${body}12${len(auth.length / 2)}${auth}1a00`;
    try {
      const { events } = await client.simulateEvents(raw);
      const me = account.addresses[NETWORKS[network].cosmos] ?? "";
      const feeEvent = events.find((e) => e.type === "tx" && e.attributes.some((a) => a.key === "fee"));
      const fee = (feeEvent?.attributes.find((a) => a.key === "fee")?.value ?? "").split(",").flatMap((c) => {
        const m = /^([0-9]+)([a-zA-Z][a-zA-Z0-9/:._-]{2,127})$/.exec(c.trim());
        return m ? [{ denom: m[2]!, amount: m[1]! }] : [];
      });
      const nfts = await cw721Moves(client, events, me);
      const changes = [...balanceChanges(events, me, fee).changes, ...nfts.changes];
      return { checkedBy: new URL(client.pool.current).host, simulation: { ok: true, changes, ...(nfts.partial ? { partial: true } : {}) } };
    } catch (e) {
      if (e instanceof ChainError) return { checkedBy: new URL(client.pool.current).host, simulation: { ok: false, error: e.message } };
      throw e;
    }
  }

  /** A Cosmos method's answer, or null when it isn't one. */
  async function handle(origin: string, method: string, params: unknown): Promise<DappReply | null> {
    if (!method.startsWith("choice_")) return null;
    return cosmos(origin, method, isObject(params) ? params : {});
  }

  return { handle };
}

/** Owners asked about in one review: each NFT that moves is one query. */
const MAX_OWNER_CHECKS = 8;

/** The CW721 NFTs a simulated Cosmos tx moves for `me`, from its wasm events (run-5): one it
 *  gets (a transfer or send to it, a mint for it) is +1 `nft:<collection>:<id>`, one it held
 *  and that is transferred, sent or burned is -1. A move's event names only who called it (an
 *  operator, a marketplace), so whose the NFT was comes from the collection, before the tx.
 *  When that can't be read, the list is only part of what moves. */
export async function cw721Moves(client: Pick<Lcd, "smart">, events: readonly TxEvent[], me: string): Promise<{ changes: Coin[]; partial: boolean }> {
  const net = new Map<string, bigint>();
  const leaving: { contract: string; id: string }[] = [];
  const coming = new Set<string>();
  let partial = false;
  for (const e of events) {
    if (e.type !== "wasm") continue;
    // A contract's attributes, from each `_contract_address` to the next.
    const groups: Record<string, string>[] = [];
    for (const a of e.attributes) {
      if (a.key === "_contract_address" || groups.length === 0) groups.push({});
      groups[groups.length - 1]![a.key] = a.value;
    }
    for (const g of groups) {
      const [contract, id, action] = [g["_contract_address"], g["token_id"], g["action"]];
      if (!contract || id === undefined || !action) continue;
      const denom = `nft:${contract}:${id}`;
      // Each NFT once: one moved through an escrow and on is still one NFT leaving.
      const leaves = () => {
        if (!leaving.some((l) => l.contract === contract && l.id === id)) leaving.push({ contract, id });
      };
      if ((action === "transfer_nft" || action === "send_nft") && g["recipient"] !== undefined) {
        if (g["recipient"] === me) {
          if (!coming.has(denom)) net.set(denom, (net.get(denom) ?? 0n) + 1n);
          coming.add(denom);
        } else leaves();
      } else if (action === "mint" && g["owner"] !== undefined) {
        if (g["owner"] === me) {
          if (!coming.has(denom)) net.set(denom, (net.get(denom) ?? 0n) + 1n);
          coming.add(denom);
        }
      } else if (action === "burn" && g["amount"] === undefined) leaves();
    }
  }
  for (const [i, { contract, id }] of leaving.entries()) {
    const denom = `nft:${contract}:${id}`;
    // One that came in within the same tx: what it held before says nothing about it.
    if (i >= MAX_OWNER_CHECKS || coming.has(denom)) {
      partial = true;
      continue;
    }
    let owner: unknown = null;
    try {
      const r = await client.smart(contract, { owner_of: { token_id: id } });
      owner = isObject(r) ? r["owner"] : null;
    } catch (e) {
      if (!(e instanceof Unreachable || e instanceof ChainError)) throw e;
    }
    if (typeof owner !== "string") partial = true;
    else if (owner === me) net.set(denom, (net.get(denom) ?? 0n) - 1n);
  }
  return { changes: [...net].filter(([, a]) => a !== 0n).map(([denom, a]) => ({ denom, amount: a.toString() })), partial };
}

/** The signatures (hex) in a TxRaw's protobuf bytes (field 3, repeated bytes); none for
 *  bytes that don't read as one. */
export function txRawSignatures(hex: string): string[] {
  const b = hex.match(/../g)?.map((x) => parseInt(x, 16)) ?? [];
  const out: string[] = [];
  let i = 0;
  const varint = (): number | null => {
    let n = 0;
    for (let shift = 0; shift < 35 && i < b.length; shift += 7) {
      const byte = b[i++]!;
      n += (byte & 0x7f) * 2 ** shift;
      if (byte < 0x80) return n;
    }
    return null;
  };
  while (i < b.length) {
    const key = varint();
    if (key === null || (key & 7) !== 2) return [];
    const len = varint();
    if (len === null || i + len > b.length) return [];
    if (key >> 3 === 3) out.push(b.slice(i, i + len).map((x) => x.toString(16).padStart(2, "0")).join(""));
    i += len;
  }
  return out;
}
