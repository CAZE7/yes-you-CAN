/**
 * The vehicle behaviour model's rules, tested where they are written (AGENTS 32).
 *
 * The scenario catalog proves the *chain*; this file proves the four rules the chain
 * rests on, because a rule that only ever appears at the end of a long run cannot be
 * traced when it misbehaves. Each test drives the model with causes and reads what it
 * wrote into a real `UdsServer` fault memory — no cast into an internal map, which is
 * the point of the server's own `setDtc()`/`removeDtc()` API.
 */

import assert from "node:assert/strict";
import { NRC, SID, UdsServer, type UdsServerLink } from "@vdp/protocols-uds";
import { createLogger } from "@vdp/shared";
import { describe, test } from "vitest";
import { VehicleBehaviourModel } from "./vehicle-model.js";
import type { SensorFaultMode, VehicleModelOptions } from "./vehicle-state.js";
import { createRandom } from "./virtual-vehicle.js";

const logger = createLogger("vehicle-model-spec", { level: "ERROR" });

/** A real UDS server behind a link that goes nowhere: the memory is what is under test. */
function memoryOf(ecu: string): UdsServer {
  const link: UdsServerLink = {
    onMessage: () => () => undefined,
    send: async () => undefined,
  };
  return new UdsServer(link, { name: ecu, logger });
}

function statusOf(server: UdsServer, code: string): number | undefined {
  return server.dtcMemory.find((dtc) => dtc.code === code)?.status;
}

function monitorOf(model: VehicleBehaviourModel, id: string) {
  const monitor = model.monitorStates().find((entry) => entry.id === id);
  if (monitor === undefined) throw new Error(`no such monitor: ${id}`);
  return monitor;
}

/** A model with one BCM attached, so a supply rule has somewhere to write. */
function modelWithBcm(options: VehicleModelOptions = {}): {
  model: VehicleBehaviourModel;
  server: UdsServer;
} {
  const server = memoryOf("bcm");
  const model = new VehicleBehaviourModel(options);
  model.attach({ ecuId: "bcm", server, documentedCodes: new Set(["B1001"]) });
  return { model, server };
}

describe("debounce and hysteresis", () => {
  test("a condition shorter than the window latches nothing", () => {
    const { model, server } = modelWithBcm({ initial: { ignition: "on", batteryVoltage: 12.6 } });
    model.setBatteryVoltage(10);
    model.advance(model.thresholds.debounceMs - 40);
    assert.equal(statusOf(server, "B1001"), undefined, "the window has not been held");
    model.setBatteryVoltage(12.9);
    model.advance(400);
    assert.equal(statusOf(server, "B1001"), undefined, "and a cause that ends never latches");
    assert.equal(monitorOf(model, "bcm-supply-voltage").raised, 0);
  });

  test("holding the condition past the window latches, and the held time stops growing", () => {
    // Key off first: a running engine with a working alternator *is* the supply, so a
    // battery reading alone cannot drag the rail down — that masking is the model's
    // answer to "why does this only show up with the key on and the engine off".
    const { model, server } = modelWithBcm({ initial: { ignition: "off" } });
    model.setBatteryVoltage(10);
    model.advance(1_000);
    assert.equal(
      statusOf(server, "B1001"),
      0x2f,
      "testFailed plus the cycle, pending and confirmed bits",
    );
    const held = monitorOf(model, "bcm-supply-voltage").heldMs;
    model.advance(1_000);
    assert.equal(
      monitorOf(model, "bcm-supply-voltage").raised,
      1,
      "a latched monitor does not latch again on every step",
    );
    assert.ok(held > 0, "the hold is measured, and reported");
  });

  test("between the two thresholds the code stays as it is — that is what hysteresis means", () => {
    const { model, server } = modelWithBcm({ initial: { ignition: "off" } });
    model.setBatteryVoltage(10);
    model.advance(600);
    assert.equal(statusOf(server, "B1001"), 0x2f);
    // 11.8 V: above the fail threshold, below the recovery threshold. A single
    // threshold would flip the code here, and a technician would call that "intermittent".
    model.setBatteryVoltage(11.8);
    model.advance(2_000);
    assert.equal(
      statusOf(server, "B1001"),
      0x2f,
      "still failing: the recovery window has not been reached",
    );
    model.setBatteryVoltage(12.1);
    model.advance(1_000);
    assert.equal(statusOf(server, "B1001"), 0x2e, "and healed once it is clearly over");
  });

  test("the upper end of the same window latches the same code", () => {
    // With a regulating alternator in front of the rail, a battery reading cannot drag
    // the supply down at all — so a load dump is stated where it happens: with the
    // regulator out, on the battery side of the node.
    const { model, server } = modelWithBcm({ initial: { ignition: "on" } });
    model.setAlternatorEfficiency(0);
    // A running engine with a regulating alternator clamps the rail, so a load dump is
    // stated where it happens: on the battery side of the node.
    model.setAlternatorEfficiency(0);
    model.setBatteryVoltage(24);
    model.advance(600);
    assert.equal(
      statusOf(server, "B1001"),
      0x2f,
      `16.5 V is the ceiling, 24 V is over it — found ${model.state.supplyVoltage} V`,
    );
  });
});

