// Fetches recent mainnet transactions by message type from a public Injective RPC, for the
// real-dapp corpus. Writes them as they are to a PRIVATE directory outside the repository:
// they name real accounts. `build.mjs` turns them into the repository's corpus, with every
// account replaced by a test account.
//
//   node tools/corpus/fetch.mjs <private-dir>
//
// Read-only public endpoints; no key, no account and nothing about the user is sent.
import fs from "node:fs";
import path from "node:path";
import { parseTx, addressesIn } from "./tx.mjs";

const RPC = "https://sentry.tm.injective.network";
const LCD = "https://sentry.lcd.injective.network";
const EVM = "https://sentry.evm-rpc.injective.network/";

// What Helix, Injective Hub, Mito, Choice and the DEXes send. Not every one turns up in a
// day of blocks (the public RPC keeps about that much).
export const ACTIONS = [
  // Hub
  "/cosmos.bank.v1beta1.MsgSend",
  "/cosmos.bank.v1beta1.MsgMultiSend",
  "/cosmos.staking.v1beta1.MsgDelegate",
  "/cosmos.staking.v1beta1.MsgUndelegate",
  "/cosmos.staking.v1beta1.MsgBeginRedelegate",
  "/cosmos.staking.v1beta1.MsgCancelUnbondingDelegation",
  "/cosmos.distribution.v1beta1.MsgWithdrawDelegatorReward",
  "/cosmos.distribution.v1beta1.MsgSetWithdrawAddress",
  "/cosmos.gov.v1beta1.MsgVote",
  "/cosmos.gov.v1.MsgVote",
  "/cosmos.gov.v1beta1.MsgDeposit",
  "/cosmos.gov.v1.MsgDeposit",
  "/ibc.applications.transfer.v1.MsgTransfer",
  "/injective.peggy.v1.MsgSendToEth",
  "/cosmos.authz.v1beta1.MsgGrant",
  "/cosmos.authz.v1beta1.MsgRevoke",
  "/cosmos.authz.v1beta1.MsgExec",
  "/cosmos.feegrant.v1beta1.MsgGrantAllowance",
  "/injective.auction.v1beta1.MsgBid",
  // Helix (exchange v1beta1 and v2)
  ...["v1beta1", "v2"].flatMap((v) =>
    [
      "MsgCreateSpotLimitOrder",
      "MsgCreateSpotMarketOrder",
      "MsgCreateDerivativeLimitOrder",
      "MsgCreateDerivativeMarketOrder",
      "MsgCancelSpotOrder",
      "MsgCancelDerivativeOrder",
      "MsgBatchCancelSpotOrders",
      "MsgBatchCancelDerivativeOrders",
      "MsgBatchUpdateOrders",
      "MsgDeposit",
      "MsgWithdraw",
      "MsgSubaccountTransfer",
      "MsgExternalTransfer",
      "MsgIncreasePositionMargin",
      "MsgDecreasePositionMargin",
      "MsgPrivilegedExecuteContract",
      "MsgInstantSpotMarketLaunch",
    ].map((m) => `/injective.exchange.${v}.${m}`),
  ),
  // Mito, Choice, the DEXes, launchpads
  "/cosmwasm.wasm.v1.MsgExecuteContract",
  "/injective.wasmx.v1.MsgExecuteContractCompat",
  "/cosmwasm.wasm.v1.MsgInstantiateContract",
  "/injective.tokenfactory.v1beta1.MsgCreateDenom",
  "/injective.tokenfactory.v1beta1.MsgMint",
  "/injective.tokenfactory.v1beta1.MsgBurn",
  "/injective.tokenfactory.v1beta1.MsgSetDenomMetadata",
  "/injective.erc20.v1beta1.MsgCreateTokenPair",
  // EVM
  "/injective.evm.v1.MsgEthereumTx",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url) {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      // The LCD answers "no such contract" with a 500 and a JSON body; that is an answer.
      if (r.status === 429 || r.status >= 502) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      if (i === 3) throw e;
      await sleep(2000 * (i + 1));
    }
  }
}

async function search(action, page, perPage) {
  const q = encodeURIComponent(`"message.action='${action}'"`);
  const d = await get(`${RPC}/tx_search?query=${q}&page=${page}&per_page=${perPage}&order_by=%22desc%22`);
  return d.result?.txs ?? [];
}

const dir = process.argv[2];
if (!dir || dir.startsWith(path.resolve(import.meta.dirname, "../.."))) {
  console.error("usage: fetch.mjs <private-dir outside the repository>");
  process.exit(2);
}
fs.mkdirSync(path.join(dir, "raw"), { recursive: true });

