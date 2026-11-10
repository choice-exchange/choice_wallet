import { useState } from "react";

import { useBackend } from "./backend";
import type { Reply, Result, UiRequest } from "./protocol";

const UNREACHABLE = "The wallet didn't answer. Try again.";

/** Send a request to the host; on failure keep its message in `error` and resolve to null. */
/** What went wrong, in words: a thrown error's message. */
export const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function useRequest() {
  const backend = useBackend();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function run<R extends UiRequest>(req: R): Promise<Reply<R> | null> {
    setError(null);
    setBusy(true);
    let r: Result<Reply<R>>;
    try {
      r = await backend.send(req);
    } catch {
      r = { ok: false, error: { code: "unreachable", message: UNREACHABLE } };
    } finally {
      setBusy(false);
    }
    if (r.ok) return r.result;
    setError(r.error.message);
    return null;
  }
  return { run, error, setError, busy };
}
