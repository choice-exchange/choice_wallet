// Cosmos sites (`window.choice`, Keplr's shape): enable, the key, signDirect, signAmino,
// ADR-036 arbitrary data, and broadcasting a signed transaction.

import { balanceChanges, bytesToHex, ChainError, cosmosTxHash, isObject, NETWORKS, type NetworkId } from "@choice-wallet/chain";
import type { AccountInfo, DappReview } from "@choice-wallet/ui/protocol";

import { b64, bytesHex, CHAIN_DISCONNECTED, fromB64, INVALID_PARAMS, MAX_ARBITRARY, no, UNAUTHORIZED, UNSUPPORTED, type DappReply, type SiteCore } from "./shared";

export function createCosmosSite(core: SiteCore) {
  const { h, isConnected, connect, sign } = core;

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
    if (wrongChain(p["chainId"])) return no(CHAIN_DISCONNECTED, chainNote);
    if (!(await isConnected(origin))) return no(UNAUTHORIZED, "Call enable first.");
    const u = await h.unlocked();
    if (!u && method === "choice_getKey") return no(UNAUTHORIZED, "Choice Wallet is locked.");

    if (method === "choice_getKey") {
      const a = u!.account;
      const evmAddr = a.addresses[net.evm] ?? "";
      return {
        result: {
          name: a.name,
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
      await (await h.sender.lcd(network)).broadcast(hex, hash);
      h.sender.broadcasted(network, hash, (await h.unlocked())?.account.addresses[net.cosmos] ?? "");
      return { result: hash };
    }
    // The account in use, as sites see it (not the list's first: another account, or a
    // Ledger's, signs for itself).
    const { accounts, active_account } = (await h.local.get(["accounts", "active_account"])) as { accounts?: AccountInfo[]; active_account?: number };
    const account = accounts?.[typeof active_account === "number" ? active_account : 0] ?? accounts?.[0];
    if (!account || account.account.derivation === "watch" || p["signer"] !== account.addresses[net.cosmos]) return no(UNAUTHORIZED, "The signer isn't this wallet's connected account.");
    const pubkey = account.public_key;
    const signature = (sig: unknown) => ({ pub_key: { type: "tendermint/PubKeySecp256k1", value: b64(pubkey) }, signature: b64(String(sig)) });

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
        "cosmos_direct",
        async () => {
          const request = { cosmos_direct: { chain: net.cosmos, signer: pubkey, body_bytes: body, auth_info_bytes: auth, account_number: accountNumber } };
          return { request, ...(await simulate(network, account, body, auth)) };
        },
        async (signed) => signature(signed["signature"]),
      );
    }
    if (method === "choice_signAmino") {
      const doc = p["signDoc"];
      if (!isObject(doc)) return no(INVALID_PARAMS, "signAmino takes a StdSignDoc.");
      if (wrongChain(doc["chain_id"])) return no(CHAIN_DISCONNECTED, chainNote);
      return sign(
        origin,
        "cosmos_amino",
        async () => ({ request: { cosmos_amino: { chain: net.cosmos, signer: pubkey, sign_doc: doc } } }),
        async (signed) => signature(signed["signature"]),
      );
    }
    if (method === "choice_signArbitrary" || method === "choice_verifyArbitrary") {
      const data = p["data"];
      if (typeof data !== "string" || !bytesHex(data) || data.replace(/^0x/, "").length > 2 * MAX_ARBITRARY) return no(INVALID_PARAMS, `${method.slice(7)} takes the data as bytes, at most ${MAX_ARBITRARY} of them.`);
      const dataHex = data.replace(/^0x/, "");
      if (method === "choice_signArbitrary") {
        return sign(
          origin,
          "cosmos_arbitrary",
          async () => ({ request: { cosmos_arbitrary: { chain: net.cosmos, signer: pubkey, data: dataHex } } }),
          async (signed) => signature(signed["signature"]),
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
      return { checkedBy: new URL(client.pool.current).host, simulation: { ok: true, changes: balanceChanges(events, me, fee).changes } };
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
