// Layout and small controls every screen uses.

import type { ReactNode } from "react";

import { BackIcon, InfoIcon, WarningIcon } from "./icons";
import type { Level } from "./protocol";

/** A screen: a top bar, a scrolling body, a foot holding its action, and the tab bar on
 *  the screens it belongs to. */
export function Screen({ top, children, foot, tabs }: { top?: ReactNode; children: ReactNode; foot?: ReactNode; tabs?: ReactNode }) {
  return (
    <div className="app">
      <div className="topbar">{top}</div>
      <div className="body slide-in">{children}</div>
      {foot && <div className="foot">{foot}</div>}
      {tabs}
    </div>
  );
}

/** A top bar with a back button and the screen's name. */
export function BackBar({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <>
      <button className="icon-btn" aria-label="Back" onClick={onBack} style={{ marginLeft: -8 }}>
        <BackIcon size={20} />
      </button>
      <span className="title">{title}</span>
    </>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: readonly (readonly [T, string])[];
  value: T;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={v} type="button" aria-pressed={v === value} onClick={() => onChange(v)}>
          {text}
        </button>
      ))}
    </div>
  );
}

/** An on/off setting that takes effect at once. */
export function Switch({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={checked} className="switch-row" onClick={() => onChange(!checked)}>
      <span>{label}</span>
      <span className="switch" aria-hidden="true">
        <span />
      </span>
    </button>
  );
}

export function Callout({ level, children }: { level: Level; children: ReactNode }) {
  return (
    <div className={`callout ${level}`} role={level === "info" ? undefined : "alert"}>
      {level === "info" ? <InfoIcon size={16} /> : <WarningIcon size={16} />}
      <span>{children}</span>
    </div>
  );
}

/** `inj1npvwllfr…re90dz`: enough of both ends to check by eye. */
export function shortAddress(a: string): string {
  return a.length > 20 ? `${a.slice(0, 10)}…${a.slice(-6)}` : a;
}

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** `$1,234.56`; a non-zero value under a cent shows as `<$0.01`. */
export function formatUsd(v: number): string {
  if (v > 0 && v < 0.01) return "<$0.01";
  return USD.format(v);
}
