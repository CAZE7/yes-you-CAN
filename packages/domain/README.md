# `@vdp/domain`

**Layer:** contract · **Pfad:** `packages/domain/` ·
**Regeln-Quelle:** [`architecture/architecture.yaml`](../../architecture/architecture.yaml)

## Purpose

Die Domänenschicht (ADR 0014): **Verträge** — Entitäten/Projektionen, Ports,
Capabilities, Risk-Policy und das Domain-Event-Katalog. Kein I/O, keine
Protokolle, keine Transporte.

## Responsibilities

- Domänenmodell/Projektionen: `DtcInfo`, `EcuSummary`, `SessionSummary`,
  `MeasurementReading`, `VehicleStateReading`, … (`model.ts`)
- Ports (das „wie“ bleibt außen): `Clock`, `IdGenerator`, `EventBus`,
  `VehicleConnection`/`DiagnosticTransport`, `DefinitionProvider`,
  `SessionStore` (`ports/`)
- Capabilities: was eine ECU anbieten kann (`capabilities.ts`)
- Risk-Policy: Write-Operationen mit Level und Policy (`risk.ts`)
- Domain-Events: der komplette Katalog (`events.ts`, `DIAGNOSTIC_EVENT_NAMES`)
- Typisierte Ids (`ids.ts`)

## Does NOT do

- keine Protokoll-, Transport- oder Adapter-Kenntnis (Portabilitäts-Regel)
- keine I/O, keine `node:`-Builtins
- keine Ausführung: Ports sind *Verträge*, `InMemoryEventBus` o. Ä. sind
  Referenzimplementierungen für Tests — nicht die Produkt-Logik
- keine Diagnose-Logik (das ist `@vdp/core`)

## Public API

`src/index.ts` (bewusst kuratiert, §30/§31): Ids, Capabilities, Risk-Policy,
Data Contracts, Events, Ports. Vollständig dort aufgeführt.

**Eingefrorene Vertragsfläche:** `npm run check:api` misst diese Fläche gegen
`architecture/public-api.json` (ADR 0059) — eine Änderung ist eine Entscheidung,
kein Nebeneffekt.

## Dependencies

Nur `@vdp/shared`.

## Data Flow

```text
@vdp/application  →  spricht ausschließlich Domäne (Commands/Queries)
@vdp/runtime      →  implementiert die Ports, registriert Handler
                    (die Ports sind die Fugen, an denen Tests schießen)
```

## Important invariants

- **Portabilität:** `mayImport` bleibt `["@vdp/shared"]`, keine
  `node:`-Builtins (maschinell geprüft).
- **Events sind Daten:** jeder diagnostische Schritt publiziert seinen
  Event — der Audit-Trail (`@vdp/runtime` `EventAuditRecorder`) ist die
  Rekonstruktionsbasis (AGENTS 10).
- **Write-Risk ist Policy, nicht Prosa:** `policyForWriteOperation(kind)` —
  neue Write-Arten brauchen hier eine Zeile (AGENTS 26).

## Tests

Co-lokatierte `src/*.spec.ts` (Projekt `unit`).

## Examples

```ts
import { InMemoryEventBus, policyForWriteOperation, capabilitiesOf } from "@vdp/domain";

const events = new InMemoryEventBus();
const policy = policyForWriteOperation("clear-dtc"); // risk + confirm-Pflicht
const caps = capabilitiesOf(["read-dtc", "read-did"]);
```
