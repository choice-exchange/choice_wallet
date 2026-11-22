// Approvals and grants: what this account lets others do, and taking it back.
//
// - authz grants and fee allowances it gave, and where its staking rewards go (LCD);
// - CW20 allowances on the CW20s it holds or added (each contract's `all_allowances`);
// - EVM permissions: ERC20 allowances, NFT operators, single NFT approvals and Permit2
//   allowances. An index (Blockscout) names every candidate from the account's logs, and what
//   still stands comes from the contracts themselves on the user's endpoint. Injective's EVM
//   side by default; another EVM chain when the screen picks one (each through its own
//   history index), so the account's address goes only where the user looks.
//
// Revokes are the wallet's own transactions: the same prepare → review → confirm_send as a
// send, decoded and graded by the vault. Cosmos revokes go in one transaction; each ERC20
// revoke is its own (an `approve(spender, 0)` on that token).

import { chainByKey, cw20Address, cw721Candidates, cw721Tokens, evmAddress, evmDenom, EvmIndex, isObject, isTokenId, NETWORKS, type EvmRpc, type Fetch, type Lcd, type NetworkId } from "@choice-wallet/chain";
import type { AccountInfo, ApprovalsSummary, EvmRevokeKind, Result, RevokeItem, SendReview, TokenInfo } from "@choice-wallet/ui/protocol";

import { evmChains } from "./evmchains";
import { sourceOfChain, type createSender, type EvmDisplayLike } from "./send";
import { fail } from "./util";

type Sender = ReturnType<typeof createSender>;

/** Most messages in one revoke transaction. */
export const MAX_REVOKES = 30;
/** CW20 contracts asked at once. */
const CW20_PARALLEL = 6;
/** The largest CW20 amount (Uint128). */
const CW20_MAX = "340282366920938463463374607431768211455";

const TYPE_URL = /^\/[A-Za-z0-9._]{1,127}$/;

/** Standing permissions the wallet has no reader for yet: always named as not checked. */
const NOT_READ: string[] = [];
/** CW721 collections, and their NFTs, whose approvals are asked. */
const CW721_COLLECTIONS = 20;
const CW721_TOKENS = 60;
/** Candidates of each EVM kind checked on chain (each is an eth_call). */
const MAX_CHECKS = 100;
/** Permit2: one address on every chain. */
const PERMIT2 = "0x000000000022d473030f116ddee9f6b43ac78ba3";

type EvmPermissions = Pick<ApprovalsSummary, "nftOperators" | "nftApprovals"> & {
  erc20: { token: string; spender: string; amount: string }[];
  permit2: { token: string; spender: string; amount: string; expiration: number }[];
  indexDown: boolean;
  rpcDown: boolean;
};

/** The EVM permissions `owner` gave on one chain: the index names candidates, the chain says
 *  what still stands. What couldn't be read is added to `unchecked`. */
