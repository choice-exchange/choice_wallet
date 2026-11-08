// The vault's wasm-bindgen glue (`wasm-bindgen --target web`), aliased by build.mjs.
declare module "choice-wallet-vault-glue" {
  /** Handle one vault request (JSON) and return the response (JSON). */
  export function handle(request: string): string;
  /** Load the module asynchronously, from a URL or bytes. */
  export default function init(input: { module_or_path: string | URL | BufferSource }): Promise<unknown>;
  /** Load the module synchronously, from bytes (tests). */
  export function initSync(input: { module: BufferSource }): unknown;
}
