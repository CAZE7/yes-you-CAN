/**
 * A scenario file, end to end (ADR 0040 + ADR 0045, master prompt §7/§9).
 *
 * This is not a parser test — the package spec already proves the reader. The
 * claim here is the one §9 demands: a file checked into `scenarios/` runs the
 * actual communication chain, and the *file’s own* expectation is what the
 * diagnostic read must reproduce:
 *
 *   scenarios/alternator_failure.json
 *     → parseScenarioFile            (deterministic model time, seeded rng)
 *     → HighFidelityVehicle.runScenario   (the cause, on the car, via the bus)
 *     → UDS 0x19 scan               (through ISO-TP, the tester’s own read)
 *     → DtcScanner.observe / EvidenceService  (the IR and its proof)
 *     → assert on the read, not on a setter
 *
 * Nothing pokes the simulator to produce a result: the file names the failed
 * alternator and the load, the model decides the voltage, the BCM stores the
 * code, and only then does the platform get to see it — with `battery_voltage`
 * re-read from the BCM’s DID so the number a monitor acted on is also the
 * number an evidence item cites.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DiagnosticEngine, DtcScanner, type EnrichedDtc } from "@vdp/core";
import { type DefinitionPackage, highFidelityPackage } from "@vdp/definitions";
import { itemsOf } from "@vdp/diagnostic-ir";
import { EvidenceService } from "@vdp/runtime";
import { type Logger, createLogger } from "@vdp/shared";
import { HighFidelityVehicle, createRandom, parseScenarioFile } from "@vdp/simulators";
import { test } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scenarioPath = join(repoRoot, "scenarios", "alternator_failure.json");
const logger: Logger = createLogger("scenario-file", { level: "ERROR" });

/** The file, read as a human on the bench would hand it to a runner. */
const fileText = readFileSync(scenarioPath, "utf8");
const parsed = parseScenarioFile(fileText);

test("the checked-in scenario file parses under its own strict reader", () => {
  assert.ok(parsed.ok, `parse errors:\n${"errors" in parsed ? parsed.errors.join("\n") : ""}`);
});
if (!parsed.ok) throw new Error("scenario file must parse for the runs below");
const { scenario, determinism } = parsed.file;

function newVehicle(): HighFidelityVehicle {
  // Same seed, same model clock the file declares: the run is reproducible by
  // the file, not by a constant baked into this test.
  return new HighFidelityVehicle({
    logger,
    modelTickMs: 0,
    model: { random: createRandom(determinism.seed) },
  });
}

function newEngine(vehicle: HighFidelityVehicle): DiagnosticEngine {
  return new DiagnosticEngine({
    logger,
    bus: vehicle.testerBus,
    definitions: [highFidelityPackage as DefinitionPackage],
  });
}

function ecuKey(ecu: { definitionEcuId?: string; name: string }): string {
  return ecu.definitionEcuId ?? ecu.name;
}

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

test("the file’s cause reaches the fault memory through the whole communication chain", async () => {
  const vehicle = newVehicle();
  await vehicle.start();
  const engine = newEngine(vehicle);
  await engine.connect({ windowMs: 150, probeDelayMs: 0 });
  try {
    // Before: no code, no fault — the file has not run yet.
    const before = (await engine.scanDtcs(0xff)).scanned;
    assert.deepEqual(
      before.flatMap((entry) => entry.dtcs),
      [],
      "nothing is stored before the cause is on the car",
    );

    // The runner drives the file; the model produces the consequences.
    const run = await vehicle.runScenario(scenario);
    assert.equal(
      run.passed,
      true,
      `the model disagreed with the file:\n${run.checks
        .filter((c) => !c.passed)
        .map((c) => `  ${c.subject}: ${c.expected} vs ${c.actual}`)
        .join("\n")}`,
    );
    assert.deepEqual(run.unexpected, [], "closed world: no code the file did not name");

    // The read over the wire is the one the file predicted: B1001 active, on
    // the BCM, answered by UDS 0x19 over ISO-TP — not written into a field.
    const scan = (await engine.scanDtcs(0xff)).scanned;
    const bcmDtc = scan
      .filter((entry) => ecuKey(entry.ecu) === "bcm")
      .flatMap((entry) => entry.dtcs)
      .find((dtc) => dtc.code === "B1001");
    assert.ok(
      bcmDtc,
      `the scan must carry the code the cause produced; read ${
        scan.flatMap((e) => e.dtcs.map((d) => `${ecuKey(e.ecu)}:${d.code}`)).join(", ") || "nothing"
      }`,
    );
    assert.equal(bcmDtc.statusBits.testFailed, true, "the file predicts active, the read agrees");

    // And the voltage the file’s comparison names is measurable at the module,
    // through a documented DID — the same statement, not a second number.
    const signals = await engine.snapshotSignals();
    const voltage = signals.find((s) => s.signalId === "bcm.battery_voltage");
    assert.ok(voltage && typeof voltage.value === "number", "the BCM supply DID answers");
    assert.equal(
      (voltage.value as number) < 12.0,
      true,
      `the file says battery_voltage < 12.0 V; the read says ${voltage.value}`,
    );

    // The IR keeps the code with its own proof, and the evidence set cites it.
    const scanner = new DtcScanner({ definitions: [highFidelityPackage] });
    const states = scanner.observe(
      scan.flatMap((entry) => entry.dtcs).map(toRecord),
      "Body Control Module",
      "bcm",
      { oem: highFidelityPackage.oem, ecu: "bcm" },
    );
    const observed = states.find((entry) => entry.state.observation.code === "B1001");
    assert.ok(observed, "the code arrives in the IR");
    assert.equal(observed.state.observation.statusBits.testFailed, true);
    assert.equal(
      observed.state.enrichment?.evidence.kind,
      "proven",
      "the package wording is cited as proven",
    );

    const evidence = new EvidenceService(engine).snapshot();
    const item = itemsOf(evidence.evidence, "dtc").find((entry) => entry.subject.includes("B1001"));
    assert.ok(item, "the evidence set carries the fault the file caused");
    assert.equal(item.evidence.kind, "proven", "with a proof line, not a bare claim");
  } finally {
    await engine.disconnect();
    await vehicle.stop();
  }
});

test("the same file run twice yields the same diagnostic result", async () => {
  // Determinism as the file promises it: the seed fixes the intermittent
  // behaviour, model time fixes the drain. Two runs must agree on the checks.
  const once = async (): Promise<string> => {
    const vehicle = newVehicle();
    await vehicle.start();
    try {
      const run = await vehicle.runScenario(scenario);
      return JSON.stringify({
        passed: run.passed,
        unexpected: run.unexpected,
        checks: run.checks,
        finalBattery: Math.round(run.finalState.batteryVoltage * 1000) / 1000,
      });
    } finally {
      await vehicle.stop();
    }
  };
  assert.equal(await once(), await once(), "same input, same result — replay is possible");
});
