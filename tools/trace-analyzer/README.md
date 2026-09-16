# `@vdp/trace-analyzer`

**Layer:** tool · **Pfad:** `tools/trace-analyzer/` ·
**Regeln-Quelle:** [`architecture/architecture.yaml`](../../architecture/architecture.yaml)

## Purpose

Offline-Trace-Analyse (AGENTS 15/21): ein aufgezeichneter CAN-Trace (NDJSON
oder candump) wird mit der **Protokoll-Schicht** dekodiert — ohne den Core,
ohne ein Fahrzeug. Für die Fallanalyse und das Protokoll-Debugging, wenn
nur der Trace vorliegt.

## Responsibilities

- `parseTrace`/`parseTraceLine`: NDJSON/candump → `TraceEntry[]`
- `decodeUdsRequest`/`decodeUdsResponse`: UDS-Payloads dekodiert
  (über `@vdp/protocols-uds` — keine zweite Dekodierung)
- `rebuildIsoTpMessages`: ISO-TP-Segmente zu Nachrichten zusammengesetzt
- `derivePairs`/`decodeMessages`: Request/Response-Paare
- `summarizeIdentifiers`/`indexEcuAddresses`: Id-Zusammenfassung gegen
  Definitionen
- `analyzeTrace` → `TraceAnalysis` + `formatTraceReport` (Text-Report)

## Does NOT do

- keinen Core-Import (dekodiert mit der Protokoll-Schicht)
- kein Fahrzeug-Zugriff: der Trace ist der Input
- keine Schicht: nichts importiert `@vdp/trace-analyzer`
- keine Neuinterpretation: „Raw bleibt raw“ — dekodierter Wert immer neben
  den Bytes (AGENTS 0.D)

## Public API

`src/index.ts`: `analyzeTrace`, `parseTrace`, `decodeUdsResponse`,
`rebuildIsoTpMessages`, `formatTraceReport`, `TraceAnalysis` o. A.

## Dependencies

`shared`, `definitions`, `protocols-uds`, `transport-can` (siehe
`architecture.yaml`).

## Data Flow

```text
Trace (NDJSON/candump) → parseTrace → Frames
  → decodeUdsRequest/Response (protocols-uds) + indexEcuAddresses (definitions)
  → analyzeTrace → TraceAnalysis → formatTraceReport (Text)
```

## Important invariants

- **Ohne Core** (Regel in `architecture.yaml`) — die Protokoll-Schicht ist
  die gemeinsame Dekodierungs-Quelle.
- **Roh bleibt roh** (ADR 0004) — der dekodierte Wert steht neben den Bytes.

## Tests

Co-lokatierte `src/*.spec.ts` (Projekt `unit`; `tools/**` ohne per-file-
Gate — siehe `vitest.config.ts`).

## Examples

```ts
import { analyzeTrace, formatTraceReport, parseTrace } from "@vdp/trace-analyzer";

const entries = parseTrace(traceContent); // NDJSON
const analysis = analyzeTrace(entries, { pkg: genericPackage });
const report = formatTraceReport(analysis);
```