describe("the four rules", () => {
  test("rule 3: a module records only a code its own definition documents", () => {
    const server = memoryOf("bcm");
    const model = new VehicleBehaviourModel({ initial: { ignition: "off" } });
    model.attach({ ecuId: "bcm", server, documentedCodes: new Set(["SOMETHING_ELSE"]) });
    model.setBatteryVoltage(10);
    model.advance(1_500);
    assert.deepEqual(
      server.dtcMemory.map((dtc) => dtc.code),
      [],
      "B1001 is not documented for this ECU, so nothing is stored",
    );
    const monitor = model.monitorStates().find((entry) => entry.id === "bcm-supply-voltage");
    assert.ok(monitor && monitor.heldMs > 0, "the condition was measured and held, though");
    assert.equal(monitor?.raised, 0, "and an unrecordable latch is not counted as one");
    // The same model, the same cause, one documented code: the verdict follows the data.
    model.attach({ ecuId: "bcm", server, documentedCodes: new Set(["B1001"]) });
    model.advance(40);
    assert.equal(
      statusOf(server, "B1001"),
      0x2f,
      "documenting the code is all it took — no simulator change, no second rule",
    );
  });

  test("rule 3b: an ECU that documents nothing records nothing", () => {
    const server = memoryOf("gateway");
    const model = new VehicleBehaviourModel();
    model.attach({ ecuId: "gateway", server, documentedCodes: new Set() });
    model.supervise("gateway", ["abs"]);
    model.heardFrom("abs");
    model.advance(3_000);
    assert.deepEqual(
      server.dtcMemory,
      [],
      "a definition with no codes is no licence to invent one: the condition held, and " +
        "the record stopped at the module boundary",
    );
    assert.equal(
      model.monitorStates().find((entry) => entry.code === "U0121")?.raised,
      0,
      "and an unrecordable latch does not count as a latch either",
    );
  });

  test("rule 4: silence counts only after the peer has been heard", () => {
    const server = memoryOf("gateway");
    const model = new VehicleBehaviourModel({ initial: { ignition: "on" } });
    model.attach({ ecuId: "gateway", server, documentedCodes: new Set(["U0121"]) });
    model.supervise("gateway", ["abs"]);
    model.advance(10_000);
    assert.deepEqual(
      server.dtcMemory,
      [],
      "a module that never spoke is absent, and absence is a discovery result",
    );
    model.heardFrom("abs");
    assert.deepEqual(model.silentPeersOf("gateway"), [], "one frame is enough to have a peer");
    model.advance(model.thresholds.busTimeoutMs + 1);
    assert.deepEqual(model.silentPeersOf("gateway"), ["abs"], "and then the timeout measures it");
    model.advance(60);
    assert.equal(statusOf(server, "U0121"), 0x2f);
  });

  test("a module with no supply neither latches nor heals: it stops reporting", () => {
    const server = memoryOf("bcm");
    const model = new VehicleBehaviourModel({ initial: { ignition: "off" } });
    model.attach({ ecuId: "bcm", server, documentedCodes: new Set(["B1001"]) });
    model.setBatteryVoltage(10.5);
    model.advance(600);
    assert.equal(statusOf(server, "B1001"), 0x2f, "while it has power it reports");
    model.setWiringFault({ ecu: "bcm", mode: "power-cut" });
    model.setBatteryVoltage(13);
    model.advance(5_000);
    assert.equal(
      statusOf(server, "B1001"),
      0x2f,
      "and a dead module does not heal a fault it cannot measure — the last statement stands",
    );
    model.clearWiringFault("bcm");
    model.advance(2_000);
    assert.equal(statusOf(server, "B1001"), 0x2e, "powered again, it finishes the job");
  });
});

