// Chains the user adds (host/addedchains.ts): found on chainlist.org's list, kept only with
// endpoints that answer as their chain ID, their logo fetched once, their coin priced, sent
// on, taken off again; and a site adding one, reviewed first.

import assert from "node:assert/strict";
import { test } from "node:test";

import { listedChain } from "../src/host/addedchains";
import { chain, code, INJ, ME_EVM, ok, PASSWORD, THEM_EVM, TINY_PNG, wallet } from "./fake";

type Added = { chainId: number; name: string; symbol: string; rpc: string[]; explorer?: string; testnet: boolean; logo?: string; llama?: string };
type Status = { chain: string; network: string; added: Added[]; accounts: { addresses: Record<string, string> }[]; active: number };
type Listed = { chainId: number; name: string; symbol: string; testnet: boolean; rpc: string[]; explorer?: string; llama?: string; flags: string[] };

const BNB = { chainId: 56, name: "BNB Smart Chain", symbol: "BNB", rpc: ["https://wrong-rpc.example", "https://bnb-rpc.example"], explorer: "https://bscscan.com/", testnet: false };

test("chainlist.org's entries are read with care: endpoints that track least first, no keys to fill in", () => {
  const bnb = listedChain({
    name: "BNB <Smart> Chain",
    chainId: 56,
    nativeCurrency: { symbol: "BNB", decimals: 18 },
    rpc: [{ url: "https://a.example", tracking: "yes" }, { url: "https://b.example/", tracking: "none" }, "https://${KEY}.example", "http://plain.example", "https://c.example/API_KEY"],
    explorers: [{ url: "javascript:alert(1)" }, { url: "https://scan.example/" }],
    chainSlug: "Binance!",
    redFlags: ["reusedChainId", 7],
  });
  assert.deepEqual(bnb, { chainId: 56, name: "BNB Smart Chain", symbol: "BNB", decimals: 18, testnet: false, rpc: ["https://b.example", "https://a.example"], explorer: "https://scan.example", flags: ["reusedChainId"] });
  for (const bad of [null, "x", { chainId: 0, name: "Zero", nativeCurrency: { symbol: "Z" } }, { chainId: 5, name: "", nativeCurrency: { symbol: "E" } }, { chainId: 1.5, name: "Half", nativeCurrency: { symbol: "H" } }, { chainId: 9, name: "Old", nativeCurrency: { symbol: "O" }, status: "deprecated" }]) {
    assert.equal(listedChain(bad), null, JSON.stringify(bad));
  }
});

