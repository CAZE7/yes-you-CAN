# Public API: `@vdp/diagnostic-ir`

> Paket: [`packages/diagnostic-ir/`](../../packages/diagnostic-ir/README.md) ·
> Layer: **contract** (importiert nur `@vdp/shared`) ·
> ADRs: [0034](../adr/0034-diagnostic-ir.md), [0037](../adr/0037-diagnostic-ir-dtc-and-session-path.md)

Die diagnostische Zwischenrepräsentation: Beobachtungen mit Beleg zwischen
Roh-Protokoll-Form und Projektionen. Sie kennt **kein** Protokoll, **keinen**
Transport, **keine** I/O — deshalb ist sie die stabile Mitte, auf die Core,
Runtime, Reports und AI gleichzeitig projectionieren dürfen.

## Primary API

| Symbol | Zweck |
|---|---|
| `DtcObservation` / `dtcObservation()` | Was die ECU gemeldet hat (Code, Status-Byte, Rohdaten, ECU, Zeit) — mit `evidence` |
| `DtcEnrichment` / `dtcEnrichment()` | Was unser Wissen dazu sagt (Beschreibung, Severity, Signale) — mit eigener `evidence` |
| `DtcState` | Observation + Enrichment + Historie (`firstSeen`/`lastSeen`) |
| `DtcStatusBits`, `DtcSeverity` | IR-eigenes Vokabular für Status-Byte und Dringlichkeit |
| `SignalReading` / `signalReading()` | Eine Signalmessung: `raw` + `rawValue` + `value` + Einheit |
| `SignalGap` / `signalGap()` | Eine gemessene Lücke (kein Wert ≠ nicht beobachtet) |
| `EcuObservation` / `ecuObservation()` | Was über eine ECU bekannt ist (Erreichbarkeit, Protokoll, Telemetrie) |
| `SessionObservation` / `sessionObservation()` | Die Sitzungsbeobachtung (Adapter, Transport, ECUs) |
| `EvidenceItem` / `itemsOf()` / `itemById()` / `unprovenItems()` | Die zitierbare Evidenz-Form |
| `EvidenceSet` / `EvidenceConflict` | Alles zu einem Moment + die Konflikte darin |
| `Hypothesis` / `HypothesisCheck` / `HypothesisTest` | Ein geurteiltes Muster (→ [hypothesis.md](hypothesis.md)) |
| `Evidence` / `provenance` / `proven()` / `unproven()` / `describeEvidence()` / `isProven()` | Der Beleg: `proven` (mit `Provenance`) oder `unproven` (mit Grund) |
| `MeasurementWindow` / `measurementWindow()` / `summariseWindow()` | Zeitfenster gemessener Punkte |

## Beispiel: eine DTC-Beobachtung mit Beleg

```ts
import { dtcObservation, dtcEnrichment, itemsOf } from "@vdp/diagnostic-ir";

const observation = dtcObservation({
  code: "P0420",
  raw: "01 31 04 20",
  failureType: "0x01",
  status: 0x0f,
  statusBits: {
    testFailed: true,
    testFailedThisOperationCycle: true,
    pendingDtc: false,
    confirmedDtc: true,
    testNotCompletedSinceLastClear: false,
    testFailedSinceLastClear: false,
    testNotCompletedThisOperationCycle: false,
    warningIndicatorRequested: false,
  },
  ecuId: "ecu-engine",
  ecuName: "Engine Control",
});
// observation.evidence ist jetzt proven({ origin: "ecu-response", serviceId: 0x19, … })

// und die IR-Form einer Evidenzmenge:
const evidence = collectEvidence({ session }); // aus @vdp/core
for (const item of itemsOf(evidence)) {
  console.log(item.id, item.statement); // "dtc:P0420@ecu-engine  …"
}
```

## Beispiel: „keine Information“ ist Information

```ts
import { signalGap } from "@vdp/diagnostic-ir";

// „nicht gemessen“ ≠ „Wert 0“: eine Gap trägt den Grund.
const gap = signalGap({ signalId: "engine.o2_voltage", reason: "no-samples" });
```

## Verträge (darf nicht verletzt werden)

1. **Jede Observation trägt `evidence`** — `proven` (mit `Provenance`) oder
   `unproven` (mit Grund). ADR 0033: fehlende Evidenz ist ein Fehlschlag.
2. **Kein I/O, kein `node:`-Builtin, keine Protokoll-Kenntnis** — der
   Dependency-Checker fällt, sobald sich das ändert.
3. **`DtcObservation` und `DtcEnrichment` bleiben getrennt** — ein Report muss
   „die ECU meldete den Code, unsere Basis kennt ihn nicht“ sagen können.
4. **Item-Ids sind Schlüssel, keine Sätze** — nie als Antwort rendern.
5. **Neue IR-Formen** kommen in diesem Paket + Export in `src/index.ts` +
   ADR — nie als parallele Vokabel in Core/Reports/AI.