describe("the physics", () => {
  test("cranking is a load, and the load is what the terminals feel", () => {
    const { model } = modelWithBcm({ initial: { ignition: "off", batteryVoltage: 12.4 } });
    model.advance(200);
    const resting = model.state.supplyVoltage;
    model.setIgnition("start");
    model.advance(200);
    const cranking = model.state.supplyVoltage;
    assert.ok(
      cranking < resting - 0.8,
      `12.4 V at rest must become ${cranking} V under the starter`,
    );
    assert.ok(
      model.state.rpm < 300,
      "a starter pulls the engine up over about a second, not instantly",
    );
    model.advance(1_200);
    assert.ok(model.state.rpm > 200, `and it gets to cranking speed: ${model.state.rpm} rpm`);
  });

  test("a charging system carries the load a battery cannot", () => {
    const { model } = modelWithBcm({ initial: { ignition: "on", batteryVoltage: 11 } });
    model.setElectricalLoad(40);
    model.advance(200);
    assert.equal(model.state.engineRunning, true, "the key is on and the engine runs");
    assert.ok(
      model.state.supplyVoltage > 13,
      `so the rail is the alternator's, found ${model.state.supplyVoltage} V`,
    );
  });

  test("with nothing charging, the drawn current spends the battery", () => {
    const { model } = modelWithBcm({ initial: { ignition: "on" } });
    model.setAlternatorEfficiency(0);
    const start = model.state.batteryVoltage;
    model.setElectricalLoad(40);
    model.advance(5_000);
    const drained = model.state.batteryVoltage;
    assert.ok(drained < start - 0.5, `${start} V → ${drained} V in 5 s of model time`);
    model.advance(60_000);
    assert.ok(
      model.state.batteryVoltage >= 6,
      "and it bottoms out at the model's empty-cell floor",
    );
  });

  test("an added resistance in the feed is load dependent, which is why it hides", () => {
    const model = new VehicleBehaviourModel({ initial: { ignition: "on" } });
    model.setWiringFault({ ecu: "bcm", mode: "supply-resistance", ohm: 0.8 });
    const atRest = model.supplyOf("bcm");
    model.setElectricalLoad(40);
    model.advance(40);
    const underLoad = model.supplyOf("bcm");
    assert.ok(
      atRest - underLoad > 0.4,
      `the pin sags with the current: ${atRest} V at rest vs ${underLoad} V loaded`,
    );
  });

  test("an intermittent contact alternates on the clock, not on luck", () => {
    const model = new VehicleBehaviourModel({
      initial: { ignition: "on" },
      // A caller-provided rng that always says "contact good" must not be able to make
      // the alternation disappear: `alternate` is the deterministic pattern.
      random: () => 0.99,
    });
    model.setWiringFault({
      ecu: "abs",
      mode: "connector-loose",
      flapMs: 500,
      pattern: "alternate",
    });
    const seen = new Set<boolean>();
    for (let i = 0; i < 10; i++) {
      model.advance(250);
      seen.add(model.isModulePowered("abs"));
    }
    assert.deepEqual([...seen].sort(), [false, true], "both states were reached");
  });

  test("one lie in a meter is a measurement, a trim and then a code", () => {
    const server = memoryOf("engine");
    const { model } = modelWithBcm({ initial: { ignition: "on" } });
    model.attach({
      ecuId: "engine",
      server,
      documentedCodes: new Set(["P0171", "P0300", "P0420"]),
    });
    // Warm the engine up first: the mixture monitors have enabling conditions, and the
    // model enforces them instead of shortcutting to the verdict.
    model.advance(9_000);
    assert.equal(model.signalValue("engine.long_term_fuel_trim"), 0, "nothing to correct yet");
    model.setSensorFault({ signal: "engine.maf_airflow", mode: "drift-low" });
    const reading = model.signalValue("engine.maf_airflow") ?? 0;
    const truth = reading / 0.55;
    assert.ok(truth > reading, `the meter reports ${reading} g/s of ${truth.toFixed(2)} g/s`);
    model.advance(20_000);
    assert.ok(
      (model.signalValue("engine.long_term_fuel_trim") ?? 0) > 12,
      "the learned correction climbs into the lean window",
    );
    assert.equal(statusOf(server, "P0171"), 0x2f, "and then the monitor says so");
  });

  test("a monitor that cannot run does not conclude: cold engine, no lean code", () => {
    const server = memoryOf("engine");
    const model = new VehicleBehaviourModel({
      initial: { ignition: "on", ambientC: 5 },
    });
    model.attach({ ecuId: "engine", server, documentedCodes: new Set(["P0171"]) });
    model.setSensorFault({ signal: "engine.maf_airflow", mode: "drift-low" });
    model.advance(2_000);
    assert.ok(model.state.coolantC < model.thresholds.closedLoopCoolantC);
    assert.deepEqual(
      server.dtcMemory,
      [],
      "the enabling condition is not met, so the test has not run",
    );
    model.advance(30_000);
    assert.equal(
      statusOf(server, "P0171"),
      0x2f,
      "and once the engine is warm enough to judge, it does",
    );
  });

  test("a coding block is a cause: the DRL bit changes the load and the rail", () => {
    const { model } = modelWithBcm({ initial: { ignition: "on" } });
    model.setAlternatorEfficiency(0);
    model.advance(40);
    const before = model.state.supplyVoltage;
    model.setCoding(new Uint8Array([0x08, 0x00, 0x00, 0x00]));
    model.advance(40);
    assert.equal(model.state.electricalLoadA, 12, "the coded consumer is switched on");
    assert.ok(
      model.state.supplyVoltage < before,
      `${before} V → ${model.state.supplyVoltage.toFixed(2)} V with the lights drawing`,
    );
    model.setCoding(new Uint8Array([0x00, 0x00, 0x00, 0x00]));
    model.advance(40);
    assert.equal(model.state.electricalLoadA, 0, "and off again after re-coding");
  });

  test("the idle adaptation the module learned is the idle the engine holds", () => {
    const { model } = modelWithBcm({ initial: { ignition: "on" } });
    model.setIdleAdaptation(864);
    model.advance(1_000);
    assert.equal(model.signalValue("engine.rpm"), 864);
    // Outside the documented window the value is refused rather than rounded.
    model.setIdleAdaptation(400);
    assert.equal(model.idleAdaptation, 600, "clamped at the low end of the declared range");
  });

  test("a short-circuited wheel sensor reads rail voltage, and both ends are implausible", () => {
    const server = memoryOf("abs");
    const model = new VehicleBehaviourModel({ initial: { ignition: "on" } });
    model.attach({ ecuId: "abs", server, documentedCodes: new Set(["C0035"]) });
    model.setDriverDemand({ demandSpeedKph: 60, gear: 4 });
    model.advance(6_000);
    assert.equal(statusOf(server, "C0035"), undefined, "four matching wheels are no fault");
    model.setSensorFault({ signal: "abs.wheel_speed_front_left", mode: "short-to-battery" });
    model.advance(600);
    assert.ok(
      (model.signalValue("abs.wheel_speed_front_left") ?? 0) > 300,
      "the value is absurd — that is the finding, not a status byte",
    );
    assert.equal(
      statusOf(server, "C0035"),
      0x2f,
      "and the rationality test catches both directions",
    );
  });
});

