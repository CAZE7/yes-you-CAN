# `@vdp/application`

**Layer:** application · **Pfad:** `packages/application/` ·
**Regeln-Quelle:** [`architecture/architecture.yaml`](../../architecture/architecture.yaml)

## Purpose

Die Anwendungsschicht (ADR 0014): das **Was** — Commands, Queries, der
Command Bus und capabilities-getriebene Actions. *Wie* ausgeführt wird, ist
Sache des `@vdp/runtime`, der hier die Handler registriert.

## Responsibilities

- Command Bus: `CommandBus` mit `dispatch`/`query`, Handler-Dedup
  (`DuplicateHandlerError`), `NoHandlerError` (`command-bus.ts`)
- Commands: `connectVehicle`, `disconnectVehicle`, `identifyEcus`, `readDid`,
  `readDtcs`, `readDtcFreezeFrame`, `snapshotSignals`, `startMeasurements`,
  `stopMeasurements`, `clearDtcs`, `addMarker` (`commands.ts`)
- Queries: `getVehicle`, `getEcu`, `getEcuList`, `getEcuCapabilities`,
  `getDtcList`, `getMeasurements`, `getStatistics`, `getAnomalies`,
  `getSession`, `getAvailableActions`, `resolveVehicle`, … (`queries.ts`)
- Actions: `ActionRegistry` + `createStandardActions()` — capability-
  getriebene UI-Aktionen mit Verdicts (`actions.ts`)

## Does NOT do

- keine Ausführung (kein Engine-Zugriff, kein Transport, kein I/O)
- keine Protokoll- oder Hardware-Kenntnis (Portabilitäts-Regel)
- keine UI-Logik: Actions *beschreiben*, die Workbench *zeichnet*

## Public API

`src/index.ts` (bewusst kuratiert): `CommandBus`, `CommandKinds` + alle
Command-Factory-Funktionen, `QueryKinds` + alle Query-Factory-Funktionen,
`ActionRegistry`/`createStandardActions`.

## Dependencies

Nur `@vdp/domain`.

## Data Flow

```text
Client (Web/CLI/Agent) → Command/Query-Factory → runtime.commands.dispatch/query
  → Handler (runtime/handlers.ts) → Services → Antwort (Domain-Form)
```

## Important invariants

- **Portabilität:** `mayImport` bleibt `["@vdp/domain"]` (maschinell).
- **Ein Command, ein Intent:** neue Client-Fähigkeiten werden als Command/
  Query hier definiert — nie als direkte Service-Methode am Client
  (ADR 0014).
- **Actions sind capability-getrieben:** eine Action, deren Capability fehlt,
  ist `ActionVerdict` mit Grund, keine UI-Spezialbehandlung.

## Tests

Co-lokatierte `src/*.spec.ts` (Projekt `unit`); End-to-End über den Bus in
`tests/integration/runtime.test.ts`.

## Examples

```ts
import { CommandBus, connectVehicle, readDtcs, getEcuList } from "@vdp/application";

// im echten System: runtime.commands (Handler aus @vdp/runtime)
const result = await bus.dispatch(connectVehicle({ windowMs: 120 }));
const dtcs = await bus.dispatch(readDtcs());
const ecus = await bus.query(getEcuList());
```

Ausführbar: [`tests/examples/diagnostic-read.example.ts`](../../tests/examples/diagnostic-read.example.ts).
