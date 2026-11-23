// A list of interchangeable endpoints, tried in turn. An endpoint that gives no usable answer
// (network error, timeout, a body that isn't JSON, an overloaded or wrong-chain node) is
// skipped; an error the chain itself returns is final and isn't retried elsewhere.
//
// Found 2026-11-08 on Injective mainnet, for a simulation that fails (insufficient funds):
// the sentry answers 500 with the chain's JSON error (over HTTP/1.1 it then cuts the
// response short), publicnode answers a bare 503, cosmos.directory answers 500 with the
// JSON error. So a JSON `{code, message}` body is the chain's answer at any status, and
// anything else is the endpoint's failure.

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** This endpoint gave no usable answer; the next one is tried. */
export class Down extends Error {
  override name = "Down";
}

/** No endpoint answered. `attempts` says what each one did. */
export class Unreachable extends Error {
  override name = "Unreachable";
  readonly attempts: readonly string[];
  constructor(attempts: readonly string[]) {
    super(`no endpoint answered (${attempts.join("; ")})`);
    this.attempts = attempts;
  }
}

/** The chain answered with an error. */
export class ChainError extends Error {
  override name = "ChainError";
  /** The gRPC status code (LCD) or JSON-RPC error code (EVM). */
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

export interface PoolOptions {
  fetch: Fetch;
  /** Per request, body included. */
  timeoutMs?: number;
  /** The most of an answer read, after the browser decodes it (default `MAX_ANSWER`). */
  maxBytes?: number;
  /** Throws `Down` unless the endpoint serves the expected chain. Run once per endpoint
   *  while it keeps passing. */
  identify(base: string): Promise<void>;
}

/** The most of one answer a pool reads: the largest the wallet asks for (a busy account's
 *  token accounts, a page of history) is well under it. An endpoint can send a few bytes the
 *  browser decodes into any amount, so the answer is read as a stream and cut off here (run-3). */
export const MAX_ANSWER = 16 * 1024 * 1024;

/** The bytes of answers every pool in this worker holds at once, until each is parsed. The cap
 *  above is per answer: a site's own endpoint answering many of its reads at once could
 *  otherwise make the worker hold any number of them (run-4). */
export const MAX_IN_FLIGHT = 48 * 1024 * 1024;
let inFlight = 0;

/** The most JSON values (arrays, objects, items) one answer may parse into: `[[],[],…]` makes a
 *  16 MiB answer some 200 MiB of arrays. The largest answers the wallet reads (a page of logs,
 *  of NFT transfers) have a few hundred thousand (run-4). */
export const MAX_VALUES = 500_000;

/** Commas, arrays and objects outside strings: a bound on how many values `text` parses into. */
function values(text: string): number {
  let n = 0;
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (quoted) {
      if (c === 92) i++;
      else if (c === 34) quoted = false;
    } else if (c === 34) quoted = true;
    else if (c === 44 || c === 91 || c === 123) n++;
  }
  return n;
}

/** The answer's text, read up to `max` bytes; `held.bytes` counts what it holds against
 *  `MAX_IN_FLIGHT` until the caller lets it go. */
async function bounded(res: Response, max: number, held: { bytes: number }): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    held.bytes += value.length;
    inFlight += value.length;
    if (size > max || inFlight > MAX_IN_FLIGHT) {
      void reader.cancel().catch(() => {});
      throw new Down(size > max ? "answer too large" : "too many answers at once");
    }
    parts.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.length;
  }
  return new TextDecoder().decode(all);
}

export class Pool {
  readonly urls: readonly string[];
  readonly #opts: PoolOptions;
  #preferred = 0;
  readonly #identified = new Map<string, Promise<void>>();

  constructor(urls: readonly string[], opts: PoolOptions) {
    const clean = urls.map((u) => u.trim().replace(/\/+$/, "")).filter(Boolean);
    if (clean.length === 0) throw new RangeError("no endpoints");
    for (const u of clean) {
      const p = new URL(u);
      const local = p.hostname === "127.0.0.1" || p.hostname === "localhost";
      if (p.protocol !== "https:" && !(local && p.protocol === "http:")) {
        throw new RangeError(`endpoints must use https: ${u}`);
      }
    }
    this.urls = clean;
    this.#opts = opts;
  }

  /** The endpoint that answered last (or will be tried first). */
  get current(): string {
    return this.urls[this.#preferred]!;
  }

  /** Run `attempt` against each endpoint in turn, starting from the last one that answered,
   *  until one answers. `attempt` throws `Down` to move on.
   *
   *  A read (the default) is sent while the endpoint is still being identified, and its
   *  answer counts only once the endpoint proves it serves the right chain: a wrong-chain
   *  endpoint's answer, or its error, is thrown away like any other failure. That saves a
   *  round trip on every new endpoint (each service worker start). A `write` (a broadcast)
   *  waits for the endpoint to be identified first. */
  async run<T>(attempt: (base: string, tries: number) => Promise<T>, opts: { write?: boolean } = {}): Promise<T> {
    const failures: string[] = [];
    for (let i = 0; i < this.urls.length; i++) {
      const index = (this.#preferred + i) % this.urls.length;
      const base = this.urls[index]!;
      try {
        let value: T;
        if (opts.write) {
          await this.#identify(base);
          value = await attempt(base, i);
        } else {
          const [identified, answered] = await Promise.allSettled([this.#identify(base), attempt(base, i)]);
          if (identified.status === "rejected") throw identified.reason;
          if (answered.status === "rejected") throw answered.reason;
          value = answered.value;
        }
        this.#preferred = index;
        return value;
      } catch (e) {
        if (!(e instanceof Down)) {
          this.#preferred = index;
          throw e;
        }
        failures.push(`${base}: ${e.message}`);
      }
    }
    throw new Unreachable(failures);
  }

  /** Fetch and parse JSON. Throws `Down` if nothing parseable came back in time. */
  async json(url: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
    const held = { bytes: 0 };
    try {
      let text: string;
      let status: number;
      try {
        const res = await this.#opts.fetch(url, { ...init, signal: AbortSignal.timeout(this.#opts.timeoutMs ?? 10_000) });
        status = res.status;
        text = await bounded(res, this.#opts.maxBytes ?? MAX_ANSWER, held);
      } catch (e) {
        if (e instanceof Down) throw e;
        throw new Down(e instanceof Error && e.name === "TimeoutError" ? "timed out" : `network error (${String(e)})`);
      }
      // Only a long answer can hold more values than the bound.
      if (text.length > MAX_VALUES && values(text) > MAX_VALUES) throw new Down("answer too large");
      try {
        return { status, body: JSON.parse(text) as unknown };
      } catch {
        throw new Down(`HTTP ${status}, not JSON`);
      }
    } finally {
      inFlight -= held.bytes;
    }
  }

  #identify(base: string): Promise<void> {
    let p = this.#identified.get(base);
    if (!p) {
      p = this.#opts.identify(base);
      this.#identified.set(base, p);
      p.catch(() => this.#identified.delete(base));
    }
    return p;
  }
}

/** Plain-object check for parsed JSON. */
export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
