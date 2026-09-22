/**
 * The chain a diagnosis is made of, end to end: cause → module → fault memory → UDS →
 * Diagnostic IR → evidence (AGENTS 32, 20; master backlog P0 #6/#16/#39).
 *
 * ```text
 * a cause on the bench          the vehicle model                  the module
 * battery dragged to 11.0 V  →  supply at the pins, 600 ms later  →  BCM monitor latches
 *                                                                        ↓
 *   evidence items       ←   Diagnostic IR (DtcState)     ←   UDS 0x19 answers the scan
 * ```
 *
 * Nothing here pokes a simulator field and reads it back: every assertion is about
 * what the *platform* sees, through the same ISO-TP + UDS path a workshop tool uses.
 * Three properties are pinned, in this order:
 *
 * 1. **The code arrives while the cause is on the car**, not after the test happened to
 *    look — so the scan runs between scenario steps.
 * 2. **The verdict a scenario predicts is the verdict the scan reports**, for every
 *    scenario in the catalog (`active`/`stored`/`absent` read off the status byte).
 * 3. **The evidence set cites the same observation**, with the IR's own proof — because
 *    a fault memory nobody can cite is still a list of codes, not a diagnosis.
 */

import assert from "node:assert/strict";
import { DiagnosticEngine, DtcScanner, type EnrichedDtc, type ScannedEcu } from "@vdp/core";
import { type DefinitionPackage, highFidelityPackage } from "@vdp/definitions";
import { itemsOf } from "@vdp/diagnostic-ir";
import { encodeDtcToBytes } from "@vdp/protocols-uds";
import { EvidenceService } from "@vdp/runtime";
import { type Logger, createLogger, fromHex } from "@vdp/shared";
import {
  HEARTBEAT_IDS,
  HighFidelityVehicle,
  type ScenarioExpectation,
  createRandom,
} from "@vdp/simulators";
import { test } from "vitest";
import { scenarioFileById, scenarioFiles } from "../helpers/scenario-files.js";
import { waitFor } from "../helpers/wait.js";

const logger: Logger = createLogger("scenario-chain", { level: "ERROR" });

/** The scenario run needs no wall clock: the model is stepped by the run itself. */
function newVehicle(): HighFidelityVehicle {
  return new HighFidelityVehicle({
    logger,
    modelTickMs: 0,
    model: { random: createRandom(4242) },
  });
}

function newEngine(vehicle: HighFidelityVehicle): DiagnosticEngine {
  return new DiagnosticEngine({
    logger,
    bus: vehicle.testerBus,
    definitions: [highFidelityPackage as DefinitionPackage],
  });
}

async function connected(): Promise<{
  vehicle: HighFidelityVehicle;
  engine: DiagnosticEngine;
  teardown: () => Promise<void>;
}> {
  const vehicle = newVehicle();
  await vehicle.start();
  const engine = newEngine(vehicle);
  await engine.connect({ windowMs: 150, probeDelayMs: 0 });
  return {
    vehicle,
    engine,
    teardown: async () => {
      await engine.disconnect();
      await vehicle.stop();
    },
  };
}

/**
 * The key a scenario names a module by: the definition id, falling back to the display
 * name. `EcuSession.id` is generated per run (`ecu_…`), so it is the one identifier a
 * reproducible statement must never be keyed on (ADR 0036 §4 says the same about a
 * golden session).
 */
function ecuKey(ecu: { definitionEcuId?: string; name: string }): string {
  return ecu.definitionEcuId ?? ecu.name;
}

const codesOf = (scan: readonly ScannedEcu[]): string[] =>
  scan.flatMap((entry) => entry.dtcs.map((dtc) => `${ecuKey(entry.ecu)}:${dtc.code}`));

/**
 * One expectation, judged from a scan alone. Returns a message when it does not hold.
 *
 * `testFailed` and the presence of the record are all this reads: the point of checking
 * a scenario from outside is that the outside has nothing else to go on.
 */
