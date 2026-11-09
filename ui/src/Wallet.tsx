// The unlocked wallet: three tabs (Wallet, Activity, Settings), and the flows that open
// over them full screen (receive, a token, send, convert, manage tokens).

import { formatShort, NETWORKS, shortDenom, usdValue } from "@choice-wallet/chain";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { AccountMark, AccountsView, isWatch } from "./Accounts";
import { ApprovalsView } from "./Approvals";
import { BridgeView, newBridgeDraft, type BridgeDraft } from "./Bridge";
import { ContactsView, type Draft } from "./Contacts";
import { ActivityView } from "./Activity";
import { merge, type ActivityState } from "./activityState";
import { Kept, KeptContext } from "./kept";
import { useBackend } from "./backend";
import { ActivityIcon, CheckIcon, ChevronDownIcon, ChevronRightIcon, CopyIcon, EyeOffIcon, LockIcon, ReceiveIcon, SendIcon, SettingsIcon, StakeIcon, SwapIcon, WalletIcon } from "./icons";
import { BackBar, Callout, formatUsd, Screen, Segmented, shortAddress, tokenSub } from "./kit";
import { NftsView, NftView } from "./Nfts";
import { InventoryScreen } from "./Inventory";
import { RescueView } from "./Rescue";
import type { ActivityPage, Balance, NetworkId, Nft, NftCollection, Replies, SendReview, Sent, StakingSummary, Status, TokenFilter } from "./protocol";
import { newDraft, SwapView, type SwapDraft } from "./Swap";
import { QrCode } from "./QrCode";
import { useRequest } from "./request";
import { Review, SendForm, SentView } from "./Send";
import { SettingsView } from "./Settings";
import { StakingView } from "./Staking";
import { ConvertForm, TokenView } from "./Token";
import { shown } from "./review";
import { applyFilter, DEFAULT_FILTER } from "./tokenFilter";
import { TokenMark } from "./TokenMark";
import { TokensView } from "./Tokens";

type Tab = "wallet" | "swap" | "activity" | "settings";

/** A flow opened over the tabs; "home" is the tabs themselves. */
type View =
  | { name: "home" }
  | { name: "accounts" }
  | { name: "receive" }
  | { name: "token"; denom: string }
  | { name: "send"; denom?: string }
  | { name: "convert"; denom: string }
  | { name: "review"; review: SendReview; entered: string; back: View; validators?: Record<string, string>; rewards?: Record<string, string>; quote?: string; bridgeQuote?: string; bridgeInQuote?: string }
  | { name: "sent"; sent: Sent; converting: boolean; done?: string; save?: Draft; next?: string; nextBridge?: string; nextBridgeIn?: string; bridge?: { chain: string }; bridgeIn?: { chain: string } }
  | { name: "bridge" }
  | { name: "staking" }
  | { name: "approvals" }
  | { name: "rescue" }
  | { name: "inventory" }
  | { name: "contacts"; prefill?: Draft }
  | { name: "nfts" }
  | { name: "nft"; collection: NftCollection; nft: Nft }
  | { name: "tokens" };

const COSMOS = "cosmos:injective-1";
const EVM = "eip155:1776";
/** While the wallet is on screen, its balances are read again this often. */
const REFRESH_MS = 15_000;

