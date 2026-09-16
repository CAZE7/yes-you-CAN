# `@vdp/protocols-oem`

**Layer:** protocol · **Pfad:** `packages/protocols/oem/` ·
**Regeln-Quelle:** [`architecture/architecture.yaml`](../../../architecture/architecture.yaml)

## Purpose

Hersteller-Hooks: der offizielle Ort für OEM-spezifische Abweichungen, die
**keine Daten** sind (z. B. proprietäre Service-Sequenzen). Füllt Lücken,
auf die Standard-UDS + Definition-Pakete keine Antwort haben — und
importiert deshalb nichts.

## Responsibilities

- Hook-Typen + `OemProtocolRegistry`: OEM-Protokolle registrieren, der Core
  fragt sie *nur dort* konsultieren, wo Definitionen schweigen. Drei Hooks:
  Address→Role-Mapping (Discovery), Identifikations-DIDs (ECU Explorer),
  DTC-Interpretation
- Provenance-Pflicht für jedes `OemProtocol` (`provenance.sourceType/source`)

## Does NOT do

- keine Standard-UDS-Logik (die ist in `@vdp/protocols-uds`)
- keine Daten: OEM-Wissen (DIDs, Signale, DTCs) ist Sache der
  Definition-Pakete (ADR 0003) — kein „Wissen“ in Hooks
- keine I/O, keine `node:`-Builtins, **keine Abhängigkeiten**

## Public API

`src/index.ts`: `OemProtocol`, `OemIdentificationHint`,
`OemDtcInterpretation`, `OemProtocolRegistry` (+ `vagExampleProtocol` als
Referenzbeispiel).

## Dependencies

Keine. (`mayImport: []` — Hooks dürfen nur über injizierte Primitiven sprechen.)

## Data Flow

```text
Core (Diagnostics)  →  oemProtocols-Option  →  Hook-Registry
Definitionen schweigen? → Hook konsultieren → (Antwort oder „nicht zuständig“)
```

## Important invariants

- **Nur dort, wo Definitionen schweigen** (Regel in `architecture.yaml`) —
  ein Hook, der Standard-Verhalten überschreibt, ist ein Defekt.
- **Provenance-Pflicht**: ein Hook ohne Quelle scheitert an Review
  (AGENTS 24/27: keine ungeklärten Fremddaten).
- **Dependency-frei** (ADR 0002).

## Tests

Co-lokatierte `src/*.spec.ts` + `tests/integration/oem-hooks.test.ts`.

## Examples

```ts
import { OemProtocolRegistry, type OemProtocol } from "@vdp/protocols-oem";

const registry = new OemProtocolRegistry([myOemProtocol]);
// Runtime: createDiagnosticRuntime({ ..., oemProtocols: registry })
```
