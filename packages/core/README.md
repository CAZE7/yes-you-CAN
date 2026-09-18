# `@vdp/core`

**Layer:** core · **Pfad:** `packages/core/` ·
**Regeln-Quelle:** [`architecture/architecture.yaml`](../../architecture/architecture.yaml)

## Purpose

Der Diagnosekern: `DiagnosticEngine` + die Subsysteme, die eine Session
laufen lassen — Discovery, UDS-Orchestrierung über die Link-Factory,
DTC-Scan/Tracking, Messwert-Engine, **WritePort** + Safety, Session-Logger,
Evidenz-Sammlung in IR-Form. Die breiteste Schicht *unter* dem Runtime.

## Responsibilities

- `session/`: `VehicleSessionData` (Schema v1), `VehicleSession`,
  `createSession`, `observation.ts` → IR-Beobachtungen
- `diagnostics/`: `DiagnosticEngine`, Discovery mit Zeitbudget (ADR 0019),
  ECU-Registry, Session-Opener
- `dtc/`: `DtcScanner` (Scan + Varianten-Kontext), `DtcTracker`
  (firstSeen/lastSeen), `freeze-frame.ts`, `clear.ts`
- `measurements/`: Decoder/Encoder, `MeasurementRecorder`, `live.ts`
  (Polling-Loop), Statistik, Signal-Analyse-Grundlagen
- `writes/`: `WritePort` + `WriteOperation`-Vertrag (ADR 0032),
  `dtc-clear.ts`, `coding.ts`, `adaptation.ts`, `transaction.ts`
- `evidence/`: `collectEvidence` → `EvidenceSet` (ADR 0038),
  `hypotheses.ts` (Ranking-Heuristik), `guided-diagnosis.ts`
- `vehicle/`: VIN-Analyse (`analyseVin`), Identität
- `safety/`: `SafetyManager` (bewertet Write-Kontexte, erteilt Permits)
- `logging/`: `SessionLogger` (Roh-Trace + Session-Daten), `integrity.ts`
  (Roh-Trace-Manifest: SHA-256 über den kanonischen Rahmenstrom, ADR 0044)

## Does NOT do

- kein HTTP, kein DOM, keine UI-Kenntnis (headless; Web/CLI komponieren
  darüber — ADR 0014)
- keine Persistenz-Dateizugriffe (`@vdp/storage` ist die Speicher-Schicht)
- keine Report-/AI-Logik: der Core *produziert* Daten, *interpretiert* sie
  Reports/Provider
- keine neue Evidenz-Vokabel: IR-Formen kommen aus `@vdp/diagnostic-ir`

## Public API

`src/index.ts` (bewusst breit, da Kompositionspunkt — die kuratierte
„vordere Tür“ ist der Runtime): `DiagnosticEngine`, `DtcScanner`,
`collectEvidence`, `createWritePort`, `VehicleSession` o. Ä.

## Dependencies

`shared`, `diagnostic-ir`, `definitions`, `protocols-uds`, `protocols-oem`,
`transport-can`, `transport-iso-tp` (siehe `architecture.yaml`).

## Data Flow

```text
Bus (CanBus) → IsoTpConnection → UdsClient → Discovery/Session
  → DtcScanner (Roh) → dtcObservationOf (IR) + Enrichment (definitions)
  → MeasurementRecorder → SignalReading (IR)
  → collectEvidence → EvidenceSet
  → WritePort (gestuft, mit SafetyManager-Permit)
```

## Important invariants

- **Roh + dekodiert getrennt** (ADR 0004) — überall.
- **Evidenz wird hier gebaut** (ADR 0033/0038) — die Projektion in
  Domain-Views passiert im Runtime.
- **Writes nur als `WriteOperation` hinter `WritePort`** (ADR 0032).
- **Engine = internes Detail des Runtime** (ADR 0014): nichts außerhalb
  des Runtime greift direkt in `DiagnosticEngine` (Workbench nutzt
  `createDiagnosticRuntime`).
- **Kein `node:`-Builtin** — der Core läuft auch im Worker und in der Vorschau;
  Digest, Uhr und Zufal kommen aus `@vdp/shared` oder von einer injizierten Naht
  (`architecture.yaml` → `rules.nodeBuiltins`, ADR 0044).
- **per-file-Coverage 88/80** — neue Dateien kommen mit Tests.

## Tests

Co-lokatierte `src/**/*.spec.ts` (Projekt `unit`) + `tests/protocol/`
(Konformanz), `tests/replay/` (Fixture), `tests/regression/`
(Error-Injection), `tests/integration/` (Ketten).

## Examples

Ausführbar: [`tests/examples/diagnostic-read.example.ts`](../../tests/examples/diagnostic-read.example.ts)
(Engine-Direktweg) und
[`tests/examples/dtc-analysis.example.ts`](../../tests/examples/dtc-analysis.example.ts)
(Scan → IR → Evidenz).
