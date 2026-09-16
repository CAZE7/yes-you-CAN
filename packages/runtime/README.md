# `@vdp/runtime`

**Layer:** runtime · **Pfad:** `packages/runtime/` ·
**Regeln-Quelle:** [`architecture/architecture.yaml`](../../architecture/architecture.yaml)

## Purpose

Die Kompositions-Wurzel (ADR 0014): `createDiagnosticRuntime` verdrahtet
Engine, Services, Command Bus, Events und Audit zu einer **headless**
Diagnose-Plattform. Web, CLI, Mobile und KI-Agenten komponieren dasselbe
Objekt — der Public Surface ist *Services + Command Bus*, die Engine ist
internes Detail.

## Responsibilities

- `runtime.ts`: `createDiagnosticRuntime` + `DiagnosticRuntime`
  (die „vordere Tür“, vollständig in [`docs/api/runtime.md`](../../docs/api/runtime.md))
- `services.ts`: `VehicleService`, `EcuService`, `DtcService`,
  `MeasurementService`, `SafetyService`, `SessionService`
- `handlers.ts`: `registerRuntimeHandlers` — verbindet Command Bus und Services
- `evidence-service.ts`: `EvidenceService` — die *einzige* Evidenz-View
  über der laufenden Session (ADR 0038)
- `signal-analysis-service.ts`: Statistik, Anomalien, Spektrum, Korrelation
- `event-recorder.ts`: `EventAuditRecorder` — der Audit-Trail
- `definition-service.ts`: `PackageDefinitionProvider` (Domain-Port)
- `transport.ts`: `DoipEcuLinkFactory` (Transport-Seam)
- `vehicle-resolution.ts`: VIN → Fahrzeug mit Belegen (ADR 0023/0026)
- `mappers.ts`: IR → Domain-Views (`toDtcInfo`, `toMeasurementReading`, …)
- `capability-map.ts`: Services → `DiagnosticCapability[]`
- `version.ts`: `PLATFORM_VERSION` (wird von Analysen zitiert, P0 #42)

## Does NOT do

- kein HTTP, kein DOM, kein UI-Toolkit (ADR 0014/0006)
- keine Persistenz-Dateizugriffe: `sessionStore` ist ein *Port*
  (`@vdp/storage` implementiert)
- keine Report-/AI-Logik: die konsumieren `evidence.collect()`
- keine zweite Evidenz-Bau-Stelle (ADR 0038)

## Public API

`src/index.ts` — vollständig in
[`docs/api/runtime.md`](../../docs/api/runtime.md) dokumentiert.

## Dependencies

`shared`, `diagnostic-ir`, `domain`, `application`, `core`, `definitions`,
`protocols-uds`, `transport-can`, `transport-doip` (siehe `architecture.yaml`).

## Data Flow

```text
Client → runtime.commands.dispatch/connectVehicle
  → handlers.ts → VehicleService → engine.connect (Discovery, Link-Factory)
  → Domain-Events → events + audit
Client → runtime.evidence.collect()
  → EvidenceService → engine.recorder/scanner → collectEvidence → EvidenceSet
```

## Important invariants

- **Headless** — kein `node:`-Builtin, kein HTTP (maschinell).
- **Public Surface = Services + Command Bus** (ADR 0014).
- **Evidenz: eine Stelle** — `runtime.evidence` (ADR 0038).
- **Writes: eine Tür** — `runtime.writes` (ADR 0032).
- **Transport-Seam:** `linkFactory` erlaubt DoIP/Custom ohne Core-Änderung.

## Tests

Co-lokatierte `src/*.spec.ts` (Projekt `unit`) + `tests/integration/runtime.test.ts`
(ganze Plattform über die Application-API).

## Examples

```ts
import { createDiagnosticRuntime } from "@vdp/runtime";

const runtime = createDiagnosticRuntime({ bus, definitions: [pkg] });
const { session, ecus } = await runtime.vehicle.connect();
const dtcs = await runtime.dtc.scan();
const evidence = runtime.evidence.collect(); // → EvidenceSet
await runtime.dispose();
```

Ausführbar: [`tests/examples/diagnostic-read.example.ts`](../../tests/examples/diagnostic-read.example.ts).