async function evmPermissions(index: EvmIndex | null, rpc: () => Promise<EvmRpc>, owner: string, unchecked: string[], now: number): Promise<EvmPermissions> {
  const out: EvmPermissions = { erc20: [], nftOperators: [], nftApprovals: [], permit2: [], indexDown: false, rpcDown: false };
  const missing = (what: string) => {
    if (!unchecked.includes(what)) unchecked.push(what);
  };
  if (!index) {
    missing("EVM allowances and NFT approvals (EVM history is off in Settings)");
    return out;
  }
  let found;
  try {
    const [a, o, p] = await Promise.all([index.approvals(owner), index.operators(owner), index.permit2Approvals(owner, PERMIT2)]);
    found = { a, o, p };
  } catch {
    out.indexDown = true;
    return out;
  }
  if (!found.a.complete) missing("ERC20 and NFT approvals past the first 5,000 records");
  if (!found.o.complete) missing("NFT operators past the first 5,000 records");
  if (!found.p.complete) missing("Permit2 allowances past the first 5,000 records");
  const cap = <T>(xs: T[], what: string) => {
    if (xs.length > MAX_CHECKS) missing(`some ${what}`);
    return xs.slice(0, MAX_CHECKS);
  };
  const pairs = cap(found.a.pairs, "ERC20 allowances");
  const nfts = cap(found.a.nfts, "NFT approvals");
  const ops = cap(found.o.pairs, "NFT operators");
  const p2 = cap(found.p.pairs, "Permit2 allowances");
  if (pairs.length + nfts.length + ops.length + p2.length === 0) return out;
  try {
    const client = await rpc();
    const [left, approved, operators, allowed] = await Promise.all([
      pairs.length ? client.erc20Allowances(pairs, owner) : [],
      nfts.length ? client.nftApproved(nfts) : [],
      ops.length ? client.nftOperators(ops, owner) : [],
      p2.length ? client.permit2Allowances(PERMIT2, p2, owner) : [],
    ]);
    pairs.forEach((p, i) => {
      const a = left[i];
      if (a === null || a === undefined) missing("some ERC20 allowances");
      else if (a > 0n) out.erc20.push({ token: p.token, spender: p.spender, amount: a.toString() });
    });
    // A token burned or sent away no longer answers, and its approval went with it.
    nfts.forEach((t, i) => {
      const who = approved[i];
      if (who) out.nftApprovals.push({ ...t, approved: who });
    });
    ops.forEach((o, i) => {
      const on = operators[i];
      if (on === null || on === undefined) missing("some NFT operators");
      else if (on) out.nftOperators.push(o);
    });
    p2.forEach((p, i) => {
      const a = allowed[i];
      if (a === null || a === undefined) missing("some Permit2 allowances");
      else if (a.amount > 0n && a.expiration >= now) out.permit2.push({ ...p, amount: a.amount.toString(), expiration: a.expiration });
    });
  } catch {
    out.rpcDown = true;
  }
  return out;
}

/** CW721 operators and single NFT approvals `owner` gave, in the collections it holds NFTs in
 *  (found from its transactions) or added by hand. Expired ones are left out by the query. */
async function cw721Permissions(lcd: Lcd, owner: string, added: readonly string[], unchecked: string[]): Promise<Pick<ApprovalsSummary, "cw721Operators" | "cw721Approvals">> {
  const out: Pick<ApprovalsSummary, "cw721Operators" | "cw721Approvals"> = { cw721Operators: [], cw721Approvals: [] };
  const missing = (what: string) => {
    if (!unchecked.includes(what)) unchecked.push(what);
  };
  let collections: string[];
  try {
    collections = [...new Set([...added, ...(await cw721Candidates(lcd, owner))])];
  } catch {
    missing("CW721 approvals");
    return out;
  }
  if (collections.length > CW721_COLLECTIONS) missing(`CW721 approvals past the first ${CW721_COLLECTIONS} collections`);
  const spenders = (r: unknown, key: string) =>
    isObject(r) && Array.isArray(r[key]) ? (r[key] as unknown[]).flatMap((a) => (isObject(a) && typeof a["spender"] === "string" ? [a["spender"]] : [])) : null;
  let budget = CW721_TOKENS;
  for (const collection of collections.slice(0, CW721_COLLECTIONS)) {
    try {
      const ops = spenders(await lcd.smart(collection, { all_operators: { owner, include_expired: false, limit: 100 } }), "operators");
      if (ops === null) missing("some CW721 operators");
      for (const operator of ops ?? []) out.cw721Operators.push({ collection, operator });
      const held = await cw721Tokens(lcd, collection, owner, budget);
      for (const tokenId of held?.ids ?? []) {
        if (budget-- <= 0) break;
        const who = spenders(await lcd.smart(collection, { approvals: { token_id: tokenId, include_expired: false } }), "approvals");
        if (who === null) missing("some CW721 approvals");
        for (const spender of who ?? []) out.cw721Approvals.push({ collection, tokenId, spender });
      }
      if (budget <= 0 || held?.more) missing("some CW721 approvals");
    } catch {
      missing("some CW721 approvals");
    }
  }
  return out;
}

