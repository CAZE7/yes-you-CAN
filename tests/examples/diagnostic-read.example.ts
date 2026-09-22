/**
 * Ausführbare Dokumentation: der diagnostische Lesevorgang (Flow
 * `docs/flows/diagnostic-read.md`).
 *
 * Das zeigt, *so* wird die Plattform gelesen: ein Client spricht über die
 * Application-API (Commands/Queries + Command Bus) mit dem Runtime, der
 * Vehicle → UDS → ISO-TP → (virtuellen) Bus führt. Roh und dekodiert bleiben
 * dabei nebeneinander (ADR 0004), und das Ergebnis trägt Evidenz.
 *
 * Läuft im Projekt `integration` (keine Hardware, deterministisch).
 */

import assert from "node:assert/strict";
import {
  connectVehicle,
  disconnectVehicle,
  getEcuList,
  readDid,
  readDtcs,
  snapshotSignals,
} from "@vdp/application";
import { genericPackage } from "@vdp/definitions";
import { itemsOf } from "@vdp/diagnostic-ir";
import { RecordingEventBus } from "@vdp/domain";
import { createDiagnosticRuntime } from "@vdp/runtime";
import { createLogger, MemorySink } from "@vdp/shared";
import { VirtualVehicle } from "@vdp/simulators";
import { afterAll, beforeAll, test } from "vitest";

const logSink = new MemorySink();
const logger = createLogger("example:read", { level: "WARN" }, [logSink]);
const vehicle = new VirtualVehicle({ logger, dynamic: true, seed: 42 });
const events = new RecordingEventBus();
const runtime = createDiagnosticRuntime({
  bus: vehicle.testerBus,
  definitions: [genericPackage],
  logger,
  events,
});

beforeAll(async () => {
  await vehicle.start();
});

afterAll(async () => {
  await runtime.dispose();
  await vehicle.stop();
});

test("1. verbinden: Command Bus → Runtime → Discovery (explizites Zeitbudget)", async () => {
  const result = await runtime.commands.dispatch(
    connectVehicle({ windowMs: 120, probeDelayMs: 0 }),
  );
  assert.ok(result.session.sessionId.length > 0);
  assert.ok(result.ecus.length >= 3, `expected at least 3 ECUs, got ${result.ecus.length}`);
  // Die Identität ist ein Beleg (ADR 0023): VIN über 0xF190, nicht geraten.
  assert.ok(result.vehicle?.vin);
  assert.ok(events.ofType("vehicle-connected").length === 1);
});

test("2. DID lesen: 0xF190 (VIN) — Rohbytes und Hex reisen zusammen", async () => {
  const ecus = await runtime.commands.query(getEcuList());
  const engineEcu = ecus.find((ecu) => ecu.rxId === 0x7e8);
  assert.ok(engineEcu, "the engine ECU answers on 0x7E8");

  const vin = await runtime.commands.dispatch(readDid(engineEcu.ecuId, 0xf190));
  assert.equal(vin.byteLength, 17);
  assert.match(vin.hex, /^[0-9A-F ]+$/, "raw bytes travel as hex next to the bytes");
  // Und der Schritt ist im Audit (AGENTS 10):
  assert.ok(events.ofType("did-read").length >= 1);
});

test("3. Signale messen: dekodierter Wert neben rawHex (ADR 0004)", async () => {
  const readings = await runtime.commands.dispatch(
    snapshotSignals(["engine.rpm", "engine.coolant_temperature"]),
  );
  assert.ok(readings.length >= 2);
  const rpm = readings.find((reading) => reading.signalId === "engine.rpm");
  assert.ok(rpm);
  assert.equal(rpm.unit, "rpm");
  assert.ok((rpm.value as number) > 0, "the decoded value is a number");
  assert.ok(rpm.rawHex.length > 0, "the raw bytes stay visible next to the value");
});

test("4. Fehlerspeicher lesen: das Fahrzeug meldet, was das Paket dokumentiert", async () => {
  const dtcs = await runtime.commands.dispatch(readDtcs());
  // Das virtuelle Fahrzeug antwortet wie ein echtes ECU-Stack: die im
  // Definition-Paket dokumentierten Codes sind gespeichert (erste je ECU
  // aktiv 0x2F, die übrigen bestätigt 0x08).
  assert.ok(dtcs.length >= 1, "the virtual vehicle answers with documented codes");
  const p0420 = dtcs.find((dtc) => dtc.code === "P0420");
  assert.ok(p0420, "P0420 is documented in the generic package");
  // Der Status-Byte ist Daten: die Zerlegung reist mit dem Code (ADR 0020):
  assert.equal(p0420!.testFailed, true, "0x2F is an active fault — the byte says so");
  // Und das Variantenwissen reist mit — keine nackte Zahl (ADR 0024):
  assert.ok(p0420!.description, "the wording is the package's, not a default");
  // (Die Freeze-Frame ist ein eigener Schritt: 0x19 0x04, nicht Teil des
  // 0x19 0x02-Scans — see docs/flows/diagnostic-read.md.)
});

test("5. Evidenz: das Set hat die IR-Form, Items sind zitierbar", async () => {
  const evidence = runtime.evidence.collect();
  assert.equal(evidence.kind, "evidence");
  assert.ok(evidence.sessionId.length > 0);
  // Jedes Item hat eine stabile, zitierbare Id — eine Analyse zitiert Ids,
  // keine Sätze (ADR 0038):
  for (const item of evidence.items) {
    assert.ok(item.id.length > 0, "every item has a stable, citable id");
  }
  // itemsOf filtert nach der Art der Aussage (hier: keine DTCs, weil none):
  assert.ok(Array.isArray(itemsOf(evidence, "dtc")));
});

test("6. trennen: die Session wird über den Command Bus geschlossen", async () => {
  await runtime.commands.dispatch(disconnectVehicle());
  await runtime.dispose();
  // dispose() ist idempotent — afterAll ruft sie erneut:
  await runtime.dispose();
});