async function verdictOf(
  scan: readonly ScannedEcu[],
  expectation: ScenarioExpectation,
): Promise<string | undefined> {
  const subject = `${expectation.ecu}:${expectation.code}`;
  const found = scan
    .filter((entry) => ecuKey(entry.ecu) === expectation.ecu)
    .flatMap((entry) => entry.dtcs)
    .find((dtc) => dtc.code === expectation.code);
  const seen = codesOf(scan).join(", ") || "nothing";
  switch (expectation.state) {
    case "absent":
      return found === undefined
        ? undefined
        : `${subject} must not be reported, and it was (status 0x${found.status
            .toString(16)
            .padStart(2, "0")}) — ${expectation.because}`;
    case "active":
      if (found === undefined) return `${subject} missing from the scan; read ${seen}`;
      return found.statusBits.testFailed
        ? undefined
        : `${subject} must read as failing now, status 0x${found.status.toString(16)}`;
    case "stored":
      if (found === undefined) return `${subject} must still be in memory; read ${seen}`;
      return found.statusBits.testFailed
        ? `${subject} healed, so testFailed has to be out of the byte a scan reads`
        : undefined;
    case "intermittent":
      return found === undefined
        ? `${subject} came and went, and a scan reads neither: ${seen}`
        : undefined;
  }
}

/** Every scenario file, measured through the wire instead of through a setter. */
for (const file of scenarioFiles()) {
  const scenario = file.scenario;
  test(`${scenario.id}: a UDS scan reports what the scenario predicted`, async () => {
    const { vehicle, engine, teardown } = await connected();
    try {
      // Every expectation with its own `atMs` is checked *at that moment*, by a scan
      // over the wire — that is the difference between "the model wrote it" and "a
      // tester can read it while the cause is on the car". The seed is the file's own,
      // so the wire sees exactly the run the file declares.
      const wireFailures: string[] = [];
      const run = await vehicle.runScenario(scenario, {
        seed: file.determinism.seed,
        onMoment: async (moment) => {
          if (moment.due.length === 0) return;
          const scan = (await engine.scanDtcs(0xff)).scanned;
          for (const expectation of moment.due) {
            const line = await verdictOf(scan, expectation);
            if (line !== undefined) wireFailures.push(`@${moment.atMs} ${line}`);
          }
        },
      });
      assert.deepEqual(
        wireFailures,
        [],
        `the UDS read did not match the scenario at the moment it names:\n${wireFailures.join("\n")}`,
      );
      assert.equal(
        run.passed,
        true,
        `the model itself disagreed with the scenario:\n${run.checks
          .filter((check) => !check.passed)
          .map((check) => `  ${check.subject}: ${check.expected} vs ${check.actual}`)
          .join("\n")}`,
      );

      // And the same statements again, read from outside at the end of the run.
      const scan = (await engine.scanDtcs(0xff)).scanned;
      for (const expectation of scenario.expectations) {
        if (expectation.atMs !== undefined && expectation.atMs !== scenario.durationMs) continue;
        const line = await verdictOf(scan, expectation);
        assert.equal(line, undefined, `the scan disagreed with the scenario: ${line}`);
      }
    } finally {
      await teardown();
    }
  });
}

