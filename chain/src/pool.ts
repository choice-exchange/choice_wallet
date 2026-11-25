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

/** This endpoint gave no usable answer; the next one is tried. `refused`: it answered, and
 *  said it didn't take the request (a rate limit), so a write wasn't sent there. */
export class Down extends Error {
  override name = "Down";
  readonly refused: boolean;
  constructor(message: string, opts: { refused?: boolean } = {}) {
    super(message);
    this.refused = opts.refused ?? false;
  }
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

/** The worker holds as many answers as its budget allows: this one was refused. It isn't the
 *  endpoint's failure, so no other endpoint is tried (run-5). */
export class Busy extends Unreachable {
  override name = "Busy";
  constructor() {
    super(["the wallet is reading too much at once"]);
  }
}

/** A write (a broadcast) went out to an endpoint, and no answer saying what became of it was
 *  read: it may be on its way. A caller follows its hash rather than call it failed, so a retry
 *  doesn't send it twice (run-5). */
export class Unconfirmed extends Unreachable {
  override name = "Unconfirmed";
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
  /** What this pool's answers are counted against: the wallet's own by default, a site's own
   *  for endpoints it supplied or reads it asks for (`siteBudget`). */
  budget?: Budget;
}

/** Bytes of answers held at once, until each is parsed, against a cap. */
export class Budget {
  held = 0;
  readonly cap: number;
  constructor(cap: number) {
    this.cap = cap;
  }
}

/** The most of one answer a pool reads: the largest the wallet asks for (a busy account's
 *  token accounts, a page of history) is well under it. An endpoint can send a few bytes the
 *  browser decodes into any amount, so the answer is read as a stream and cut off here (run-3). */
export const MAX_ANSWER = 16 * 1024 * 1024;

/** The bytes of answers the wallet's own pools hold at once, until each is parsed. The cap
 *  above is per answer: a site's own endpoint answering many of its reads at once could
 *  otherwise make the worker hold any number of them (run-4). A site's load is counted against
 *  its own budget instead, so holding it can't fail the wallet's reads (run-5). */
export const MAX_IN_FLIGHT = 48 * 1024 * 1024;
/** What one site's endpoints and reads may hold at once: one answer as large as any. */
export const MAX_SITE_IN_FLIGHT = 24 * 1024 * 1024;
/** The most of a write's answer read (a broadcast's is a hash or a short result). Not counted
 *  against any budget, so nothing else held can make it look unanswered. */
export const MAX_WRITE_ANSWER = 1024 * 1024;

const WALLET = new Budget(MAX_IN_FLIGHT);
const sites = new Map<string, Budget>();
/** The budget a site's endpoints and reads share (by origin). */
export function siteBudget(origin: string): Budget {
  let b = sites.get(origin);
  if (!b) {
    b = new Budget(MAX_SITE_IN_FLIGHT);
    sites.set(origin, b);
  }
  return b;
}

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
 *  `budget` (none for a write) until the caller lets it go. */
async function bounded(res: Response, max: number, held: { bytes: number }, budget: Budget | null): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (budget) {
      held.bytes += value.length;
      budget.held += value.length;
    }
    if (size > max) {
      void reader.cancel().catch(() => {});
      throw new Down("answer too large");
    }
    if (budget && budget.held > budget.cap) {
      void reader.cancel().catch(() => {});
      throw new Busy();
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
   *  waits for the endpoint to be identified first, and once it went out to any endpoint, no
   *  answer read ends in `Unconfirmed`, not `Unreachable`: it may have landed (run-5). The same
   *  bytes still go to the next endpoint, which can only relay them again. */
  async run<T>(attempt: (base: string, tries: number) => Promise<T>, opts: { write?: boolean } = {}): Promise<T> {
    const failures: string[] = [];
    /** A write went out to an endpoint that then gave no answer. */
    let sent = false;
    for (let i = 0; i < this.urls.length; i++) {
      const index = (this.#preferred + i) % this.urls.length;
      const base = this.urls[index]!;
      let going = false;
      try {
        let value: T;
        if (opts.write) {
          await this.#identify(base);
          going = true;
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
          // Anything else after an earlier endpoint took it (the chain's "nonce too low": it
          // landed; or this endpoint's check failing) says nothing sure about the write.
          // "Already known" says it's there.
          if (sent && !(e instanceof ChainError && /already known|already imported|known transaction/i.test(e.message))) {
            throw new Unconfirmed([...failures, `${base}: ${e instanceof Error ? e.message : String(e)}`]);
          }
          throw e;
        }
        failures.push(`${base}: ${e.message}`);
        if (going && !e.refused) sent = true;
      }
    }
    throw sent ? new Unconfirmed(failures) : new Unreachable(failures);
  }

  /** Fetch and parse JSON. Throws `Down` if nothing parseable came back in time, `Busy` when
   *  the pool's budget is full. A `write`'s answer is read on its own small cap, uncounted. */
  async json(url: string, init: RequestInit = {}, opts: { write?: boolean } = {}): Promise<{ status: number; body: unknown }> {
    const held = { bytes: 0 };
    const budget = opts.write ? null : (this.#opts.budget ?? WALLET);
    try {
      let text: string;
      let status: number;
      try {
        const res = await this.#opts.fetch(url, { ...init, signal: AbortSignal.timeout(this.#opts.timeoutMs ?? 10_000) });
        status = res.status;
        text = await bounded(res, opts.write ? MAX_WRITE_ANSWER : (this.#opts.maxBytes ?? MAX_ANSWER), held, budget);
      } catch (e) {
        if (e instanceof Down || e instanceof Busy) throw e;
        throw new Down(e instanceof Error && e.name === "TimeoutError" ? "timed out" : `network error (${String(e)})`);
      }
      // Only a long answer can hold more values than the bound.
      if (text.length > MAX_VALUES && values(text) > MAX_VALUES) throw new Down("answer too large");
      try {
        return { status, body: JSON.parse(text) as unknown };
      } catch {
        // A 4xx that isn't the chain's JSON (a rate limit, a refusal) didn't take the request.
        throw new Down(`HTTP ${status}, not JSON`, { refused: status >= 400 && status < 500 });
      }
    } finally {
      if (budget) budget.held -= held.bytes;
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
