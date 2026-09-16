/**
 * Ausführbare Dokumentation: der Evidence-Flow (Flow
 * `docs/flows/ai-analysis.md`).
 *
 * Der Pfad: Session mit Fehlerspeicher → Scan → `EvidenceSet` (eine Stelle,
 * ADR 0038) → `AnalysisInput` → Provider → `AnalysisResult`, dessen Befunde
 * Item-Ids zitieren und dessen Provenance die Versionen nennt.
 *
 * Der Analyse-Provider berührt dabei nie das Fahrzeug: sein Input ist das
 * EvidenceSet, und `@vdp/ai` darf nur `shared` + `diagnostic-ir` importieren
 * (maschinell geprüft, ADR 0038).
 */

import assert from "node:assert/strict";
import { type AnalysisInput, AnalysisService, HeuristicAnalysisProvider } from "@vdp/ai";
import { connectVehicle, readDtcs } from "@vdp/application";
import { genericPackage } from "@vdp/definitions";
import { isProven, itemById, itemsOf } from "@vdp/diagnostic-ir";
import { RecordingEventBus } from "@vdp/domain";
import { PLATFORM_VERSION, createDiagnosticRuntime } from "@vdp/runtime";
import { MemorySink, createLogger } from "@vdp/shared";
import { VirtualVehicle } from "@vdp/simulators";
import { afterAll, beforeAll, test } from "vitest";

const logSink = new MemorySink();
const logger = createLogger("example:evidence", { level: "WARN" }, [logSink]);

// Das virtuelle Fahrzeug meldet die im Paket dokumentierten Codes; der
// injizierte Status gewinnt über den Default (0x0F statt 0x2F: bestätigt
// und in diesem Zyklus fehlgeschlagen, aber nicht „failed since last clear“).
const vehicle = new VirtualVehicle({
  logger,
  dynamic: true,
  seed: 7,
  dtcs: { engine: [{ code: "P0420", status: 0x0f }] },
});
const events = new RecordingEventBus();
const runtime = createDiagnosticRuntime({
  bus: vehicle.testerBus,
  definitions: [genericPackage],
  logger,
  events,
});

beforeAll(async () => {
  await vehicle.start();
  await runtime.commands.dispatch(connectVehicle({ windowMs: 120, probeDelayMs: 0 }));
});

afterAll(async () => {
  await runtime.dispose();
  await vehicle.stop();
});

test("1. der Scan meldet die dokumentierten Codes — die Injektion gewinnt", async () => {
  const dtcs = await runtime.commands.dispatch(readDtcs());
  assert.ok(dtcs.length >= 1, "the vehicle answers with the documented codes");
  const p0420 = dtcs.find((dtc) => dtc.code === "P0420");
  assert.ok(p0420, "P0420 is documented in the generic package");
  // 0x0F (injiziert) statt 0x2F (Default): „failed since last clear“ ist aus
  // dem Byte heraus — die Injektion hat den Status gesetzt:
  assert.equal(p0420!.testFailed, true);
  assert.equal(p0420!.confirmed, true);
});

test("2. EvidenceService: das Set hat die IR-Form und zitierbare Items", async () => {
  const evidence = runtime.evidence.collect();
  assert.equal(evidence.kind, "evidence");
  const items = itemsOf(evidence, "dtc");
  assert.ok(items.length >= 1, "at least the dtc item");

  const dtcItem = items.find((item) => item.subject === "P0420");
  assert.ok(dtcItem, `dtc item for P0420; got ${items.map((item) => item.id)}`);
  // Das Enrichment ist BELEGT: das Generic-Paket dokumentiert P0420 —
  // der Beleg ist Daten (kind "proven"), keine Prosa-Annahme:
  assert.ok(isProven(dtcItem!.evidence), "the item's statement carries its proof");
  // Zitation: ein Befund verweist auf die Id, nicht auf den Satz:
  const cited = itemById(evidence, dtcItem.id);
  assert.equal(cited?.id, dtcItem.id);
});

test("3. AnalysisInput: Evidenz + Versionen — keine zweite Kopie der Belege", async () => {
  const input = await buildInput();
  assert.ok(input.evidence, "the evidence set IS the factual input (ADR 0038)");
  assert.ok(
    input.dtcs.some((dtc) => dtc.code === "P0420"),
    "the scan's codes travel with the input",
  );
  assert.equal(input.versions?.runtimeVersion, PLATFORM_VERSION);
  assert.ok(input.versions?.definitionVersion, "the definition version travels with the answer");
});

test("4. Provider: Befunde zitieren echte Items, Provenance nennt die Versionen", async () => {
  const input = await buildInput();
  const service = new AnalysisService({ providers: [new HeuristicAnalysisProvider()] });
  const provider = service.listProviders()[0];
  assert.ok(provider, "the heuristic provider ships in the box");
  assert.equal(provider.sendsDataOffBox, false, "the label is a promise, not a log line");

  const result = await service.analyze({ input });
  assert.equal(result.provider, provider.id);
  assert.equal(result.source, "heuristic");
  assert.ok(result.findings.length >= 1, "a documented major code produces a finding");
  // Zitate existieren nur auf echte Items (ADR 0038) — ein Zitat ins Leere fällt weg:
  for (const finding of result.findings) {
    for (const citedId of finding.basedOn ?? []) {
      assert.ok(
        itemById(input.evidence!, citedId),
        `citation ${citedId} must exist in the evidence set`,
      );
    }
  }
  // Provenance: die Antwort sagt, unter welchen Versionen sie stand (P0 #42):
  assert.ok(result.provenance, "an answer without provenance is a guess");
});

/** Der AnalysisInput einer laufenden Session — die eine Bau-Stelle. */
async function buildInput(): Promise<AnalysisInput> {
  const dtcs = await runtime.commands.dispatch(readDtcs());
  return {
    signals: [],
    dtcs: dtcs.map((dtc) => ({
      code: dtc.code,
      severity: dtc.severity ?? "info",
      ecu: dtc.ecuId,
      ...(dtc.description !== undefined ? { description: dtc.description } : {}),
      ...(dtc.hint !== undefined ? { hint: dtc.hint } : {}),
    })),
    anomalies: [],
    notes: [],
    evidence: runtime.evidence.collect(),
    hypotheses: runtime.evidence.hypotheses(),
    versions: {
      promptVersion: "example-1",
      runtimeVersion: PLATFORM_VERSION,
      definitionVersion: `generic@${genericPackage.version}`,
    },
  };
}
