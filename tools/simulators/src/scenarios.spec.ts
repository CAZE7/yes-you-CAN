/**
 * The scenario engine and its catalog (AGENTS 32, master backlog P0 #16).
 *
 * Three things are pinned here, and the third is the one that makes the others worth
 * having:
 *
 * 1. the *engine*: steps are applied in model time, `holdMs` lifts a cause again, and a
 *    run reports one check per expectation instead of a boolean.
 * 2. the *catalog*: every built-in scenario reaches the verdict its own `expectations`
 *    and `conditions` state, on a vehicle with real UDS servers on a real virtual wire.
 * 3. the *negative control*: with its causes removed, a scenario must fail its own
 *    expectations. A fault that appears without the cause is not caused by it — and a
 *    suite that only ever checks the positive direction cannot tell those apart.
 */

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { scenarioFiles } from "../../../tests/helpers/scenario-files.js";
import { HEARTBEAT_IDS, HighFidelityVehicle } from "./high-fidelity-vehicle.js";
import {
  describeCause,
  modelTarget,
  runScenario,
  type ScenarioCheck,
  type VehicleScenario,
  withoutCauses,
} from "./scenarios.js";
import { VehicleBehaviourModel } from "./vehicle-model.js";
import { createVirtualCanNetwork } from "./virtual-can.js";
import { createRandom } from "./virtual-vehicle.js";

/**
 * A vehicle that steps when told to, on its own wire.
 *
 * `modelTickMs: 0` keeps the model still until a run advances it, and the seeded rng is
 * what makes an intermittent contact an *intermittent* one instead of a permanently dead
 * one — `Math.random` would make the same scenario pass or not by luck (AGENTS 31).
 */
function scenarioVehicle(): HighFidelityVehicle {
  return new HighFidelityVehicle({ modelTickMs: 0, model: { random: createRandom(4242) } });
}

function failures(run: {
  checks: ScenarioCheck[];
  unexpected: string[];
  scenarioId: string;
}): string {
  const bad = run.checks
    .filter((check) => !check.passed)
    .map(
      (check) =>
        `  ${check.subject} @${check.atMs} ms: expected ${check.expected}, got ${check.actual} — ${check.because}`,
    );
  const extra = run.unexpected.map((code) => `  unexpected latch: ${code}`);
  return `${bad.length + extra.length} failed check(s) of ${run.scenarioId}:\n${[...bad, ...extra].join("\n")}`;
}

describe("scenario engine", () => {
  test("a cause is applied at its model time, not at the wall clock", async () => {
    const model = new VehicleBehaviourModel({ initial: { ignition: "on" } });
    const scenario: VehicleScenario = {
      id: "battery-dip",
      title: "one dip, one window",
      summary: "",
      durationMs: 2_000,
      steps: [{ atMs: 500, cause: { kind: "electrical-load", amps: 25 }, holdMs: 500 }],
      expectations: [],
    };
    const run = await runScenario(modelTarget(model), scenario);
    // Applied at 500, lifted at 1000: what a run *ends* with is the restored state,
    // because `holdMs` is a real lift and not a comment in the data.
    assert.equal(run.finalState.electricalLoadA, 0);
    assert.equal(run.timeline.length, 2, "one apply line and one lift line");
    assert.match(run.timeline[0] ?? "", /load → 25 A/);
    assert.match(run.timeline[1] ?? "", /lifted load → 25 A/);
  });

  test("an expectation without atMs is checked at the end of the run", async () => {
    const model = new VehicleBehaviourModel({ initial: { ignition: "on" } });
    const run = await runScenario(modelTarget(model), {
      id: "no-op",
      title: "nothing happens",
      summary: "",
      durationMs: 100,
      steps: [],
      expectations: [
        {
          ecu: "bcm",
          code: "B1001",
          state: "absent",
          because: "no cause, no code — a fault memory that stays empty is the baseline",
        },
      ],
    });
    assert.equal(run.passed, true, failures(run));
    assert.equal(run.checks[0]?.atMs, 100);
  });

  test("a code nobody predicted is a failed run, not a footnote", async () => {
    const vehicle = scenarioVehicle();
    await vehicle.start();
    try {
      const run = await vehicle.runScenario({
        id: "unpredicted",
        title: "an undervoltage the scenario says nothing about",
        summary: "",
        durationMs: 2_000,
        steps: [
          { atMs: 0, cause: { kind: "ignition", state: "off" } },
          { atMs: 0, cause: { kind: "battery", volts: 10 } },
        ],
        expectations: [],
      });
      assert.equal(run.passed, false, "the run must not be green on a surprise");
      assert.deepEqual(run.unexpected, ["bcm:B1001 from bcm-supply-voltage"]);
    } finally {
      await vehicle.stop();
    }
  });

  test("closedWorld can be turned off, and then a surprise is only reported", async () => {
    const vehicle = scenarioVehicle();
    await vehicle.start();
    try {
      const run = await vehicle.runScenario(
        {
          id: "unpredicted-open",
          title: "the same cause, open world",
          summary: "",
          durationMs: 2_000,
          steps: [{ atMs: 0, cause: { kind: "battery", volts: 10 } }],
          expectations: [],
        },
        { closedWorld: false },
      );
      assert.equal(run.passed, true);
      assert.equal(run.unexpected.length, 0);
    } finally {
      await vehicle.stop();
    }
  });

  test("a condition on a field of the wrong kind fails instead of skipping", async () => {
    const model = new VehicleBehaviourModel({ initial: { ignition: "on" } });
    const run = await runScenario(modelTarget(model), {
      id: "wrong-kind",
      title: "a numeric bound on the ignition string",
      summary: "",
      durationMs: 100,
      steps: [],
      conditions: [{ field: "ignition", above: 3, because: "cannot be compared numerically" }],
      expectations: [],
    });
    assert.equal(run.checks[0]?.passed, false);
    assert.equal(run.checks[0]?.actual, "on");
  });

  test("describeCause words every cause for the timeline", () => {
    assert.equal(describeCause({ kind: "ignition", state: "start" }), "ignition → start");
    assert.equal(describeCause({ kind: "battery", volts: 11.2 }), "battery → 11.2 V");
    assert.equal(
      describeCause({ kind: "alternator", efficiency: 0.5 }),
      "alternator → 50 % of rated output",
    );
    assert.equal(
      describeCause({ kind: "driver", throttlePct: 40, brakePressed: false }),
      "driver → 40 % throttle, free",
    );
    assert.equal(
      describeCause({ kind: "bus", ecu: "abs", mode: "stutter", dropRate: 0.25 }),
      "bus abs → stutter (25 % lost)",
    );
    assert.equal(
      describeCause({ kind: "sensor", signal: "engine.maf_airflow", mode: "drift-low" }),
      "sensor engine.maf_airflow → drift-low",
    );
  });
});