const pages = { "/cosmwasm.wasm.v1.MsgExecuteContract": 4, "/injective.evm.v1.MsgEthereumTx": 4 };
for (const action of ACTIONS) {
  const file = path.join(dir, "raw", action.slice(1).replaceAll("/", "_") + ".json");
  if (fs.existsSync(file)) continue;
  const txs = [];
  for (let p = 1; p <= (pages[action] ?? 1); p++) {
    const got = await search(action, p, 50);
    txs.push(...got.map((t) => ({ hash: t.hash, height: t.height, code: t.tx_result.code, tx: t.tx })));
    await sleep(400);
    if (got.length < 50) break;
  }
  fs.writeFileSync(file, JSON.stringify(txs));
  console.log(action, txs.length);
}

// Busy dapp contracts, sampled by contract: most CosmWasm calls in a day are bots'. Pools of
// DojoSwap, Choice (AMM and CLMM), Astroport and White Whale, Choice's CLMM manager and the
// CW20 adapter.
export const CONTRACTS = [
  "inj1h0mpv48ctcsmydymh2hnkal7hla5gl4gftemqv", "inj1d5xuqkrj8kwqvwyxss4q5w0dkduywqq3uucv87",
  "inj1c95v0zr7ah777qn05sqwfnd03le4f40rucs0dp", "inj13p9q5hqudqrmryz6f0t7j9yatacw9rueuy6n8w",
  "inj17lpu6atwwtdnn6t9fuedhstqkrzsqh42l2jz0w", "inj1gdh672jjy0yhu86xwfv2gejr08xpccf8u7c8e7",
  "inj1gk4thnx4t9y4ltnau60mpst5xyu0u57hqfl0qs", "inj10fd06xl4q6jp9qlhemvm6ymmm83ppj2g8rzquw",
  "inj1jkpm8nwjtcz536ulyyf2z675ekgsvf5rkessm2", "inj10g2xy5cnr54zjwc6ugaeq9u3mjlc7we7p6hq27",
  "inj1eag2kjzs5ma5sflxvlhaacdxxpvdjg4ny7yg3g", "inj14ejqjyq8um4p3xfqj74yld5waqljf88f9eneuk",
];
for (const c of CONTRACTS) {
  const file = path.join(dir, "raw", `contract_${c}.json`);
  if (fs.existsSync(file)) continue;
  const q = encodeURIComponent(`"execute._contract_address='${c}'"`);
  const d = await get(`${RPC}/tx_search?query=${q}&page=1&per_page=30&order_by=%22desc%22`);
  const txs = (d.result?.txs ?? []).map((t) => ({ hash: t.hash, height: t.height, code: t.tx_result.code, tx: t.tx }));
  fs.writeFileSync(file, JSON.stringify(txs));
  console.log(c.slice(0, 10), txs.length);
  await sleep(400);
}

// Which addresses are contracts (CosmWasm or EVM), so the build keeps them and replaces only
// accounts.
const kindFile = path.join(dir, "kinds.json");
const kinds = fs.existsSync(kindFile) ? JSON.parse(fs.readFileSync(kindFile, "utf8")) : {};
const all = new Set();
for (const f of fs.readdirSync(path.join(dir, "raw"))) {
  for (const t of JSON.parse(fs.readFileSync(path.join(dir, "raw", f), "utf8"))) {
    if (t.code !== 0) continue;
    try {
      for (const a of addressesIn(parseTx(Buffer.from(t.tx, "base64")))) all.add(a);
    } catch {
      // Not a transaction this tool reads; the build skips it too.
    }
  }
}
let n = 0;
for (const a of all) {
  if (a in kinds) continue;
  if (a.startsWith("0x")) {
    const r = await fetch(EVM, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getCode", params: [a, "latest"] }),
      signal: AbortSignal.timeout(30_000),
    }).then((r) => r.json());
    kinds[a] = r.result && r.result !== "0x" ? "evm_contract" : "account";
  } else {
    const r = await get(`${LCD}/cosmwasm/wasm/v1/contract/${a}`);
    kinds[a] = r.contract_info ? "wasm_contract" : "account";
  }
  if (++n % 50 === 0) fs.writeFileSync(kindFile, JSON.stringify(kinds));
  await sleep(150);
}
fs.writeFileSync(kindFile, JSON.stringify(kinds));
console.log("addresses", all.size, "new", n);

// Contract labels, to name the dapp behind each CosmWasm case.
const labelFile = path.join(dir, "labels.json");
const labels = fs.existsSync(labelFile) ? JSON.parse(fs.readFileSync(labelFile, "utf8")) : {};
for (const [a, k] of Object.entries(kinds)) {
  if (k !== "wasm_contract" || a in labels) continue;
  const r = await get(`${LCD}/cosmwasm/wasm/v1/contract/${a}`);
  labels[a] = r.contract_info?.label ?? "";
  await sleep(150);
}
fs.writeFileSync(labelFile, JSON.stringify(labels));
console.log("labels", Object.keys(labels).length);
