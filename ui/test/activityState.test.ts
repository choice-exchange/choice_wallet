// How a page of activity joins what the tab already shows.

import assert from "node:assert/strict";
import { test } from "node:test";

import { merge } from "../src/activityState.ts";
import type { ActivityItem, ActivityPage } from "../src/protocol.ts";

const row = (height: number): ActivityItem => ({ hash: `H${height}`, height: String(height), time: "2026-11-09T08:00:00Z", ok: true, kind: "receive", signed: false, changes: [], fee: [] });
const page = (heights: number[], more: boolean, cutoff: number | null): ActivityPage => ({
  network: "mainnet",
  items: heights.map(row),
  tokens: {},
  more,
  cutoff: cutoff === null ? null : String(cutoff),
  filter: { all: false, hideSmall: false, shown: [], hidden: [] },
});
const heights = (s: { items: ActivityItem[] }) => s.items.map((a) => Number(a.height));

test("the first read, then the next page below it", () => {
  const one = merge(null, page([100, 90], true, 90), 1, 5);
  assert.deepEqual([heights(one), one.page, one.at], [[100, 90], 1, 5]);
  const two = merge(one, page([90, 80, 70], false, null), 2, 9);
  assert.deepEqual([heights(two), two.page, two.more, two.cutoff, two.at], [[100, 90, 80, 70], 2, false, null, 5]);
});

test("the first page read again goes on top of the pages already read", () => {
  const two = merge(merge(null, page([100, 90], true, 90), 1, 5), page([80, 70], false, null), 2, 6);
  const again = merge(two, page([120, 100], true, 100), 1, 50);
  assert.deepEqual([heights(again), again.page, again.more, again.cutoff, again.at], [[120, 100, 90, 80, 70], 2, false, null, 50]);
});

test("past a gap (more new rows than a page holds), it starts over", () => {
  const two = merge(merge(null, page([100, 90], true, 90), 1, 5), page([80, 70], false, null), 2, 6);
  const again = merge(two, page([300, 250], true, 250), 1, 50);
  assert.deepEqual([heights(again), again.page, again.more], [[300, 250], 1, true]);
});