test("the fault is on the wire *while* the cause is on the car, not only after it", async () => {
  const { vehicle, engine, teardown } = await connected();
  try {
    const before = (await engine.scanDtcs(0xff)).scanned;
    assert.deepEqual(codesOf(before), [], "nothing is stored before anything happened");

    vehicle.setIgnition("off");
    vehicle.setBatteryVoltage(11);
    vehicle.setElectricalLoad(25);
    vehicle.advance(600);

    const during = (await engine.scanDtcs(0xff)).scanned;
    const bcmCodes = during
      .filter((entry) => ecuKey(entry.ecu) === "bcm")
      .flatMap((entry) => entry.dtcs);
    const underVoltage = bcmCodes.find((dtc) => dtc.code === "B1001");
    assert.ok(
      underVoltage,
      `the BCM has to answer 0x19 with B1001 while the supply is down; read ${codesOf(during)}`,
    );
    assert.equal(underVoltage.statusBits.testFailed, true);
    // The words the definition package has for the code travel with it — the scan is
    // not a bare number, and this is where that stops being a claim.
    assert.match(underVoltage.description ?? "", /voltage/i);

    // And the cause is measurable at the module, not only in the model.
    const signals = await engine.snapshotSignals();
    const voltage = signals.find((entry) => entry.signalId === "bcm.battery_voltage");
    assert.ok(voltage, "the BCM's supply DID is a documented signal");
    assert.equal(typeof voltage.value, "number");
    assert.ok(
      (voltage.value as number) < 11.5,
      `the read says ${voltage.value} V — the same number the monitor acted on`,
    );

    // The recovery is a cause as well — a booster at the terminals, not a call that
    // clears a status byte. 11.0 V cannot catch an engine, so the flat battery has to
    // be replaced by a supply before anything may heal.
    vehicle.setBatteryVoltage(13.4);
    vehicle.setIgnition("start");
    vehicle.advance(2_500);
    vehicle.setIgnition("on");
    vehicle.advance(1_500);
    const after = (await engine.scanDtcs(0xff)).scanned;
    const healed = after
      .filter((entry) => ecuKey(entry.ecu) === "bcm")
      .flatMap((entry) => entry.dtcs)
      .find((dtc) => dtc.code === "B1001");
    assert.ok(healed, "the code stays in memory after the fault is over");
    assert.equal(healed.statusBits.testFailed, false);
    assert.ok(
      vehicle.model.state.engineRunning,
      "and the engine caught while cranking — the charge is what healed the code",
    );
  } finally {
    await teardown();
  }
});

test("a latched fault becomes an evidence item that cites its own proof", async () => {
  const { vehicle, engine, teardown } = await connected();
  try {
    vehicle.setIgnition("off");
    vehicle.setBatteryVoltage(10.8);
    vehicle.advance(1_000);

    const scan = (await engine.scanDtcs(0xff)).scanned;
    const records = scan.flatMap((entry) => entry.dtcs);
    assert.ok(records.length > 0, "the scan found the fault the cause produced");

    // The IR half: one observation per code, with the scan's own evidence line.
    const scanner = new DtcScanner({ definitions: [highFidelityPackage] });
    const states = scanner.observe(records.map(toRecord), "Body Control Module", "bcm", {
      oem: highFidelityPackage.oem,
      ecu: "bcm",
    });
    const scanned = states.find((entry) => entry.state.observation.code === "B1001");
    assert.ok(
      scanned,
      `the code is in the IR; got ${states.map((entry) => entry.state.observation.code)}`,
    );
    const observation = scanned.state;
    assert.equal(observation.observation.ecuId, "bcm");
    assert.match(observation.observation.raw, /^[0-9a-f]{6}$/i, "the raw bytes of the DTC");
    assert.equal(observation.observation.statusBits.testFailed, true, "the byte a scan read, kept");
    assert.equal(observation.enrichment?.evidence.kind, "proven");
    assert.match(observation.enrichment?.description ?? "", /voltage/i);
    // The ECU's answer *is* the origin: nothing above the transport invented this code.
    assert.deepEqual(
      fromHex(observation.observation.raw),
      encodeDtcToBytes("B1001"),
      "the raw value is the DTC the module was asked about, byte for byte",
    );

    // The evidence half: the session's last scan, as items with stable ids.
    const evidence = new EvidenceService(engine).snapshot();
    const dtcItems = itemsOf(evidence.evidence, "dtc");
    const item = dtcItems.find((entry) => entry.subject.includes("B1001"));
    assert.ok(item, `the evidence set cites the fault; items: ${dtcItems.map((e) => e.subject)}`);
    assert.equal(
      item.evidence.kind,
      "proven",
      "a scan of this platform always leaves a proof line",
    );
    assert.ok(item.at.length > 0, "and it says when");
    assert.equal(evidence.evidence.sessionId, engine.vehicleSession?.id);

    // A report/AI consumer must be able to reach the same item by id, not by copy.
    const again = new EvidenceService(engine).snapshot();
    assert.equal(
      itemsOf(again.evidence, "dtc").find((entry) => entry.subject.includes("B1001"))?.id,
      item.id,
      "the item id is stable for one stored scan, so a citation survives a re-read",
    );
  } finally {
    await teardown();
  }
});

