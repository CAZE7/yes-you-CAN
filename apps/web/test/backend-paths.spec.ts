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
import { TransportClosedError, createLogger } from "@vdp/shared";
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
 * Chaos, measured where it has to bite: on the session.
 *
 * The layer used to sit *beside* the bus the runtime held, so every switch reported its own
 * observation while the vehicle noticed nothing — 0.E E24, measured as `dropRate: 1` counting
 * 566 frames in 600 ms while `identify()` went through, `scanDtcs()` answered 7 codes and 23
 * signals kept polling. `start()` installs the chaos layer in the path now (AGENTS 35: a
 * switch that cannot reach anything is a widget, not a control), so these tests assert the
 * effect on a request and not the counter of a bystander.
 */
test("chaos before a connection is refused with its reason", () => {
  const backend = new DemoBackend({ logger, seedDtcs: false });
  // Nothing is open, so there is no bus to arm. A silent no-op here is what made the panel
  // lie; `TransportClosedError` is what makes `POST /api/chaos/inject` answer 409.
  assert.throws(
    () => backend.injectChaos({ dropRate: 1 }),
    (error: unknown) =>
      error instanceof TransportClosedError &&
      /chaos needs an open connection/.test(error.message) &&
      error.code === "E_TRANSPORT_CLOSED",
  );
  assert.equal(backend.chaosStatus().active, false, "and nothing was armed either");
});

test("a bus-wide drop rate starves the session, and a reset hands the bus back", async () => {
  const backend = new DemoBackend({ logger, liveIntervalMs: 60, seedDtcs: false });
  const samples = () =>
    backend.state().statistics.reduce((total, entry) => total + entry.samples, 0);
  try {
    await backend.start();
    await backend.startLive(["engine.rpm"]);
    await waitFor(
      () => samples(),
      (count) => count >= 2,
      { timeoutMs: 4000 },
    );

    backend.injectChaos({ dropRate: 1 });
    const armed = backend.chaosStatus();
    assert.equal(armed.active, true, "the sustained rate is reported as set");
    assert.equal(armed.dropRate, 1);
    await waitFor(
      () => backend.chaosStatus().droppedFrames,
      (count) => count > 0,
      { timeoutMs: 4000 },
    );

    // The claim that was missing before E24 was fixed: not "the counter moved" but "the
    // session stopped working". Polling asks the vehicle for a value on every round; on a bus
    // that eats every frame there is nothing to record, so the sample count must freeze.
    const frozen = samples();
    await tick(400);
    assert.equal(
      samples(),
      frozen,
      "a bus that drops everything must not keep collecting samples, and that is the proof " +
        "that the chaos sits in the session's path",
    );

    backend.resetChaos();
    const reset = backend.chaosStatus();
    assert.equal(reset.dropRate, 0, "the rate is disarmed");
    assert.equal(reset.active, false, "and nothing claims to be running");
    assert.ok(
      reset.droppedFrames > 0,
      "the counters stay: a reset removes rules, it does not erase what happened",
    );
    await waitFor(
      () => samples(),
      (count) => count > frozen,
      { timeoutMs: 4000 },
    );
    assert.ok(true, "and the same polling collects samples again once the rules are gone");
  } finally {
    backend.stopLive();
    await backend.stop();
  }
});

test("an armed burst is spent on frames, and its target is stated either way", async () => {
  const backend = new DemoBackend({ logger, liveIntervalMs: 60, seedDtcs: false });
  try {
    await backend.start();
    await backend.startLive();
    backend.injectChaos({ dropBurst: 6 });
    const armed = backend.chaosStatus();
    assert.equal(armed.dropBurstRemaining, 6, "before frames went by, all six are left");
    assert.equal(armed.dropBurstScope, "bus-wide", "and it was aimed at the connection");
    assert.equal(armed.dropBurstTarget, null);
    await waitFor(
      () => backend.chaosStatus().dropBurstRemaining,
      (count) => count === 0,
      { timeoutMs: 4000 },
    );
    const spent = backend.chaosStatus();
    assert.ok(
      spent.droppedFrames >= 6,
      `a bus-wide burst of 6 must have taken six frames, got ${JSON.stringify(spent)}`,
    );
  } finally {
    backend.stopLive();
    await backend.stop();
  }
});

test("a burst aimed at an id nobody answers on is visible as aimed there", async () => {
  // E24's second half was not the missing effect but the missing *sentence*: the switch
  // reported `active: true` for a rule that could never match. The target is part of the
  // status now, so an aimed-but-untouched burst reads as what it is.
  const backend = new DemoBackend({ logger, liveIntervalMs: 60, seedDtcs: false });
  try {
    await backend.start();
    await backend.startLive();
    const nowhere = 0x7f0;
    backend.injectChaos({ dropBurst: 6, dropBurstCanId: nowhere });
    const status = backend.chaosStatus();
    assert.equal(status.dropBurstScope, "targeted");
    assert.equal(status.dropBurstTarget, "0x7F0", "formatted like every other id on this wire");
    await tick(400);
    const after = backend.chaosStatus();
    assert.equal(
      after.dropBurstRemaining,
      6,
      "the vehicle does not talk on 0x7f0, so the burst is still armed — stated, not secret",
    );
    // …and the same count aimed at an id the vehicle does answer on takes them (measured:
    // 0x7e0 is the demo vehicle's request id, see `chaos-lab.spec.ts` for the rule itself).
    backend.resetChaos();
    backend.injectChaos({ dropBurst: 3, dropBurstCanId: 0x7e0 });
    await waitFor(
      () => backend.chaosStatus().dropBurstRemaining,
      (count) => count === 0,
      { timeoutMs: 4000 },
    );
  } finally {
    backend.stopLive();
    await backend.stop();
  }
});

test("a corrupted response takes codes off the readout, and the aim says which", async () => {
  const backend = new DemoBackend({ logger, liveIntervalMs: 60 });
  try {
    await backend.start();
    await backend.startLive();
    const clean = (await backend.scanDtcs()).map((dtc) => dtc.code);
    assert.equal(
      clean.length,
      8,
      `the seeded vehicle answers with eight codes before anything is injected, got ${clean.join(",")}`,
    );

    // The response id is where a multi-frame answer can be broken: the engine's records stop
    // mid-transfer, and the workshop reads fewer codes. That is the effect on the session —
    // not a counter next to it — and the reset hands the full readout back.
    backend.injectChaos({ corruptSequenceCanId: 0x7e8 });
    const mangled = (await backend.scanDtcs()).map((dtc) => dtc.code);
    assert.ok(
      mangled.length < clean.length,
      `a mangled response must be felt in the readout, got ${mangled.length} of ${clean.length}`,
    );
    assert.ok(backend.chaosStatus().corruptedFrames > 0, "and it is counted");

    backend.resetChaos();
    const again = (await backend.scanDtcs()).map((dtc) => dtc.code);
    assert.deepEqual(again, clean, "with the rules gone the same scan reads the same codes");

    // The request id is a different story, and it is the reason the aim is a field of the
    // status: single-frame requests carry no sequence number, so this injection changes
    // nothing on the readout while still counting frames.
    backend.injectChaos({ corruptSequenceCanId: 0x7e0 });
    assert.deepEqual(
      (await backend.scanDtcs()).map((dtc) => dtc.code),
      clean,
      "corruption aimed at the request id leaves a single-frame readout untouched",
    );
    backend.resetChaos();
  } finally {
    backend.stopLive();
    await backend.stop();
  }
});
