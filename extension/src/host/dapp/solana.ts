// Solana sites, through the Wallet Standard (../../inpage.ts registers the wallet): accounts,
// connecting, and messages and transactions to sign (../solana.ts reads a transaction).

import { base58ToBytes, bytesToHex, hexToBytes, isObject, NETWORKS, type NetworkId } from "@choice-wallet/chain";

import { bytesHex, CHAIN_DISCONNECTED, INVALID_PARAMS, MAX_ARBITRARY, no, UNAUTHORIZED, UNSUPPORTED, type DappReply, type SiteCore } from "./shared";

export function createSolanaSite(core: SiteCore) {
  const { h, isConnected, connect, sign, disconnect } = core;

  /** The Wallet Standard's name for the network's cluster. */
  const standardChain = (network: NetworkId) => (network === "mainnet" ? "solana:mainnet" : "solana:devnet");

  /** The Solana account a site sees: the account's, while connected and unlocked. */
  async function solanaAccounts(origin: string): Promise<{ address: string; publicKey: string }[]> {
    if (!(await isConnected(origin))) return [];
    const u = await h.unlocked();
    const a = u?.account.addresses[NETWORKS[await h.network()].solana.caip2];
    return a ? [{ address: a, publicKey: bytesToHex(base58ToBytes(a)) }] : [];
  }

  async function solanaSite(origin: string, method: string, p: Record<string, unknown>): Promise<DappReply> {
    const network = await h.network();
    const net = NETWORKS[network];
    const chains = { chains: [standardChain(network)] };
    if (method === "solana_accounts") return { result: { accounts: await solanaAccounts(origin), ...chains } };
    if (method === "solana_connect") {
      // Silent: only what a connected site already sees; the user is never asked.
      if (p["silent"] === true) return { result: { accounts: await solanaAccounts(origin), ...chains } };
      return connect(origin, async () => ({ result: { accounts: await solanaAccounts(origin), ...chains } }));
    }
    if (method === "solana_disconnect") {
      await disconnect(origin);
      return { result: null };
    }
    if (p["chain"] !== undefined && p["chain"] !== standardChain(network)) return no(CHAIN_DISCONNECTED, `Choice Wallet is on ${net.solana.name} (${standardChain(network)}).`);
    if (!(await isConnected(origin))) return no(UNAUTHORIZED, "Connect to Choice Wallet first.");
    const mine = (await solanaAccounts(origin))[0]?.address;
    if (!mine || p["account"] !== mine) return no(UNAUTHORIZED, "That account isn't this wallet's connected Solana account.");
    if (method === "solana_signMessage") {
      const message = p["message"];
      if (typeof message !== "string" || !bytesHex(message) || message.length === 0 || message.length > 2 * MAX_ARBITRARY) return no(INVALID_PARAMS, `signMessage takes the message as bytes, at most ${MAX_ARBITRARY} of them.`);
      return sign(
        origin,
        "solana_message",
        async () => ({ request: { solana_message: { chain: net.solana.caip2, signer: mine, message: message.replace(/^0x/, "") } } }),
        async (signed) => ({ signature: signed["signature"] }),
      );
    }
    if (method === "solana_signTransaction" || method === "solana_signAndSendTransaction") {
      const tx = p["transaction"];
      if (typeof tx !== "string" || !bytesHex(tx) || tx.length < 4 || tx.length > 2 * 1232) return no(INVALID_PARAMS, `${method.slice(7)} takes a serialized transaction (at most 1232 bytes).`);
      const wire = hexToBytes(tx.replace(/^0x/, ""));
      const send = method === "solana_signAndSendTransaction";
      let read: Awaited<ReturnType<typeof h.solana.siteTransaction>> | null = null;
      return sign(
        origin,
        "solana_transaction",
        async (account) => {
          read = await h.solana.siteTransaction(network, account, wire);
          return { request: read.request, checkedBy: read.checkedBy, simulation: read.simulation, tokens: read.tokens, context: read.context };
        },
        async (signed) => {
          if (!read || Number(signed["index"]) !== read.index) throw new RangeError("The signature isn't where this account signs.");
          const done = await h.solana.siteSigned(network, read, hexToBytes(String(signed["signature"])), send);
          return send ? { signature: bytesToHex(base58ToBytes(done.signature)) } : { transaction: bytesToHex(done.wire) };
        },
      );
    }
    return no(UNSUPPORTED, `${method} isn't supported.`);
  }

  /** A Solana method's answer, or null when it isn't one. */
  async function handle(origin: string, method: string, params: unknown): Promise<DappReply | null> {
    if (!method.startsWith("solana_")) return null;
    return solanaSite(origin, method, isObject(params) ? params : {});
  }

  return { handle };
}
