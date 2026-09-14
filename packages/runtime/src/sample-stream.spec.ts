/**
 * The sample stream's four rules, tested without a bus.
 *
 * The service-level tests in `runtime.spec.ts` drive the whole runtime; this spec
 * pins the subscription lifecycle itself, because the interesting cases are the
 * ones a running measurement makes hard to reach: a subscriber that arrives
 * before `start()`, a second `bind()` for the same run, and a listener that
 * unsubscribes twice.
 */

import assert from "node:assert/strict";
import type { LiveDataEngine, MeasurementSample, PollRoundResult } from "@vdp/core";
import { describe, test } from "vitest";
import { type SampleRound, SampleStream } from "./sample-stream.js";

function sample(signal: string, value: number): MeasurementSample {
  return {
    timestamp: "2026-09-14T10:00:00.000Z",
    t: 1,
    signal,
    value,
    rawValue: value,
    rawHex: "0000",
    outOfRange: false,
  };
}

function round(overrides: Partial<PollRoundResult> = {}): PollRoundResult {
  return {
    ecuId: "ecu_1",
    round: 1,
    at: 1_700_000_000_000,
    signals: [
      { signalId: "engine.rpm", name: "Engine speed" } as PollRoundResult["signals"][number],
    ],
    samples: [sample("engine.rpm", 812.5)],
    gaps: [],
    errors: [],
    ...overrides,
  };
}

/**
 * A live engine reduced to what the stream uses: a listener list and a way to
 * fire a round. `stop()` is what the real engine does when the poll loop dies —
 * rounds after it must not reach anybody.
 */
function fakeEngine(): {
  engine: LiveDataEngine;
  emit: (result: PollRoundResult) => void;
  listeners: number;
} {
  const registered: Array<(result: PollRoundResult) => void> = [];
  const engine = {
    onRound(listener: (result: PollRoundResult) => void) {
      registered.push(listener);
      return () => {
        const index = registered.indexOf(listener);
        if (index >= 0) registered.splice(index, 1);
      };
    },
  } as unknown as LiveDataEngine;
  return {
    engine,
    emit: (result) => {
      for (const listener of [...registered]) listener(result);
    },
    get listeners() {
      return registered.length;
    },
  } as { engine: LiveDataEngine; emit: (result: PollRoundResult) => void; listeners: number };
}

describe("SampleStream", () => {
  test("delivers a round as readings, named from the round's own signal list", () => {
    const stream = new SampleStream();
    const seen: SampleRound[] = [];
    stream.subscribe((payload) => seen.push(payload));
    const fake = fakeEngine();
    stream.bind(fake.engine);

    fake.emit(round());

    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.readings.length, 1);
    assert.equal(seen[0]?.readings[0]?.name, "Engine speed");
    assert.equal(seen[0]?.readings[0]?.signalId, "engine.rpm");
    assert.equal(
      seen[0]?.readings[0]?.value,
      812.5,
      "the reading carries the measured value — formatting is the view layer's job",
    );
  });

  test("a subscriber that arrives before start() still gets the first round", () => {
    const stream = new SampleStream();
    const seen: SampleRound[] = [];
    stream.subscribe((payload) => seen.push(payload));
    const fake = fakeEngine();

    fake.emit(round());
    assert.deepEqual(seen, [], "without a binding there is nowhere to subscribe yet");

    stream.bind(fake.engine);
    fake.emit(round());
    assert.equal(seen.length, 1, "the listener was attached by bind(), not lost");
  });

  test("unbind() detaches and reattaches without double delivery", () => {
    const stream = new SampleStream();
    const seen: SampleRound[] = [];
    stream.subscribe((payload) => seen.push(payload));
    const first = fakeEngine();
    const second = fakeEngine();

    stream.bind(first.engine);
    stream.bind(first.engine);
    assert.equal(first.listeners, 1, "a second bind for the same run must not double-subscribe");
    first.emit(round());
    assert.equal(seen.length, 1);

    stream.unbind();
    first.emit(round());
    assert.equal(seen.length, 1, "the old engine is silent after unbind()");
    assert.equal(first.listeners, 0, "and it stopped calling into the stream");

    stream.bind(second.engine);
    second.emit(round());
    assert.equal(seen.length, 2, "the subscription survives the stop/start cycle");
  });

  test("unsubscribing is idempotent and leaves other listeners alone", () => {
    const stream = new SampleStream();
    const first: SampleRound[] = [];
    const second: SampleRound[] = [];
    const off = stream.subscribe((payload) => first.push(payload));
    stream.subscribe((payload) => second.push(payload));
    const fake = fakeEngine();
    stream.bind(fake.engine);

    off();
    off();
    fake.emit(round());

    assert.deepEqual(first, []);
    assert.equal(second.length, 1, "one listener leaving is not a stop()");
    assert.equal(stream.size, 1);
  });

  test("a round without readings is not pushed", () => {
    const stream = new SampleStream();
    const seen: SampleRound[] = [];
    stream.subscribe((payload) => seen.push(payload));
    const fake = fakeEngine();
    stream.bind(fake.engine);

    fake.emit(round({ samples: [], signals: [] }));

    assert.deepEqual(
      seen,
      [],
      "an empty push would blank the UI instead of keeping the last frame",
    );
  });
});
