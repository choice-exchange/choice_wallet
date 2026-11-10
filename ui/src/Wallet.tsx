// The unlocked wallet: three tabs (Wallet, Activity, Settings), and the flows that open
// over them full screen (receive, a token, send, convert, manage tokens).

import { chainByKey, chainList, formatShort, NETWORKS, usdValue } from "@choice-wallet/chain";
import { useEffect, useMemo, useRef, useState } from "react";

import { AccountMark, AccountsView, isWatch } from "./Accounts";
import { AddChainView } from "./AddChain";
import { ApprovalsView } from "./Approvals";
import { BridgeView, newBridgeDraft, type BridgeDraft } from "./Bridge";
import { ChainPill, ChainSheet, chainName, type ChainRow } from "./Chains";
import { ContactsView, type Draft } from "./Contacts";
import { ActivityPane } from "./Activity";
import { merge, type ActivityState } from "./activityState";
import { Kept, KeptContext } from "./kept";
import { useBackend } from "./backend";
import { chainTotal, EvmHome, holdsLine, InjectiveHome, SolanaHome, solanaTotal } from "./Home";
import { CheckIcon, ChevronDownIcon, CopyIcon, GlobeIcon, SettingsIcon, StakeIcon, SwapIcon, WalletIcon } from "./icons";
import { formatUsd, PillTabs, Screen, shortAddress } from "./kit";
import { NftsView, NftView } from "./Nfts";
import { LiquidityPane, TradingPane } from "./Inventory";
import { RescueView } from "./Rescue";
import type { ActivityPage, Balance, ChainHoldings, ChainView, NetworkId, Nft, NftCollection, Replies, SendReview, Sent, StakingSummary, Status, TokenFilter } from "./protocol";
import { newDraft, SwapView, type SwapDraft } from "./Swap";
import { Receive } from "./Receive";
import { useRequest } from "./request";
import { Review, SendForm, SentView } from "./Send";
import { SettingsView } from "./Settings";
import { StakingView } from "./Staking";
import { ConvertForm, TokenView } from "./Token";
import { shown } from "./review";
import { applyFilter, DEFAULT_FILTER } from "./tokenFilter";
import { TokenMark } from "./TokenMark";
import { TokensView } from "./Tokens";

type Tab = "wallet" | "swap" | "bridge" | "stake";
/** The Wallet tab's panes, under its pills: Trading and Liquidity are Injective's. */
type Pane = "tokens" | "trading" | "liquidity" | "activity";

/** A flow opened over the tabs; "home" is the tabs themselves. */
type View =
  | { name: "home" }
  | { name: "accounts" }
  | { name: "receive" }
  | { name: "token"; denom: string }
  | { name: "send"; denom?: string }
  | { name: "convert"; denom: string }
  | { name: "review"; review: SendReview; entered: string; back: View; validators?: Record<string, string>; rewards?: Record<string, string>; quote?: string; bridgeQuote?: string; done?: string }
  | { name: "sent"; sent: Sent; converting: boolean; done?: string; save?: Draft; next?: string; nextBridge?: string; bridge?: { from: string; to: string; waitMs: number } }
  | { name: "settings" }
  | { name: "approvals" }
  | { name: "rescue" }
  | { name: "contacts"; prefill?: Draft }
  | { name: "nfts" }
  | { name: "nft"; collection: NftCollection; nft: Nft }
  | { name: "tokens" }
  | { name: "add_chain" };

const COSMOS = "cosmos:injective-1";
/** While the wallet is on screen, its balances are read again this often. */
const REFRESH_MS = 15_000;

const TABS: readonly (readonly [Tab, string, typeof WalletIcon])[] = [
  ["wallet", "Wallet", WalletIcon],
  ["swap", "Swap", SwapIcon],
  ["bridge", "Bridge", GlobeIcon],
  ["stake", "Stake", StakeIcon],
];

function TabBar({ tab, onTab }: { tab: Tab; onTab: (t: Tab) => void }) {
  return (
    <nav className="tabbar" aria-label="Sections">
      {TABS.map(([t, label, Icon]) => (
        <button key={t} type="button" aria-current={t === tab ? "page" : undefined} onClick={() => onTab(t)}>
          <Icon size={20} />
          <span>{label}</span>
        </button>
      ))}
    </nav>
  );
}

