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
  /** Throws `Down` unless the endpoint serves the expected chain. Run once per endpoint
   *  while it keeps passing. */
  identify(base: string): Promise<void>;
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
   *  until one answers. `attempt` throws `Down` to move on. */
  async run<T>(attempt: (base: string, tries: number) => Promise<T>): Promise<T> {
    const failures: string[] = [];
    for (let i = 0; i < this.urls.length; i++) {
      const index = (this.#preferred + i) % this.urls.length;
      const base = this.urls[index]!;
      try {
        await this.#identify(base);
        const value = await attempt(base, i);
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
    let text: string;
    let status: number;
    try {
      const res = await this.#opts.fetch(url, { ...init, signal: AbortSignal.timeout(this.#opts.timeoutMs ?? 10_000) });
      status = res.status;
      text = await res.text();
    } catch (e) {
      throw new Down(e instanceof Error && e.name === "TimeoutError" ? "timed out" : `network error (${String(e)})`);
    }
    try {
      return { status, body: JSON.parse(text) as unknown };
    } catch {
      throw new Down(`HTTP ${status}, not JSON`);
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
