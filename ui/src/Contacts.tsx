// The address book: saved recipients, each with the memo an exchange needs, if any. A send
// to a saved address is named in its review, one that only looks like a saved address is
// flagged, and a saved memo has to be on the send.

import { useEffect, useState, type FormEvent } from "react";

import { ChevronRightIcon } from "./icons";
import { BackBar, Callout, Screen, shortAddress } from "./kit";
import type { AccountInfo, Contact } from "./protocol";
import { useRequest } from "./request";

/** A contact not saved yet, from a send. */
export type Draft = { address: string; memo: string };

const COSMOS = "cosmos:injective-1";

export function ContactsView({ prefill, onBack }: { prefill?: Draft | undefined; onBack: () => void }) {
  const { run, error } = useRequest();
  const [list, setList] = useState<Contact[] | null>(null);
  const [editing, setEditing] = useState<Contact | Draft | null>(prefill ?? null);

  useEffect(() => {
    void run({ type: "contacts" }).then((r) => r && setList(r));
  }, []);

  if (editing) {
    return (
      <ContactEditor
        initial={editing}
        onDone={(next) => {
          if (next) setList(next);
          // Opened from a send: back to where it came from.
          if (prefill) onBack();
          else setEditing(null);
        }}
      />
    );
  }

  return (
    <Screen
      top={<BackBar title="Address book" onBack={onBack} />}
      foot={
        <button className="btn btn-gold" onClick={() => setEditing({ address: "", memo: "" })}>
          Add contact
        </button>
      }
    >
      {error && <Callout level="amber">{error}</Callout>}
      {list === null && !error && [0, 1].map((i) => <div key={i} className="skeleton" style={{ height: 44 }} />)}
      {list?.length === 0 && <p className="empty">No contacts yet. Save the addresses you send to.</p>}
      {list && list.length > 0 && (
        <div className="token-list">
          {list.map((c) => (
            <button key={c.id} className="token" title={c.address} onClick={() => setEditing(c)}>
              <span className="name">
                <span className="symbol">{c.name}</span>
                <span className="sub mono">
                  {shortAddress(c.address)}
                  {c.memo ? ` · memo ${c.memo}` : ""}
                </span>
              </span>
              <ChevronRightIcon size={16} />
            </button>
          ))}
        </div>
      )}
      <p className="footnote">Sends to a saved address are named in the review. Lookalikes are flagged.</p>
    </Screen>
  );
}

function ContactEditor({ initial, onDone }: { initial: Contact | Draft; onDone: (list: Contact[] | null) => void }) {
  const saved = "id" in initial ? initial : null;
  const [name, setName] = useState(saved?.name ?? "");
  const [address, setAddress] = useState(initial.address);
  const [memo, setMemo] = useState(initial.memo);
  const { run, error, busy } = useRequest();

  async function save(e: FormEvent) {
    e.preventDefault();
    const r = await run({ type: "save_contact", ...(saved ? { id: saved.id } : {}), name, address: address.trim(), memo });
    if (r) onDone(r);
  }
  async function remove() {
    if (!saved) return;
    const r = await run({ type: "remove_contact", id: saved.id });
    if (r) onDone(r);
  }

  return (
    <form onSubmit={(e) => void save(e)} style={{ height: "100%" }}>
      <Screen
        top={<BackBar title={saved ? "Edit contact" : "New contact"} onBack={() => onDone(null)} />}
        foot={
          <>
            {error && <Callout level="amber">{error}</Callout>}
            <button className="btn btn-gold" type="submit" disabled={busy || !name.trim() || !address.trim()}>
              {busy ? "Saving…" : "Save"}
            </button>
            {saved && (
              <button type="button" className="btn btn-quiet danger-text" disabled={busy} onClick={() => void remove()}>
                Delete contact
              </button>
            )}
          </>
        }
      >
        <label className="field">
          <span className="eyebrow">Name</span>
          <input className="input" aria-label="Contact name" autoComplete="off" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </label>
        <label className="field">
          <span className="eyebrow">Address</span>
          <input className="input mono" aria-label="Contact address" placeholder="inj1… or 0x…" autoComplete="off" spellCheck={false} value={address} onChange={(e) => setAddress(e.target.value)} />
        </label>
        <label className="field">
          <span className="eyebrow">Memo</span>
          <input className="input mono" aria-label="Contact memo" placeholder="Only for exchanges" autoComplete="off" spellCheck={false} value={memo} onChange={(e) => setMemo(e.target.value)} />
          <span className="meta">An exchange shows it beside its deposit address. Sends here will need it.</span>
        </label>
      </Screen>
    </form>
  );
}

/** Pick a recipient: the user's other accounts, then the address book. */
export function RecipientPicker({
  accounts,
  contacts,
  onPick,
  onBack,
}: {
  accounts: AccountInfo[];
  contacts: Contact[] | null;
  onPick: (address: string, memo: string) => void;
  onBack: () => void;
}) {
  const own = accounts.filter((a) => a.addresses[COSMOS]);
  return (
    <Screen top={<BackBar title="Send to" onBack={onBack} />}>
      {own.length > 0 && (
        <>
          <div className="section-head">
            <span className="eyebrow">Your accounts</span>
          </div>
          <div className="token-list">
            {own.map((a) => (
              <button key={a.addresses[COSMOS]} className="token" title={a.addresses[COSMOS]} onClick={() => onPick(a.addresses[COSMOS]!, "")}>
                <span className="name">
                  <span className="symbol">{a.name}</span>
                  <span className="sub mono">{shortAddress(a.addresses[COSMOS]!)}</span>
                </span>
              </button>
            ))}
          </div>
        </>
      )}
      <div className="section-head">
        <span className="eyebrow">Address book</span>
      </div>
      {contacts === null && <div className="skeleton" style={{ height: 44 }} />}
      {contacts?.length === 0 && <p className="empty">No contacts yet. Add them in Settings.</p>}
      {contacts && contacts.length > 0 && (
        <div className="token-list">
          {contacts.map((c) => (
            <button key={c.id} className="token" title={c.address} onClick={() => onPick(c.address, c.memo)}>
              <span className="name">
                <span className="symbol">{c.name}</span>
                <span className="sub mono">
                  {shortAddress(c.address)}
                  {c.memo ? ` · memo ${c.memo}` : ""}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </Screen>
  );
}
