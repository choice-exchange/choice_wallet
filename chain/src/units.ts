// Amounts: base units (integers, as decimal strings on the wire) ⇄ what people type and
// read. BigInt only; never floating point.

const DIGITS = /^[0-9]+$/;

/** Base units → a decimal string, exact, trailing zeros dropped: (1500000, 6) → "1.5". */
export function formatUnits(amount: string | bigint, decimals: number): string {
  const v = typeof amount === "bigint" ? amount : toBigInt(amount);
  if (v < 0n) throw new RangeError("negative amount");
  const s = v.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

/** Like `formatUnits`, cut (never rounded up) to `maxFraction` digits, for lists. */
export function formatShort(amount: string | bigint, decimals: number, maxFraction = 6): string {
  const exact = formatUnits(amount, decimals);
  const [whole = "0", frac = ""] = exact.split(".");
  const cut = frac.slice(0, maxFraction).replace(/0+$/, "");
  if (cut) return `${whole}.${cut}`;
  if (frac && whole === "0") return `<0.${"0".repeat(maxFraction - 1)}1`;
  return whole;
}

/** What someone typed → base units. Throws RangeError with a short reason. */
export function parseUnits(text: string, decimals: number): bigint {
  const t = text.trim();
  const m = /^([0-9]*)(?:\.([0-9]*))?$/.exec(t);
  if (!t || !m || (!m[1] && !m[2])) throw new RangeError("Enter a number.");
  const whole = m[1] || "0";
  const frac = m[2] ?? "";
  if (frac.length > decimals) throw new RangeError(`At most ${decimals} decimal places.`);
  return BigInt(whole + frac.padEnd(decimals, "0"));
}

/** A non-negative integer string (as the chain sends amounts) → bigint. */
export function toBigInt(s: string): bigint {
  if (!DIGITS.test(s)) throw new RangeError(`not an integer amount: ${JSON.stringify(s)}`);
  return BigInt(s);
}

/** A chain decimal ("160000000.000000000000000000") → bigint, rounded up. */
export function ceilDecimal(s: string): bigint {
  const m = /^([0-9]+)(?:\.([0-9]+))?$/.exec(s.trim());
  if (!m || m[1] === undefined) throw new RangeError(`not a decimal: ${JSON.stringify(s)}`);
  const whole = BigInt(m[1]);
  return m[2] && /[1-9]/.test(m[2]) ? whole + 1n : whole;
}