test("a chain from chainlist.org: endpoints checked, logo kept, coin priced, sent on, then removed", async () => {
  const net = chain({ balances: { inj: INJ } });
  const { service } = await wallet(net);

  // Found by name or ID; chains built in, coins not at 18 decimals and other networks' aren't offered.
  const found = ok<Listed[]>(await service.handle({ type: "chain_search", query: "bnb" }));
  assert.deepEqual(found.map((c) => c.chainId), [56]);
  assert.deepEqual([found[0]!.name, found[0]!.rpc], ["BNB Smart Chain", ["https://bnb-rpc.example", "https://wrong-rpc.example"]]);
  assert.deepEqual([found[0]!.llama, found[0]!.explorer], ["binance", "https://bscscan.com"]);
  assert.deepEqual(ok<Listed[]>(await service.handle({ type: "chain_search", query: "97" })).map((c) => [c.chainId, c.testnet]), [[97, true]]);
  for (const q of ["8453", "six"]) assert.deepEqual(ok<Listed[]>(await service.handle({ type: "chain_search", query: q })), [], q);
  assert.deepEqual(ok<Listed[]>(await service.handle({ type: "chain_search", query: "reused" }))[0]!.flags, ["reusedChainId"]);
  assert.equal(code(await service.handle({ type: "chain_search", query: " " })), "bad_request");

  // Prices already read for the chains there were: a chain added now is priced at once.
  ok(await service.handle({ type: "balances" }));

  // Refused: a built-in chain, a coin with no symbol, endpoints that aren't the chain's.
  assert.equal(code(await service.handle({ type: "add_chain", chain: { ...BNB, chainId: 8453 } })), "invalid");
  assert.equal(code(await service.handle({ type: "add_chain", chain: { ...BNB, symbol: "" } })), "invalid");
  assert.equal(code(await service.handle({ type: "add_chain", chain: { ...BNB, rpc: ["http://bnb-rpc.example"] } })), "invalid_endpoint");
  assert.equal(code(await service.handle({ type: "add_chain", chain: { ...BNB, rpc: ["https://wrong-rpc.example"] } })), "unreachable");
  assert.equal(code(await service.handle({ type: "add_chain", chain: { ...BNB, explorer: "http://bscscan.com" } })), "invalid");

  // Added: only the endpoint that serves chain 56 kept; DefiLlama's logo, as a data URL.
  const s = ok<Status>(await service.handle({ type: "add_chain", chain: BNB }));
  const added = s.added[0]!;
  assert.deepEqual([added.chainId, added.rpc, added.explorer, added.llama], [56, ["https://bnb-rpc.example"], "https://bscscan.com", "binance"]);
  assert.match(added.logo ?? "", /^data:image\/png;base64,/);
  assert.deepEqual(net.state.logos, ["/icons/chains/rsz_binance.jpg"]);
  assert.equal(code(await service.handle({ type: "add_chain", chain: BNB })), "exists");
  // The account's 0x is its address there.
  assert.equal(s.accounts[s.active]!.addresses["eip155:56"], ME_EVM);

  // On Home: its coin, priced by DefiLlama, and no USDC.
  ok(await service.handle({ type: "pick_chain", chain: "added-56" }));
  const b = ok<{ chains: { chain: string; balances: { denom: string; symbol: string; amount: string; usd?: number }[] }[] }>(await service.handle({ type: "balances" }));
  const held = b.chains.find((c) => c.chain === "added-56")!;
  assert.deepEqual(held.balances.map((x) => [x.denom, x.symbol, x.amount, x.usd]), [["native:eip155:56", "BNB", (3n * 10n ** 17n).toString(), 180]]);

  // A send there: the vault reads it as an added chain's, and it's broadcast there.
  const review = ok<{ digest: string; display: { chain: string; network: { added: boolean } }; tokens: Record<string, { symbol: string }> }>(
    await service.handle({ type: "prepare_send", denom: "native:eip155:56", to: THEM_EVM, amount: (10n ** 17n).toString() }),
  );
  assert.deepEqual([review.display.chain, review.display.network.added, review.tokens["native:eip155:56"]?.symbol], ["eip155:56", true, "BNB"]);
  assert.equal(code(await service.handle({ type: "prepare_send", denom: "usdc:eip155:56", to: THEM_EVM, amount: "1" })), "bad_request");
  ok(await service.handle({ type: "confirm_send", digest: review.digest }));
  assert.equal(net.state.bnb.sent.length, 1);
  assert.ok(net.state.bnb.sent[0]!.startsWith("0x02f8") && net.state.bnb.sent[0]!.slice(8, 10) === "38", "signed for chain 56");

  // Kept across a lock, and in Settings with its endpoint.
  ok(await service.handle({ type: "lock" }));
  ok(await service.handle({ type: "unlock", password: PASSWORD }));
  const settings = ok<{ chains: { mainnet: Record<string, string[]> } }>(await service.handle({ type: "settings" }));
  assert.deepEqual(settings.chains.mainnet["added-56"], ["https://bnb-rpc.example"]);

  // Removed: off the list, Home back on Injective, its endpoints forgotten.
  const after = ok<Status>(await service.handle({ type: "remove_chain", chainId: 56 }));
  assert.deepEqual([after.added, after.chain], [[], "injective"]);
  assert.equal(ok<{ chains: { mainnet: Record<string, string[]> } }>(await service.handle({ type: "settings" })).chains.mainnet["added-56"], undefined);
  assert.equal(code(await service.handle({ type: "remove_chain", chainId: 56 })), "bad_request");
});

test("a chain added by hand, and none while chainlist.org is down: still checked, no logo", async () => {
  const net = chain();
  net.state.directory = null;
  const { service } = await wallet(net);
  assert.equal(code(await service.handle({ type: "chain_search", query: "bnb" })), "unreachable");
  const s = ok<Status>(await service.handle({ type: "add_chain", chain: { chainId: 56, name: "My BNB", symbol: "BNB", rpc: ["https://bnb-rpc.example"], testnet: true } }));
  assert.deepEqual(s.added, [{ chainId: 56, name: "My BNB", symbol: "BNB", rpc: ["https://bnb-rpc.example"], testnet: true }]);
  // On the test networks' list: not on mainnet's.
  assert.equal(code(await service.handle({ type: "pick_chain", chain: "added-56" })), "bad_request");
  ok(await service.handle({ type: "pick_chain", chain: "added-56", network: "testnet" }));
});

