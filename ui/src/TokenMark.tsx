// A token's mark: its logo if it is on the wallet's list, otherwise its first letters on a
// hue taken from its denom.
//
// The logo is chosen by DENOM, never by symbol, and only for tokens the host marks as
// known: a token whose creator named it "USDT" costs nothing to make, and painting the
// real USDT's logo on it is the one rendering mistake here worth money to someone. Its
// monogram's hue comes from the denom too, so two "USDT"s look different.

import atom from "./assets/tokens/atom.png";
import inj from "./assets/tokens/inj.png";
import usdc from "./assets/tokens/usdc.png";
import usdt from "./assets/tokens/usdt.png";
import weth from "./assets/tokens/weth.png";

const LOGOS: Record<string, string> = {
  inj,
  "erc20:0xa00C59fF5a080D2b954d0c75e46E22a0c371235a": usdc,
  "ibc/2CBC2EA121AE42563B08028466F37B600F2D7D4282342DE938283CC3FB2BC00E": usdc,
  peggy0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48: usdc,
  peggy0xdAC17F958D2ee523a2206206994597C13D831ec7: usdt,
  peggy0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2: weth,
  "ibc/C4CFF46FD6DE35CA4CF4CE031E643C8FDC9BA4B99AE598E9B0ED98FE3A2319F9": atom,
  // On Solana: Circle's USDC (mainnet and devnet) and Tether's USDT, by mint.
  "spl:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": usdc,
  "spl:4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU": usdc,
  "spl:Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB": usdt,
};

export function TokenMark({ denom, symbol, known, small }: { denom: string; symbol: string; known: boolean; small?: boolean }) {
  // USDC on another chain, in a bridge transfer's review (`usdc:<chain>`).
  const logo = known ? (LOGOS[denom] ?? (denom.startsWith("usdc:") ? usdc : undefined)) : undefined;
  const cls = small ? "mark sm" : "mark";
  if (logo) {
    return (
      <span className={cls} style={{ borderColor: "transparent" }} aria-hidden="true">
        <img src={logo} alt="" />
      </span>
    );
  }
  const hue = hueOf(denom);
  return (
    <span
      className={cls}
      aria-hidden="true"
      style={{ background: `hsl(${hue} 38% 16%)`, borderColor: `hsl(${hue} 40% 26%)`, color: `hsl(${hue} 70% 76%)` }}
    >
      {monogram(symbol)}
    </span>
  );
}

function monogram(symbol: string): string {
  const letters = symbol.replace(/[^\p{L}\p{N}]/gu, "").toUpperCase();
  return letters.slice(0, symbol.length > 4 ? 2 : 3) || "?";
}

/** FNV-1a over the denom, to a hue. */
function hueOf(denom: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < denom.length; i++) {
    h ^= denom.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 360;
}
