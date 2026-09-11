# 0014 — Domain-, Application- und Runtime-Schicht: schrittweise Ablösung des Gott-Controllers

Status: accepted · Datum: 2026-09-11 · Bezug: ADR 0001, 0003; AGENTS 2, 9, 28, 34.3, 36

## Kontext

Die Plattform hat heute eine funktionierende Schichtung (ADR 0001): UI → Core →
Protocols/Transport → Adapters. Innerhalb von `@vdp/core` bündelt die
`DiagnosticEngine` jedoch alles: Transportaufbau, ECU-Discovery, UDS-Sitzungen,
Messwert-Engine, DTC-System, Safety und Session-Buchhaltung. Sie ist der einzige
Einstiegspunkt — Web-App, Tools und Tests greifen direkt auf sie zu.

Das ist funktional, aber die Zielarchitektur der Plattform (mehrere Clients:
Web/Desktop/Mobile/CLI/Cloud/AI; Definitions als Daten statt Code; Capability- statt
Marken-Logik; Safety als eigene Domäne) braucht eine stabilere Grenze:

- **Domänenlogik von Technik trennen.** Verträge (Fahrzeug, ECU, DTC, Messwert,
  Capability, Risiko, Ereignisse) dürfen nichts von CAN, ISO-TP, UDS oder HTTP wissen.
- **Ports statt Implementierungen.** Der Kern kennt `DiagnosticTransport`,
  `DefinitionProvider`, `SessionStore`, `EventBus`, `Clock`, `IdGenerator` — nicht
  `IsoTpConnection`, `CanableAdapter` oder `FileSystemSessionRepository`.
- **Command/Query statt Methodenwald.** Alle Clients dispatchen dieselben
  Kommando-/Query-Objekte; die UI trifft keine Diagnoseentscheidungen selbst.
- **Ereignisse statt Kopplung.** Logger, Session-Recorder, UI, Telemetrie und später
  AI sind Konsumenten von Domänen-Ereignissen — der UDS-Code kennt sie nicht.

Ein Komplett-Rewrite verbietet sich: Die bestehende Basis (Protokoll-Tests,
Simulator, Replay, Safety-Kette) ist zu wertvoll (AGENTS 34.2).

## Entscheidung

Die Migration läuft **schrittweise** über drei neue Pakete, die neben der Engine
entstehen und sie einhüllen, statt sie zu ersetzen:

1. **`@vdp/domain`** — reine Verträge, keine I/O, nur `@vdp/shared` als Abhängigkeit:
   - Projektionen/Read-Models (`EcuSummary`, `DtcInfo`, `MeasurementReading`,
     `SessionSummary`, `ClearDtcOutcome`, …) als das, was Clients zu sehen bekommen;
   - Capability-Vokabular (`DiagnosticCapability`) und Set-Operationen — *welcher*
     UDS-Service welche Capability belegt, entscheidet bewusst erst die Runtime;
   - Risiko-Policy für Schreiboperationen (`WriteOperationKind` → Bestätigung,
     Backup, Verifikation);
   - der geschlossene Domänen-Ereigniskatalog (`DiagnosticEventMap`);
   - Ports: `DiagnosticTransport`/`VehicleConnection`, `DefinitionProvider`,
     `SessionStore<T>`, `EventBus`, `Clock`, `IdGenerator`.
2. **`@vdp/application`** — Command-Bus plus Kommandos (`vehicle.connect`,
   `dtc.read`, `dtc.clear`, `did.read`, `measurement.*`) und Queries
   (`session.get`, `ecu.list`, `dtc.list`, `actions.available`, …) als Daten,
   dazu die Capability-getriebene `ActionRegistry`. Hängt nur an `@vdp/domain`.
3. **`@vdp/runtime`** — der Kompositionsroot: `createDiagnosticRuntime(...)`
   verdrahtet Engine, Services (`VehicleService`, `EcuService`, `DtcService`,
   `MeasurementService`, `SessionService`, `SafetyService`), Command-Bus und
   Event-Bus. Die Services sind heute dünne Fassaden über der `DiagnosticEngine`;
   ihre Signaturen sind bereits die Ziel-API (`runtime.vehicle.connect()`,
   `runtime.dtc.read(ecuId)`, `runtime.measurements.snapshot(...)`).

Weitere Festlegungen:

- **Kein zweites Entity-System parallel.** Solange die Engine die Zuständigkeit
  hat, definiert die Domain *Projektionen*, keine konkurrierenden Entities. Erst
  wenn die Engine zerlegt wird (Phase 4), werden daraus die führenden Entities.
- **Die Engine bleibt als Escape-Hatch sichtbar** (`runtime.engine`), aber neue
  Code-Pfade benutzen Services/Command-Bus. Die Web-App wird in einem eigenen
  Schritt gegen die Runtime gehängt (Phase 10).
- **Ereignisse tragen Korrelations-Ids** (`sessionId`, `ecuId`, `actionId`), damit
  Observability später ohne Umbau einzieht.
- **UDS-Service→Capability-Abbildung lebt in der Runtime**, nicht in der Domain:
  Die Domain kennt keine Protokolle, die Protokolle kennen keine Capabilities.

## Migrationsplan (Reihenfolge verbindlich)

| Phase | Inhalt | Status |
|---|---|---|
| 1 | Domain-Verträge (`@vdp/domain`) | ✅ erledigt |
| 2 | Ports (Transport, DefinitionProvider, SessionStore, EventBus, Clock, IdGenerator) | ✅ erledigt |
| 3 | Runtime (`@vdp/runtime`) + Command/Query-Verdrahtung | ✅ erledigt |
| 4 | `DiagnosticEngine` in Services zerlegen (Implementierungen unter die Ports) | offen |
| 5 | Web-App gegen Runtime/Command-Bus hängen | offen |
| 6 | Definitionen als Daten außerhalb des Codes (JSON/Loader hinter `DefinitionProvider`) | offen |
| 7 | Deterministischer Simulator als `Virtual Vehicle` mit Szenarien | teilweise (Simulator vorhanden) |
| 8 | Offline-first + Sync-Vertrag (`entityId`/`revision`/`updatedAt`/`deviceId`) | offen |

## Konsequenzen

- Neue Features landen als Kommandos/Queries/Aktionen, nicht als Engine-Methoden.
- `@vdp/domain` und `@vdp/application` müssen portabel bleiben (kein `node:*`);
  das erzwingt ADR 0015 automatisiert.
- Die doppelte Buchhaltung (Engine-Zustand + Projektionen) ist der bewusste Preis
  der Zwischenphase und endet mit Phase 4.