test("a module that stops answering is a gap in the evidence, not a missing row", async () => {
  const { vehicle, engine, teardown } = await connected();
  try {
    const session = engine.vehicleSession;
    assert.ok(session);
    const ecuCount = session.data.ecus.length;
    assert.ok(ecuCount >= 5, `five modules were discovered, got ${ecuCount}`);
    vehicle.advance(400);
    const heartbeat = HEARTBEAT_IDS.abs ?? 0;
    await waitFor(
      () => vehicle.network.snapshot().some((frame) => frame.id === heartbeat),
      undefined,
      { message: "the ABS put a frame on the wire" },
    );

    vehicle.cutPower("abs");
    vehicle.advance(900);

    const scan = (await engine.scanDtcs(0xff)).scanned;
    assert.equal(
      scan.some((entry) => ecuKey(entry.ecu) === "abs"),
      false,
      "the scan could not read it — and the scan says so by not listing it",
    );
    // The session still knows the module: an unanswered ECU is data, not a disappearance.
    assert.equal(session.data.ecus.length, ecuCount, "the row stays in the session");
    const gatewayCodes = scan
      .filter((entry) => ecuKey(entry.ecu) === "gateway")
      .flatMap((entry) => entry.dtcs)
      .map((dtc) => dtc.code);
    assert.ok(
      gatewayCodes.includes("U0121"),
      `and the peer that measures the silence reports it, read ${gatewayCodes.join(", ")}`,
    );

    const evidence = new EvidenceService(engine).snapshot();
    const gaps = itemsOf(evidence.evidence, "gap");
    assert.ok(
      gaps.length > 0,
      "the open questions of the session are items of their own, with a reason",
    );
    for (const gap of gaps) {
      assert.ok(gap.statement.length > 0, `an unproven item without a reason: ${gap.id}`);
      assert.equal(gap.evidence.kind, "unproven");
    }

    vehicle.restorePower("abs");
    vehicle.advance(400);
    const restored = (await engine.scanDtcs(0xff)).scanned;
    assert.ok(
      restored.some((entry) => ecuKey(entry.ecu) === "abs"),
      "and it is readable again, without anyone re-attaching it",
    );
  } finally {
    await teardown();
  }
});

test("a value outside the declared range is a measurement, an anomaly and an item", async () => {
  const { vehicle, engine, teardown } = await connected();
  try {
    // A regulator that stopped regulating: the number leaves the package's declared
    // window, and everything above the transport notices through that number alone.
    vehicle.setAlternator(0);
    vehicle.setBatteryVoltage(24);
    vehicle.advance(600);

    const signals = await engine.snapshotSignals();
    const voltage = signals.find((entry) => entry.signalId === "bcm.battery_voltage");
    assert.ok(voltage);
    assert.equal(voltage.outOfRange, true, `24 V is outside 0…20 V, got ${voltage.value}`);

    await engine.startLiveData({
      signalIds: ["bcm.battery_voltage"],
      intervalMs: 10,
      maxRounds: 2,
    });
    await waitFor(() => engine.recorder.statisticsForAll().length > 0, undefined, {
      message: "a sample landed in the recorder",
    });
    engine.stopLiveData();
    const anomalies = engine.recorder.anomalies();
    assert.ok(
      anomalies.some((entry) => entry.signal === "bcm.battery_voltage"),
      `the recorder flags the range violation, got ${JSON.stringify(anomalies)}`,
    );

    const evidence = new EvidenceService(engine).snapshot();
    const anomalyItems = itemsOf(evidence.evidence, "anomaly");
    assert.ok(
      anomalyItems.some((item) => item.subject.includes("bcm.battery_voltage")),
      "and the anomaly is citable as an item, so a report can print it",
    );

    // The same cause, one step further: the BCM's own window monitor stores the code.
    const scan = (await engine.scanDtcs(0xff)).scanned;
    assert.ok(
      scan
        .filter((entry) => ecuKey(entry.ecu) === "bcm")
        .flatMap((entry) => entry.dtcs)
        .some((dtc) => dtc.code === "B1001"),
      "the fault memory and the measurement are two views of one event",
    );
  } finally {
    await teardown();
  }
});