describe("scenario catalog", () => {
  test("the catalog covers the six failure classes it exists for", () => {
    // The catalog *is* the scenarios/ directory now (ADR 0048): these are the parsed
    // files, not a second list in code.
    assert.deepEqual(
      scenarioFiles().map((file) => file.id),
      [
        "abs-intermittently-offline",
        "alternator_failure",
        "can-bus-dropouts",
        "charging-system-failure",
        "load-dump-overvoltage",
        "sensor-out-of-plausible-range",
        "under-voltage-at-start",
      ],
    );
    for (const file of scenarioFiles()) {
      const scenario = file.scenario;
      assert.ok(file.determinism.seed >= 0, `${scenario.id} carries the seed it runs with`);
      assert.ok(scenario.title.trim().length > 0, `${scenario.id} needs a title`);
      assert.ok(scenario.summary.trim().length > 0, `${scenario.id} needs a summary`);
      assert.ok(scenario.steps.length > 0, `${scenario.id} must state at least one cause`);
      assert.ok(
        scenario.expectations.length > 0 || (scenario.conditions?.length ?? 0) > 0,
        `${scenario.id} must say what the cause leads to`,
      );
      for (const expectation of scenario.expectations) {
        assert.ok(
          expectation.because.trim().length > 20,
          `${scenario.id}/${expectation.code}: because is the claim a reader checks`,
        );
      }
      const last = Math.max(...scenario.steps.map((step) => step.atMs));
      assert.ok(
        last <= scenario.durationMs,
        `${scenario.id}: the last step (${last}) must lie inside the run (${scenario.durationMs})`,
      );
    }
  });

  for (const file of scenarioFiles()) {
    const scenario = file.scenario;
    test(`${scenario.id}: the vehicle reaches the verdict the scenario predicts`, async () => {
      const vehicle = scenarioVehicle();
      await vehicle.start();
      try {
        // The file's seed drives the run, exactly as the workbench server drives it.
        const run = await vehicle.runScenario(scenario, { seed: file.determinism.seed });
        assert.equal(run.passed, true, failures(run));
      } finally {
        await vehicle.stop();
      }
    });
  }

  for (const file of scenarioFiles()) {
    const scenario = file.scenario;
    test(`${scenario.id}: without its causes, its own expectations do not hold`, async () => {
      const vehicle = scenarioVehicle();
      await vehicle.start();
      try {
        const stripped = withoutCauses(scenario);
        const run = await vehicle.runScenario(stripped, { seed: file.determinism.seed });
        const caused = run.checks.filter(
          (check) => check.kind === "dtc" && check.expected !== "absent",
        );
        assert.ok(
          caused.length > 0,
          `${scenario.id}: no positive expectation to control against — a scenario that ` +
            `only predicts "absent" cannot show that a cause produced the code`,
        );
        assert.ok(
          caused.every((check) => !check.passed),
          `${scenario.id}: these faults appeared without their cause — ${caused
            .filter((check) => check.passed)
            .map((check) => `${check.subject} was ${check.actual}`)
            .join(", ")}`,
        );
      } finally {
        await vehicle.stop();
      }
    });
  }

  test("two runs of one scenario reach the same verdict (reproducible, not flaky)", async () => {
    const file = scenarioFiles().find((entry) => entry.id === "sensor-out-of-plausible-range");
    assert.ok(file, "the catalog must not be empty");
    const scenario = file.scenario;
    const first = await (async () => {
      const vehicle = scenarioVehicle();
      await vehicle.start();
      try {
        return await vehicle.runScenario(scenario, { seed: file.determinism.seed });
      } finally {
        await vehicle.stop();
      }
    })();
    const second = await (async () => {
      const vehicle = scenarioVehicle();
      await vehicle.start();
      try {
        return await vehicle.runScenario(scenario, { seed: file.determinism.seed });
      } finally {
        await vehicle.stop();
      }
    })();
    assert.deepEqual(
      second.checks.map((check) => `${check.subject}=${check.actual}`),
      first.checks.map((check) => `${check.subject}=${check.actual}`),
    );
    assert.deepEqual(second.timeline, first.timeline);
    assert.equal(second.finalState.supplyVoltage, first.finalState.supplyVoltage);
  });
});

