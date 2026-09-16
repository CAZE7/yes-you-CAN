# `@vdp/charts`

**Layer:** foundation · **Pfad:** `packages/charts/` ·
**Regeln-Quelle:** [`architecture/architecture.yaml`](../../architecture/architecture.yaml)

## Purpose

DOM-freier Chart-Kern (ADR 0011): Daten → gezeichnete Darstellung, komplett
getestet, ohne ein DOM-Buchstabenpaar. Das Frontend (`apps/web/public/`)
zeichnet die Ausgabe; dieser Kern *entscheidet*, was gezeichnet wird.

## Responsibilities

- Skalierung: lineare/logarithmische Achsen (`scale.ts`)
- Decimation: Zeitfenster → zeichbare Punktliste (`decimate.ts`)
- Gruppierung mehrerer Signale (`group.ts`)
- Viewport-Berechnung (`viewport.ts`)
- Serien- und Typdefinitionen (`series.ts`, `types.ts`)

## Does NOT do

- kein DOM, kein Canvas, kein SVG-Rendering (das ist Frontend-Jobs)
- keine Abhängigkeiten, keine I/O, keine Zeit
- keine Diagnose-Logik: der Kern nimmt Punkte, nicht Sessions

## Public API

`src/index.ts`: `scale.ts`, `decimate.ts`, `group.ts`, `series.ts`,
`viewport.ts`, `types.ts` komplett.

## Dependencies

Keine.

## Data Flow

```text
Messwerte (domain MeasurementReading / IR SignalReading)
  → Frontend (apps/web/public) → @vdp/charts (Berechnung) → Canvas-Zeichnung
```

## Important invariants

- **DOM-frei** (ADR 0011) — der Kern läuft in Node-Tests ohne Browser.
- **Dependency-frei** (ADR 0002) — `mayImport: []`.
- **Getestet:** der Kern trägt seine eigene Suite (per-file-Gate 95/80).

## Tests

Co-lokatierte `src/*.spec.ts` (Projekt `unit`, per-file-Gate 90/75).

## Examples

```ts
import { linearScale, decimate } from "@vdp/charts";

const scale = linearScale({ domain: [0, 4000], range: [0, 600] });
const points = decimate(samples, { viewport: { x0: 0, x1: 600 }, maxPoints: 300 });
```