export function Wallet({ status, onLock, onStatus }: { status: Status; onLock: () => void; onStatus: (s?: Status) => void }) {
  const backend = useBackend();
  const [tab, setTab] = useState<Tab>("wallet");
  const [pane, setPane] = useState<Pane>("tokens");
  const [view, setView] = useState<View>({ name: "home" });
  const [balances, setBalances] = useState<Balance[] | null>(null);
  const [filter, setFilter] = useState<TokenFilter>(DEFAULT_FILTER);
  const [prices, setPrices] = useState(true);
  const [evmDown, setEvmDown] = useState(false);
  /** The account's Solana side (its own key): null for an account without one. */
  const [solana, setSolana] = useState<Replies["balances"]["solana"] | null>(null);
  /** The EVM chains beside Injective: the account's coin and USDC on each. */
  const [chains, setChains] = useState<ChainHoldings[] | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [staking, setStaking] = useState<StakingSummary | null>(null);
  const [swapDraft, setSwapDraft] = useState<SwapDraft>(() => newDraft(NETWORKS[status.network].feeDenom));
  const [swapNote, setSwapNote] = useState<string | null>(null);
  const [bridgeDraft, setBridgeDraft] = useState<BridgeDraft>(newBridgeDraft);
  const [bridgeNote, setBridgeNote] = useState<string | null>(null);
  /** When the balances on screen were read: from disk at first, then each answer. */
  const [readAt, setReadAt] = useState<number | null>(null);
  /** The chain answered for this account: what's on disk is older. */
  const answered = useRef(false);
  const [savedActivity, setSavedActivity] = useState<ActivityPage | null>(null);
  /** What the Activity tab showed, for the next visit while the popup is open. */
  const activity = useRef<ActivityState | null>(null);
  const { run, error, setError } = useRequest();

  // The last filter save, so a refresh never reads the filter before it lands.
  const saving = useRef<Promise<unknown>>(Promise.resolve());

  const account = status.accounts[status.active] ?? status.accounts[0];
  const address = account?.addresses[COSMOS] ?? "";
  const watch = isWatch(account);
  const solAddress = account?.addresses[NETWORKS[status.network].solana.caip2];
  /** The chain Home shows: the one picked, when this account has a key there. */
  const picked = chainByKey(status.network, status.chain);
  const chain: ChainView = picked && picked.kind !== "injective" && account?.addresses[picked.caip2] ? picked.key : "injective";
  /** Home is on an EVM chain beside Injective: which, and what the account holds there. */
  const evmChain = picked?.kind === "evm" && chain === picked.key ? picked : undefined;
  const evmHeld = evmChain ? (chains?.find((h) => h.chain === evmChain.key) ?? null) : null;
  const [picking, setPicking] = useState(false);
  /** What other screens read (NFTs, trading and liquidity, approvals, swap tokens), for this
   *  account and network while the popup is open. */
  const kept = useMemo(() => new Kept(), [address, status.network]);
  /** Something happened (a send, the watcher's word): every screen asks again next time. */
  const activityStale = () => {
    if (activity.current) activity.current = { ...activity.current, at: 0 };
    kept.stale();
  };
  // Another account: its balances, never the last one's while they load. What it showed
  // last comes from disk at once, while the chain is asked.
  useEffect(() => {
    setBalances(null);
    setSolana(null);
    setChains(null);
    setStaking(null);
    setReadAt(null);
    setSavedActivity(null);
    activity.current = null;
    answered.current = false;
    setSwapDraft(newDraft(NETWORKS[status.network].feeDenom));
    setBridgeDraft(newBridgeDraft());
    let live = true;
    void backend.send({ type: "snapshot" }).then((r) => {
      if (!live || !r.ok || !r.result) return;
      const { balances: b, staking: st, activity } = r.result;
      if (b && !answered.current) {
        setBalances(b.value.balances);
        setSolana(b.value.solana ?? null);
        setChains(b.value.chains ?? null);
        setFilter(b.value.filter);
        setPrices(b.value.prices);
        setReadAt(b.at);
      }
      if (st) setStaking((now) => now ?? st.value);
      if (activity) setSavedActivity(activity.value);
    });
    return () => {
      live = false;
    };
  }, [address, status.network]);

  // The wallet is open: the count on the toolbar icon is read.
  useEffect(() => {
    void backend.send({ type: "seen" }).catch(() => {});
  }, []);

  // Read again every few seconds while the wallet is on screen, and whenever the host says
  // something landed.
  useEffect(() => {
    const again = () => {
      if (document.visibilityState === "visible") setRefresh((n) => n + 1);
    };
    const timer = setInterval(again, REFRESH_MS);
    const off = backend.onRefresh?.(() => {
      activityStale();
      again();
    });
    return () => {
      clearInterval(timer);
      off?.();
    };
  }, []);

  useEffect(() => {
    if (view.name !== "home" || tab !== "wallet") return;
    let live = true;
    // Staking loads beside the balances; if it fails the wallet still shows.
    // A failure keeps what's on screen (the saved summary, or the last answer).
    void backend.send({ type: "staking" }).then((r) => live && r.ok && setStaking(r.result));
    void saving.current.then(() => run({ type: "balances" })).then((r) => {
      if (live && r) {
        setBalances(r.balances);
        setSolana(r.solana ?? null);
        setChains(r.chains ?? []);
        setFilter(r.filter);
        setPrices(r.prices);
        setEvmDown(r.evmDown === true);
        setReadAt(Date.now());
        answered.current = true;
      }
    });
    return () => {
      live = false;
    };
  }, [view.name, tab, refresh, status.network, address]);

  /** Back to the tabs, on the one in use: a flow started from Stake ends on Stake. */
  const home = () => {
    setRefresh((n) => n + 1);
    setView({ name: "home" });
  };
  const tabs = (
    <TabBar
      tab={tab}
      onTab={(t) => {
        if (t === "wallet" && tab !== "wallet") setRefresh((n) => n + 1);
        // A bridge not started yet goes from the chain on screen, as each chain's Bridge
        // button did.
        if (t === "bridge" && tab !== "bridge" && !bridgeDraft.amount) openBridge(chain);
        setTab(t);
      }}
    />
  );
  /** Apply a filter change now; put it back if the host refuses it. */
  const changeFilter = (next: TokenFilter) => {
    const before = filter;
    setFilter(next);
    saving.current = saving.current
      .then(() => backend.send({ type: "save_token_filter", filter: next }))
      .then((r) => {
        if (!r.ok) {
          setFilter(before);
          setError(r.error.message);
        }
      });
  };
  /** Add a token by contract; null when it worked, else what went wrong. */
  const addToken = async (contract: string): Promise<string | null> => {
    await saving.current;
    const r = await backend.send({ type: "add_token", address: contract });
    if (!r.ok) return r.error.message;
    setFilter(r.result.filter);
    const b = await backend.send({ type: "balances" });
    if (b.ok) {
      setBalances(b.result.balances);
      setFilter(b.result.filter);
      setEvmDown(b.result.evmDown === true);
    }
    return null;
  };
  const sorted = balances ? applyFilter(balances, filter, NETWORKS[status.network].feeDenom) : null;
  const injPrice = balances?.find((b) => b.denom === "inj")?.priceUsd;
  // Staked, unstaking and unclaimed INJ are still yours: they count in the total.
  const stakedAll = staking ? BigInt(staking.staked) + BigInt(staking.unbondingTotal) + BigInt(staking.rewards) : 0n;
  const totalUsd = sorted?.totalUsd === undefined ? undefined : sorted.totalUsd + (injPrice && prices ? usdValue(stakedAll.toString(), 18, injPrice) : 0);
  const solTotal = solana ? solanaTotal(solana.balances, prices) : null;

  /** Show another chain, or switch between mainnet and the test networks (the sheet stays
   *  open for that, its totals reading again). */
  async function pickChain(next: ChainView, network: NetworkId = status.network) {
    const r = await backend.send({ type: "pick_chain", chain: next, network });
    if (!r.ok) {
      setError(r.error.message);
      return;
    }
    if (network === status.network) setPicking(false);
    onStatus(r.result);
  }
  /** Each chain in the picker, with what the account holds there: Injective, Solana, then
   *  the EVM chains, those holding something first. */
  const evmRows = chainList(status.network)
    .filter((c) => c.kind === "evm")
    .map((c) => {
      const h = chains?.find((x) => x.chain === c.key);
      const t = h ? chainTotal(c, h.balances, prices) : null;
      const row: ChainRow = {
        chain: c.key,
        ...(account?.addresses[c.caip2] ? { address: account.addresses[c.caip2]! } : {}),
        total: t?.text ?? (chains === null ? null : `0 ${c.native.symbol}`),
        holds: h ? holdsLine(h.balances) : "",
      };
      return { row, usd: t?.usd, held: h?.balances.some((b) => BigInt(b.amount) > 0n) === true };
    });
  const chainRows: ChainRow[] = [
    {
      chain: "injective",
      address,
      total: balances === null ? null : totalUsd !== undefined ? formatUsd(totalUsd) : `${formatShort((BigInt(balances.find((b) => b.denom === "inj")?.amount ?? "0") + stakedAll).toString(), 18, 4)} INJ`,
      holds: sorted?.shown.length ? `${sorted.shown.length} ${sorted.shown.length === 1 ? "token" : "tokens"}` : "",
    },
    {
      chain: "solana",
      ...(solAddress ? { address: solAddress } : {}),
      // A Ledger account's Solana key comes from the device's Solana app.
      ...(!solAddress && account?.account.derivation === "ledger" && backend.ledger && backend.openLedgerPage
        ? { add: { label: "Add from your Ledger", run: () => backend.openLedgerPage?.("solana") } }
        : {}),
      total: solTotal?.text ?? (balances === null ? null : "0 SOL"),
      holds: solana ? holdsLine(solana.balances) : "",
    },
    ...evmRows.filter((r) => r.held).map((r) => r.row),
    ...evmRows.filter((r) => !r.held).map((r) => r.row),
  ];
  // Every chain together, when each one's total is in USD.
  const everyUsd = totalUsd !== undefined && (!solAddress || solTotal?.usd !== undefined) && chains !== null && evmRows.every((r) => !r.row.address || r.usd !== undefined);
  const allUsd = everyUsd ? formatUsd(totalUsd + (solTotal?.usd ?? 0) + evmRows.reduce((t, r) => t + (r.usd ?? 0), 0)) : undefined;

  /** The next step of a swap, once the last one landed; back to the form if its quote ran out. */
  async function nextSwapStep(quote: string) {
    const r = await backend.send({ type: "prepare_swap", quote });
    if (r.ok) {
      setView({ name: "review", review: r.result, entered: "", back: { name: "home" }, quote });
      return;
    }
    setSwapNote(r.error.message);
    setTab("swap");
    setView({ name: "home" });
  }

  /** A bridge transfer's next step (the burn, after its approval landed); back to the form if
   *  its quote ran out. */
  async function nextBridgeStep(quote: string) {
    const r = await backend.send({ type: "prepare_bridge", quote });
    if (r.ok) {
      setView({ name: "review", review: r.result, entered: "", back: { name: "home" }, bridgeQuote: quote });
      return;
    }
    setBridgeNote(r.error.message);
    setTab("bridge");
    setView({ name: "home" });
  }

  /** Mint a transfer on its destination from this account, when nobody has. */
  async function finishBridge(from: string, hash: string) {
    const r = await backend.send({ type: "prepare_bridge_receive", from, hash });
    if (r.ok) {
      setView({ name: "review", review: r.result, entered: "", back: { name: "home" } });
      return;
    }
    setBridgeNote(r.error.message);
    setTab("bridge");
    setView({ name: "home" });
  }

  /** The bridge form, from `from` (empty: wherever the USDC is), to Injective unless that's
   *  where it starts. */
  function openBridge(from: string) {
    setBridgeDraft((d) => ({ ...d, from, to: d.to && d.to !== from ? d.to : from === "injective" ? "" : "injective" }));
    setTab("bridge");
    setView({ name: "home" });
  }

  return <KeptContext.Provider value={kept}>{screen()}</KeptContext.Provider>;

  function screen() {
    switch (view.name) {
      case "accounts":
        return <AccountsView status={status} onStatus={(s) => onStatus(s)} onBack={home} />;
      case "receive":
        return (
          <Receive
            addresses={account?.addresses ?? {}}
            network={status.network}
            chain={chain}
            ledger={account?.account.derivation === "ledger"}
            onBack={home}
            onBridgeIn={() => openBridge("")}
          />
        );
      case "tokens":
        return (
          <TokensView
            balances={balances ?? []}
            filter={filter}
            network={status.network}
            prices={prices}
            onChange={changeFilter}
            onAdd={addToken}
            onBack={() => setView({ name: "home" })}
          />
        );
      case "token": {
        const t = balances?.find((b) => b.denom === view.denom);
        if (!t) return null;
        return (
          <TokenView
            token={t}
            feeDenom={NETWORKS[status.network].feeDenom}
            canSign={!watch}
            onSend={() => setView({ name: "send", denom: t.denom })}
            onConvert={() => setView({ name: "convert", denom: t.denom })}
            {...(t.denom.toLowerCase() === `erc20:${NETWORKS[status.network].cctp.usdc}`.toLowerCase() ? { onBridge: () => openBridge("injective") } : {})}
            onBack={home}
          />
        );
      }
      case "send":
        return (
          <SendForm
            balances={
              chain === "solana"
                ? (solana?.balances ?? []).filter((b) => BigInt(b.amount) > 0n)
                : evmChain
                  ? (evmHeld?.balances ?? []).filter((b) => BigInt(b.amount) > 0n)
                  : (sorted?.shown ?? [])
            }
            accounts={status.accounts.filter((_, i) => i !== status.active)}
            denom={view.denom}
            onReview={(review, entered, denom) => setView({ name: "review", review, entered, back: { name: "send", denom } })}
            onBack={home}
          />
        );
      case "convert": {
        const t = balances?.find((b) => b.denom === view.denom);
        if (!t) return null;
        return (
          <ConvertForm
            token={t}
            onReview={(review) => setView({ name: "review", review, entered: "", back: { name: "convert", denom: t.denom } })}
            onBack={() => setView({ name: "token", denom: t.denom })}
          />
        );
      }
      case "settings":
        return (
          <SettingsView
            status={status}
            onStatus={(s) => onStatus(s)}
            onLock={onLock}
            onApprovals={() => setView({ name: "approvals" })}
            onRescue={() => setView({ name: "rescue" })}
            onContacts={() => setView({ name: "contacts" })}
            onBack={home}
            onDone={() => {
              onStatus();
              home();
            }}
          />
        );
      case "rescue":
        return <RescueView status={status} onReview={(review) => setView({ name: "review", review, entered: "", back: { name: "rescue" }, done: "Confirmed" })} onBack={() => setView({ name: "settings" })} />;
      case "approvals":
        return <ApprovalsView canSign={!watch} onReview={(review) => setView({ name: "review", review, entered: "", back: { name: "approvals" }, done: "Confirmed" })} onBack={() => setView({ name: "settings" })} />;
      case "review":
        return (
          <Review
            review={view.review}
            entered={view.entered}
            network={status.network}
            {...(view.validators ? { validators: view.validators } : {})}
            {...(view.rewards ? { rewards: view.rewards } : {})}
            onSent={(sent) => {
              activityStale();
              const back = view.back;
              // What a conversion makes is what the user asked for: show it, like a token added by hand.
              const made = back.name === "convert" ? balances?.find((b) => b.denom === back.denom)?.convertsTo : undefined;
              if (made && !filter.shown.includes(made)) changeFilter({ ...filter, shown: [...filter.shown, made], hidden: filter.hidden.filter((x) => x !== made) });
              // A send to an address the review didn't name (no contact, not an account here): offer to save it.
              const sentTo = back.name === "send" ? shown(view.review.display, status.network) : null;
              const named = view.review.risk.findings.some((f) => f.rule === "address_book");
              // (The address book holds Injective addresses, not Solana's yet.)
              const save = sentTo && sentTo.sends.length === 1 && !named && view.review.display.kind !== "solana_transaction" ? { address: sentTo.sends[0]!.to, memo: sentTo.memo } : undefined;
              const step = view.review.swap;
              const crossing = view.review.bridge;
              setView({
                name: "sent",
                sent,
                converting: back.name === "convert",
                ...(view.done ? { done: view.done } : {}),
                ...(step ? { done: step.step === "swap" ? "Swapped" : "Approved" } : {}),
                ...(step && step.left > 0 && view.quote ? { next: view.quote } : {}),
                ...(crossing?.step === "approve" ? { done: "Approved", ...(view.bridgeQuote ? { nextBridge: view.bridgeQuote } : {}) } : {}),
                // Into Injective on mainnet Choice's bridge service mints it; this account is
                // offered to once it had a minute.
                ...(crossing?.step === "burn" ? { bridge: { from: crossing.fromKey, to: crossing.to, waitMs: crossing.toKey === "injective" && crossing.delivery === "anyone" && status.network === "mainnet" ? 60_000 : 0 } } : {}),
                ...(crossing?.step === "receive" ? { done: "Minted" } : {}),
                ...(save ? { save } : {}),
              });
            }}
            onCancel={() => setView(view.back)}
          />
        );
      case "sent":
        return (
          <SentView
            sent={view.sent}
            onDone={home}
            onSave={view.save ? () => setView({ name: "contacts", prefill: view.save! }) : undefined}
            onNext={view.next ? () => void nextSwapStep(view.next!) : view.nextBridge ? () => void nextBridgeStep(view.nextBridge!) : undefined}
            converting={view.converting}
            bridge={view.bridge}
            finishAfterMs={view.bridge?.waitMs ?? 0}
            onFinish={view.bridge ? () => void finishBridge(view.bridge!.from, view.sent.hash) : undefined}
            {...(view.done ? { done: view.done } : {})}
          />
        );
      case "contacts":
        return <ContactsView prefill={view.prefill} onBack={home} />;
      case "add_chain":
        return (
          <AddChainView
            network={status.network}
            onAdded={(s, key, network) => {
              onStatus(s);
              void pickChain(key, network).then(() => {
                setPicking(false);
                setTab("wallet");
                setView({ name: "home" });
              });
            }}
            onBack={home}
          />
        );
      case "nfts":
        return <NftsView canSign={!watch} onOpen={(collection, nft) => setView({ name: "nft", collection, nft })} onBack={home} />;
      case "nft":
        return (
          <NftView
            collection={view.collection}
            nft={view.nft}
            canSign={!watch}
            accounts={status.accounts}
            onReview={(review, entered) => setView({ name: "review", review, entered, back: { name: "nft", collection: view.collection, nft: view.nft } })}
            onBack={() => setView({ name: "nfts" })}
          />
        );
      case "home": {
        if (tab === "bridge") {
          return (
            <BridgeView
              key={`${address} ${status.network}`}
              network={status.network}
              canSign={!watch}
              draft={bridgeDraft}
              onDraft={setBridgeDraft}
              note={bridgeNote}
              onReview={(review, quote) => {
                setBridgeNote(null);
                setView({ name: "review", review, entered: "", back: { name: "home" }, ...(quote ? { bridgeQuote: quote } : {}) });
              }}
              onFinish={(from, hash) => void finishBridge(from, hash)}
              tabs={tabs}
            />
          );
        }
        if (tab === "stake") {
          return (
            <StakingView
              key={`${address} ${status.network}`}
              initial={staking}
              canSign={!watch}
              onReview={(review, validators, rewards) => setView({ name: "review", review, entered: "", back: { name: "home" }, validators, rewards, done: "Confirmed" })}
              tabs={tabs}
              head={null}
            />
          );
        }
        if (tab === "swap" && chain !== "injective") {
          return (
            <Screen tabs={tabs} top={<span className="title">Swap</span>}>
              <div className="surface-hero">
                <TokenMark denom="inj" symbol="INJ" known />
                <p className="lead">Swaps run on Injective. Bring USDC over from {chainName(chain, status.network)} to swap it.</p>
              </div>
              <button
                className="btn btn-gold"
                onClick={() => openBridge(chain)}
              >
                Bridge USDC
              </button>
              <button className="btn btn-quiet" onClick={() => void pickChain("injective")}>
                Use Injective
              </button>
            </Screen>
          );
        }
        if (tab === "swap") {
          return (
            <SwapView
              key={`${address} ${status.network}`}
              network={status.network}
              canSign={!watch}
              draft={swapDraft}
              onDraft={setSwapDraft}
              note={swapNote}
              onReview={(review, quote) => {
                setSwapNote(null);
                setView({ name: "review", review, entered: "", back: { name: "home" }, quote: quote.id });
              }}
              tabs={tabs}
            />
          );
        }
        // The Wallet tab: the chain's figure, Send and Receive, and its panes under pills.
        const panes: readonly (readonly [Pane, string])[] =
          chain === "injective"
            ? [
                ["tokens", "Tokens"],
                ["trading", "Trading"],
                ["liquidity", "Liquidity"],
                ["activity", "Activity"],
              ]
            : [
                ["tokens", "Tokens"],
                ["activity", "Activity"],
              ];
        const shownPane: Pane = panes.some(([p]) => p === pane) ? pane : "tokens";
        const pills = <PillTabs label="Wallet" options={panes} value={shownPane} onChange={setPane} />;
        const paneBody =
          shownPane === "activity" ? (
            chain === "solana" ? (
              <ActivityPane key={`${address} solana`} network={status.network} chain="solana" />
            ) : evmChain ? (
              <ActivityPane key={`${address} ${evmChain.key}`} network={status.network} chain={evmChain.key} />
            ) : (
              // This session's, or else the copy saved on disk (shown, then read again).
              <ActivityPane
                key={address}
                network={status.network}
                chain="injective"
                kept={activity.current ?? (savedActivity ? merge(null, savedActivity, 1, 0) : null)}
                onKeep={(s) => (activity.current = s)}
              />
            )
          ) : shownPane === "trading" ? (
            <TradingPane canSign={!watch} onReview={(review) => setView({ name: "review", review, entered: "", back: { name: "home" }, done: "Confirmed" })} />
          ) : shownPane === "liquidity" ? (
            <LiquidityPane />
          ) : null;
        const openAccounts = () => setView({ name: "accounts" });
        return (
          <Screen
            tabs={tabs}
            top={
              <>
                <div className="account-head">
                  {account && (
                    // The mark opens the accounts too; the name beside it is the button screen readers get.
                    <span className="account-head-mark" aria-hidden="true" onClick={openAccounts}>
                      <AccountMark a={account} index={status.active} />
                    </span>
                  )}
                  <button className="account-switch" aria-label={`Account: ${account?.name ?? ""}. Switch accounts`} onClick={openAccounts}>
                    <span className="account-name">{account?.name}</span>
                    <ChevronDownIcon size={16} />
                  </button>
                  <CopyAddress address={chain !== "injective" ? (account?.addresses[picked?.caip2 ?? ""] ?? address) : address} />
                </div>
                <ChainPill chain={chain} network={status.network} onClick={() => setPicking(true)} />
                {/* Lock is in Settings ("Lock now"), and the wallet locks itself when idle. */}
                <button className="icon-btn" aria-label="Settings" onClick={() => setView({ name: "settings" })}>
                  <SettingsIcon />
                </button>
              </>
            }
            overlay={
              picking && (
                <ChainSheet
                  chain={chain}
                  network={status.network}
                  rows={chainRows}
                  {...(allUsd ? { all: allUsd } : {})}
                  onPick={(c) => void pickChain(c)}
                  onTestnet={(on) => void pickChain(chain, on ? "testnet" : "mainnet")}
                  onAdd={() => {
                    setPicking(false);
                    setView({ name: "add_chain" });
                  }}
                  onClose={() => setPicking(false)}
                />
              )
            }
          >
            {chain === "solana" && solAddress ? (
              <SolanaHome
                network={status.network}
                holdings={solana ?? null}
                total={solTotal}
                watch={watch}
                onSend={(denom) => setView({ name: "send", ...(denom ? { denom } : {}) })}
                onReceive={() => setView({ name: "receive" })}
                onBridge={() => openBridge("solana")}
                pills={pills}
                pane={paneBody}
              />
            ) : evmChain ? (
              <EvmHome
                chain={evmChain}
                holdings={evmHeld}
                total={evmHeld ? chainTotal(evmChain, evmHeld.balances, prices) : null}
                watch={watch}
                onSend={(denom) => setView({ name: "send", ...(denom ? { denom } : {}) })}
                onReceive={() => setView({ name: "receive" })}
                pills={pills}
                pane={paneBody}
              />
            ) : (
              <InjectiveHome
                balances={balances}
                sorted={sorted}
                totalUsd={totalUsd}
                stakedAll={stakedAll}
                injPrice={injPrice}
                prices={prices}
                staking={staking}
                watch={watch}
                error={error}
                readAt={readAt}
                evmDown={evmDown}
                onSend={() => setView({ name: "send" })}
                onReceive={() => setView({ name: "receive" })}
                onStake={() => setTab("stake")}
                onTokens={() => setView({ name: "tokens" })}
                onToken={(denom) => setView({ name: "token", denom })}
                onNfts={() => setView({ name: "nfts" })}
                pills={pills}
                pane={paneBody}
              />
            )}
          </Screen>
        );
      }
    }
  }
}

/** The account's address under its name: copies on a click. */
function CopyAddress({ address }: { address: string }) {
  const backend = useBackend();
  const [copied, setCopied] = useState(false);
  return (
    <button
      className={copied ? "address-copy copied" : "address-copy"}
      title={address}
      aria-label="Copy address"
      onClick={() =>
        void backend.copy(address).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        })
      }
    >
      <span className="mono">{copied ? "Copied" : shortAddress(address)}</span>
      {copied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
    </button>
  );
}
