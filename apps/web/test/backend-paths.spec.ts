/**
 * The backend arms that no happy path reaches.
 *
 * E17's remainder: `apps/web/src/backend.ts` sat at 67,87 branch coverage with a strip of
 * single lines nobody walked — the replay source decisions, the event-listener guard, the
 * marker-before-start return, the statistics arm of the signal analysis, and the refusal a
 * managed adapter gets when an embedder registers it under another id. Each of them is a
 * rule, and a rule no test walks is a rule that can quietly become something else.
 *
 * These run against the backend directly (not through HTTP): the routes in front of them are
 * pinned in `server.spec.ts` and `server-paths.spec.ts`, and what is unproven here is the
 * layer beneath.
 */

import assert from "node:assert/strict";
import { AdapterCatalog, type AdapterEntry } from "@vdp/adapter-host";
import { createLogger } from "@vdp/shared";
import { MemorySessionRepository } from "@vdp/storage";
import { test } from "vitest";
import { tick, waitFor } from "../../../tests/helpers/wait.js";
import { DemoBackend } from "../src/backend.js";

const logger = createLogger("web-test", { level: "ERROR" });

/** A recording with two frames, in the shape a session export has. */
const INLINE_RECORDING = JSON.stringify({
  format: "vdp.session",
  transport: { channel: "can0" },
  trace: [
    { t: 0, canId: 0x7e8, direction: "rx", payload: "62 F1 90" },
    { t: 5, canId: 0x7e8, direction: "rx", payload: "7e 88 03" },
  ],
});

test("replay accepts an inline session export, not only a stored id", async () => {
  const backend = new DemoBackend({
    logger,
    selection: { id: "replay", config: { trace: INLINE_RECORDING } },
    seedDtcs: false,
  });
  try {
    const state = await backend.start();
    assert.equal(state.mode, "replay");
    assert.equal(state.connected, true, "an inline recording is a bus like any other");
  } finally {
    await backend.stop();
  }
});

test("a stored session whose trace was never written is refused, not replayed empty", async () => {
  const repository = new MemorySessionRepository({ logger });
  const origin = new DemoBackend({ logger, repository, seedDtcs: false });
  let tracelessId = "";
  try {
    await origin.start();
    await origin.identify();
    // The JSON half of a session, without the NDJSON trace beside it: the state survives, the
    // raw bus does not. That is the case a replay must refuse rather than walk an empty bus.
    const saved = await origin.saveSession();
    const { data } = await repository.load(saved.id);
    tracelessId = `${saved.id}-without-trace`;
    await repository.save({ ...structuredClone(data), id: tracelessId });
  } finally {
    await origin.stop();
  }
  assert.ok(tracelessId.length > 0);

  const backend = new DemoBackend({
    logger,
    repository,
    selection: { id: "replay", config: { trace: tracelessId } },
    seedDtcs: false,
  });
  try {
    await assert.rejects(() => backend.start(), /contains no raw trace/);
    assert.equal(backend.state().connected, false, "a refused start leaves nothing open");
  } finally {
    await backend.stop();
  }
});

test("a path that is not there is named, including what was asked for", async () => {
  const backend = new DemoBackend({
    logger,
    selection: { id: "replay", config: { trace: "/tmp/vdp-definitely-not-here.json" } },
    seedDtcs: false,
  });
  try {
    await assert.rejects(
      () => backend.start(),
      /cannot read recording "\/tmp\/vdp-definitely-not-here\.json"/,
      "the refusal quotes the reference the operator wrote",
    );
  } finally {
    await backend.stop();
  }
});

test("one throwing listener does not take the stream, nor the other listeners", async () => {
  const backend = new DemoBackend({ logger, seedDtcs: false });
  const seen: string[] = [];
  try {
    await backend.start();
    backend.subscribe(() => {
      throw new Error("a listener that breaks — the SSE writer of yesterday");
    });
    const unsubscribe = backend.subscribe((event) => seen.push(event.type));
    // A marker is the cheapest event the backend emits on its own.
    backend.addMarker("probe");
    await waitFor(
      () => seen.length,
      (count) => count > 0,
      { timeoutMs: 4000 },
    );
    assert.ok(seen.includes("marker"), `the good listener still received: ${seen.join(", ")}`);
    // The returned closure is how a stream ends, and the guard must not resurrect it.
    unsubscribe();
    const after = seen.length;
    backend.addMarker("second");
    await tick(250);
    assert.equal(seen.length, after, "an unsubscribed listener is not called again");
  } finally {
    await backend.stop();
  }
});

test("a marker before any connection is a no-op, not a crash", () => {
  const backend = new DemoBackend({ logger, seedDtcs: false });
  // Nothing is connected, so there is no runtime to dispatch through; the session log line
  // before the guard is what makes the marker still show up in a later export.
  assert.doesNotThrow(() => backend.addMarker("before start"));
  assert.equal(backend.state().connected, false);
});

