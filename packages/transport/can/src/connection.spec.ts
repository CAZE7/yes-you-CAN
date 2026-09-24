/**
 * The connection state machine of the frame/byte layer (master prompt P1).
 *
 * What is pinned here is what the promise says: every state is reachable, the
 * transitions carry a reason and a timestamp, repetition is not a transition,
 * a listener that throws cannot break the adapter's own bookkeeping, and
 * "usable" means exactly `connected` or `degraded` — a `recovering` link must
 * never be mistaken for a working one (that is the silent state this vocabulary
 * exists to remove).
 */

import assert from "node:assert/strict";
import { test } from "vitest";
import {
  ADAPTER_CONNECTION_STATES,
  ConnectionTracker,
  connectionStatusOf,
  USABLE_CONNECTION_STATES,
} from "./connection.js";

/** A tracker on a frozen clock, so timestamps are assertions, not noise. */
function trackerAt(start = 1_000): { tracker: ConnectionTracker; advance: (ms: number) => void } {
  let now = start;
  const tracker = new ConnectionTracker({ adapterId: "test", now: () => now });
  return {
    tracker,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test("a fresh link is disconnected, not an error", () => {
  const { tracker } = trackerAt();
  const status = tracker.status();
  assert.equal(status.state, "disconnected");
  assert.equal(status.adapterId, "test");
  assert.equal(status.lastError, undefined);
  assert.equal(tracker.usable, false, "nothing may be sent before open()");
});

test("the lifecycle runs disconnected → connecting → connected → disconnected", () => {
  const { tracker, advance } = trackerAt();
  tracker.connect("open()");
  assert.equal(tracker.state, "connecting");
  assert.equal(tracker.usable, false, "a handshake in flight is not a usable link");
  advance(5);
  tracker.connected("ELM327 v2.1 @ /dev/ttyUSB0");
  assert.equal(tracker.state, "connected");
  assert.equal(tracker.usable, true);
  assert.equal(tracker.status().detail, "ELM327 v2.1 @ /dev/ttyUSB0");
  assert.equal(tracker.status().since, 1_005);
  advance(5);
  tracker.disconnected("closed by the caller");
  assert.equal(tracker.state, "disconnected");
  assert.equal(tracker.usable, false);
});

test("every state of the vocabulary is reachable through the tracker", () => {
  const { tracker } = trackerAt();
  const seen = new Set<string>([tracker.state]);
  tracker.connect("a");
  seen.add(tracker.state);
  tracker.connected();
  seen.add(tracker.state);
  tracker.degraded("a refused frame");
  seen.add(tracker.state);
  tracker.recovering("a reconnect is in flight");
  seen.add(tracker.state);
  tracker.fail("the device left");
  seen.add(tracker.state);
  assert.deepEqual([...ADAPTER_CONNECTION_STATES].sort(), [...seen].sort());
});

test("degraded is usable, recovering and error are not", () => {
  const { tracker } = trackerAt();
  tracker.connected();
  tracker.degraded("ELM327 refused the frame: BUFFER FULL");
  assert.equal(tracker.usable, true, "a degraded link still carries frames");
  assert.equal(tracker.status().stateReason, "ELM327 refused the frame: BUFFER FULL");
  tracker.recovering("link lost — reconnect scheduled");
  assert.equal(tracker.usable, false, "a link being revived is not a link");
  assert.equal(tracker.stateReason, "link lost — reconnect scheduled");
  tracker.fail("no reconnect attempt left");
  assert.equal(tracker.usable, false);
  assert.equal(tracker.status().lastError, "no reconnect attempt left");
});

test("degraded → healthy returns to connected without an error trail", () => {
  const { tracker } = trackerAt();
  tracker.connected();
  tracker.degraded("BUS BUSY");
  tracker.healthy("the device answered again");
  assert.equal(tracker.state, "connected");
  assert.equal(tracker.status().lastError, undefined);
  // healthy() does nothing when there is nothing to heal — repetition is not a
  // transition, and a listener must not be woken by the state it already had.
  const transitions = tracker.history.length;
  tracker.healthy("again");
  assert.equal(tracker.history.length, transitions);
});

test("a successful connection clears the previous error", () => {
  const { tracker } = trackerAt();
  tracker.fail("byte stream failed: EIO");
  assert.equal(tracker.status().lastError, "byte stream failed: EIO");
  tracker.connect("open() again");
  tracker.connected("revived");
  assert.equal(tracker.status().lastError, undefined);
  assert.equal(tracker.state, "connected");
});

test("transitions carry from, to, at and the reason — in order", () => {
  const { tracker, advance } = trackerAt(500);
  tracker.connect("first");
  advance(10);
  tracker.connected("ELM327 v2.1", "second");
  advance(10);
  tracker.disconnected("third");
  assert.deepEqual(
    tracker.history.map((entry) => [entry.from, entry.to, entry.at, entry.reason]),
    [
      ["disconnected", "connecting", 500, "first"],
      ["connecting", "connected", 510, "second"],
      ["connected", "disconnected", 520, "third"],
    ],
  );
});

test("the history is bounded, keeping the newest transitions", () => {
  let now = 0;
  const tracker = new ConnectionTracker({ adapterId: "t", now: () => now++, historyLimit: 3 });
  for (let i = 0; i < 10; i++) {
    tracker.fail(`incident ${i}`);
    tracker.connected();
  }
  assert.equal(tracker.history.length, 3);
  assert.equal(tracker.history.at(-1)?.to, "connected");
});

test("listeners see every transition and can unsubscribe", () => {
  const { tracker } = trackerAt();
  const seen: string[] = [];
  const off = tracker.onTransition((status, change) => {
    seen.push(`${change.from}->${change.to}:${status.state}`);
  });
  tracker.connect("open");
  tracker.connected();
  tracker.degraded("BUS BUSY");
  off();
  tracker.disconnected();
  assert.deepEqual(seen, [
    "disconnected->connecting:connecting",
    "connecting->connected:connected",
    "connected->degraded:degraded",
  ]);
});

test("a listener that throws is recorded, not able to break the adapter", () => {
  const { tracker } = trackerAt();
  tracker.onTransition(() => {
    throw new Error("the UI listener is broken");
  });
  const second: string[] = [];
  tracker.onTransition((status) => second.push(status.state));
  tracker.connect("open");
  tracker.connected();
  // The other listener still ran, the state still moved, and the failure is
  // visible instead of silent (AGENTS 34.25).
  assert.deepEqual(second, ["connecting", "connected"]);
  assert.equal(tracker.state, "connected");
  assert.equal(tracker.listenerHealth.failures, 2);
  assert.equal(tracker.listenerHealth.lastFailure, "the UI listener is broken");
});

test("counters are reported by the adapter, and the status carries them", () => {
  const { tracker } = trackerAt();
  tracker.report({ tx: 2, rx: 1, at: 4_242 });
  tracker.report({ rx: 1 });
  const status = tracker.status();
  assert.equal(status.txCount, 2);
  assert.equal(status.rxCount, 2);
  assert.equal(status.lastActivityAt, 4_242);
});

test("connectionStatusOf is the honest answer for a bus without a state machine", () => {
  assert.deepEqual(connectionStatusOf(true, "fixture"), {
    state: "connected",
    adapterId: "fixture",
  });
  assert.equal(connectionStatusOf(false, "fixture", "no device").state, "disconnected");
  assert.equal(connectionStatusOf(false, "fixture", "no device").detail, "no device");
});

test("usable states are exactly connected and degraded — one list, no drift", () => {
  assert.deepEqual([...USABLE_CONNECTION_STATES], ["connected", "degraded"]);
  for (const state of ADAPTER_CONNECTION_STATES) {
    const { tracker } = trackerAt();
    // Drive the tracker into every state and compare against the published list.
    if (state === "connecting") tracker.connect("x");
    if (state === "connected") tracker.connected();
    if (state === "degraded") tracker.degraded("x");
    if (state === "recovering") tracker.recovering("x");
    if (state === "error") tracker.fail("x");
    assert.equal(tracker.usable, USABLE_CONNECTION_STATES.includes(state), state);
  }
});
