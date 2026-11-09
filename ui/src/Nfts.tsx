// NFTs: the account's CW721 and ERC721 NFTs by collection, a collection added by its
// contract, and one NFT sent. Nothing is loaded from the NFTs' metadata links (that would
// tell their hosts what the account holds): names come from on-chain metadata, and a link
// shows as text to open on purpose.

import { useEffect, useState, type FormEvent } from "react";

import { useBackend } from "./backend";
import { RecipientPicker } from "./Contacts";
import { BackBar, Callout, Screen, shortAddress } from "./kit";
import type { AccountInfo, Contact, Nft, NftCollection, NftList, SendReview } from "./protocol";
import { useRequest } from "./request";

/** A collection's or NFT's tile: its first letters, never a remote image. */
function Tile({ text, small }: { text: string; small?: boolean }) {
  const letters = (text.replace(/^#/, "").match(/[\p{L}\p{N}]/gu) ?? ["?"]).slice(0, 2).join("").toUpperCase();
  return (
    <span className={small ? "nft-tile small" : "nft-tile"} aria-hidden="true">
      {letters}
    </span>
  );
}

export const nftLabel = (n: Nft) => n.name || `#${n.tokenId}`;

export function NftsView({ canSign, onOpen, onBack }: { canSign: boolean; onOpen: (c: NftCollection, n: Nft) => void; onBack: () => void }) {
  const backend = useBackend();
  const { run, error, busy } = useRequest();
  const [list, setList] = useState<NftList | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [address, setAddress] = useState("");

  useEffect(() => {
    void backend.send({ type: "nfts" }).then((r) => (r.ok ? setList(r.result) : setProblem(r.error.message)));
  }, []);

  async function add(e: FormEvent) {
    e.preventDefault();
    const r = await run({ type: "add_nft_collection", address: address.trim() });
    if (r) {
      setList(r);
      setAdding(false);
      setAddress("");
    }
  }

  const count = list?.collections.reduce((n, c) => n + c.items.length, 0) ?? 0;
  return (
    <Screen top={<BackBar title="NFTs" onBack={onBack} />}>
      {problem && <Callout level="amber">{problem}</Callout>}
      {!list && !problem && <p className="meta">Looking for NFTs…</p>}
      {list && count === 0 && <p className="empty">No NFTs found. Add a collection by its contract if one is missing.</p>}
      {list?.collections.map((c) => (
        <div key={c.address} className="wallet-group">
          <div className="section-head">
            <span className="eyebrow" title={c.address}>
              {c.name || shortAddress(c.address)}
              {c.symbol ? ` · ${c.symbol}` : ""}
            </span>
            <span className="meta">{c.standard === "cw721" ? "CW721" : "ERC721"}</span>
          </div>
          <div className="token-list">
            {c.items.map((n) => (
              <button key={n.tokenId} className="token" onClick={() => onOpen(c, n)} title={`${c.address} #${n.tokenId}`}>
                <Tile text={nftLabel(n)} />
                <span className="name">
                  <span className="symbol">{nftLabel(n)}</span>
                  <span className="sub denom">{n.name ? `#${n.tokenId}` : shortAddress(c.address)}</span>
                </span>
              </button>
            ))}
          </div>
          {c.more && <p className="meta">More are held than listed here.</p>}
        </div>
      ))}
      {list?.evmDown && <p className="meta warn">EVM NFTs may be missing: no EVM endpoint answered.</p>}
      {adding ? (
        <form className="well add-token" onSubmit={(e) => void add(e)}>
          <input
            className="input mono"
            placeholder="inj1… or 0x…"
            aria-label="Collection contract"
            spellCheck={false}
            autoFocus
            value={address}
            onChange={(e) => setAddress(e.target.value)}
          />
          {error && <p className="error">{error}</p>}
          <span className="meta">A CW721 or ERC721 collection's contract.</span>
          <div className="add-token-actions">
            <button type="button" className="btn btn-quiet" onClick={() => setAdding(false)}>
              Cancel
            </button>
            <button className="btn btn-gold" disabled={busy || !address.trim()}>
              {busy ? "Checking…" : "Add"}
            </button>
          </div>
        </form>
      ) : (
        list && (
          <button type="button" className="btn btn-quiet" onClick={() => setAdding(true)}>
            Add a collection
          </button>
        )
      )}
      <p className="footnote">{canSign ? "Found from your history and checked with each collection." : "Watch-only: this account can't send them."}</p>
    </Screen>
  );
}

/** One NFT: what it is, and a send. */
export function NftView({
  collection,
  nft,
  canSign,
  accounts,
  onReview,
  onBack,
}: {
  collection: NftCollection;
  nft: Nft;
  canSign: boolean;
  accounts: AccountInfo[];
  onReview: (review: SendReview, entered: string) => void;
  onBack: () => void;
}) {
  const backend = useBackend();
  const { run, error, busy } = useRequest();
  const [to, setTo] = useState("");
  const [choosing, setChoosing] = useState(false);
  const [contacts, setContacts] = useState<Contact[] | null>(null);

  useEffect(() => {
    void backend.send({ type: "contacts" }).then((r) => r.ok && setContacts(r.result));
  }, []);

  if (choosing) {
    return (
      <RecipientPicker
        accounts={accounts}
        contacts={contacts}
        onBack={() => setChoosing(false)}
        onPick={(address) => {
          setTo(address);
          setChoosing(false);
        }}
      />
    );
  }

  async function review(e: FormEvent) {
    e.preventDefault();
    const r = await run({ type: "prepare_nft_send", standard: collection.standard, collection: collection.address, tokenId: nft.tokenId, to: to.trim() });
    if (r) onReview(r, to.trim());
  }

  return (
    <Screen top={<BackBar title={nftLabel(nft)} onBack={onBack} />}>
      <div className="surface-hero nft-hero">
        <Tile text={nftLabel(nft)} />
        <div className="name">
          <div className="symbol">{nftLabel(nft)}</div>
          <div className="meta">{collection.name || "Unnamed collection"}</div>
        </div>
      </div>
      <div className="well rows">
        <div className="row">
          <span>Token ID</span>
          <span className="mono" style={{ wordBreak: "break-all" }}>
            {nft.tokenId}
          </span>
        </div>
        <div className="row">
          <span>Collection</span>
          <span className="mono" title={collection.address}>
            {shortAddress(collection.address)} · {collection.standard === "cw721" ? "CW721" : "ERC721"}
          </span>
        </div>
        {nft.uri && (
          <div className="row">
            <span>Metadata</span>
            {nft.uri.startsWith("https://") ? (
              <button type="button" className="link" onClick={() => backend.openLink(nft.uri!)}>
                Open
              </button>
            ) : (
              <span className="mono" style={{ wordBreak: "break-all" }}>
                {nft.uri}
              </span>
            )}
          </div>
        )}
      </div>
      {canSign && (
        <form className="well add-token" onSubmit={(e) => void review(e)}>
          <span className="eyebrow">Send it</span>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              className="input mono"
              placeholder={collection.standard === "cw721" ? "inj1… or 0x…" : "0x… or inj1…"}
              aria-label="Recipient"
              spellCheck={false}
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
            <button type="button" className="pill" onClick={() => setChoosing(true)}>
              Contacts
            </button>
          </div>
          {error && <p className="error">{error}</p>}
          <button className="btn btn-gold" disabled={busy || !to.trim()}>
            {busy ? "Checking…" : "Review"}
          </button>
        </form>
      )}
      <p className="footnote">The wallet doesn&apos;t load NFT images or metadata, so their hosts don&apos;t learn what you hold.</p>
    </Screen>
  );
}