test("a site adds a chain: reviewed with the list's details, kept, and the site moves there", async () => {
  const net = chain({ balances: { inj: INJ } });
  const w = await wallet(net);
  const site = (method: string, params?: unknown) => w.service.dapp("https://app.example", { method, params }) as Promise<{ result?: unknown; error?: { code: number } }>;
  let seen = 0;
  const window = async () => {
    for (let i = 0; i < 200 && w.ui.opened.length <= seen; i++) await new Promise((r) => setTimeout(r, 5));
    seen = w.ui.opened.length;
    const id = w.ui.opened.at(-1)!;
    return { id, req: ok<{ kind: string; chain?: Added; listed?: Listed; siteName?: string }>(await w.service.handle({ type: "dapp_request", id })) };
  };
  const params = { chainId: "0x38", chainName: "Binance Chain", nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 }, rpcUrls: ["https://tracker.example"], iconUrls: ["https://tracker.example/logo.png"] };
  assert.equal((await site("wallet_addEthereumChain", [params])).error?.code, 4100);
  const connect = site("eth_requestAccounts");
  ok(await w.service.handle({ type: "dapp_answer", id: (await window()).id, approve: true }));
  await connect;
  assert.equal((await site("wallet_addEthereumChain", [{ ...params, nativeCurrency: { symbol: "BNB", decimals: 9 } }])).error?.code, -32602);

  // The list has chain 56: its name and endpoints, the site's name beside them.
  const asked = site("wallet_addEthereumChain", [params]);
  const a = await window();
  assert.equal(a.req.kind, "add_chain");
  assert.deepEqual([a.req.chain?.name, a.req.chain?.rpc, a.req.listed?.chainId, a.req.siteName], ["BNB Smart Chain", ["https://bnb-rpc.example", "https://wrong-rpc.example"], 56, "Binance Chain"]);
  ok(await w.service.handle({ type: "dapp_answer", id: a.id, approve: true }));
  assert.deepEqual(await asked, { result: null });
  assert.deepEqual(await site("eth_chainId"), { result: "0x38" });
  assert.deepEqual(await site("eth_accounts"), { result: [ME_EVM.toLowerCase()] });
  assert.ok(!net.state.hosts.has("tracker.example"), "the site's endpoint and icon are never asked");
  const s = ok<Status>(await w.service.handle({ type: "status" }));
  assert.deepEqual(s.added.map((c) => [c.chainId, c.name, c.rpc]), [[56, "BNB Smart Chain", ["https://bnb-rpc.example"]]]);
  // Reads go to its endpoint; adding it again is a switch.
  assert.deepEqual(await site("eth_blockNumber"), { result: "0x3000000" });
  assert.deepEqual(await site("wallet_addEthereumChain", [params]), { result: null });

  // A chain the list doesn't have: the site's details, on the network in use, and endpoints
  // that don't answer leave the request open in the window.
  const odd = site("wallet_addEthereumChain", [{ chainId: "0x1b207", chainName: "Odd Chain", nativeCurrency: { symbol: "ODD", decimals: 18 }, rpcUrls: ["https://wrong-rpc.example"] }]);
  const b = await window();
  assert.deepEqual([b.req.chain?.name, b.req.chain?.testnet, b.req.listed], ["Odd Chain", false, undefined]);
  assert.equal(code(await w.service.handle({ type: "dapp_answer", id: b.id, approve: true })), "unreachable");
  ok(await w.service.handle({ type: "dapp_answer", id: b.id, approve: false }));
  assert.equal((await odd).error?.code, 4001);
});

