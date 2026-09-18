# `@vdp/diagnostic-ir`

**Layer:** contract · **Pfad:** `packages/diagnostic-ir/` ·
**Regeln-Quelle:** [`architecture/architecture.yaml`](../../architecture/architecture.yaml)

## Purpose

Die diagnostische Zwischenrepräsentation (ADR 0034/0037): Beobachtungen mit
Beleg zwischen der Roh-Protokoll-Form und allen Projektionen (Domain-Views,
Reports, AI). Sie ist die stabile Mitte — deshalb kennt sie **kein**
Protokoll, **keinen** Transport, **keine** I/O.

## Responsibilities

- DTC-Beobachtungen: `DtcObservation` (Fahrzeug) getrennt von
  `DtcEnrichment` (unser Wissen), zusammen in `DtcState`
- Signal-Beobachtungen: `SignalReading` (raw + value), `SignalGap`
  („kein Wert“ ≠ „nicht beobachtet“)
- Session/ECU-Beobachtungen: `SessionObservation`, `EcuObservation`
- Evidenz-Formen: `EvidenceItem`, `EvidenceSet`, `EvidenceConflict`,
  `Evidence` (`proven`/`unproven`) mit `Provenance`
- Hypothesen-Formen: `Hypothesis`, `HypothesisCheck`, `HypothesisTest`,
  `DiscriminatingTest`, `GuidedDiagnosisState`
- Zeitfenster: `MeasurementWindow`, `summariseWindow()`

## Does NOT do

- keinen CAN-Zugriff, keine UDS-Requests, keine I/O, keine `node:`-Builtins
- kein Deuten: kein „was die Kombination bedeutet“ (das ist Evidence/Hypothesis-
  *Logik* in `@vdp/core`), hier stehen nur die Formen
- keine Reparaturanweisungen („repair“ ist das Wort des Pakets, nicht unseres)
- keine numerische Konfidenz, die der Input nicht trägt

## Public API

Komplett dokumentiert in [`docs/api/diagnostic-ir.md`](../../docs/api/diagnostic-ir.md)
bzw. [`docs/api/evidence.md`](../../docs/api/evidence.md) /
[`docs/api/hypothesis.md`](../../docs/api/hypothesis.md).

## Dependencies

Nur `@vdp/shared` (`mayImport` in `architecture.yaml`).

## Data Flow

```text
@vdp/core (session/observation.ts, dtc/scanner.ts)
  → baut Observations mit provenance → IR-Formen (dieses Paket)
  → Projektionen: @vdp/runtime (mappers), @vdp/reports, @vdp/ai
```

Dieses Paket ist die **Ziel-Form**; die Erzeugung sitzt im Core, das
Verbrauchen in Runtime/Reports/AI.

## Important invariants

- **Jede Observation trägt `evidence`** — `proven` (mit Herkunft) oder
  `unproven` (mit Grund). Fehlende Evidenz ist ein Fehlschlag (ADR 0033).
- **`mayImport` bleibt `["@vdp/shared"]`** — der Dependency-Checker fällt
  (per-file-Coverage 95/90).
- **Item-Ids sind Schlüssel, keine Sätze** — nie als Antwort rendern.
- **Observation ≠ Enrichment**: zwei Hälften, zwei eigene Belege.
- Vokabel-Kontrakt: [`docs/glossary.md`](../../docs/glossary.md)
  („DiagnosticData“/„Reading“-Doppelnamen sind verboten).

## Tests

Co-lokatierte `src/*.spec.ts` (Projekt `unit`, Gate 95/90).

## Examples

```ts
import { dtcObservation, signalReading, itemsOf } from "@vdp/diagnostic-ir";

const dtc = dtcObservation({ /* code, raw, status, statusBits, ecuId, … */ });
dtc.evidence.origin; // "ecu-response"

const reading = signalReading({
  signalId: "engine.rpm",
  raw: new Uint8Array([0x0b, 0xb8]),
  rawValue: 3000,
  value: 3000,
  unit: "rpm",
  ecuId: "ecu-engine",
  did: 0x0c02,
});

const evidence = itemsOf(someEvidenceSet); // zitierbare Items
```

Ausführbar: [`tests/examples/dtc-analysis.example.ts`](../../tests/examples/dtc-analysis.example.ts).
