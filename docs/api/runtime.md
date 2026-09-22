# Public API: `@vdp/runtime` (die vordere Tür)

> Paket: [`packages/runtime/`](../../packages/runtime/README.md) ·
> Layer: **runtime** (Kompositions-Wurzel) ·
> ADR: [0014](../adr/0014-domain-application-runtime.md)

Der Runtime ist die headless Diagnose-Plattform: ein
`createDiagnosticRuntime`-Aufruf komponiert Engine, Services, Command Bus,
Events und Audit. **Alles außerhalb des Runtime spricht über diese API** —
Web, CLI, Mobile und KI-Agenten. Die `DiagnosticEngine` aus `@vdp/core` ist
damit internes Detail.

## Primary API

| Symbol | Zweck |
|---|---|
| `createDiagnosticRuntime(options)` | Komposition: `bus`, `definitions`, `logger`, `events`, `sessionStore`, `clock`, `linkFactory` (Transport-Seam), `safety`, `pollIntervalMs` |
| `DiagnosticRuntime` | Das Objekt: `vehicle`, `ecus`, `dtc`, `measurements`, `signalAnalysis`, `writes`, `evidence`, `session`, `safety`, `definitions`, `actions`, `commands`, `events`, `audit`, `dispose()` |
| `VehicleService` | `connect()`, `disconnect()`, `identity()`, `resolve()` (Fahrzeugauflösung, ADR 0023/0026) |
| `EcuService` | `list()`, `get()`, `capabilities()`, `identifyAll()`, `readDid()` |
| `DtcService` | `scan()`, `freezeFrame()`, `precheckClear()`, `clear()` (über den WritePort); Read-Modelle `lastScanResult` und `lastScanGaps` — die Module, die der letzte Scan **nicht** lesen konnte (ADR 0049) |
| `MeasurementService` | `snapshot()`, `start()`/`stop()`, `samples()`, `onSample()` (Streaming), `markers()`, `statistics()`, `rawExport()` |
| `SignalAnalysisService` | Statistik, Anomalien, Spektrum, Korrelation |
| `WritePort` (`runtime.writes`) | `precheck(kind, input, binding)`, `run(...)`, `history` — die einzige Schreib-Tür (ADR 0032) |
| `EvidenceService` (`runtime.evidence`) | `collect()` → `EvidenceSet`, `hypotheses()`, `recordStepMeasurement()` |
| `EventAuditRecorder` (`runtime.audit`) | Zeitgestempelter Trail aller Domain-Events |
| `CommandBus` (`runtime.commands`) | `dispatch(command)`, `query(query)` — das Vokabular aus `@vdp/application` |
| `registerRuntimeHandlers` | Intern: verbindet Bus und Services (im Runtime selbst aufgerufen) |
| `PLATFORM_VERSION` | Die Version, die eine Analyse als `runtimeVersion` zitiert (P0 #42) |

## Beispiel: eine komplette Lese-Session

```ts
import {
  connectVehicle,
  getDtcScanGaps,
  getEcuList,
  readDid,
  readDtcs,
  snapshotSignals,
} from "@vdp/application";
import { genericPackage } from "@vdp/definitions";
import { createDiagnosticRuntime } from "@vdp/runtime";
import { VirtualVehicle } from "@vdp/simulators";

const vehicle = new VirtualVehicle({ dynamic: true, seed: 42 });
await vehicle.start();

const runtime = createDiagnosticRuntime({
  bus: vehicle.testerBus,
  definitions: [genericPackage],
});

const { session, ecus, vehicle: identity } = await runtime.commands.dispatch(
  connectVehicle({ windowMs: 120, probeDelayMs: 0 }),
);
const engineEcu = (await runtime.commands.query(getEcuList())).find((e) => e.rxId === 0x7e8);
const vin = await runtime.commands.dispatch(readDid(engineEcu.ecuId, 0xf190));
const dtcs = await runtime.commands.dispatch(readDtcs());
// Die zweite Hälfte der Antwort: über welche Module die Liste oben überhaupt
// zustande kam. Leer, wenn jedes Modul geantwortet hat (ADR 0049).
const unread = await runtime.commands.query(getDtcScanGaps());
const readings = await runtime.commands.dispatch(snapshotSignals(["engine.rpm"]));

const evidence = runtime.evidence.collect(); // → EvidenceSet (read-only)
await runtime.dispose();
await vehicle.stop();
```

## Verträge

1. **Public Surface = Services + Command Bus.** Nichts außerhalb des Runtime
   greift in die Engine (ADR 0014).
2. **Headless:** kein HTTP, kein DOM, kein UI-Toolkit — die App ist eine
   Projektion (ADR 0006).
3. **Evidenz kommt von `runtime.evidence`** — eine zweite Kopie ist ein
   Defekt (ADR 0038).
4. **Schreiben nur über `runtime.writes`** (WritePort), nie über eine
   Service-Methode am Lesepfad (ADR 0032).
5. **Transport-Seam:** `linkFactory` erlaubt DoIP oder Custom-Links, ohne
   dass sich eine Zeile im Core ändert (AGENTS 5/36).
6. **Ein Scan antwortet in zwei Hälften.** `scanned` sind die Codes, `unread` die
   Module ohne Antwort — mit `ecuId`, `ecuName`, `rxId` und Grund. Dieselbe Zahl
   steht als Pflichtfeld `unreadCount` im `dtcs-read`-Ereignis, damit kein Trail
   „gelesen" sagen kann, ohne zu sagen, wie viel davon fehlte (ADR 0049; dieselbe
   Regel wie ADR 0033 für Messwerte).
