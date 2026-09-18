# `@vdp/reports`

**Layer:** presentation · **Pfad:** `packages/reports/` ·
**Regeln-Quelle:** [`architecture/architecture.yaml`](../../architecture/architecture.yaml)

## Purpose

Der Diagnosebericht (AGENTS 21): PDF- und HTML-Sektionen aus dem, was der
Kern produziert hat. Reports liest dafür das **Diagnostic IR direkt** —
eine Sektion, die einen unbelegten Satz zeigen würde, muss die Evidenz-Wörter
des IR verwenden, statt sie neu zu erfinden (ADR 0037).

## Responsibilities

- `report.ts`: `buildReport(ReportInput) → ReportDocument` + Sektionen
  (Fahrzeug, ECUs, Fehlerspeicher, Messwerte, Evidenz),
  `renderHtml(document)`, `renderPdf(document)`
- `pdf.ts`: PDF-Encoder (Strings sind Latin-1 — ein Encoder für Text,
  Länge und Offsets, ADR 0021)

## Does NOT do

- keinen Fahrzeug-Zugriff, kein Transport, kein Runtime
- keine Evidenz-Neuerfindung: Unproven wird mit dem *IR-Grund* angezeigt,
  nicht umformuliert (ADR 0033/0037)
- keine Chart-Logik (das ist `@vdp/charts`), keine UI (das ist `@vdp/web`)

## Public API

`src/index.ts`: `report.ts` (`buildReport`, `renderHtml`, `renderPdf`,
`ReportInput`, `ReportDocument`, …), `pdf.ts` komplett.

## Dependencies

`@vdp/core` (Session-Formen), `@vdp/diagnostic-ir` (Evidenz-Wörter).

## Data Flow

```text
VehicleSessionData + EvidenceSet (IR)
  → reports: Sektionen (Evidenz wird zitiert, nicht umformuliert)
  → pdf.ts (Latin-1-Encoder) → PDF-Bytes
```

## Important invariants

- **Evidenz aus dem IR** (ADR 0037) — eine zweite Kopie der Belege ist ein
  Defekt.
- **PDF-Strings sind Latin-1** (ADR 0021) — der Encoder ist die eine Stelle
  für Text/Länge/Offsets.
- **Getestet:** `src/*.spec.ts` (Gate 95/82).

## Tests

Co-lokatierte `src/*.spec.ts` (Projekt `unit`).

## Examples

```ts
import { buildReport, renderPdf } from "@vdp/reports";

const document = buildReport(reportInput); // Session + Evidenz (IR) → Sektionen
const pdfBytes = renderPdf(document); // → Uint8Array
```