describe("the sensor vocabulary", () => {
  /**
   * One wheel channel, one mode, the number a tester would read. The model's whole
   * claim about sensors is that each mode is a different *electrical story* with its own
   * reading — so this is where a mode collapsing into another one, or into a catch-all,
   * becomes visible.
   */
  function readingWith(mode: SensorFaultMode, value?: number): number | undefined {
    const { model } = modelWithBcm({ initial: { speedKph: 60 } });
    model.setSensorFault({
      signal: "abs.wheel_speed_front_left",
      mode,
      ...(value === undefined ? {} : { value }),
    });
    model.advance(40);
    return model.signalValue("abs.wheel_speed_front_left");
  }

  test("each mode of the vocabulary reads as the story it tells", () => {
    const readings = [
      readingWith("open-circuit"),
      readingWith("short-to-ground"),
      readingWith("short-to-battery"),
      readingWith("stuck", 42),
      readingWith("drift-high"),
      readingWith("drift-low"),
    ];
    assert.deepEqual(readings, [0, 0, 520, 42, 150, 18]);
    assert.equal(
      new Set(readings).size,
      5,
      "six modes, five readings: a cut wire and a wire on ground are the same dead channel, " +
        "and that is a decision the model states — every other mode stands alone",
    );
  });

  test("a stuck channel stays stuck while the car moves", () => {
    const { model } = modelWithBcm({ initial: { speedKph: 20 } });
    model.setSensorFault({ signal: "abs.wheel_speed_front_left", mode: "stuck", value: 42 });
    model.setDriverDemand({ demandSpeedKph: 90 });
    // 12 km/h per second of model time is the acceleration this car has, so six seconds
    // is the shortest wait that lets the neighbour arrive at 90 — the numbers in this
    // file are chosen from the model's rates, not from a sleep that happens to work.
    model.advance(6_000);
    assert.equal(model.signalValue("abs.wheel_speed_front_left"), 42, "the value it froze at");
    assert.equal(
      model.signalValue("abs.wheel_speed_front_right"),
      90,
      "while its neighbour arrived at what the driver asked for",
    );
  });

  test("a lie at the meter is a different number than the same lie at the wheel", () => {
    // The MAF path scales against what the engine breathes and the wheel path against
    // the speed the car rolls at; both must stay inside their own units, and a shared
    // "fault means zero" shortcut for both would erase the difference the monitors read.
    const { model } = modelWithBcm({ initial: { speedKph: 60, rpm: 800 } });
    model.setSensorFault({ signal: "engine.maf_airflow", mode: "drift-high" });
    model.advance(40);
    const maf = model.signalValue("engine.maf_airflow") ?? 0;
    assert.ok(maf > 0, "a drifted meter still reports a quantity, not a zero");
    assert.equal(
      model.signalValue("abs.wheel_speed_front_left"),
      60,
      "and the wheels are untouched",
    );
  });
});