/** "just now", "4 min ago", "2 h ago", "3 days ago". */
export function ago(at: number, now = Date.now()): string {
  const m = Math.floor((now - at) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  const days = Math.floor(h / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

const TABS: readonly (readonly [Tab, string, typeof WalletIcon])[] = [
  ["wallet", "Wallet", WalletIcon],
  ["swap", "Swap", SwapIcon],
  ["activity", "Activity", ActivityIcon],
  ["settings", "Settings", SettingsIcon],
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
  const [view, setView] = useState<View>({ name: "home" });
  const [balances, setBalances] = useState<Balance[] | null>(null);
  const [filter, setFilter] = useState<TokenFilter>(DEFAULT_FILTER);
  const [prices, setPrices] = useState(true);
  const [evmDown, setEvmDown] = useState(false);
  /** The account's Solana side (its own key): null for an account without one. */
  const [solana, setSolana] = useState<Replies["balances"]["solana"] | null>(null);
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

  const home = () => {
    setRefresh((n) => n + 1);
    setTab("wallet");
    setView({ name: "home" });
  };
  const tabs = (
    <TabBar
      tab={tab}
      onTab={(t) => {
        if (t === "wallet" && tab !== "wallet") setRefresh((n) => n + 1);
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
      setView({ name: "review", review: r.result, entered: "", back: { name: "bridge" }, bridgeQuote: quote });
      return;
    }
    setBridgeNote(r.error.message);
    setView({ name: "bridge" });
  }

  /** A transfer in's next step (the burn, after its approval landed on that chain). */
  async function nextBridgeInStep(quote: string) {
    const r = await backend.send({ type: "prepare_bridge_in", quote });
    if (r.ok) {
      setView({ name: "review", review: r.result, entered: "", back: { name: "bridge" }, bridgeInQuote: quote });
      return;
    }
    setBridgeNote(r.error.message);
    setView({ name: "bridge" });
  }

  /** Mint a transfer in on Injective from this account, when nobody has. */
  async function finishBridgeIn(chain: string, hash: string) {
    const r = await backend.send({ type: "prepare_bridge_receive", chain, hash });
    if (r.ok) {
      setView({ name: "review", review: r.result, entered: "", back: { name: "bridge" } });
      return;
    }
    setBridgeNote(r.error.message);
    setView({ name: "bridge" });
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
            onBack={home}
            onBridgeIn={() => {
              setBridgeDraft((d) => ({ ...d, dir: "in" }));
              setView({ name: "bridge" });
            }}
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
            {...(t.denom.toLowerCase() === `erc20:${NETWORKS[status.network].cctp.usdc}`.toLowerCase() ? { onBridge: () => setView({ name: "bridge" }) } : {})}
            onBack={home}
          />
        );
      }
      case "send":
        return (
          <SendForm
            balances={[...(sorted?.shown ?? []), ...(solana?.balances ?? []).filter((b) => BigInt(b.amount) > 0n)]}
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
      case "staking":
        return (
          <StakingView
            initial={staking}
            canSign={!watch}
            onReview={(review, validators, rewards) => setView({ name: "review", review, entered: "", back: { name: "staking" }, validators, rewards })}
            onBack={home}
          />
        );
      case "inventory":
        return <InventoryScreen canSign={!watch} onReview={(review) => setView({ name: "review", review, entered: "", back: { name: "inventory" } })} onBack={() => setView({ name: "home" })} />;
      case "rescue":
        return <RescueView status={status} onReview={(review) => setView({ name: "review", review, entered: "", back: { name: "rescue" } })} onBack={() => setView({ name: "home" })} />;
      case "approvals":
        return <ApprovalsView canSign={!watch} onReview={(review) => setView({ name: "review", review, entered: "", back: { name: "approvals" } })} onBack={() => setView({ name: "home" })} />;
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
              const arriving = view.review.bridgeIn;
              setView({
                name: "sent",
                sent,
                converting: back.name === "convert",
                ...(back.name === "staking" || back.name === "approvals" || back.name === "rescue" || back.name === "inventory" ? { done: "Confirmed" } : {}),
                ...(step ? { done: step.step === "swap" ? "Swapped" : "Approved" } : {}),
                ...(step && step.left > 0 && view.quote ? { next: view.quote } : {}),
                ...(crossing?.step === "approve" ? { done: "Approved", ...(view.bridgeQuote ? { nextBridge: view.bridgeQuote } : {}) } : {}),
                ...(crossing?.step === "burn" ? { bridge: { chain: crossing.chain } } : {}),
                ...(arriving?.step === "approve" ? { done: "Approved", ...(view.bridgeInQuote ? { nextBridgeIn: view.bridgeInQuote } : {}) } : {}),
                ...(arriving?.step === "burn" ? { bridgeIn: { chain: arriving.chain } } : {}),
                ...(arriving?.step === "receive" ? { done: "Minted" } : {}),
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
            onNext={view.next ? () => void nextSwapStep(view.next!) : view.nextBridge ? () => void nextBridgeStep(view.nextBridge!) : view.nextBridgeIn ? () => void nextBridgeInStep(view.nextBridgeIn!) : undefined}
            converting={view.converting}
            bridge={view.bridge}
            bridgeIn={view.bridgeIn}
            finishAfterMs={status.network === "testnet" ? 0 : 60_000}
            onFinish={view.bridgeIn && view.sent.chain ? () => void finishBridgeIn(view.sent.chain!, view.sent.hash) : undefined}
            {...(view.done ? { done: view.done } : {})}
          />
        );
      case "contacts":
        return <ContactsView prefill={view.prefill} onBack={home} />;
      case "bridge":
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
              setView({ name: "review", review, entered: "", back: { name: "bridge" }, ...(quote.dir === "in" ? { bridgeInQuote: quote.id } : { bridgeQuote: quote.id }) });
            }}
            onFinish={(chain, hash) => void finishBridgeIn(chain, hash)}
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
        if (tab === "activity") {
          // This session's, or else the copy saved on disk (shown, then read again).
          const kept = activity.current ?? (savedActivity ? merge(null, savedActivity, 1, 0) : null);
          return <ActivityView key={address} network={status.network} tabs={tabs} kept={kept} onKeep={(s) => (activity.current = s)} />;
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
        if (tab === "settings") {
          return (
            <SettingsView
              status={status}
              onStatus={(s) => onStatus(s)}
              tabs={tabs}
              onLock={onLock}
              onApprovals={() => setView({ name: "approvals" })}
              onRescue={() => setView({ name: "rescue" })}
              onContacts={() => setView({ name: "contacts" })}
              onDone={() => {
                onStatus();
                home();
              }}
            />
          );
        }
        const inj = balances?.find((b) => b.denom === "inj");
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
                  <CopyAddress address={address} />
                </div>
                <button className="pill" onClick={() => setTab("settings")} aria-label={`Network: ${status.network}`}>
                  <span className={status.network === "testnet" ? "dot testnet" : "dot"} />
                  {status.network === "testnet" ? "Testnet" : "Mainnet"}
                </button>
                <button className="icon-btn" aria-label="Lock" onClick={onLock}>
                  <LockIcon />
                </button>
              </>
            }
          >
            {/* Everything the account holds, staking included: in USD when Choice prices
                something here, otherwise in INJ. */}
            <section className="balance-head" aria-label="Total balance">
              {balances === null ? (
                <div className="skeleton" style={{ width: 168, height: 40, margin: "3px auto" }} />
              ) : totalUsd === undefined ? (
                <Figure text={formatShort((BigInt(inj?.amount ?? "0") + stakedAll).toString(), 18, 4)} unit="INJ" />
              ) : (
                <Figure text={formatUsd(totalUsd)} />
              )}
              <div className="balance-sub">
                {watch && <span className="flag quiet">Watch-only</span>}
                {balances !== null && stakedAll > 0n && (
                  <span>Includes {totalUsd !== undefined && injPrice && prices ? formatUsd(usdValue(stakedAll.toString(), 18, injPrice)) : `${formatShort(stakedAll, 18, 4)} INJ`} staked</span>
                )}
              </div>
            </section>
            <div className="quick-actions">
              <QuickAction label="Send" gold disabled={watch || !sorted?.shown.length} onClick={() => setView({ name: "send" })}>
                <SendIcon size={20} />
              </QuickAction>
              <QuickAction label="Receive" onClick={() => setView({ name: "receive" })}>
                <ReceiveIcon size={20} />
              </QuickAction>
              <QuickAction label="Swap" onClick={() => setTab("swap")}>
                <SwapIcon size={20} />
              </QuickAction>
              <QuickAction label="Stake" onClick={() => setView({ name: "staking" })}>
                <StakeIcon size={20} />
              </QuickAction>
            </div>

            <div className="section-head">
              <span className="eyebrow">Tokens{sorted?.shown.length ? ` · ${sorted.shown.length}` : ""}</span>
              {balances !== null && balances.length > 0 && (
                <button className="link" onClick={() => setView({ name: "tokens" })}>
                  Manage
                </button>
              )}
            </div>
            {error && balances !== null && readAt !== null ? (
              <p className="meta warn">Couldn&apos;t update. Showing balances from {ago(readAt)}.</p>
            ) : (
              error && <Callout level="amber">{error}</Callout>
            )}
            {sorted === null ? (
              !error && [0, 1, 2].map((i) => <div key={i} className="skeleton" style={{ height: 40 }} />)
            ) : sorted.shown.length === 0 && sorted.hidden.length === 0 ? (
              <p className="empty">No tokens yet. Use Receive to get your address.</p>
            ) : (
              <div className="token-list">
                {sorted.shown.map((b) => (
                  <button
                    key={b.denom}
                    className="token"
                    title={b.denom}
                    onClick={() => setView({ name: "token", denom: b.denom })}
                  >
                    <TokenMark denom={b.denom} symbol={b.symbol} known={b.known} />
                    <span className="name">
                      <span className="symbol">{b.symbol}</span>
                      <span className={b.known ? "sub" : "sub denom"}>{tokenSub(b)}</span>
                    </span>
                    <HoldingValue amount={formatShort(b.amount, b.decimals)} symbol={b.symbol} usd={b.usd} />
                  </button>
                ))}
                {sorted.hidden.length > 0 && (
                  <button className="hidden-row" onClick={() => setView({ name: "tokens" })}>
                    <EyeOffIcon size={16} />
                    {sorted.hidden.length} hidden {sorted.hidden.length === 1 ? "token" : "tokens"}
                    <ChevronRightIcon size={16} />
                  </button>
                )}
              </div>
            )}
            {/* The account's Solana key: shown once it holds something there (Receive has its address). */}
            {solana && (solana.down || solana.balances.some((b) => BigInt(b.amount) > 0n)) && (
              <>
                <div className="section-head">
                  <span className="eyebrow">{NETWORKS[status.network].solana.name}</span>
                  <span className="meta mono">{shortAddress(solana.address)}</span>
                </div>
                {solana.down && <p className="meta warn">{NETWORKS[status.network].solana.name} didn&apos;t answer. Its balances may be missing.</p>}
                <div className="token-list">
                  {solana.balances
                    .filter((b) => b.denom === "sol" || BigInt(b.amount) > 0n)
                    .map((b) => (
                      <button key={b.denom} className="token" title={b.denom} disabled={watch} onClick={() => setView({ name: "send", denom: b.denom })}>
                        <TokenMark denom={b.denom} symbol={b.symbol} known={b.known} />
                        <span className="name">
                          <span className="symbol">{b.symbol}</span>
                          <span className={b.known ? "sub" : "sub denom"}>{b.denom === "sol" ? "Solana" : b.known ? `${b.name} on Solana` : tokenSub(b)}</span>
                        </span>
                        <HoldingValue amount={formatShort(b.amount, b.decimals)} symbol={b.symbol} usd={b.usd} />
                      </button>
                    ))}
                </div>
              </>
            )}
            {/* Staked, unstaking and unclaimed INJ. Nothing staked: the Stake button above. */}
            {staking && stakedAll > 0n && (
              <>
                <div className="section-head">
                  <span className="eyebrow">Staking</span>
                </div>
                <button className="token" onClick={() => setView({ name: "staking" })}>
                  <TokenMark denom="inj" symbol="INJ" known />
                  <span className="name">
                    <span className="symbol">Staked INJ</span>
                    <span className="sub">{BigInt(staking.rewards) > 0n ? `Rewards ${formatShort(staking.rewards, 18, 4)} INJ` : "Earning rewards"}</span>
                  </span>
                  <HoldingValue amount={formatShort(stakedAll, 18, 4)} symbol="INJ" usd={injPrice && prices ? usdValue(stakedAll.toString(), 18, injPrice) : undefined} />
                </button>
              </>
            )}
            <div className="section-head">
              <span className="eyebrow">More</span>
            </div>
            <button className="token" onClick={() => setView({ name: "bridge" })}>
              <TokenMark denom={`erc20:${NETWORKS[status.network].cctp.usdc}`} symbol="USDC" known />
              <span className="name">
                <span className="symbol">Bridge USDC</span>
                <span className="sub">To Base, Solana and more, by Circle</span>
              </span>
              <ChevronRightIcon size={16} />
            </button>
            <button className="token" onClick={() => setView({ name: "inventory" })}>
              <span className="nft-tile small" aria-hidden="true">
                LP
              </span>
              <span className="name">
                <span className="symbol">Trading and liquidity</span>
                <span className="sub">Orderbook accounts, Choice pools</span>
              </span>
              <ChevronRightIcon size={16} />
            </button>
            <button className="token" onClick={() => setView({ name: "nfts" })}>
              <span className="nft-tile small" aria-hidden="true">
                NFT
              </span>
              <span className="name">
                <span className="symbol">NFTs</span>
                <span className="sub">CW721 and ERC721</span>
              </span>
              <ChevronRightIcon size={16} />
            </button>
            {evmDown && <p className="meta warn">EVM tokens may be missing: no EVM endpoint answered.</p>}
            <p className="footnote">{totalUsd === undefined ? "Pre-alpha. Not for real funds." : "Prices from Choice. Pre-alpha. Not for real funds."}</p>
          </Screen>
        );
      }
    }
  }
}