test("a managed adapter under another id is refused by the adapter layer, not the runtime", async () => {
  // The mode decision is made on the *id*, so an embedder that registers the simulator bus
  // under a new id gets "hardware" — and then must be stopped from opening it, because two
  // owners of one vehicle model is the bug this refusal exists to prevent.
  const managed: AdapterEntry = {
    id: "my-managed-bus",
    displayName: "Someone else's simulator",
    kind: "simulator",
    transport: "can",
    description: "an application-managed entry registered under an id the mode lookup cannot see",
    capabilities: {
      can: true,
      canFd: false,
      doip: false,
      isoTpOffload: false,
      channels: 1,
      supportsFunctionalAddressing: true,
    },
    requires: {},
    managedBy: "application",
    probe: async () => ({ available: true, detail: "always" }),
    create: async () => {
      throw new Error("must never be reached — the refusal comes first");
    },
  };
  const backend = new DemoBackend({
    logger,
    adapters: new AdapterCatalog([managed]),
    selection: { id: "my-managed-bus", config: {} },
    seedDtcs: false,
  });
  try {
    await assert.rejects(
      () => backend.start(),
      /my-managed-bus" is managed by the application and cannot be opened by the adapter layer/,
    );
  } finally {
    await backend.stop();
  }
});

test("signal analysis states its statistics once there are samples to state", async () => {
  const backend = new DemoBackend({ logger, liveIntervalMs: 60, seedDtcs: false });
  try {
    await backend.start();
    await backend.startLive(["engine.rpm"]);
    await waitFor(
      () => backend.state().statistics.filter((entry) => entry.signal === "engine.rpm").length,
      (count) => count > 0,
      { timeoutMs: 5000 },
    );
    const empty = backend.analyzeSignal("engine.rpm");
    // With a handful of samples the statistics block is the reason the view exists: p5/p50/p95
    // and the shape numbers, not just a spectrum.
    assert.ok(empty.statistics, "the statistics arm fires once samples exist");
    assert.ok(
      empty.statistics.p5 <= empty.statistics.p50 && empty.statistics.p50 <= empty.statistics.p95,
      `percentiles must be ordered, got ${JSON.stringify(empty.statistics)}`,
    );
    assert.ok(empty.spectrum, "a spectrum exists once the signal is sampled");
    assert.ok(Number.isFinite(empty.spectrum.snrDb), "the spectrum is measured, not guessed");
  } finally {
    backend.stopLive();
    await backend.stop();
  }
});

/**
 * What the chaos switches report, measured on this bus — and deliberately nothing more.
 *
 * The figures this file had to establish first (one run each, printed from a probe that was then
 * deleted): a corruption rule on `0x7e0` counted 328 frames in 900 ms, a burst of 6 drained in
 * about the same time, a sustained rate of 1 added a few hundred more, and `resetChaos()` cleared
 * the rules without clearing the counts.
 *
 * What those counters count is the chaos layer's *own* view of the bus, not what the session lost:
 * `apps/web/src/backend.ts:1039-1041` builds the `CanChaosBus` beside the bus the runtime holds,
 * and `openBus()` never installs one. A `dropRate` of 1 armed after `start()` therefore left
 * `identify()` and `scanDtcs()` working and the polling at 23 signals — measured here, same
 * probe. That gap is 0.E **E24**, including the fact that arming before `start()` cannot work
 * either because `stop()` zeroes `chaosBus`/`chaosDropRate` (606, 613-614) and `start()` stops
 * first. This test pins the reporting; the fix for the reaching needs its own assertions and is
 * not to be smuggled in here.
 */
test("chaos: the switches report themselves, and reset disarms without erasing", async () => {
  const backend = new DemoBackend({ logger, liveIntervalMs: 60, seedDtcs: false });
  try {
    await backend.start();
    await backend.startLive();
    const fresh = backend.chaosStatus();
    assert.equal(fresh.active, false, "a fresh connection has nothing armed");
    assert.equal(fresh.droppedFrames, 0);

    backend.injectChaos({ corruptSequenceCanId: 0x7e0 });
    await waitFor(
      () => backend.chaosStatus().corruptedFrames,
      (count) => count > 0,
      { timeoutMs: 4000 },
    );

    backend.injectChaos({ dropBurst: 6 });
    assert.equal(
      backend.chaosStatus().dropBurstRemaining,
      6,
      "an armed burst is stated before the bus has carried anything",
    );
    await waitFor(
      () => backend.chaosStatus().droppedFrames,
      (count) => count > 0,
      { timeoutMs: 4000 },
    );
    const burst = backend.chaosStatus();
    assert.equal(burst.dropBurstRemaining, 0, "and it is spent once the frames went by");
    assert.ok(
      burst.droppedFrames >= 6,
      `the layer must have seen the burst's frames go by, got ${burst.droppedFrames}`,
    );

    backend.injectChaos({ dropRate: 1 });
    const armed = backend.chaosStatus();
    assert.equal(armed.active, true, "a sustained rate is active");
    assert.equal(armed.dropRate, 1, "and the rate is stated back as set");
    await waitFor(
      () => backend.chaosStatus().droppedFrames,
      (count) => count > burst.droppedFrames,
      { timeoutMs: 4000 },
    );

    backend.resetChaos();
    const reset = backend.chaosStatus();
    assert.equal(reset.dropRate, 0, "the rate is disarmed");
    assert.equal(reset.active, false, "and nothing claims to be running");
    assert.ok(
      reset.droppedFrames >= 6,
      "the counters stay: a reset removes rules, it does not erase what happened",
    );
  } finally {
    backend.stopLive();
    await backend.stop();
  }
});
