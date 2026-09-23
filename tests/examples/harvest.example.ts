/**
 * Ausführbare Dokumentation: die Ernte (Flow `docs/flows/harvest.md`, ADR 0058).
 *
 * Der Pfad: Plan (Daten) → Discovery → sichere Dienstsonden → Identifikation →
 * DID-Sweep → Fehlerspeicher mit Verfügbarkeitsmaske → **eine** Beobachtung
 * (`HarvestReport`) → drei Projektionen (Datensatz, ODX-D/PDX, Definitions-Kandidat)
 * → Gegenprüfung gegen eine zweite Implementierung.
 *
 * Gezeigt am virtuellen Fahrzeug, weil eine Ernte sonst nichts zum Auslesen hätte
 * (ADR 0005): dieselbe Bibliothek, derselbe Bus-Vertrag, dieselben Artefakte wie am
 * realen Adapter.
 */

import assert from "node:assert/strict";
import { genericPackage, validateDefinitionPackage } from "@vdp/definitions";
import {
  definitionCandidate,
  describeHarvestPlan,
  expectationsOf,
  findWriteRequests,
  type HarvestReport,
  harvestServiceIds,
  harvestVehicle,
  renderOdxHarvest,
  resolveHarvestPlan,
  summariseHarvest,
  verifyOdxDocument,
} from "@vdp/harvest";
import { SID } from "@vdp/protocols-uds";
import { createLogger, type Logger } from "@vdp/shared";
import { VirtualVehicle } from "@vdp/simulators";
import { afterAll, beforeAll, test } from "vitest";

const logger: Logger = createLogger("example:harvest", { level: "ERROR" });

let vehicle: VirtualVehicle;
let report: HarvestReport;

beforeAll(async () => {
  vehicle = new VirtualVehicle({
    logger,
    definitions: genericPackage,
    seed: 4242,
    dtcs: {
      engine: [{ code: "P0420", status: 0x2f, snapshot: new Uint8Array([0x09, 0x46, 0x00, 0x32]) }],
    },
  });
  await vehicle.start();

  report = await harvestVehicle({
    bus: vehicle.testerBus,
    definitions: [genericPackage],
    logger,
    identity: { source: "example:simulator", platformVersion: "0.1.0", operator: "Doku-Beispiel" },
    // Ein Plan ist Daten: schmalere Bereiche und kein Abstand halten das Beispiel schnell.
    plan: {
      requestGapMs: 0,
      windowMs: 60,
      didRanges: [{ name: "identification", from: 0xf180, to: 0xf19f, reason: "Beispiel" }],
    },
    timestamp: () => "2026-09-23T10:00:00.000Z",
    now: () => 1_000,
  });
});

afterAll(async () => {
  await vehicle.stop();
});

test("der Plan steht vor dem Lauf — und ist read-only", () => {
  const plan = resolveHarvestPlan();
  const text = describeHarvestPlan(plan);
  assert.match(text, /identification 0xf180–0xf1ff/);
  assert.match(text, /Schreib-Unterstützung sondieren: nein/);

  // Die eine Regel, die ein Leser prüfen können muss: kein Schreibdienst im Plan.
  assert.deepEqual(findWriteRequests(harvestServiceIds()), []);
  assert.equal(harvestServiceIds().includes(SID.WRITE_DATA_BY_IDENTIFIER), false);
  assert.equal(harvestServiceIds().includes(SID.CLEAR_DIAGNOSTIC_INFORMATION), false);
});

test("eine Ernte liest Adressen, Dienste, DIDs und den Fehlerspeicher", () => {
  assert.equal(report.kind, "vdp.harvest");
  assert.ok(report.ecus.length >= 3, `${report.ecus.length} ECUs`);

  const engine = report.ecus.find((ecu) => ecu.rxId === 0x7e8);
  assert.ok(engine);
  assert.equal(engine.definitionEcuId, "engine", "Discovery hat das Paket erkannt");
  assert.ok(engine.supportedServices.includes(SID.READ_DATA_BY_IDENTIFIER));

  // Ein Wert: Rohbytes, Länge, ASCII-Hinweis — und woher die Frage kam.
  const vin = engine.dids.find((did) => did.did === 0xf190);
  assert.ok(vin);
  assert.equal(vin.byteLength, 17);
  assert.equal(vin.origin, "standard");
  assert.match(vin.asciiHint ?? "", /^[A-HJ-NPR-Z0-9]{17}$/, "Hinweis, keine Dekodierung");
});

test("beide Hälften eines Laufs sind Daten: Antworten und Verweigerungen", () => {
  const engine = report.ecus.find((ecu) => ecu.rxId === 0x7e8);
  assert.ok(engine);

  // Verweigerte DIDs stehen gruppiert da, nicht als 100 einzelne Einträge.
  const refusals = engine.didRefusals.find((group) => group.origin === "identification");
  assert.ok(refusals);
  assert.equal(refusals.nrc, 0x31, "requestOutOfRange — die normale Antwort eines Sweeps");
  assert.ok(refusals.count > 0);

  // Dienste, die nie gesendet werden, erscheinen als not-probed mit Grund.
  const neverSent = engine.serviceProbes.filter((probe) => probe.outcome === "not-probed");
  assert.ok(neverSent.some((probe) => probe.service === SID.CLEAR_DIAGNOSTIC_INFORMATION));
  assert.match(neverSent[0]?.detail ?? "", /never sent|opt-in|no safe probe/);

  // Und der Lauf sagt, was er nicht getan hat.
  assert.ok(report.notes.some((note) => note.includes("Default-Sitzung")));
  assert.match(summariseHarvest(report), /ECU\(s\) gelesen/);
});

