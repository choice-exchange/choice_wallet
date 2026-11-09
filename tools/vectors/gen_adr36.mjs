// ADR-036 (signArbitrary) vectors from injective-ts: the sign doc it builds and the
// ethsecp256k1 signature over it (keccak256), for the test phrase's account 0.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrivateKey, generateArbitrarySignDoc } from "@injectivelabs/sdk-ts";

const PHRASE = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const key = PrivateKey.fromMnemonic(PHRASE, "m/44'/60'/0'/0/0");
const signer = key.toBech32();
const hex = (b) => Buffer.from(b).toString("hex");

const cases = [
  ["text", "Sign in to example.org\nNonce: 42"],
  ["empty", ""],
  ["unicode", "Choice ✓ 你好"],
].map(([name, message]) => {
  const { signDocBuff } = generateArbitrarySignDoc(message, signer);
  const signature = key.sign(Buffer.from(signDocBuff));
  return { name, data_hex: hex(Buffer.from(message, "utf8")), sign_doc: Buffer.from(signDocBuff).toString("utf8"), signature: hex(signature) };
});

const out = { generator: "tools/vectors/gen_adr36.mjs with @injectivelabs/sdk-ts 1.20.62", phrase: PHRASE, signer, public_key: hex(key.toPublicKey().toBytes?.() ?? Buffer.from(key.toPublicKey().toBase64(), "base64")), cases };
const file = join(dirname(fileURLToPath(import.meta.url)), "../../crates/injective/tests/vectors/adr36.json");
writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
console.log(`wrote ${cases.length} ADR-036 cases to ${file}`);
