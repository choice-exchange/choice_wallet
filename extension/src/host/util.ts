// What the service worker's modules share: a refusal in the UI's terms, and a random ID.

import { bytesToHex } from "@choice-wallet/chain";
import type { Result } from "@choice-wallet/ui/protocol";

/** A refusal for the UI: a stable code, and a message in words. */
export const fail = (code: string, message: string): Result<never> => ({ ok: false, error: { code, message } });

/** A random ID, `bytes` long, in hex: for something kept between two steps. */
export const randomId = (bytes = 8): string => bytesToHex(crypto.getRandomValues(new Uint8Array(bytes)));