test("a scenario is runnable without a test runner at all (the same data drives a demo)", async () => {
  const vehicle = newVehicle();
  await vehicle.start();
  try {
    const file = scenarioFileById("under-voltage-at-start");
    const scenario = file.scenario;
    const before = vehicle.model.monitorStates();
    const run = await vehicle.runScenario(scenario, { seed: file.determinism.seed });
    assert.equal(run.passed, true);
    assert.notDeepEqual(
      vehicle.model.monitorStates(),
      before,
      "a run that changed nothing about the monitors would be a script, not a simulation",
    );
    assert.ok(run.timeline.length >= scenario.steps.length, "and it says what it did");
  } finally {
    await vehicle.stop();
  }
});

test("a negative control: the same vehicle, the same time, no causes, no codes", async () => {
  const { vehicle, engine, teardown } = await connected();
  try {
    // 40 s of a car sitting with the key on is long enough for every monitor in this
    // model to have run — and with no cause there is nothing for them to report.
    vehicle.advance(40_000);
    const scan = (await engine.scanDtcs(0xff)).scanned;
    assert.deepEqual(
      codesOf(scan),
      [],
      `nothing was caused, so nothing may be stored: ${codesOf(scan)}`,
    );
    const evidence = new EvidenceService(engine).snapshot();
    assert.deepEqual(itemsOf(evidence.evidence, "dtc"), []);
  } finally {
    await teardown();
  }
});

test("when the supply fails for the whole car, the platform says so instead of guessing", async () => {
  // The same scenario as above, run to the end of the battery: every module leaves the
  // bus. A diagnosis that reported "no faults stored" here would be the most dangerous
  // sentence this platform can print, so the requirement is the opposite one: the scan
  // comes back empty *and* the evidence set says which modules could not be read.
  const { vehicle, engine, teardown } = await connected();
  try {
    vehicle.setIgnition("on");
    vehicle.setElectricalLoad(45);
    vehicle.setAlternator(0);
    vehicle.advance(45_000);
    assert.ok(
      vehicle.model.state.supplyVoltage < vehicle.model.thresholds.brownoutV,
      `the premise has to hold: ${vehicle.model.state.supplyVoltage} V at the pins`,
    );

    const scan = (await engine.scanDtcs(0xff)).scanned;
    assert.deepEqual(codesOf(scan), [], "nothing can be read off a car with no power");
    const evidence = new EvidenceService(engine).snapshot();
    const gaps = itemsOf(evidence.evidence, "gap");
    assert.ok(gaps.length > 0, "and every unanswered module is an item with a reason");
    assert.ok(
      gaps.every((gap) => gap.evidence.kind === "unproven"),
      "an unanswered read is never reported as a proven statement",
    );
    assert.equal(
      engine.vehicleSession?.data.ecus.length,
      5,
      "the session keeps the modules it found: unreachable is a state, not a deletion",
    );
  } finally {
    await teardown();
  }
});

/** An `EnrichedDtc` back to the protocol record shape `DtcScanner.observe` reads. */
function toRecord(dtc: EnrichedDtc) {
  return {
    code: dtc.code,
    status: dtc.status,
    raw: dtc.raw,
    failureType: dtc.failureType,
    statusBits: dtc.statusBits,
    severity: dtc.severity,
    ...(dtc.snapshot === undefined ? {} : { snapshot: dtc.snapshot }),
    ...(dtc.extendedData === undefined ? {} : { extendedData: dtc.extendedData }),
  };
}
