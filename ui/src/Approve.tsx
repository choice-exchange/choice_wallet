// The approval window: a site's request, as the wallet reads it, and the user's answer.
//
// - It never asks for a password. A locked wallet says so and waits: unlocking happens in
//   the toolbar popup, so a page can't train the user to type the password into windows
//   that appear by themselves.
// - Its buttons wake only after the window has been in front, visible and focused, for a
//   moment, so a site can't open it under a click meant for something else.
// - What it shows is the vault's decode of what will be signed, prepared when it asks;
//   approving names that decode's digest.

import { chainByCaip2, chainByKey, formatUnits, NETWORKS, shortDenom } from "@choice-wallet/chain";
import { useEffect, useState, type ReactNode } from "react";

import { useBackend } from "./backend";
import { ArrowDownIcon, CheckIcon, GlobeIcon, LockIcon } from "./icons";
import { Callout, Screen, shortAddress } from "./kit";
import { DeviceStep } from "./Ledger";
import type { Coin, CosmosDisplay, DappRequest, DappReview, DeviceRequest, DeviceSignature, ListedChain, NetworkId, NewChain, Status } from "./protocol";
import { shown } from "./review";
import { Figure, formName, realName, SwapCards } from "./Send";

/** How long the window must be in front before its buttons work. */
const ARM_MS = 800;
/** How often the window asks for the request and the lock state (it also keeps the
 *  service worker, which holds the request, awake). */
const POLL_MS = 1500;

function useArmed(): boolean {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      clearTimeout(t);
      if (document.visibilityState === "visible" && document.hasFocus()) t = setTimeout(() => setArmed(true), ARM_MS);
      else setArmed(false);
    };
    check();
    const events = ["focus", "blur", "visibilitychange"] as const;
    for (const e of events) (e === "visibilitychange" ? document : window).addEventListener(e, check);
    return () => {
      clearTimeout(t);
      for (const e of events) (e === "visibilitychange" ? document : window).removeEventListener(e, check);
    };
  }, []);
  return armed;
}

const WHAT: Record<DappRequest["kind"], string> = { connect: "wants to connect", switch: "wants to switch network", add_chain: "wants to add a chain", sign: "wants a signature" };

