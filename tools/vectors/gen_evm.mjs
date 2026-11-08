// Generates crates/evm/tests/vectors/eip1559.json with viem, an implementation
// independent of ours. The Rust tests must match it byte for byte.
//
//   cd tools/vectors && npm ci && npm run gen
//
// Keys come from the BIP-39 test phrase only. They belong to no one.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeFunctionData, erc20Abi, hashTypedData, keccak256, serializeTransaction } from "viem";
import { mnemonicToAccount } from "viem/accounts";

const PHRASE = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const account = mnemonicToAccount(PHRASE, { addressIndex: 0 });
const to = mnemonicToAccount(PHRASE, { addressIndex: 1 }).address;
const USDC = "0xa00C59fF5a080D2b954d0c75e46E22a0c371235a"; // Injective mainnet USDC (ERC20 shape only)
const MAX = 2n ** 256n - 1n;

const cases = [
  {
    name: "native_inj",
    build: { kind: "native", to, value: "1500000000000000000" },
    tx: { chainId: 1776, nonce: 0, maxPriorityFeePerGas: 0n, maxFeePerGas: 500000000n, gas: 21000n, to, value: 1500000000000000000n },
  },
  {
    name: "native_testnet_big_nonce",
    build: { kind: "native", to, value: "1" },
    tx: { chainId: 1439, nonce: 1000, maxPriorityFeePerGas: 1n, maxFeePerGas: 160000000n, gas: 21000n, to, value: 1n },
  },
  {
    name: "erc20_usdc",
    build: { kind: "erc20", token: USDC, to, amount: "2500000" },
    tx: {
      chainId: 1776, nonce: 7, maxPriorityFeePerGas: 0n, maxFeePerGas: 500000000n, gas: 65000n, to: USDC, value: 0n,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, 2500000n] }),
    },
  },
  {
    name: "erc20_max_amount_high_fees",
    build: { kind: "erc20", token: USDC, to, amount: MAX.toString() },
    tx: {
      chainId: 1776, nonce: 2 ** 40, maxPriorityFeePerGas: 2n ** 100n, maxFeePerGas: 2n ** 127n, gas: 10000000n, to: USDC, value: 0n,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, MAX] }),
    },
  },
];

const out = {
  generator: "tools/vectors/gen_evm.mjs with viem 2.57.7",
  phrase: PHRASE,
  from: account.address,
  cases: await Promise.all(cases.map(async (c) => {
    const tx = { type: "eip1559", ...c.tx };
    const unsigned = serializeTransaction(tx);
    const raw = await account.signTransaction(tx);
    return {
      name: c.name,
      build: c.build,
      chain_id: c.tx.chainId,
      nonce: c.tx.nonce,
      max_priority_fee_per_gas: c.tx.maxPriorityFeePerGas.toString(),
      max_fee_per_gas: c.tx.maxFeePerGas.toString(),
      gas_limit: Number(c.tx.gas),
      data: c.tx.data ?? "0x",
      unsigned,
      signing_hash: keccak256(unsigned),
      raw,
      hash: keccak256(raw),
    };
  })),
};

const file = join(dirname(fileURLToPath(import.meta.url)), "../../crates/evm/tests/vectors/eip1559.json");
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
console.log(`wrote ${out.cases.length} cases to ${file}`);

// ---- EIP-712 typed data ----
// `viem` is what viem hashes and signs. `json` is the same data as a dapp would pass to
// eth_signTypedData_v4: bigints as decimal strings unless the case overrides a field.

const bigToString = (_k, v) => (typeof v === "bigint" ? v.toString() : v);
const person = (name, i, age) => ({ name, wallet: mnemonicToAccount(PHRASE, { addressIndex: i }).address, age });

const typed = [
  {
    name: "mail_spec_example",
    viem: {
      domain: { name: "Ether Mail", version: "1", chainId: 1n, verifyingContract: "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC" },
      types: {
        EIP712Domain: [
          { name: "name", type: "string" }, { name: "version", type: "string" },
          { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" },
        ],
        Person: [{ name: "name", type: "string" }, { name: "wallet", type: "address" }],
        Mail: [{ name: "from", type: "Person" }, { name: "to", type: "Person" }, { name: "contents", type: "string" }],
      },
      primaryType: "Mail",
      message: {
        from: { name: "Cow", wallet: "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826" },
        to: { name: "Bob", wallet: "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB" },
        contents: "Hello, Bob!",
      },
    },
  },
  {
    name: "erc2612_permit_max",
    viem: {
      domain: { name: "USD Coin", version: "2", chainId: 1776n, verifyingContract: USDC },
      types: {
        EIP712Domain: [
          { name: "name", type: "string" }, { name: "version", type: "string" },
          { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" },
        ],
        Permit: [
          { name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" },
          { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
        ],
      },
      primaryType: "Permit",
      message: { owner: account.address, spender: to, value: MAX, nonce: 0n, deadline: 1893456000n },
    },
    json: (j) => { j.domain.chainId = 1776; },
  },
  {
    name: "nested_arrays_signed_ints_bytes",
    viem: {
      domain: { name: "Test", chainId: 1439n, salt: "0x" + "ab".repeat(32) },
      types: {
        EIP712Domain: [{ name: "name", type: "string" }, { name: "chainId", type: "uint256" }, { name: "salt", type: "bytes32" }],
        Person: [{ name: "name", type: "string" }, { name: "wallet", type: "address" }, { name: "age", type: "uint16" }],
        Group: [
          { name: "title", type: "string" }, { name: "members", type: "Person[]" }, { name: "tags", type: "bytes32[2]" },
          { name: "open", type: "bool" }, { name: "delta", type: "int256" }, { name: "tiny", type: "int8" },
          { name: "small", type: "uint8" }, { name: "data", type: "bytes" }, { name: "code", type: "bytes4" },
          { name: "matrix", type: "uint256[][]" },
        ],
      },
      primaryType: "Group",
      message: {
        title: "Team ✓ <&>",
        members: [person("Ann", 0, 31), person("Ben", 1, 65535)],
        tags: ["0x" + "11".repeat(32), "0x" + "22".repeat(32)],
        open: true,
        delta: -12345678901234567890n,
        tiny: -128,
        small: 255,
        data: "0xdeadbeef",
        code: "0xa9059cbb",
        matrix: [[1n, 2n], [], [MAX]],
      },
    },
    json: (j) => { j.domain.chainId = "0x59f"; j.message.matrix[0][1] = "0x2"; },
  },
  {
    name: "domain_types_derived",
    viem: {
      domain: { name: "Derived", version: "3", chainId: 1n },
      types: { Ping: [{ name: "n", type: "uint64" }] },
      primaryType: "Ping",
      message: { n: 42n },
    },
    json: (j) => { j.message.n = 42; },
  },
];

const typedOut = {
  generator: "tools/vectors/gen_evm.mjs with viem 2.57.7",
  phrase: PHRASE,
  signer: account.address,
  cases: await Promise.all(typed.map(async (c) => {
    const json = JSON.parse(JSON.stringify(c.viem, bigToString));
    if (c.json) c.json(json);
    return {
      name: c.name,
      typed_data: JSON.stringify(json),
      hash: hashTypedData(c.viem),
      signature: await account.signTypedData(c.viem),
    };
  })),
};

const typedFile = join(dirname(fileURLToPath(import.meta.url)), "../../crates/evm/tests/vectors/eip712.json");
writeFileSync(typedFile, JSON.stringify(typedOut, null, 2) + "\n");
console.log(`wrote ${typedOut.cases.length} cases to ${typedFile}`);