export interface ApprovalChains {
  /** The user's history indexes for an EVM chain (empty: off), or its defaults. */
  historyEndpoints(network: NetworkId, key: string): Promise<readonly string[]>;
  /** The NFT collections added by hand on a network. */
  addedNfts?(network: NetworkId): Promise<string[]>;
  fetch: Fetch;
  now?: () => number;
}

export function createApprovals(sender: Sender, chains: ApprovalChains) {
  const now = () => Math.floor((chains.now ?? Date.now)() / 1000);

  /** The other EVM chains whose permissions can be checked: those with a history index. */
  async function checkable(network: NetworkId): Promise<ApprovalsSummary["chains"]> {
    const out: ApprovalsSummary["chains"] = [];
    for (const c of evmChains(network)) if ((await chains.historyEndpoints(network, c.key)).length > 0) out.push({ key: c.key, name: c.name });
    return out;
  }

  async function summary(network: NetworkId, account: AccountInfo, chain?: unknown): Promise<Result<ApprovalsSummary>> {
    if (chain !== undefined) return chainSummary(network, account, chain);
    const net = NETWORKS[network];
    const address = account.addresses[net.cosmos];
    const evm0x = account.addresses[net.evm];
    if (!address || !evm0x) return fail("bad_request", "This account has no address on this network.");
    try {
      const client = await sender.lcd(network);
      const [grants, feeGrants, rewardsTo, held] = await Promise.all([
        client.authzGrants(address),
        client.feeGrants(address),
        client.withdrawAddress(address),
        sender.balances(network, account),
      ]);
      // CW20 allowances on every CW20 the wallet lists for this account.
      // What wasn't read: classes the wallet has no reader for yet, and sources that were off
      // or failed. The screen names them, and never says nothing stands while any is left.
      const unchecked: string[] = [...NOT_READ];
      if (!held.ok) unchecked.push("CW20 allowances");
      const contracts = held.ok ? held.result.balances.map((b) => cw20Address(b.denom)).filter((c): c is string => c !== null) : [];
      const cw20: ApprovalsSummary["cw20"] = [];
      for (let i = 0; i < contracts.length; i += CW20_PARALLEL) {
        const batch = contracts.slice(i, i + CW20_PARALLEL);
        const answers = await Promise.all(batch.map((c) => client.cw20Allowances(c, address).catch(() => null)));
        batch.forEach((c, j) => {
          if (answers[j] === null && !unchecked.includes("some CW20 allowances")) unchecked.push("some CW20 allowances");
          for (const a of answers[j] ?? []) cw20.push({ token: `cw20:${c}`, spender: a.spender, amount: a.amount.toString(), expires: a.expires });
        });
      }

      const cw721 = await cw721Permissions(client, address, ((await chains.addedNfts?.(network)) ?? []).filter((a) => a.startsWith("inj1")), unchecked);

      // EVM permissions on Injective's EVM side: Blockscout finds, the contracts answer.
      unchecked.push("other EVM chains (pick one above)");
      const perms = await evmPermissions(await sender.evmIndex(network), () => sender.evm(network), evm0x, unchecked, now());
      const erc20 = perms.erc20.map((e) => ({ ...e, token: evmDenom(e.token) }));
      const permit2 = perms.permit2.map((p) => ({ ...p, token: evmDenom(p.token) }));
      const tokens = await sender.tokensFor(network, [...cw20.map((c) => c.token), ...erc20.map((e) => e.token), ...permit2.map((p) => p.token)]);
      return {
        ok: true,
        result: {
          network,
          grants,
          feeGrants,
          rewardsTo: rewardsTo === address ? null : rewardsTo,
          cw20,
          erc20,
          ...cw721,
          nftOperators: perms.nftOperators,
          nftApprovals: perms.nftApprovals,
          permit2,
          chains: await checkable(network),
          tokens,
          unchecked,
          ...(perms.indexDown ? { evmIndexDown: true as const } : {}),
          ...(perms.rpcDown ? { evmDown: true as const } : {}),
        },
      };
    } catch (e) {
      return sender.chainFailure(e);
    }
  }

  /** Another EVM chain's permissions: its own history index and endpoints. */
  async function chainSummary(network: NetworkId, account: AccountInfo, key: unknown): Promise<Result<ApprovalsSummary>> {
    const c = typeof key === "string" ? evmChains(network).find((x) => x.key === key) : undefined;
    if (!c) return fail("bad_request", "Not an EVM chain on this network.");
    const owner = account.addresses[c.caip2] ?? account.addresses[NETWORKS[network].evm];
    if (!owner) return fail("bad_request", "This account has no EVM address.");
    try {
      const urls = await chains.historyEndpoints(network, c.key);
      const unchecked: string[] = [];
      const perms = await evmPermissions(urls.length > 0 ? new EvmIndex(urls, chains.fetch) : null, () => sender.chainRpc(network, c.key), owner, unchecked, now());
      // Token names from the chain itself, for a few.
      const tokens: Record<string, TokenInfo> = {};
      const named = [...new Set([...perms.erc20, ...perms.permit2].map((x) => x.token))].slice(0, 12);
      if (named.length > 0) {
        const rpc = await sender.chainRpc(network, c.key);
        await Promise.all(
          named.map(async (t) => {
            const m = await rpc.erc20Metadata(t).catch(() => null);
            if (m) tokens[evmDenom(t)] = { denom: evmDenom(t), symbol: m.symbol, name: m.name || m.symbol, decimals: m.decimals, known: false, chain: c.caip2 };
          }),
        );
      }
      return {
        ok: true,
        result: {
          network,
          chain: c.key,
          chains: await checkable(network),
          grants: [],
          feeGrants: [],
          rewardsTo: null,
          cw20: [],
          cw721Operators: [],
          cw721Approvals: [],
          erc20: perms.erc20.map((e) => ({ ...e, token: evmDenom(e.token) })),
          nftOperators: perms.nftOperators,
          nftApprovals: perms.nftApprovals,
          permit2: perms.permit2.map((p) => ({ ...p, token: evmDenom(p.token) })),
          tokens,
          unchecked,
          ...(perms.indexDown ? { evmIndexDown: true as const } : {}),
          ...(perms.rpcDown ? { evmDown: true as const } : {}),
        },
      };
    } catch (e) {
      return sender.chainFailure(e);
    }
  }

  /** One transaction taking back Cosmos-side permissions: grants, fee allowances, the
   *  rewards address and CW20 allowances. */
  async function prepare(network: NetworkId, account: AccountInfo, items: unknown): Promise<Result<SendReview>> {
    if (!Array.isArray(items) || items.length === 0) return fail("bad_request", "Nothing to revoke.");
    if (items.length > MAX_REVOKES) return fail("bad_request", `At most ${MAX_REVOKES} at once.`);
    const messages: unknown[] = [];
    for (const raw of items as RevokeItem[]) {
      const str = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= 128;
      switch (raw?.type) {
        case "authz":
          if (!str(raw.grantee) || !TYPE_URL.test(String(raw.msg_type_url))) return fail("bad_request", "Not a grant.");
          messages.push({ type: "authz_revoke", grantee: raw.grantee, msg_type_url: raw.msg_type_url });
          break;
        case "fee":
          if (!str(raw.grantee)) return fail("bad_request", "Not a fee grant.");
          messages.push({ type: "fee_revoke", grantee: raw.grantee });
          break;
        case "rewards":
          messages.push({ type: "reset_withdraw_address" });
          break;
        case "cw20":
          // Down by the most a CW20 amount can be, not by what the LCD said is left: the
          // contract clears the allowance whatever it really is.
          if (!str(raw.contract) || !str(raw.spender)) return fail("bad_request", "Not an allowance.");
          messages.push({ type: "cw20_decrease_allowance", contract: raw.contract, spender: raw.spender, amount: CW20_MAX });
          break;
        case "cw721_all":
          if (!str(raw.contract) || !str(raw.operator)) return fail("bad_request", "Not an operator.");
          messages.push({ type: "cw721_revoke_all", contract: raw.contract, operator: raw.operator });
          break;
        case "cw721_token":
          if (!str(raw.contract) || !str(raw.spender) || !isTokenId(raw.token_id)) return fail("bad_request", "Not an NFT approval.");
          messages.push({ type: "cw721_revoke", contract: raw.contract, spender: raw.spender, token_id: raw.token_id });
          break;
        default:
          return fail("bad_request", "Unknown revoke.");
      }
    }
    return sender.prepareCosmos(network, account, {
      denom: NETWORKS[network].feeDenom,
      amount: "",
      noAmount: true,
      messages: () => messages,
    });
  }

  /** `approve(spender, 0)` on one ERC20. */
  async function prepareErc20(network: NetworkId, account: AccountInfo, token: unknown, spender: unknown): Promise<Result<SendReview>> {
    if (typeof token !== "string" || !evmAddress(token) || typeof spender !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(spender)) {
      return fail("bad_request", "Not an allowance.");
    }
    return sender.prepareEvm(network, account, { denom: token, to: evmAddress(token)!, amount: "0", revoke: spender });
  }

  /** One EVM permission taken back, on Injective's EVM side or another chain (`chain`). */
  async function prepareEvmRevoke(
    network: NetworkId,
    account: AccountInfo,
    r: { chain?: unknown; kind?: unknown; contract?: unknown; spender?: unknown; token?: unknown; token_id?: unknown },
  ): Promise<Result<SendReview>> {
    const addr = (v: unknown) => (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v) ? v.toLowerCase() : null);
    const contract = addr(r.contract);
    if (!contract) return fail("bad_request", "Not a contract.");
    const kind = r.kind as EvmRevokeKind;
    const lower = (v: unknown) => String(v ?? "").toLowerCase();
    const at = (d: EvmDisplayLike) => d.to.toLowerCase() === contract;
    let call: Record<string, unknown>;
    let expect: (d: EvmDisplayLike) => string | null;
    const wrong = "The vault didn't read this as that revoke.";
    switch (kind) {
      case "erc20": {
        const spender = addr(r.spender);
        if (!spender) return fail("bad_request", "Not an allowance.");
        if (r.chain === undefined) return prepareErc20(network, account, evmDenom(contract), spender);
        call = { type: "erc20_revoke", spender };
        expect = (d) => (at(d) && d.call["type"] === "approve" && d.call["amount"] === "0" && lower(d.call["spender"]) === spender ? null : wrong);
        break;
      }
      case "nft_all": {
        const operator = addr(r.spender);
        if (!operator) return fail("bad_request", "Not an operator.");
        call = { type: "nft_revoke_all", operator };
        expect = (d) => (at(d) && d.call["selector"] === "0xa22cb465" ? null : wrong);
        break;
      }
      case "nft_token": {
        const id = typeof r.token_id === "string" && /^[0-9]{1,78}$/.test(r.token_id) ? r.token_id : null;
        if (!id) return fail("bad_request", "Not an NFT.");
        call = { type: "nft_revoke", token_id: id };
        expect = (d) => (at(d) && d.call["type"] === "approve" && /^0x0{40}$/i.test(String(d.call["spender"])) && d.call["amount"] === id ? null : wrong);
        break;
      }
      case "permit2": {
        const [token, spender] = [addr(r.token), addr(r.spender)];
        if (!token || !spender || contract !== PERMIT2) return fail("bad_request", "Not a Permit2 allowance.");
        call = { type: "permit2_revoke", token, spender };
        expect = (d) => (at(d) && ((d.call["type"] === "permit2_approve" && d.call["amount"] === "0") || d.call["selector"] === "0x87517c45") ? null : wrong);
        break;
      }
      default:
        return fail("bad_request", "Unknown revoke.");
    }
    if (r.chain === undefined) return sender.prepareEvmCall(network, account, { to: contract, amount: 0n, call, tokens: [], expect });
    const c = typeof r.chain === "string" ? chainByKey(network, r.chain) : undefined;
    if (!c || c.kind !== "evm") return fail("bad_request", "Not an EVM chain on this network.");
    return sender.prepareSourceCall(network, account, sourceOfChain(c), { to: contract, amount: 0n, call, expect });
  }

  return { summary, prepare, prepareErc20, prepareEvmRevoke };
}