describe("fault memory lifecycle", () => {
  test("a healed code ages out after the documented number of key-off cycles", () => {
    const { model, server } = modelWithBcm({ initial: { ignition: "off" } });
    model.setBatteryVoltage(10);
    model.advance(600);
    assert.equal(statusOf(server, "B1001"), 0x2f);
    model.setBatteryVoltage(13);
    model.advance(1_500);
    assert.equal(statusOf(server, "B1001"), 0x2e, "healed, still in memory");
    // A cycle has to *end* to count, and a key that was already off does not end one:
    // that is why the loop switches on first. A model that counted `off → off` as a
    // cycle would age faults out while the car sat with the key off.
    const cycles = model.thresholds.removalCycles;
    for (let i = 0; i < cycles; i++) {
      model.setIgnition("on");
      model.advance(100);
      model.setIgnition("off");
      model.advance(100);
    }
    assert.equal(
      statusOf(server, "B1001"),
      undefined,
      `after ${cycles} clean operation cycles the ECU forgets it — without anyone clearing it`,
    );
  });

  test("an active code does not age out, only a healed one", () => {
    const { model, server } = modelWithBcm({ initial: { ignition: "on" } });
    model.setBatteryVoltage(10);
    model.advance(600);
    for (let i = 0; i < 5; i++) {
      model.setIgnition("off");
      model.advance(100);
      model.setIgnition("on");
      model.advance(100);
    }
    assert.equal(
      statusOf(server, "B1001"),
      0x2f,
      "the condition is present, so the fault stays reported",
    );
  });

  test("a freeze frame is written with the layout and the moment the caller provides", async () => {
    const server = memoryOf("engine");
    const model = new VehicleBehaviourModel({ initial: { ignition: "on" } });
    let captured: Readonly<{ rpm: number }> | undefined;
    model.attach({
      ecuId: "engine",
      server,
      documentedCodes: new Set(["P0300"]),
      freezeFrame: (_code, state) => {
        captured = { rpm: state.rpm };
        return new Uint8Array([0x01, 0x02]);
      },
    });
    model.setAlternatorEfficiency(0);
    model.setBatteryVoltage(9.9);
    model.setElectricalLoad(30);
    model.advance(1_000);
    assert.equal(model.state.engineRunning, true, "weak enough to misfire, not to stop");
    assert.equal(statusOf(server, "P0300"), 0x2f);
    assert.ok(captured, "the vehicle's encoder ran at the latch moment");
    const record = server.dtcMemory.find((dtc) => dtc.code === "P0300");
    assert.deepEqual(
      Array.from(record?.snapshot ?? []),
      [0x01, 0x02],
      "and its bytes are the record",
    );
    // A record the ECU has no bytes for is refused with the number, not with zeros.
    await server.handle(new Uint8Array([SID.READ_DTC_INFORMATION, 0x04, 0x04, 0x20, 0x00, 0x01]));
    assert.equal(server.stats.negativeResponses, 1, "P0420 has no record here");
    assert.equal(NRC.REQUEST_OUT_OF_RANGE, 0x31, "the refusal this stands for");
  });
});