test("der Fehlerspeicher trägt die Maske, die seinen Status lesbar macht", () => {
  const engine = report.ecus.find((ecu) => ecu.rxId === 0x7e8);
  assert.ok(engine);
  const catalyst = engine.dtcs.find((dtc) => dtc.code === "P0420");
  assert.ok(catalyst);

  assert.equal(catalyst.statusBits.testFailed, true);
  assert.equal(catalyst.severity, "critical");
  assert.equal(
    catalyst.availabilityMask,
    0xff,
    "ISO 14229-1 §11.3.4.2: welche Statusbits dieses ECU überhaupt setzt",
  );
  assert.equal(engine.dtcAvailabilityMask, 0xff);
  assert.ok((catalyst.snapshots?.length ?? 0) >= 1, "der Freeze Frame ist gelesen, roh");
});

test("die VIN ist maskiert, solange niemand --keep-vin verlangt", () => {
  assert.equal(report.identity.vinRedacted, true);
  assert.match(report.identity.vin ?? "", /^1HG\*+4352$/);
  assert.ok(report.notes.some((note) => note.includes("maskiert")));
});

test("aus einer Beobachtung wird eine ODX-Beschreibung — byte-exakt", () => {
  const odx = renderOdxHarvest(report);
  assert.match(odx, /<ODX MODEL-VERSION="2\.2\.0"/);
  assert.match(odx, /SI="provenance">observed</);
  assert.match(odx, /<BASE-VARIANT ID="[^"]+\.ecu-7e8">/);
  assert.match(odx, /<TROUBLE-CODE>270336<\/TROUBLE-CODE>/, "P0420-00 als 24-Bit-Zahl");

  // Die Rundläufe, die das Dokument verspricht — als Daten, damit eine zweite
  // Implementierung sie prüfen kann (odx/verify.ts, `--verify-odx`).
  const expectations = expectationsOf(report);
  assert.ok(expectations.length > 0);
  const vinTrip = expectations.find((entry) => entry.service === "read_did_F190");
  assert.ok(vinTrip);
  assert.equal(vinTrip.requestHex, "22F190");
  assert.equal(vinTrip.responseHex.slice(0, 6), "62F190");

  const verification = verifyOdxDocument(odx, { expectations });
  assert.ok(
    verification.state === "verified" || verification.state === "not-run",
    verification.reason ?? "",
  );
  if (verification.state === "not-run") {
    // Ehrlich: ohne installiertes odxtools ist die Prüfung nicht gelaufen, nicht bestanden.
    assert.match(verification.reason ?? "", /not importable|not usable|no Python/);
  }
});

test("aus derselben Beobachtung wird ein Definitions-Kandidat mit observed-Provenance", () => {
  const candidate = definitionCandidate(report, { oem: "harvest-example" });
  const validation = validateDefinitionPackage(candidate.pkg);
  assert.deepEqual(validation.errors, [], validation.errors.join("\n"));

  assert.equal(candidate.pkg.provenance.sourceType, "observed");
  assert.equal(candidate.pkg.provenance.retrievedAt, "2026-09-23");

  const engine = candidate.pkg.ecus.find((ecu) => ecu.id === "engine");
  assert.ok(engine);
  assert.equal(engine.provenance?.sourceType, "observed");

  // Ein Signal existiert nur, wo eine Länge eine dokumentierte Kodierung hat.
  const vinSignal = candidate.pkg.signals.find((signal) => signal.did === 0xf190);
  assert.ok(vinSignal);
  assert.equal(vinSignal.encoding, "ascii");
  assert.equal(vinSignal.provenance?.sourceType, "observed");

  // Eine DTC-Beschreibung sagt „gemeldet", nie „bedeutet".
  const dtc = engine.dtcs?.find((entry) => entry.code === "P0420");
  assert.ok(dtc);
  assert.match(dtc.description, /Bedeutung nicht dokumentiert/);
  // Die Recordnummer ist die, die das Steuergerät zurückspiegelt — 0xff heißt
  // „alle Aufzeichnungen", die Nummer selbst ist dann unbeobachtet (ehrlich bleibt
  // sie trotzdem: #255 ist die Antwort, nicht eine erfundene 1).
  assert.match(dtc.description, /Freeze Frames: #\d+ 09460032/);

  // Und was nicht übernommen wurde, steht mit Grund da — nicht stillschweigend.
  for (const skipped of candidate.skipped) {
    assert.ok(skipped.reason.length > 10, skipped.item);
  }
});