// Run-2 NV1: a logo is kept only as a small PNG the wallet draws. An SVG (whatever its
// server calls it), a picture whose header declares a huge size, or a body past the cap is
// never decoded nor kept: the chain is added without a logo.
test("a chain's logo that isn't a sane raster image is never kept", async () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1"/></svg>');
  const huge = Buffer.from(TINY_PNG);
  huge.writeUInt32BE(30_000, 16);
  huge.writeUInt32BE(30_000, 20);
  for (const [name, body, type] of [
    ["an SVG", svg, "image/svg+xml"],
    ["an SVG called a PNG", svg, "image/png"],
    ["a PNG declaring 30000 by 30000", huge, "image/png"],
    ["a body past the cap", Buffer.concat([TINY_PNG, Buffer.alloc(300 * 1024)]), "image/png"],
  ] as const) {
    const net = chain({ balances: { inj: INJ } });
    const honest = net.fetch;
    net.fetch = async (input: string, init?: RequestInit) => (String(input).includes("/icons/chains/") ? new Response(body, { status: 200, headers: { "content-type": type } }) : honest(input, init));
    const { service } = await wallet(net);
    const s = ok<Status>(await service.handle({ type: "add_chain", chain: BNB }));
    assert.equal(s.added[0]?.chainId, 56, name);
    assert.equal(s.added[0]?.logo, undefined, name);
  }
});

// Run-2 NV1, as the extension runs: the browser draws the logo small. A JPEG or WebP reaches
// it, one whose header declares too much never does, and only the 64 px PNG it makes is kept.
test("a chain's JPEG logo is drawn small by the browser; one declaring too much never reaches it", async () => {
  const jpeg = (w: number, h: number) => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff, 0x03, 0, 0, 0, 0]);
  const png = (side: number) => {
    const b = Buffer.from(TINY_PNG);
    b.writeUInt32BE(side, 16);
    b.writeUInt32BE(side, 20);
    return `data:image/png;base64,${b.toString("base64")}`;
  };
  for (const [name, body, made, kept] of [
    ["a 640 by 480 JPEG", jpeg(640, 480), png(64), true],
    ["a JPEG declaring 5000 by 5000", jpeg(5000, 5000), png(64), false],
    ["a PNG bigger than the wallet makes, from the browser", jpeg(640, 480), png(128), false],
    ["nothing from the browser", jpeg(640, 480), null, false],
  ] as const) {
    const net = chain({ balances: { inj: INJ } });
    const honest = net.fetch;
    net.fetch = async (input: string, init?: RequestInit) => (String(input).includes("/icons/chains/") ? new Response(body, { status: 200, headers: { "content-type": "image/jpeg" } }) : honest(input, init));
    const asked: Buffer[] = [];
    const { service } = await wallet(net, {
      opened: [],
      notified: 0,
      resize: async (bytes) => {
        asked.push(Buffer.from(bytes));
        return made;
      },
    });
    const s = ok<Status>(await service.handle({ type: "add_chain", chain: BNB }));
    assert.equal(s.added[0]?.chainId, 56, name);
    assert.equal(s.added[0]?.logo, kept ? made : undefined, name);
    assert.equal(asked.length, body.readUInt16BE(13) > 2048 ? 0 : 1, name);
  }
});

// ethereum-lists' icon record can list a chain's logo in several formats: an SVG first is
// passed over for its PNG.
test("ethereum-lists' PNG is used when its record lists an SVG first", async () => {
  const net = chain({ balances: { inj: INJ } });
  const honest = net.fetch;
  const SVG_CID = `Qm${"s".repeat(44)}`;
  const PNG_CID = `Qm${"p".repeat(44)}`;
  const asked: string[] = [];
  net.fetch = async (input: string, init?: RequestInit) => {
    const u = String(input);
    if (u.includes("/icons/chains/")) return new Response("no", { status: 404 });
    if (u.endsWith("/_data/icons/bnbchain.json")) return Response.json([{ url: `ipfs://${SVG_CID}`, format: "svg" }, { url: `ipfs://${PNG_CID}`, format: "png" }]);
    if (u.includes("/ipfs/")) {
      asked.push(u);
      return new Response(u.endsWith(PNG_CID) ? TINY_PNG : "<svg/>", { status: 200 });
    }
    return honest(input, init);
  };
  const { service } = await wallet(net);
  const s = ok<Status>(await service.handle({ type: "add_chain", chain: BNB }));
  assert.equal(s.added[0]?.logo, `data:image/png;base64,${TINY_PNG.toString("base64")}`);
  assert.deepEqual(asked, [`https://ipfs.io/ipfs/${PNG_CID}`]);
});

