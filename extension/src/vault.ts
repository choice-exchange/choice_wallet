// The vault protocol (crates/vault): one JSON request, one JSON response.

export type VaultError = { code: string; message: string };
export type Result<T> = { ok: true; result: T } | { ok: false; error: VaultError };

/** Call the vault through its `handle` export. */
export function callVault<T>(handle: (request: string) => string, method: string, params?: unknown): Result<T> {
  return JSON.parse(handle(JSON.stringify({ method, params: params ?? {} }))) as Result<T>;
}

/** An account as `accounts` lists it. */
export type AccountInfo = {
  account: { derivation: "default" | "ledger_live"; index: number } | { derivation: "imported" };
  public_key: string;
  /** Address per CAIP-2 chain ID. */
  addresses: Record<string, string>;
};