describe("the wire behind the scenarios", () => {
  test("a bus cause really loses frames, and lifting it restores them", async () => {
    const network = createVirtualCanNetwork({ random: () => 0 });
    const bus = network.createBus("a");
    const other = network.createBus("b");
    await bus.open();
    await other.open();
    const seen: number[] = [];
    other.subscribe((frame) => seen.push(frame.id));
    await bus.send({
      timestamp: 0,
      id: 0x123,
      extended: false,
      fd: false,
      dlc: 1,
      channel: "vcan0",
      payload: new Uint8Array([1]),
    });
    assert.deepEqual(seen, [0x123], "an intact wire carries");
    const remove = network.impair({ id: "cut", match: (frame) => frame.id === 0x123 });
    await bus.send({
      timestamp: 0,
      id: 0x123,
      extended: false,
      fd: false,
      dlc: 1,
      channel: "vcan0",
      payload: new Uint8Array([1]),
    });
    assert.deepEqual(seen, [0x123], "a cut wire does not");
    assert.deepEqual(network.impairmentStats(), [{ id: "cut", matched: 1, dropped: 1 }]);
    remove();
    assert.deepEqual(network.impairments, []);
    await bus.send({
      timestamp: 0,
      id: 0x123,
      extended: false,
      fd: false,
      dlc: 1,
      channel: "vcan0",
      payload: new Uint8Array([1]),
    });
    assert.deepEqual(seen, [0x123, 0x123], "and the handle really lifts it");
    assert.equal(network.frames.length, 3, "the wire kept every frame, lost or not");
    await bus.close();
    await other.close();
  });

  test("a stutter drops at the rate it states, and counts both sides", async () => {
    const network = createVirtualCanNetwork({ random: () => 0.5 });
    const bus = network.createBus("a");
    await bus.open();
    let seen = 0;
    const other = network.createBus("b");
    await other.open();
    other.subscribe(() => {
      seen += 1;
    });
    network.impair({
      id: "rough",
      match: () => true,
      lossRate: 0.4,
    });
    for (let i = 0; i < 4; i++) {
      await bus.send({
        timestamp: 0,
        id: 0x100,
        extended: false,
        fd: false,
        dlc: 1,
        channel: "vcan0",
        payload: new Uint8Array([i]),
      });
    }
    // rng() < 0.4 is false for the injected 0.5, so nothing is dropped — and the
    // accounting says so: matched four, dropped none.
    assert.equal(seen, 4);
    assert.deepEqual(network.impairmentStats(), [{ id: "rough", matched: 4, dropped: 0 }]);
    await bus.close();
    await other.close();
  });

  test("a module with no supply stops putting frames on the wire, and starts again", async () => {
    const vehicle = scenarioVehicle();
    await vehicle.start();
    try {
      const absHeartbeat = HEARTBEAT_IDS.abs ?? 0;
      vehicle.advance(200);
      const before = framesOf(vehicle, absHeartbeat);
      assert.ok(before > 0, "an online module broadcasts, so a peer can notice it");
      vehicle.cutPower("abs");
      vehicle.advance(200);
      const during = framesOf(vehicle, absHeartbeat);
      assert.equal(during, before, "a module with no supply sends nothing — that is the silence");
      assert.equal(vehicle.isEcuOnline("abs"), false, "and the vehicle calls it what it is");
      vehicle.restorePower("abs");
      vehicle.advance(200);
      assert.ok(
        framesOf(vehicle, absHeartbeat) > during,
        "restored supply means frames again, without anyone setting a flag",
      );
      assert.equal(vehicle.isEcuOnline("abs"), true);
    } finally {
      await vehicle.stop();
    }
  });
});

/** Frames of one identifier the whole wire saw. */
function framesOf(vehicle: HighFidelityVehicle, canId: number): number {
  return vehicle.network.snapshot().filter((frame) => frame.id === canId).length;
}
