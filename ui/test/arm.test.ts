// The approval window's main button: when it starts to work.

import assert from "node:assert/strict";
import { test } from "node:test";

import { arm, ARM_MS, type ArmEnv } from "../src/arm.ts";

/** A window that is in front or not, with a clock moved by hand. */
function fakeWindow() {
  let now = 0;
  let front = true;
  let timers: { at: number; f: () => void }[] = [];
  const listeners = new Set<() => void>();
  const pressed = new Set<(id?: string) => void>();
  const released = new Set<(id: string) => void>();
  const env: ArmEnv = {
    front: () => front,
    watch(f) {
      listeners.add(f);
      return () => listeners.delete(f);
    },
    presses(down, up) {
      pressed.add(down);
      if (up) released.add(up);
      return () => {
        pressed.delete(down);
        if (up) released.delete(up);
      };
    },
    later(f, ms) {
      const t = { at: now + ms, f };
      timers.push(t);
      return () => (timers = timers.filter((x) => x !== t));
    },
  };
  return {
    env,
    advance(ms: number) {
      now += ms;
      for (const t of timers.filter((x) => x.at <= now)) {
        timers = timers.filter((x) => x !== t);
        t.f();
      }
    },
    focus(on: boolean) {
      front = on;
      for (const f of listeners) f();
    },
    press() {
      for (const f of pressed) f();
    },
    down(id: string) {
      for (const f of pressed) f(id);
    },
    up(id: string) {
      for (const f of released) f(id);
    },
  };
}

// Run-4: a press begun on the disarmed button and held past ARM_MS doesn't arm it: the click
// comes on release, so the count starts again from the release. A press after it armed acts.
test("a press held from before arming keeps it disarmed until released", () => {
  const w = fakeWindow();
  let armed = false;
  const stop = arm(true, w.env, (v) => (armed = v));
  w.advance(300);
  w.down("pointer:1");
  w.advance(2 * ARM_MS);
  assert.equal(armed, false, "held");
  w.up("pointer:1");
  assert.equal(armed, false, "released: the click on release finds it disarmed");
  w.advance(ARM_MS);
  assert.equal(armed, true);
  // Once armed, a press and its release are the click: nothing disarms.
  w.down("pointer:2");
  w.up("pointer:2");
  assert.equal(armed, true);
  stop();
});

test("key auto-repeat is one held key, and a release with no press changes nothing", () => {
  const w = fakeWindow();
  let armed = false;
  const stop = arm(true, w.env, (v) => (armed = v));
  w.up("key:Enter");
  w.advance(ARM_MS);
  assert.equal(armed, true, "a stray release doesn't hold it off");
  stop();
  const again = arm(true, w.env, (v) => (armed = v));
  for (let i = 0; i < 20; i++) {
    w.down("key:Enter");
    w.advance(100);
  }
  assert.equal(armed, false);
  w.up("key:Enter");
  w.advance(ARM_MS);
  assert.equal(armed, true);
  // Losing the front while a press is held forgets it.
  again();
  const third = arm(true, w.env, (v) => (armed = v));
  w.down("pointer:3");
  w.focus(false);
  w.focus(true);
  w.advance(ARM_MS);
  assert.equal(armed, true);
  third();
});

// Hardening: the button armed 800 ms after the window took focus, even when a signature's
// review arrived later, so the button first appeared already working.
test("the button works only once it has shown for a moment, however long the window waited", () => {
  const w = fakeWindow();
  let armed = false;
  const set = (v: boolean) => (armed = v);
  // Waiting for the review: no button, and nothing arms however long it takes.
  let stop = arm(false, w.env, set);
  w.advance(5_000);
  assert.equal(armed, false);
  // The review is here and the button shows: still not working, until the moment passes.
  stop();
  stop = arm(true, w.env, set);
  assert.equal(armed, false);
  w.advance(ARM_MS - 1);
  assert.equal(armed, false);
  w.advance(1);
  assert.equal(armed, true);
  // Away from the window: off at once; back: counted again from then.
  w.focus(false);
  assert.equal(armed, false);
  w.focus(true);
  w.advance(ARM_MS - 1);
  assert.equal(armed, false);
  w.advance(1);
  assert.equal(armed, true);
  // Stopped: nothing more fires.
  stop();
  w.focus(false);
  assert.equal(armed, true);
});

// Run-3: a stream of clicks begun on the page (presses on the disabled button) never arms it
// while it lasts; it arms ARM_MS after the last press, and a press then counts.
test("a stream of presses keeps the button disarmed until it stops", () => {
  const w = fakeWindow();
  let armed = false;
  const stop = arm(true, w.env, (v) => (armed = v));
  for (let t = 0; t < 3000; t += 100) {
    w.press();
    w.advance(100);
    assert.equal(armed, false, `at ${t} ms`);
  }
  // The last press was 100 ms ago.
  w.advance(ARM_MS - 200);
  assert.equal(armed, false);
  w.advance(100);
  assert.equal(armed, true);
  // Once armed, a press is the click: it doesn't disarm.
  w.press();
  assert.equal(armed, true);
  stop();
});
