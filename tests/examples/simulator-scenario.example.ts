/**
 * Ausführbare Dokumentation: Simulator & Szenario-Engine (Flow
 * `docs/flows/recording-replay.md`, ADR 0040).
 *
 * Das zeigt, *so* wird das virtuelle Fahrzeug gefahren:
 *
 * 1. Das **Szenario** schreibt Ursachen und Erwartungen in Modellzeit vor —
 *    `runScenario` wendet sie an und liefert ein `ScenarioRun`, es assertet
 *    nie (das Urteil gehört in den Test).
 * 2. Die **Negative Kontrolle** ist Pflicht: dasselbe Szenario *ohne*
 *    Ursachen darf nicht grün sein — ein Szenario, das auch ohne Ursache
 *    besteht, misst nichts.
 * 3. Der **Draht** ist der zweite Beobachter: ein UDS-Scan während der
 *    Ursache liest, was der Monitor gelatched hat (ADR 0040: Antwort über
 *    den Draht, nie ein Simulator-Feld).
 */

import assert from "node:assert/strict";
import { DiagnosticEngine, type ScannedEcu } from "@vdp/core";
import { type DefinitionPackage, highFidelityPackage } from "@vdp/definitions";
import { createLogger, type Logger } from "@vdp/shared";
import { createRandom, HighFidelityVehicle, withoutCauses } from "@vdp/simulators";
import { afterAll, beforeAll, test } from "vitest";
import { scenarioFileById } from "../helpers/scenario-files.js";

const logger: Logger = createLogger("example:scenario", { level: "ERROR" });
// The scenario *file* is the catalog (ADR 0048): the example reads it the way the
// workbench does, and runs it with the seed the file declares.
const file = scenarioFileById("under-voltage-at-start");
const scenario = file.scenario;

function ecuKey(ecu: { definitionEcuId?: string; name: string }): string {
  return ecu.definitionEcuId ?? ecu.name;
}

let vehicle: HighFidelityVehicle;
let engine: DiagnosticEngine;

beforeAll(async () => {
  vehicle = new HighFidelityVehicle({
    logger,
    modelTickMs: 0,
    model: { random: createRandom(4242) },
  });
  await vehicle.start();
  engine = new DiagnosticEngine({
    logger,
    bus: vehicle.testerBus,
    definitions: [highFidelityPackage as DefinitionPackage],
  });
  await engine.connect({ windowMs: 150, probeDelayMs: 0 });
});

afterAll(async () => {
  await engine.disconnect();
  await vehicle.stop();
});

test("1. das Szenario läuft: Ursachen anwenden, Erwartungen treffen (Modellzeit)", async () => {
  const run = await vehicle.runScenario(scenario, { seed: file.determinism.seed });
  assert.equal(run.scenarioId, "under-voltage-at-start");
  // Das Urteil ist Daten — der Test entscheidet, nicht runScenario:
  const failed = run.checks.filter((check) => !check.passed);
  assert.deepEqual(
    failed,
    [],
    `failed checks:\n${failed
      .map((check) => `  ${check.subject}: ${check.expected} vs ${check.actual}`)
      .join("\n")}`,
  );
  assert.equal(run.passed, true);
  assert.ok(run.timeline.length > 0, "the timeline names what happened, in model time");
  // Der Endzustand ist Daten, die man prüfen kann — kein „der Lauf lief gut“:
  assert.equal(run.finalState.engineRunning, true, "the engine caught (condition 3)");
  assert.ok(run.finalState.supplyVoltage > 13, "the alternator carries the load again");
});

test("2. negative Kontrolle: dasselbe Szenario OHNE Ursachen darf nicht bestehen", async () => {
  const control = await vehicle.runScenario(withoutCauses(scenario), {
    seed: file.determinism.seed,
  });
  assert.equal(control.passed, false, "a scenario that passes without its causes measures nothing");
  const failed = control.checks.filter((check) => !check.passed);
  assert.ok(failed.length > 0, "the missing cause must show up as a failed check");
});

test("3. der Draht: ein UDS-Scan liest den Code, WÄHREND die Ursache am Fahrzeug ist", async () => {
  const scanAtActive = await wireScanAtActiveExpectation();
  assert.ok(scanAtActive, "the active expectation exists and was checked on a due moment");
  const bcmCodes = scanAtActive
    .filter((entry) => ecuKey(entry.ecu) === "bcm")
    .flatMap((entry) => entry.dtcs);
  const underVoltage = bcmCodes.find((dtc) => dtc.code === "B1001");
  assert.ok(underVoltage, "the BCM answers 0x19 with B1001 while the sag is on the car");
  assert.equal(
    underVoltage.statusBits.testFailed,
    true,
    "active means the status byte says so — read, not assumed",
  );
});

/**
 * Führt das Szenario und hält, am Moment der `active`-Erwartung für B1001,
 * einen UDS-Scan fest — der zweite, unabhängige Beobachter (ADR 0040).
 */
async function wireScanAtActiveExpectation(): Promise<readonly ScannedEcu[] | undefined> {
  let captured: readonly ScannedEcu[] | undefined;
  await vehicle.runScenario(scenario, {
    seed: file.determinism.seed,
    onMoment: async (moment) => {
      if (captured !== undefined) return;
      const due = moment.due.find(
        (expectation) => expectation.code === "B1001" && expectation.state === "active",
      );
      if (due === undefined) return;
      captured = (await engine.scanDtcs(0xff)).scanned;
    },
  });
  return captured;
}