/** The headline figure: dollars with their cents dimmed, or an amount and its unit. Long
 *  figures step down a size so they stay on one line. */
function Figure({ text, unit }: { text: string; unit?: string }) {
  const dot = unit ? -1 : text.lastIndexOf(".");
  const size = text.length > 13 ? "smaller" : text.length > 10 ? "small" : "";
  return (
    <div className={`hero balance-figure ${size}`}>
      {dot < 0 ? text : text.slice(0, dot)}
      {dot >= 0 && <span className="cents">{text.slice(dot)}</span>}
      {unit && <span className="unit">{unit}</span>}
    </div>
  );
}

/** A holding's value column: its USD value first, the amount under it; the amount alone
 *  when nothing prices it. */
function HoldingValue({ amount, symbol, usd }: { amount: string; symbol: string; usd: number | undefined }) {
  if (usd === undefined) {
    return (
      <span className="value">
        <span className="amount">{amount}</span>
      </span>
    );
  }
  return (
    <span className="value">
      <span className="amount">{formatUsd(usd)}</span>
      <span className="usd">
        {amount} {symbol}
      </span>
    </span>
  );
}

function QuickAction({ label, gold, disabled, onClick, children }: { label: string; gold?: boolean; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button className={gold ? "quick-action gold" : "quick-action"} disabled={disabled} onClick={onClick}>
      <span className="quick-icon">{children}</span>
      {label}
    </button>
  );
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

function Receive({ addresses, network, onBack, onBridgeIn }: { addresses: Record<string, string>; network: NetworkId; onBack: () => void; onBridgeIn: () => void }) {
  const backend = useBackend();
  const [side, setSide] = useState<"cosmos" | "evm" | "solana">("cosmos");
  const [copied, setCopied] = useState(false);
  const cluster = NETWORKS[network].solana;
  const sol = addresses[cluster.caip2];
  const address = (side === "cosmos" ? addresses[COSMOS] : side === "evm" ? addresses[EVM] : sol) ?? "";
  return (
    <Screen
      top={<BackBar title="Receive" onBack={onBack} />}
      foot={
        <button
          className="btn btn-gold"
          onClick={() =>
            void backend.copy(address).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            })
          }
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
          {copied ? "Copied" : "Copy address"}
        </button>
      }
    >
      <Segmented
        label="Address format"
        options={[["cosmos", "Injective"], ["evm", "EVM (0x)"], ...(sol ? ([["solana", "Solana"]] as const) : [])]}
        value={side}
        onChange={(v) => {
          setSide(v);
          setCopied(false);
        }}
      />
      <div className="surface-hero">
        <div className="eyebrow">{side === "cosmos" ? "Injective address" : side === "evm" ? "EVM address" : `${cluster.name} address`}</div>
        {address && (
          <div className="qr-frame">
            <QrCode text={address} />
          </div>
        )}
        <div className="well">
          <code className="mono address" style={{ fontSize: 15, lineHeight: "22px" }}>
            {address}
          </code>
        </div>
      </div>
      <p className="lead">{side === "solana" ? "Only Solana tokens here. Same phrase, its own key." : "Both addresses are the same account."}</p>
      <button type="button" className="btn btn-quiet" onClick={onBridgeIn}>
        USDC on another chain? Bring it in
      </button>
    </Screen>
  );
}
