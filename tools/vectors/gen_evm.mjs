// Generates crates/evm/tests/vectors/eip1559.json with viem, an implementation
// independent of ours. The Rust tests must match it byte for byte.
//
//   cd tools/vectors && npm ci && npm run gen
//
// Keys come from the BIP-39 test phrase only. They belong to no one.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeFunctionData, erc20Abi, keccak256, serializeTransaction } from "viem";
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
