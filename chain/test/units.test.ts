import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { cosmosTxHash, hexToBase64 } from "../src/encoding.ts";
import { ceilDecimal, formatShort, formatUnits, parseUnits } from "../src/units.ts";

test("format and parse amounts exactly", () => {
  assert.equal(formatUnits("1500000", 6), "1.5");
  assert.equal(formatUnits("1", 18), "0.000000000000000001");
  assert.equal(formatUnits("1000000000000000000", 18), "1");
  assert.equal(formatUnits("0", 6), "0");
  assert.equal(formatUnits("123", 0), "123");
  assert.equal(parseUnits("1.5", 6), 1_500_000n);
  assert.equal(parseUnits(" .5 ", 6), 500_000n);
  assert.equal(parseUnits("2.", 6), 2_000_000n);
  assert.equal(parseUnits("0.000000000000000001", 18), 1n);
  assert.equal(parseUnits("123456789.123456789123456789", 18), 123456789123456789123456789n);
  for (const bad of ["", ".", "-1", "1e3", "1,5", "0x10", "1.2.3", " ", "Infinity"]) {
    assert.throws(() => parseUnits(bad, 6), RangeError, bad);
  }
  assert.throws(() => parseUnits("1.1234567", 6), /At most 6 decimal places/);
  assert.throws(() => formatUnits("-1", 6), RangeError);
  assert.throws(() => formatUnits("1.5", 6), RangeError);
});

test("short amounts cut, never round up", () => {
  assert.equal(formatShort("1999999999", 9, 6), "1.999999");
  assert.equal(formatShort("1", 18), "<0.000001");
  assert.equal(formatShort("1000000", 6), "1");
  assert.equal(formatShort("0", 6), "0");
});

test("chain decimals round up", () => {
  assert.equal(ceilDecimal("160000000.000000000000000000"), 160_000_000n);
  assert.equal(ceilDecimal("160000000.000000000000000001"), 160_000_001n);
  assert.equal(ceilDecimal("7"), 7n);
  assert.throws(() => ceilDecimal("-1"), RangeError);
});

test("tx hash and base64", async () => {
  const tx = "0a020a00120012001a00";
  assert.equal(await cosmosTxHash(tx), createHash("sha256").update(Buffer.from(tx, "hex")).digest("hex").toUpperCase());
  assert.equal(hexToBase64("0a00"), "CgA=");
  assert.equal(hexToBase64(tx), Buffer.from(tx, "hex").toString("base64"));
  assert.equal(hexToBase64(""), "");
});