// Run-2 NV1: an older version kept SVG logos as they came. One read back is dropped, and the
// chain is kept with its letters.
test("a stored SVG logo is dropped and its chain kept", async () => {
  const net = chain({ balances: { inj: INJ } });
  const { service, local } = await wallet(net);
  await local.set({ added_chains: [{ chainId: 56, name: "BNB Smart Chain", symbol: "BNB", rpc: ["https://bnb-rpc.example"], testnet: false, logo: `data:image/svg+xml;base64,${Buffer.from("<svg/>").toString("base64")}` }] });
  const s = ok<Status>(await service.handle({ type: "status" }));
  assert.deepEqual(s.added.map((a) => [a.chainId, a.logo]), [[56, undefined]]);
});

// Review of #8: a chain a site adds that the list doesn't have is read through the site's
// own endpoint. Every review through it says so, the wallet's own sends too, until the user
// sets an endpoint; and a site can't name such a chain after one of the wallet's own.
test("a site's own endpoint is said in every review through it; a copied chain name is refused", async () => {
  const net = chain({ balances: { inj: INJ } });
  net.state.directory = null;
  const w = await wallet(net);
  const origin = "https://app.example";
  const site = (method: string, params?: unknown) => w.service.dapp(origin, { method, params }) as Promise<{ result?: unknown; error?: { code: number; message: string } }>;
  let seen = 0;
  const window = async () => {
    for (let i = 0; i < 200 && w.ui.opened.length <= seen; i++) await new Promise((r) => setTimeout(r, 5));
    seen = w.ui.opened.length;
    return w.ui.opened.at(-1)!;
  };
  const connect = site("eth_requestAccounts");
  ok(await w.service.handle({ type: "dapp_answer", id: await window(), approve: true }));
  await connect;

  // Named after a chain on the wallet's list, or in look-alike letters: refused at once.
  const coin = { symbol: "BNB", decimals: 18 };
  for (const chainName of ["Ethereum", "base mainnet", "Injective EVM", "Еthereum"]) {
    const r = await site("wallet_addEthereumChain", [{ chainId: "0x38", chainName, nativeCurrency: coin, rpcUrls: ["https://bnb-rpc.example"] }]);
    assert.equal(r.error?.code, -32602, chainName);
  }
  // By hand too, whatever the list says.
  assert.equal(code(await w.service.handle({ type: "add_chain", chain: { ...BNB, name: "Arbitrum One" } })), "invalid");

  // The list can't be reached: the site's endpoint, remembered as the site's.
  const asked = site("wallet_addEthereumChain", [{ chainId: "0x38", chainName: "Smart Chain", nativeCurrency: coin, rpcUrls: ["https://bnb-rpc.example"] }]);
  ok(await w.service.handle({ type: "dapp_answer", id: await window(), approve: true }));
  assert.deepEqual(await asked, { result: null });
  const s = ok<Status & { added: (Added & { rpcFrom?: string })[] }>(await w.service.handle({ type: "status" }));
  assert.equal(s.added[0]?.rpcFrom, origin);

  const rules = (r: { risk: { findings: { rule: string; level: string }[] } }) => r.risk.findings.map((f) => `${f.rule} ${f.level}`);
  const siteTx = async () => {
    const sent = site("eth_sendTransaction", [{ from: ME_EVM, to: THEM_EVM, value: "0x1" }]);
    const id = await window();
    const r = ok<{ risk: { findings: { rule: string; level: string }[] } }>(await w.service.handle({ type: "dapp_review", id }));
    ok(await w.service.handle({ type: "dapp_answer", id, approve: false }));
    await sent;
    return rules(r);
  };
  const ownSend = async () => rules(ok(await w.service.handle({ type: "prepare_send", denom: "native:eip155:56", to: THEM_EVM, amount: "1" })));
  assert.ok((await siteTx()).includes("site_endpoint amber"));
  assert.ok((await ownSend()).includes("site_endpoint amber"));

  // The user's own endpoint: no longer the site's.
  ok(await w.service.handle({ type: "save_settings", network: "mainnet", chain: { key: "added-56", rpc: ["https://bnb-rpc.example"] } }));
  assert.ok(!(await siteTx()).includes("site_endpoint amber"));
  assert.ok(!(await ownSend()).includes("site_endpoint amber"));
});