describe("running the model", () => {
  test("reseed replaces the random stream, derived from the seed alone", () => {
    // Reseeding is how a scenario file's seed reaches an already-built vehicle
    // (ADR 0048): the stream it installs must be exactly the one constructing with
    // the same seed would have produced — otherwise "same seed" would not mean the
    // same run.
    // Randomness is drawn where the engine stumbles (an unstable supply makes the rpm
    // wobble), so the test runs *that* path: identical streams must give identical
    // states, or "same seed" would not mean the same run. Every model is fresh — the
    // comparison is between runs, and a run consumes its model's time.
    const run = (model: VehicleBehaviourModel): Readonly<unknown> => {
      // A dying alternator and 9.2 V: below the misfire window (9.6) so the rpm
      // wobbles on every step, above the brownout window (8 + 1) so the engine keeps
      // running and keeps drawing. (With a working alternator the supply recovers to
      // 14.1 V and no randomness is ever drawn — the seed would be decoration.)
      model.setAlternatorEfficiency(0);
      model.setBatteryVoltage(9.2);
      model.advance(2_000);
      return { state: model.state, monitors: model.monitorStates() };
    };
    const reseeded = run(
      (() => {
        const model = new VehicleBehaviourModel();
        model.reseed(99);
        return model;
      })(),
    );
    assert.deepEqual(
      run(new VehicleBehaviourModel({ random: createRandom(99) })),
      reseeded,
      "reseed installs exactly the stream the same seed would have constructed",
    );
    const twin = (() => {
      const model = new VehicleBehaviourModel();
      model.reseed(99);
      return model;
    })();
    assert.deepEqual(run(twin), reseeded, "and two models on one seed are one run");
    // A different seed is allowed to wobble differently — that is the point of one.
    assert.notDeepEqual(
      run(new VehicleBehaviourModel({ random: createRandom(100) })),
      reseeded,
      "the seed is load-bearing, not decoration",
    );
  });

  test("slicing the advance changes nothing", () => {
    const options = {
      initial: { ignition: "on" as const, batteryVoltage: 11.6 },
      random: createRandom(7),
    };
    const whole = new VehicleBehaviourModel(options);
    const sliced = new VehicleBehaviourModel(options);
    whole.setElectricalLoad(30);
    sliced.setElectricalLoad(30);
    whole.advance(5_000);
    for (let i = 0; i < 50; i++) sliced.advance(100);
    assert.equal(whole.state.supplyVoltage, sliced.state.supplyVoltage);
    assert.equal(whole.state.rpm, sliced.state.rpm);
    assert.deepEqual(whole.monitorStates(), sliced.monitorStates());
  });

  test("a signal the model has no rule for is left to the vehicle, not reported as zero", () => {
    const { model } = modelWithBcm();
    assert.equal(model.signalValue("engine.vin"), undefined);
    assert.equal(model.signalValue("transmission.input_speed"), undefined);
  });

  test("summary says what the run reached, in the numbers a reader checks", () => {
    const { model } = modelWithBcm({ initial: { ignition: "off" } });
    model.setBatteryVoltage(10);
    model.advance(1_000);
    const summary = model.summary();
    assert.equal(typeof summary.supplyVoltage, "number");
    assert.equal(summary.activeCodes, 1, "one latched monitor, and the summary says one");
    assert.equal(summary.ignition, "off", "the state a reader would call the car in");
    assert.ok(Number(summary.supplyVoltage) < 11.5, "and the number the code was latched on");
  });

  test("reset removes causes and latches, and keeps the attached modules", () => {
    const { model, server } = modelWithBcm({ initial: { ignition: "on" } });
    model.setAlternatorEfficiency(0);
    model.setBatteryVoltage(9.4);
    model.setSensorFault({ signal: "engine.maf_airflow", mode: "drift-low" });
    model.advance(1_000);
    assert.ok(statusOf(server, "B1001") !== undefined);
    model.advance(1_000);
    const withFault = model.signalValue("engine.maf_airflow");
    model.reset();
    assert.equal(monitorOf(model, "bcm-supply-voltage").raised, 0, "the model forgot its latches");
    assert.equal(model.sensorFault("engine.maf_airflow"), undefined, "and every cause it carried");
    // A reset forgets causes and latches; it does not rewrite the last measured value.
    assert.equal(model.state.mafGramsPerS, withFault);
    model.setSensorFault({ signal: "engine.maf_airflow", mode: "drift-high" });
    model.advance(100);
    assert.notEqual(
      model.state.mafGramsPerS,
      withFault,
      "and a *new* cause is obeyed again, which is what proves the old one is gone",
    );
    model.setBatteryVoltage(12.9);
    model.advance(1_200);
    assert.equal(
      statusOf(server, "B1001"),
      0x2f,
      "and reset() does not touch a module's fault memory: the record the ECU holds stays " +
        "as it was. Forgetting a diagnosis is service 0x14, not a constructor (AGENTS 20)",
    );
  });
});
