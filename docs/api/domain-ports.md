# Public API: `@vdp/domain` — die Sprache, in der ein Konsument fragen darf

> Paket: [`packages/domain/`](../../packages/domain/README.md) ·
> Layer: **contract** (importiert nur `@vdp/shared`, keine `node:`-Builtins) ·
> ADRs: [0014](../adr/0014-domain-application-runtime.md), [0004](../adr/0004-raw-vs-decoded.md),
> [0032](../adr/0032-write-path-as-its-own-port.md) ·
> Vertrag im Record: `@vdp/domain` (ADR [0059](../adr/0059-contracts-are-frozen-and-measured.md))

Diese Fläche ist der Grund, warum ein geschlossenes Modul nichts über die Innereien der
Plattform wissen muss: Ein Konsument fragt über **Ports** und beschreibt Ergebnisse mit
**Projektionen**. Wer eine andere Implementierung danebenstellt, implementiert diese
Typen — er liest nicht unsere Module.

## Was hier Vertrag ist

**1. Ports — das „wie“ bleibt außen.**

| Port | Was der Aufrufer damit darf | Wer implementiert |
|---|---|---|
| `Clock` | Zeit lesen (`systemClock`, `FixedClock` für Tests) | Runtime, Tests |
| `IdGenerator` | Ids ziehen (`DefaultIdGenerator`) | Runtime, Tests |
| `EventBus` | Events publizieren/abonnieren (`InMemoryEventBus`) | Runtime |
| `VehicleConnection` / `DiagnosticTransport` | Verbindung + Transaktion (`ConnectionCapabilities`, `DiagnosticRequestOptions`) | Adapter/Transporte |
| `DefinitionProvider` | Definitionen auflösen (`FindDidQuery`, `ResolveVehicleQuery`) | `@vdp/definitions`-Konsumenten |
| `SessionStore` | Sitzungen ablegen/lesen (`StoredSessionInfo`) | `@vdp/storage` |

Die drei In-Memory-Implementierungen (`InMemoryEventBus`, `StaticDefinitionProvider`,
`InMemorySessionStore`) sind **Referenzimplementierungen für Tests**, nicht die
Produkt-Logik — sie stehen hier, damit ein Test denselben Vertrag erfüllen kann, ohne die
Produktion zu importieren.

**2. Projektionen — was ein Ergebnis sein darf.** `DtcInfo`, `EcuSummary`,
`SessionSummary`, `MeasurementReading`, `VehicleStateReading`, `RawDidReading`,
`IdentificationEntry`, `UnreadEcuInfo`, … Diese Typen sind die einzige Form, in der eine
Umsetzung ihre Ergebnisse weitergeben darf. `raw` bleibt `raw` und `decoded` bleibt
`decoded` (ADR [0004](../adr/0004-raw-vs-decoded.md)) — die Projektion ist die Grenze
dazwischen, nicht ein Vorwand, sie zu vermischen.

**3. Capabilities — was eine ECU anbieten kann.** `DiagnosticCapability`,
`ALL_CAPABILITIES`, `capabilitiesOf`, `hasCapability`, `hasAllCapabilities`,
`missingCapabilities`, `describeCapability`. Eine UI-Frage („darf ich diesen Knopf
zeigen?“) ist damit eine Frage an die Capability-Menge, keine an die Verbindung.

**4. Risk-Policy — was ein Write kostet.** `WriteOperationKind`,
`policyForWriteOperation(kind)`, `WRITE_OPERATION_POLICIES`. Ein neuer Write-Typ braucht
hier eine Zeile (AGENTS 26); die Policy ist Daten, kein Kommentar.

**5. Events und Ids.** `DIAGNOSTIC_EVENT_NAMES` und die Payload-Typen
(`DiagnosticEventMap`) sind der Audit-Trail (AGENTS 10), `ID_PREFIXES`/`asId` die
typisierten Ids — beide sind Vertrag, weil ein geschlossenes Modul seine eigenen
Ergebnisse in genau dieser Form melden muss.

## Die Kanten (maschinell geprüft)

1. **`mayImport` bleibt `["@vdp/shared"]`** — und die Portabilitätsregel verbietet
   `node:`-Builtins in `domain`/`application` (`npm run check:deps`,
   `architecture/architecture.yaml`). Ein Port, der `node:fs` braucht, ist kein Port.
2. **Ports sind Verträge, ihre Implementierung ist nicht Teil dieser Fläche.** Wer
   `VehicleConnection` implementiert, darf `@vdp/domain` zeigen — `@vdp/domain` zeigt
   nicht auf ihn.
3. **Die Fläche ist eingefroren:** `npm run check:api` misst die emittierten `.d.ts`
   (12 Dateien) gegen `architecture/public-api.json` (ADR 0059). Eine Änderung ohne
   Entscheidung fällt.

## Häufige Fehler

- **Eine Projektion erweitern, um „schnell“ etwas durchzureichen** — dann ist die
  Projektion ein Transporttyp und ihre Bedeutung weg. Neue Felder brauchen einen Grund,
  der in `why`/ADR passt.
- **Einen Port um eine Bypass-Methode ergänzen** (z. B. „sende rohen Request“) — damit
  wandert die Write-Kette aus `SafetyManager`/`WritePort` heraus (AGENTS 26).
- **In-Memory-Helfer für Produktion halten:** `StaticDefinitionProvider` ist ein
  Fixture-Baustein; wer ihn produktiv nutzt, hat eine leere Definitionswelt.

**Zugehörig:** [`docs/api/evidence.md`](evidence.md) (was eine Aussage belegen muss),
[`docs/api/definitions-schema.md`](definitions-schema.md) (die Daten gegenüber diesen
Ports), [`tests/architecture/api.test.ts`](../../tests/architecture/api.test.ts) (das
Gate), `AGENTS 26` (Write-Safety).
