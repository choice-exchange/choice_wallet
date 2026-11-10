// Home, the Wallet tab: what the account holds on the chain picked, in one figure, its
// quick actions and its tokens. Injective's adds staking and the ways to the rest
// (bridge, trading accounts, NFTs); Solana's and each EVM chain's, the way to bridge.

import { chainCoin, formatShort, NETWORKS, usdValue, type AnyChain } from "@choice-wallet/chain";
import type { ReactNode } from "react";

import { ChevronRightIcon, EyeOffIcon, GlobeIcon, ReceiveIcon, SendIcon, StakeIcon, SwapIcon } from "./icons";
import { useKept } from "./kept";
import { Callout, formatUsd, tokenSub } from "./kit";
import type { Balance, ChainHoldings, NetworkId, Replies, StakingSummary } from "./protocol";
import type { Sorted } from "./tokenFilter";
import { TokenMark } from "./TokenMark";

/** "just now", "4 min ago", "2 h ago", "3 days ago". */
function ago(at: number, now = Date.now()): string {
  const m = Math.floor((now - at) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  const days = Math.floor(h / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

/** Home on Injective: everything the account holds there, staking included, in USD when
 *  Choice prices something here, otherwise in INJ. */
export function InjectiveHome({
  balances,
  sorted,
  totalUsd,
  stakedAll,
  injPrice,
  prices,
  staking,
  watch,
  error,
  readAt,
  evmDown,
  onSend,
  onReceive,
  onSwap,
  onStake,
  onTokens,
  onToken,
  onBridge,
  onInventory,
  onNfts,
}: {
  balances: Balance[] | null;
  sorted: Sorted | null;
  totalUsd: number | undefined;
  /** Staked, unstaking and unclaimed INJ, in its base units. */
  stakedAll: bigint;
  injPrice: string | undefined;
  prices: boolean;
  staking: StakingSummary | null;
  watch: boolean;
  error: string | null;
  /** When the balances on screen were read. */
  readAt: number | null;
  evmDown: boolean;
  onSend: () => void;
  onReceive: () => void;
  onSwap: () => void;
  onStake: () => void;
  onTokens: () => void;
  onToken: (denom: string) => void;
  onBridge: () => void;
  onInventory: () => void;
  onNfts: () => void;
}) {
  const inj = balances?.find((b) => b.denom === "inj");
  return (
    <>
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
        <QuickAction label="Send" gold disabled={watch || !sorted?.shown.some((b) => BigInt(b.amount) > 0n)} onClick={() => onSend()}>
          <SendIcon size={20} />
        </QuickAction>
        <QuickAction label="Receive" onClick={onReceive}>
          <ReceiveIcon size={20} />
        </QuickAction>
        <QuickAction label="Swap" onClick={onSwap}>
          <SwapIcon size={20} />
        </QuickAction>
        <QuickAction label="Stake" onClick={onStake}>
          <StakeIcon size={20} />
        </QuickAction>
      </div>

      <div className="section-head">
        <span className="eyebrow">Tokens{sorted?.shown.length ? ` · ${sorted.shown.length}` : ""}</span>
        {balances !== null && balances.length > 0 && (
          <button className="link" onClick={onTokens}>
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
              onClick={() => onToken(b.denom)}
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
            <button className="hidden-row" onClick={onTokens}>
              <EyeOffIcon size={16} />
              {sorted.hidden.length} hidden {sorted.hidden.length === 1 ? "token" : "tokens"}
              <ChevronRightIcon size={16} />
            </button>
          )}
        </div>
      )}
      {/* Staked, unstaking and unclaimed INJ. Nothing staked: the Stake button above. */}
      {staking && stakedAll > 0n && (
        <>
          <div className="section-head">
            <span className="eyebrow">Staking</span>
          </div>
          <button className="token" onClick={onStake}>
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
      <button className="token" onClick={onBridge}>
        <TokenMark denom="usdc:injective" symbol="USDC" known />
        <span className="name">
          <span className="symbol">Bridge USDC</span>
          <span className="sub">To Base, Solana and more, by Circle</span>
        </span>
        <ChevronRightIcon size={16} />
      </button>
      <button className="token" onClick={onInventory}>
        <span className="nft-tile small" aria-hidden="true">
          LP
        </span>
        <span className="name">
          <span className="symbol">Trading and liquidity</span>
          <span className="sub">Orderbook accounts, Choice pools</span>
        </span>
        <ChevronRightIcon size={16} />
      </button>
      <button className="token" onClick={onNfts}>
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
    </>
  );
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

type SolanaHoldings = NonNullable<Replies["balances"]["solana"]>;

/** What the account holds on Solana, in one figure: the USD of what has a price (as
 *  Injective's total), otherwise its SOL. */
export function solanaTotal(balances: Balance[], prices: boolean): { text: string; usd?: number } {
  const priced = balances.filter((b) => b.usd !== undefined);
  if (prices && priced.length > 0) {
    const usd = priced.reduce((t, b) => t + (b.usd ?? 0), 0);
    return { text: formatUsd(usd), usd };
  }
  return { text: `${formatShort(balances.find((b) => b.denom === "sol")?.amount ?? "0", 9, 4)} SOL` };
}

/** An EVM chain's total: USD when something there is priced, otherwise its coin (USDC on
 *  Arc, whose coin is its USDC). */
export function chainTotal(c: AnyChain, balances: Balance[], prices: boolean): { text: string; usd?: number } {
  const priced = balances.filter((b) => b.usd !== undefined);
  if (prices && priced.length > 0) {
    const usd = priced.reduce((t, b) => t + (b.usd ?? 0), 0);
    return { text: formatUsd(usd), usd };
  }
  const main = balances.find((b) => b.denom === chainCoin(c.caip2)) ?? balances[0];
  return { text: `${formatShort(main?.amount ?? "0", main?.decimals ?? 18, 4)} ${main?.symbol ?? c.native.symbol}` };
}

/** "SOL, USDC": what's held, for the picker. */
export function holdsLine(balances: Balance[]): string {
  const held = balances.filter((b) => BigInt(b.amount) > 0n).map((b) => b.symbol);
  return held.length > 3 ? `${held.slice(0, 2).join(", ")} and ${held.length - 2} more` : held.join(", ");
}

/** Home on Solana: the account's Solana key, its SOL and tokens, and the way to Injective. */
export function SolanaHome({
  network,
  holdings,
  total,
  watch,
  onSend,
  onReceive,
  onBridge,
}: {
  network: NetworkId;
  holdings: SolanaHoldings | null;
  total: { text: string; usd?: number } | null;
  watch: boolean;
  onSend: (denom?: string) => void;
  onReceive: () => void;
  onBridge: () => void;
}) {
  const cluster = NETWORKS[network].solana;
  /** Rent in burn records that comes back to the account, 5 days after each transfer. */
  const rent = useKept({ type: "bridge_reclaims" });
  const ready = (rent.value ?? []).filter((r) => r.ready).length;
  const waiting = (rent.value ?? []).length - ready;
  const list = holdings?.balances.filter((b) => b.denom === "sol" || BigInt(b.amount) > 0n) ?? null;
  return (
    <>
      <section className="balance-head" aria-label="Total balance">
        {total === null ? (
          <div className="skeleton" style={{ width: 168, height: 40, margin: "3px auto" }} />
        ) : total.usd !== undefined ? (
          <Figure text={total.text} />
        ) : (
          <Figure text={total.text.replace(/ SOL$/, "")} unit="SOL" />
        )}
        <div className="balance-sub">{watch && <span className="flag quiet">Watch-only</span>}</div>
      </section>
      <div className="quick-actions three">
        <QuickAction label="Send" gold disabled={watch || !list?.some((b) => BigInt(b.amount) > 0n)} onClick={() => onSend()}>
          <SendIcon size={20} />
        </QuickAction>
        <QuickAction label="Receive" onClick={onReceive}>
          <ReceiveIcon size={20} />
        </QuickAction>
        <QuickAction label="Bridge" onClick={onBridge}>
          <GlobeIcon size={20} />
        </QuickAction>
      </div>
      <div className="section-head">
        <span className="eyebrow">Tokens{list?.length ? ` · ${list.length}` : ""}</span>
      </div>
      {holdings?.down && <p className="meta warn">{cluster.name} didn&apos;t answer. Its balances may be missing.</p>}
      {list === null ? (
        [0, 1].map((i) => <div key={i} className="skeleton" style={{ height: 40 }} />)
      ) : (
        <div className="token-list">
          {list.map((b) => (
            <button key={b.denom} className="token" title={b.denom} disabled={watch || BigInt(b.amount) === 0n} onClick={() => onSend(b.denom)}>
              <TokenMark denom={b.denom} symbol={b.symbol} known={b.known} />
              <span className="name">
                <span className="symbol">{b.symbol}</span>
                <span className={b.known ? "sub" : "sub denom"}>{b.known ? b.name : tokenSub(b)}</span>
              </span>
              <HoldingValue amount={formatShort(b.amount, b.decimals)} symbol={b.symbol} usd={b.usd} />
            </button>
          ))}
        </div>
      )}
      <div className="section-head">
        <span className="eyebrow">Bridge</span>
      </div>
      <button className="token" onClick={onBridge}>
        <TokenMark denom="usdc:injective" symbol="USDC" known />
        <span className="name">
          <span className="symbol">USDC to Injective</span>
          <span className="sub">{ready > 0 ? `Rent to take back from ${ready} ${ready === 1 ? "transfer" : "transfers"}` : waiting > 0 ? `Rent comes back 5 days after each transfer` : "By Circle"}</span>
        </span>
        <ChevronRightIcon size={16} />
      </button>
      <p className="footnote">Pre-alpha. Not for real funds.</p>
    </>
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

/** Home on an EVM chain beside Injective: the account's coin and USDC there (the same 0x
 *  address as on Injective), and the way to bridge. On a chain the user added: its coin
 *  alone, and no bridge (CCTP doesn't reach it). */
export function EvmHome({
  chain,
  holdings,
  total,
  watch,
  onSend,
  onReceive,
  onBridge,
}: {
  chain: AnyChain;
  holdings: ChainHoldings | null;
  total: { text: string; usd?: number } | null;
  watch: boolean;
  onSend: (denom?: string) => void;
  onReceive: () => void;
  onBridge: () => void;
}) {
  const list = holdings?.balances ?? null;
  const unit = total?.text.split(" ").pop() ?? "";
  return (
    <>
      <section className="balance-head" aria-label="Total balance">
        {total === null ? (
          <div className="skeleton" style={{ width: 168, height: 40, margin: "3px auto" }} />
        ) : total.usd !== undefined ? (
          <Figure text={total.text} />
        ) : (
          <Figure text={total.text.slice(0, -unit.length - 1)} unit={unit} />
        )}
        <div className="balance-sub">{watch && <span className="flag quiet">Watch-only</span>}</div>
      </section>
      <div className={chain.added ? "quick-actions two" : "quick-actions three"}>
        <QuickAction label="Send" gold disabled={watch || !list?.some((b) => BigInt(b.amount) > 0n)} onClick={() => onSend()}>
          <SendIcon size={20} />
        </QuickAction>
        <QuickAction label="Receive" onClick={onReceive}>
          <ReceiveIcon size={20} />
        </QuickAction>
        {!chain.added && (
          <QuickAction label="Bridge" onClick={onBridge}>
            <GlobeIcon size={20} />
          </QuickAction>
        )}
      </div>
      <div className="section-head">
        <span className="eyebrow">Tokens{list?.length ? ` · ${list.length}` : ""}</span>
      </div>
      {holdings?.down && <p className="meta warn">{chain.name} didn&apos;t answer. Its balances may be missing.</p>}
      {list === null ? (
        [0, 1].map((i) => <div key={i} className="skeleton" style={{ height: 40 }} />)
      ) : (
        <div className="token-list">
          {list.map((b) => (
            <button key={b.denom} className="token" title={b.denom} disabled={watch || BigInt(b.amount) === 0n} onClick={() => onSend(b.denom)}>
              <TokenMark denom={b.denom} symbol={b.symbol} known={b.known} />
              <span className="name">
                <span className="symbol">{b.symbol}</span>
                <span className="sub">{b.denom === chainCoin(chain.caip2) ? `Gas on ${chain.name}` : b.name}</span>
              </span>
              <HoldingValue amount={formatShort(b.amount, b.decimals)} symbol={b.symbol} usd={b.usd} />
            </button>
          ))}
        </div>
      )}
      {chain.added ? (
        <p className="meta">Added by you. Chain ID {chain.chainId}.</p>
      ) : (
        <>
          <div className="section-head">
            <span className="eyebrow">Bridge</span>
          </div>
          <button className="token" onClick={onBridge}>
            <TokenMark denom="usdc:injective" symbol="USDC" known />
            <span className="name">
              <span className="symbol">USDC to another chain</span>
              <span className="sub">{chain.forwarding ? "By Circle" : "By Circle, claimed by this wallet"}</span>
            </span>
            <ChevronRightIcon size={16} />
          </button>
        </>
      )}
      <p className="footnote">Pre-alpha. Not for real funds.</p>
    </>
  );
}
