// The vault protocol (crates/vault): one JSON request, one JSON response.

import type { Result } from "@choice-wallet/ui/protocol";

export type { AccountInfo, Result } from "@choice-wallet/ui/protocol";

/** Call the vault through its `handle` export. */
export function callVault<T>(handle: (request: string) => string, method: string, params?: unknown): Result<T> {
  return JSON.parse(handle(JSON.stringify({ method, params: params ?? {} }))) as Result<T>;
}
