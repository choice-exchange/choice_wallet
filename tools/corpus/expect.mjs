// Stores what the vault said about each corpus case (from `CORPUS_RECORD=<file> cargo test
// -p choice-wallet-vault real_dapp`) as the case's expectation, once it has been reviewed.
//   node tools/corpus/expect.mjs <outcomes.json> [crates/vault/tests/corpus.json]
import fs from "node:fs";

const [outcomes, file = "crates/vault/tests/corpus.json"] = process.argv.slice(2);
const got = JSON.parse(fs.readFileSync(outcomes, "utf8"));
const corpus = JSON.parse(fs.readFileSync(file, "utf8"));
for (const c of corpus.cases) {
  if (!(c.name in got)) throw new Error(`no outcome for ${c.name}`);
  c.expect = got[c.name];
}
fs.writeFileSync(file, JSON.stringify(corpus, null, 1) + "\n");
console.log("expectations", corpus.cases.length);