export function ApproveView({ id }: { id: string }) {
  const backend = useBackend();
  const armed = useArmed();
  const [req, setReq] = useState<DappRequest | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [closed, setClosed] = useState<string | null>(null);
  const [review, setReview] = useState<DappReview | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<"approved" | "rejected" | null>(null);
  /** A Ledger account's request, handed to the device after approving. */
  const [device, setDevice] = useState<DeviceRequest | null>(null);

  useEffect(() => {
    if (done) return;
    let live = true;
    const tick = async () => {
      const [r, s] = await Promise.all([backend.send({ type: "dapp_request", id }), backend.send({ type: "status" })]);
      if (!live) return;
      if (r.ok) setReq(r.result);
      else setClosed(r.error.message);
      if (s.ok) setStatus(s.result);
    };
    void tick();
    const t = setInterval(() => void tick(), POLL_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [id, done]);

  // The account in use answers; a watch-only one can't, so it reads like a locked wallet.
  const signer = status?.accounts[status.active];
  const watchOnly = signer?.account.derivation === "watch";
  const unlocked = status?.unlocked === true && !watchOnly;
  useEffect(() => {
    if (req?.kind !== "sign" || !unlocked || review || problem) return;
    void backend.send({ type: "dapp_review", id }).then((r) => (r.ok ? setReview(r.result) : setProblem(r.error.message)));
  }, [req?.kind, unlocked]);

  async function answer(approve: boolean) {
    setBusy(true);
    const r = await backend.send({ type: "dapp_answer", id, approve, ...(review ? { digest: review.digest } : {}), ...(review?.risk.confirm ? { confirm: typed } : {}) });
    setBusy(false);
    if (!r.ok) {
      setProblem(r.error.message);
      return;
    }
    if ("device" in r.result) {
      setDevice(r.result.device);
      return;
    }
    setDone(approve ? "approved" : "rejected");
    setTimeout(() => window.close(), approve ? 1500 : 400);
  }

  /** The Ledger's signature: the vault checks it, then the site gets its answer. */
  async function signed(sig: DeviceSignature): Promise<string | null> {
    if (!review) return "Nothing to sign.";
    const r = await backend.send({ type: "dapp_ledger_signed", id, digest: review.digest, ...sig });
    if (!r.ok) return r.error.message;
    setDone("approved");
    setTimeout(() => window.close(), 1500);
    return null;
  }

  if (done || (closed && !req)) {
    return (
      <Screen foot={<button className="btn" onClick={() => window.close()}>Close</button>}>
        <div className="status">
          {done === "approved" && (
            <span className="status-icon success">
              <CheckIcon size={30} />
            </span>
          )}
          <h1 className="page-title">{done === "approved" ? "Done" : done === "rejected" ? "Rejected" : "Nothing to answer"}</h1>
          <p className="lead">{done ? "You can close this window." : closed}</p>
        </div>
      </Screen>
    );
  }
  if (!req) return <Screen>{null}</Screen>;

  const net = NETWORKS[req.network];
  const account = signer;
  const site = req.origin.replace(/^https:\/\//, "");
  const risk = review?.risk;
  const blocked = risk?.level === "blocked";
  const needsWord = risk?.confirm !== undefined && typed.trim() !== risk.confirm;
  const ready = unlocked && (req.kind !== "sign" || review !== null) && !closed;
  const yes = { connect: "Connect", switch: "Switch", add_chain: "Add and switch", sign: req.method === "evm_transaction" ? "Confirm" : "Sign" }[req.kind];

  return (
    <Screen
      top={
        <div className="approve-site">
          <GlobeIcon size={18} />
          <span className="approve-origin" title={req.origin}>
            {site}
          </span>
          <span className="meta">{WHAT[req.kind]}</span>
        </div>
      }
      foot={
        device ? (
          <DeviceStep request={device} onSignature={signed} onCancel={() => void answer(false)} />
        ) : (
        <>
          {problem && <Callout level="red">{problem}</Callout>}
          {ready && !problem && (
            <button
              className={risk && (risk.level === "red" || blocked) ? "btn btn-danger" : "btn btn-gold"}
              disabled={!armed || busy || blocked || needsWord}
              onClick={() => void answer(true)}
            >
              {busy ? "Working…" : yes}
            </button>
          )}
          <button className="btn btn-quiet" disabled={busy} onClick={() => void answer(false)}>
            Reject
          </button>
        </>
        )
      }
    >
      {!req.origin.startsWith("https://") && <Callout level="amber">This page isn&apos;t https. Only for development on this machine.</Callout>}
      {!unlocked ? (
        <div className="surface-hero locked-note">
          <LockIcon size={22} />
          <p className="lead">
            {watchOnly
              ? `${signer?.name} is watch-only. Switch to an account that can sign, then come back to this window.`
              : "Choice Wallet is locked. Unlock it from its toolbar button, then come back to this window."}
          </p>
        </div>
      ) : req.kind === "connect" ? (
        <div className="surface-hero">
          <div className="eyebrow">{site} will</div>
          <ul className="grant-list">
            <li>See this account&apos;s addresses</li>
            <li>Ask you to approve transactions and signatures, here, one at a time</li>
          </ul>
          <hr className="divider" style={{ margin: "14px 0 12px" }} />
          <div className="eyebrow">{account?.name}</div>
          <code className="mono address" style={{ display: "block", marginTop: 6 }}>
            {account?.addresses[net.cosmos]}
          </code>
          <code className="mono address meta" style={{ display: "block", marginTop: 4 }}>
            {account?.addresses[net.evm]}
          </code>
          {account?.addresses[net.solana.caip2] && (
            <code className="mono address meta" style={{ display: "block", marginTop: 4 }}>
              {account.addresses[net.solana.caip2]}
            </code>
          )}
          <p className="meta" style={{ marginTop: 12 }}>
            Connect only to sites you trust. You can disconnect in Settings.
          </p>
        </div>
      ) : req.kind === "switch" ? (
        <div className="surface-hero">
          <div className="eyebrow">Switch the wallet to</div>
          <div className="hero" style={{ fontSize: 24, marginTop: 6 }}>
            {req.toChain ? (chainByKey(req.to ?? req.network, req.toChain)?.name ?? NETWORKS[req.to ?? req.network].name) : NETWORKS[req.to ?? req.network].name}
          </div>
          <p className="meta" style={{ marginTop: 8 }}>
            From {net.name}. Every connected site sees the change.
          </p>
        </div>
      ) : req.kind === "add_chain" && req.chain ? (
        <AddChainBody chain={req.chain} listed={req.listed} siteName={req.siteName} from={net.name} />
      ) : !review ? (
        !problem && [0, 1].map((i) => <div key={i} className="skeleton" style={{ height: 64 }} />)
      ) : (
        <SignBody review={review} network={req.network} typed={typed} onTyped={setTyped} />
      )}
    </Screen>
  );
}

export function SignBody({ review, network, typed, onTyped }: { review: DappReview; network: NetworkId; typed: string; onTyped: (s: string) => void }) {
  const { risk, tokens, display } = review;
  const d = display as Record<string, unknown>;
  const net = NETWORKS[network];
  const amount = (c: Coin) => {
    const t = tokens[c.denom];
    return t ? `${formatUnits(c.amount.replace("-", ""), t.decimals)} ${t.symbol}` : `${c.amount.replace("-", "")} ${shortDenom(c.denom)}`;
  };
  // An Injective tx sent as EIP-712 typed data reads like any Cosmos tx.
  const injTx = d["kind"] === "evm_typed_data" && typeof d["injective_tx"] === "object" && d["injective_tx"] !== null ? (d["injective_tx"] as Record<string, unknown>) : null;
  const txLike: CosmosDisplay | null = injTx
    ? {
        kind: "cosmos_eip712",
        chain: net.cosmos,
        signer: String(d["signer"] ?? ""),
        memo: String(injTx["memo"] ?? ""),
        fee: { amount: ((injTx["fee"] as { amount?: Coin[] } | undefined)?.amount ?? []) as Coin[], gas_limit: "0", granter: null, payer: null },
        messages: (injTx["messages"] ?? []) as CosmosDisplay["messages"],
      }
    : null;
  const solana = d["kind"] === "solana_transaction";
  const isTx = d["kind"] === "evm_transaction" || d["kind"] === "cosmos_direct" || d["kind"] === "cosmos_amino" || solana || txLike !== null;
  const view = isTx ? shown((txLike ?? display) as CosmosDisplay, network) : null;
  const messages = (txLike ?? (display as CosmosDisplay)).messages ?? [];
  // The signer's bech32 address. Typed data names it in 0x form; its messages' senders are
  // the signer (the vault checks).
  const sender = messages.map((m) => (m as { sender?: unknown }).sender).find((x): x is string => typeof x === "string");
  const me = (txLike ? sender : undefined) ?? String(d["signer"] ?? "");

  return (
    <>
      {risk.findings.map((f, i) => (
        <Callout key={i} level={f.level}>
          {f.message}
        </Callout>
      ))}
      {review.simulation && !review.simulation.ok && <Callout level="red">Simulation failed: {review.simulation.error}</Callout>}
      {review.simulation?.ok && (
        <div className="well">
          <div className="eyebrow">Simulated: what this account would see</div>
          {review.simulation.changes.length === 0 ? (
            <p className="meta" style={{ marginTop: 6 }}>No balance changes, besides the fee.</p>
          ) : (
            <ul className="changes">
              {review.simulation.changes.map((c) => (
                <li key={c.denom} className={c.amount.startsWith("-") ? "out" : "in"}>
                  {c.amount.startsWith("-") ? "−" : "+"}
                  {amount(c)}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {view?.sends.map((m, i) => (
        <div className="surface-hero" key={`s${i}`}>
          <div className="eyebrow">You send</div>
          {m.coins.map((c) => (
            <Figure key={c.denom} coin={c} t={tokens[c.denom]} />
          ))}
          {m.coins.map((c) => {
            const real = realName(c.denom, tokens[c.denom]);
            return real ? (
              <div key={`r${c.denom}`} className="meta mono" style={{ marginTop: 4, marginLeft: 46, wordBreak: "break-all" }}>
                {real}
              </div>
            ) : null;
          })}
          <hr className="divider" style={{ margin: "14px 0 12px" }} />
          <div className="eyebrow">To</div>
          <code className="mono recipient" style={{ display: "block", marginTop: 6, fontSize: 14 }}>
            {m.to}
          </code>
        </div>
      ))}
      {view?.converts.map((cv, i) => (
        <div className="surface-hero" key={`c${i}`}>
          <div className="eyebrow">You convert · {formName(cv.from.denom)}</div>
          <Figure coin={cv.from} t={tokens[cv.from.denom]} />
          <div className="convert-arrow" aria-hidden="true">
            <ArrowDownIcon size={18} />
          </div>
          <div className="eyebrow">You get · {formName(cv.to.denom)}</div>
          <Figure coin={cv.to} t={tokens[cv.to.denom]} />
          {cv.recipient.toLowerCase() !== me.toLowerCase() && (
            <div className="meta" style={{ marginTop: 8, wordBreak: "break-all" }}>
              Delivered to {cv.recipient}
            </div>
          )}
        </div>
      ))}

      {view && <SwapCards view={view} tokens={tokens} network={network} from={String(d["from"] ?? "")} />}
      {d["kind"] === "evm_transaction" && view?.sends.length === 0 && view.swaps.length === 0 && view.approvals.length === 0 && <EvmCall d={d} />}
      {solana && view && view.others.length > 0 && (
        <div className="surface">
          <div className="eyebrow">It also</div>
          <ul className="grant-list">
            {view.others.map((o, i) => (
              <li key={i}>{o}</li>
            ))}
          </ul>
        </div>
      )}
      {/* Every message no card above stands for, in full. */}
      {isTx &&
        d["kind"] !== "evm_transaction" &&
        messages.map((m, i) => (view?.carded?.has(i) ? null : <MessageCard key={`m${i}`} m={m as Record<string, unknown>} />))}

      {(d["kind"] === "evm_personal_sign" || d["kind"] === "cosmos_arbitrary" || d["kind"] === "solana_message") && (
        <div className="surface-hero">
          <div className="eyebrow">Message</div>
          <pre className="message-box">{typeof d["text"] === "string" ? d["text"] : String(d["hex"])}</pre>
          {typeof d["text"] !== "string" && <p className="meta">Not text: shown as bytes.</p>}
        </div>
      )}
      {d["kind"] === "evm_typed_data" && !txLike && <TypedData d={d} />}

      <div className="well rows">
        {view && (
          <div className="row">
            <span>Network fee</span>
            <span className="num">{view.fee.map(amount).join(" + ") || "None"}</span>
          </div>
        )}
        <div className="row">
          <span>Network</span>
          <span>{networkName(d, network)}</span>
        </div>
        {view?.memo && (
          <div className="row">
            <span>Memo</span>
            <span>{view.memo}</span>
          </div>
        )}
        {review.checkedBy && (
          <div className="row">
            <span>{d["kind"] === "evm_transaction" ? "Estimated on" : "Simulated on"}</span>
            <span>{review.checkedBy}</span>
          </div>
        )}
      </div>
      {risk.confirm && (
        <label className="field">
          <span className="eyebrow">Type {risk.confirm} to continue</span>
          <input className="input" autoComplete="off" spellCheck={false} value={typed} onChange={(e) => onTyped(e.target.value)} />
        </label>
      )}
      <details className="raw">
        <summary>Everything the wallet decoded</summary>
        <pre className="message-box">{JSON.stringify(display, null, 2)}</pre>
      </details>
    </>
  );
}

/** A site's chain to add: as it would be added, and what chainlist.org's list says of it. */
function AddChainBody({ chain, listed, siteName, from }: { chain: NewChain; listed: ListedChain | undefined; siteName: string | undefined; from: string }) {
  const host = (u: string | undefined) => (u ? new URL(u).host : "None");
  return (
    <>
      <div className="surface-hero">
        <div className="eyebrow">Add to {chain.testnet ? "the test networks" : "the chain list"}, then switch to</div>
        <div className="hero" style={{ fontSize: 24, marginTop: 6 }}>
          {chain.name}
        </div>
        <p className="meta" style={{ marginTop: 8 }}>
          From {from}. Every connected site sees the change.
        </p>
      </div>
      {!listed && <Callout level="amber">Not on chainlist.org&apos;s list. Check its chain ID with whoever runs it.</Callout>}
      {listed?.flags.includes("reusedChainId") && <Callout level="amber">chainlist.org says another chain uses this chain ID too.</Callout>}
      {siteName && <Callout level="amber">The site calls it {siteName}. The list says {chain.name}.</Callout>}
      <Rows>
        <div className="row">
          <span>Chain ID</span>
          <span className="num">{chain.chainId}</span>
        </div>
        <div className="row">
          <span>Coin</span>
          <span>{chain.symbol}</span>
        </div>
        <div className="row">
          <span>Endpoint</span>
          <span>{host(chain.rpc[0])}</span>
        </div>
        <div className="row">
          <span>Explorer</span>
          <span>{host(chain.explorer)}</span>
        </div>
      </Rows>
      <p className="meta">The wallet signs there by chain ID. The name and coin are labels.</p>
    </>
  );
}

function Rows({ children }: { children: ReactNode }) {
  return <div className="well rows">{children}</div>;
}

function EvmCall({ d }: { d: Record<string, unknown> }) {
  const call = d["call"] as { type: string; selector?: string | null };
  const value = String(d["value"] ?? "0");
  return (
    <div className="surface-hero">
      <div className="eyebrow">Contract call</div>
      <code className="mono recipient" style={{ display: "block", marginTop: 6, fontSize: 14 }}>
        {String(d["to"])}
      </code>
      {value !== "0" && (
        <div className="hero" style={{ fontSize: 20, marginTop: 8 }}>
          {formatUnits(value, 18)} <span className="unit">INJ</span>
        </div>
      )}
      <div className="meta mono" style={{ marginTop: 8 }}>
        Function {call.selector ?? "none"} · {(String(d["data"]).length - 2) / 2} bytes of data
      </div>
    </div>
  );
}

/** Staking messages a site may ask for, by the vault's decoded type. */
const STAKING_CARD: Record<string, { title: string }> = {
  delegate: { title: "Stake" },
  undelegate: { title: "Unstake" },
  redelegate: { title: "Move stake" },
  withdraw_rewards: { title: "Claim staking rewards" },
  cancel_unbonding: { title: "Cancel unstaking" },
  transfer_delegation: { title: "Give away stake" },
};

function MessageCard({ m }: { m: Record<string, unknown> }) {
  const type = String(m["type"] ?? "message");
  if (type === "execute_contract") {
    let json = String(m["json"] ?? "");
    try {
      json = JSON.stringify(JSON.parse(json), null, 2);
    } catch {
      // Shown as sent.
    }
    const funds = Array.isArray(m["funds"]) ? (m["funds"] as Coin[]) : [];
    return (
      <div className="surface">
        <div className="eyebrow">Contract call</div>
        <code className="mono" style={{ display: "block", marginTop: 6, wordBreak: "break-all" }}>
          {String(m["contract"])}
        </code>
        {funds.length > 0 && <div className="meta" style={{ marginTop: 6 }}>Attaches {funds.map((c) => `${c.amount} ${shortDenom(c.denom)}`).join(", ")}</div>}
        <pre className="message-box">{json}</pre>
      </div>
    );
  }
  const staking = STAKING_CARD[type];
  if (staking) {
    const coin = m["amount"] as Coin | undefined;
    const field = (label: string, key: string) =>
      typeof m[key] === "string" && (
        <>
          <div className="eyebrow" style={{ marginTop: 10 }}>
            {label}
          </div>
          <code className="mono" style={{ display: "block", marginTop: 4, wordBreak: "break-all" }}>
            {String(m[key])}
          </code>
        </>
      );
    return (
      <div className="surface">
        <div className="eyebrow">{staking.title}</div>
        {coin && typeof coin.amount === "string" && (
          <div className="hero" style={{ fontSize: 20, marginTop: 6 }}>
            {coin.denom === "inj" ? formatUnits(coin.amount, 18) : coin.amount} <span className="unit">{coin.denom === "inj" ? "INJ" : shortDenom(coin.denom)}</span>
          </div>
        )}
        {field(type === "redelegate" ? "From validator" : "Validator", type === "redelegate" ? "from_validator" : "validator")}
        {type === "redelegate" && field("To validator", "to_validator")}
        {type === "transfer_delegation" && field("Given to", "receiver")}
      </div>
    );
  }
  const { type: _t, ...rest } = m;
  return (
    <div className="surface">
      <div className="eyebrow">{type.replace(/_/g, " ")}</div>
      <pre className="message-box">{JSON.stringify(rest, null, 2)}</pre>
    </div>
  );
}

function TypedData({ d }: { d: Record<string, unknown> }) {
  const domain = (d["domain"] ?? {}) as Record<string, unknown>;
  return (
    <>
      <Rows>
        <div className="row">
          <span>App</span>
          <span>{String(domain["name"] ?? "Not named")}</span>
        </div>
        {domain["verifyingContract"] !== undefined && (
          <div className="row">
            <span>Contract</span>
            <span className="mono">{shortAddress(String(domain["verifyingContract"]))}</span>
          </div>
        )}
        <div className="row">
          <span>Type</span>
          <span>{String(d["primary_type"])}</span>
        </div>
      </Rows>
      <div className="surface">
        <div className="eyebrow">Message</div>
        <pre className="message-box">{JSON.stringify(d["message"], null, 2)}</pre>
      </div>
    </>
  );
}

/** The chain a request is signed for: an EVM chain by its name (Injective's EVM side marked
 *  so), Solana's cluster, or Injective. */
function networkName(d: Record<string, unknown>, network: NetworkId): string {
  const net = NETWORKS[network];
  const kind = d["kind"];
  if (kind === "solana_transaction" || kind === "solana_message") return net.solana.name;
  const chain = typeof d["chain"] === "string" ? d["chain"] : "";
  if (chain.startsWith("eip155:")) {
    const c = chainByCaip2(network, chain);
    // An added chain is named by the user (or a site), so its ID goes with the name.
    if (c?.kind === "evm") return c.added ? `${c.name} (chain ${c.chainId})` : c.name;
    const added = typeof d["network"] === "object" && d["network"] !== null && (d["network"] as { added?: unknown }).added === true;
    if (added) return `Chain ${chain.slice("eip155:".length)}`;
    return `${net.name}${kind === "evm_transaction" ? " (EVM)" : ""}`;
  }
  return net.name;
}
