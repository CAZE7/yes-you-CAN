/**
 * Ausführbare Dokumentation: die DTC-Analyse (Flow
 * `docs/flows/dtc-analysis.md`).
 *
 * Der Pfad: Ursache am Fahrzeug → Monitor latched → UDS 0x19 antwortet →
 * `EnrichedDtc` (Roh + Variantenwissen) → IR-Form (`DtcState` mit eigener
 * Evidenz je Hälfte) → Evidenz-Items, die zitiert werden können.
 *
 * Die ganze Zeit über den Draht: der Scan liest, was der UDS-Server
 * antwortet — kein Simulator-Feld wird direkt gelesen (ADR 0040).
 */

import assert from "node:assert/strict";
import { DiagnosticEngine, DtcScanner, type EnrichedDtc, type ScannedEcu } from "@vdp/core";
import { type DefinitionPackage, highFidelityPackage } from "@vdp/definitions";
import { describeEvidence, isProven } from "@vdp/diagnostic-ir";
import { type Logger, createLogger } from "@vdp/shared";
import { HighFidelityVehicle, createRandom } from "@vdp/simulators";
import { afterAll, beforeAll, test } from "vitest";

const logger: Logger = createLogger("example:dtc", { level: "ERROR" });

/** Der Key, den Szenarien ein Modul nennen: Definition-Id, nicht die Laufzeit-Id. */
function ecuKey(ecu: { definitionEcuId?: string; name: string }): string {
  return ecu.definitionEcuId ?? ecu.name;
}

const codesOf = (scanned: readonly ScannedEcu[]): string[] =>
  scanned.flatMap((entry) => entry.dtcs.map((dtc) => `${ecuKey(entry.ecu)}:${dtc.code}`));

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

test("1. ohne Ursache scannt man nichts — der leere Scan ist der Befund", async () => {
  const { scanned, unread } = await engine.scanDtcs(0xff);
  assert.deepEqual(codesOf(scanned), []);
  // Die leere Liste ist nur darum ein Befund, weil jedes Modul geantwortet hat
  // (ADR 0049): ohne die zweite Hälfte wäre sie nicht von einem toten Bus zu
  // unterscheiden.
  assert.deepEqual(unread, []);
});

test("2. Ursache anlegen → der Monitor latcht → 0x19 meldet B1001 (aktiv)", async () => {
  vehicle.setIgnition("off");
  vehicle.setBatteryVoltage(11);
  vehicle.setElectricalLoad(25);
  vehicle.advance(600); // Modellzeit, nicht Wanduhr (ADR 0040)

  // Ein Scan hat zwei Hälften (ADR 0049): die gelesenen Codes und die Module, die
  // nicht geantwortet haben. Beides zusammen ist die Aussage — nur die erste Hälfte
  // zu lesen hieße, eine leere Liste für ein fehlerfreies Auto zu halten.
  const { scanned, unread } = await engine.scanDtcs(0xff);
  assert.deepEqual(unread, [], "every module answered, so the list below is complete");
  const bcmCodes = scanned
    .filter((entry) => ecuKey(entry.ecu) === "bcm")
    .flatMap((entry) => entry.dtcs);
  const underVoltage = bcmCodes.find((dtc) => dtc.code === "B1001");
  assert.ok(underVoltage, `read ${codesOf(scanned)}`);
  assert.equal(underVoltage.statusBits.testFailed, true, "active: the byte says so");
  // Das Variantenwissen reist mit dem Code (ADR 0024):
  assert.match(underVoltage.description ?? "", /voltage/i);
});

test("3. IR-Form: DtcState trägt je Hälfte eigene Evidenz (ADR 0037)", async () => {
  const { scanned } = await engine.scanDtcs(0xff);
  const records = scanned.flatMap((entry) => entry.dtcs);
  assert.ok(records.length > 0, "the scan found the fault the cause produced");

  // `observe` ist der Core-Pfad Scan → IR (DtcScan: DtcState + Varianten-Claim):
  const scanner = new DtcScanner({ definitions: [highFidelityPackage] });
  const states = scanner.observe(records.map(toRecord), "Body Control Module", "bcm", {
    oem: highFidelityPackage.oem,
    ecu: "bcm",
  });
  const state = states.find((entry) => entry.state.observation.code === "B1001");
  assert.ok(state, `codes in the IR: ${states.map((entry) => entry.state.observation.code)}`);

  const observation = state!.state.observation;
  // Observation: was das Fahrzeug sagte — mit dem Beleg der Antwort:
  assert.equal(observation.ecuId, "bcm");
  assert.ok(isProven(observation.evidence), "the vehicle's statement is proven");
  assert.equal(observation.evidence.provenance.origin, "ecu-response");

  // Enrichment: was unser Wissen dazu sagt — mit *eigener* Evidenz:
  const enrichment = state!.state.enrichment;
  assert.ok(enrichment, "the package documents this code");
  assert.ok(enrichment && isProven(enrichment.evidence), describeEvidence(enrichment!.evidence));
  assert.ok(enrichment!.description, "the wording is the package's, not a default");
});

test("4. Heilung ist auch eine Ursache — der Code bleibt im Speicher", async () => {
  vehicle.setBatteryVoltage(13.4);
  vehicle.setIgnition("start");
  vehicle.advance(2_500);
  vehicle.setIgnition("on");
  vehicle.advance(1_500);

  const { scanned } = await engine.scanDtcs(0xff);
  const healed = scanned
    .filter((entry) => ecuKey(entry.ecu) === "bcm")
    .flatMap((entry) => entry.dtcs)
    .find((dtc) => dtc.code === "B1001");
  assert.ok(healed, "the code stays in memory after the fault is over");
  assert.equal(
    healed.statusBits.testFailed,
    false,
    "healed: testFailed is out of the byte — stored, not active",
  );
});

/** Eine `EnrichedDtc` zurück in die Protokoll-Record-Form, die `observe` liest. */
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
