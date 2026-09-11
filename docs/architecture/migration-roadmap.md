# Migrations-Roadmap zur Zielarchitektur

Stand: 2026-09-11 · Bezug: ADR 0014, ADR 0015

Dieses Dokument verbindet die langfristige Zielarchitektur (Vehicle Diagnostic
Platform: Clients → Application Layer → Domain Core → Protocols/Definitions/Safety
→ Transport → Hardware Adapters) mit dem tatsächlichen Zustand des Repos. Es gilt
der Grundsatz: **kein Rewrite — schrittweise Migration**, Paket für Paket.

## Zielbild (Kurzfassung)

```
Clients (Web / Desktop / Mobile / CLI / Cloud / API / AI)
   ↓
Application Layer (Commands / Queries / Sessions / Workflows / Safety-Freigaben)
   ↓
Domain Core (Vehicle, ECU, DiagnosticSession, DTC, Measurements, Capabilities, Events)
   ↓
Ports (DiagnosticTransport, DefinitionProvider, SessionStore, EventBus, Clock, IdGenerator)
   ↓
Implementierungen (Protocols · Definitions · Transports · Adapters · Storage · AI)
```

Rote Linien (werden in `tests/architecture` erzwungen):

- ❌ Herstellerlogik in UDS · ❌ Adapter direkt in der UI · ❌ HTTP im Core
- ❌ React/DOM in der Domain · ❌ AI im Core · ❌ Datenbanken in der Domain
- ❌ Singleton-Gottservices · ❌ Marken-if/else-Kaskaden
- ❌ unversionierte Sessions/Definitionen · ❌ versteckte Write-Operationen
- ✅ Domain-driven · Ports & Adapters · Capability-driven · Definition-driven
- ✅ Command/Query · intern Event-driven · Offline-first · Replay-first
- ✅ deterministische Simulation · versionierte Schemas · stabile Public APIs

## Stand der Migration

| Schritt | Inhalt | Stand | Wo |
|---|---|---|---|
| 1. Domain-Verträge | Projektionen, Capabilities, Risiko-Policy, Ereigniskatalog | ✅ | `packages/domain` |
| 2. Ports | Transport, Verbindung, DefinitionProvider, SessionStore, EventBus, Clock, IdGenerator | ✅ | `packages/domain/ports` |
| 3. Runtime | `createDiagnosticRuntime`, Services, Command/Query-Handler, Events | ✅ | `packages/runtime` |
| 4. Command/Query-Layer | Command-Bus, Commands/Queries als Daten | ✅ | `packages/application` |
| 5. Event-Bus | geschlossener Ereigniskatalog + In-Memory/Recording-Bus | ✅ | `@vdp/domain`, Runtime publiziert |
| 6. Capability-System | Vokabular + UDS-Service-Abbildung + Aktionen-Registry | ✅ | `@vdp/domain`, `@vdp/runtime`, `@vdp/application` |
| 7. Architekturtests | Importgraph als Test, Node-Builtin-Verbot, UI-Import-Verbot | ✅ | `tests/architecture` |
| 8. `DiagnosticEngine` zerlegen | Implementierungen unter die Ports ziehen, Engine in Services auflösen | ⏳ nächster Schritt | `packages/core` → `@vdp/runtime`-Services |
| 9. Frontend gegen Runtime | Web-App dispatcht Commands/Queries statt Engine-Aufrufe | ⏳ | `apps/web` |
| 10. Definitions als Daten | Pakete aus JSON/Datei/Cloud hinter `DefinitionProvider` statt Import | ⏳ | `packages/definitions` |
| 11. Observability | Korrelations-/Action-Ids durchgängig in Traces & Logs | ⏳ | Events tragen die Ids bereits |
| 12. Offline-first + Sync-Vertrag | `entityId`/`revision`/`updatedAt`/`deviceId` auf Entities | ⏳ | `@vdp/domain`, `@vdp/storage` |
| 13. Deterministischer Simulator als Virtual Vehicle | Gateway + mehrere ECUs mit Zuständen, Szenarien als Tests | teilweise | `tools/simulators` |

## Regeln für die nächsten Schritte

1. Neue Features gehen über `@vdp/application` (Command/Query/Aktion) — keine neuen
   öffentlichen Engine-Methoden mehr.
2. Jede neue Abhängigkeit muss in `tests/architecture` erlaubt werden; die Allowlist
   ist Architektur-Dokumentation.
3. Write-Operationen laufen immer über Risiko-Policy (`@vdp/domain/risk`) +
   Safety-Kette (`@vdp/core/safety`) + Audit-Ereignisse.
4. Definitionen bleiben Daten mit SemVer und Provenance; Code darf OEM-Wissen
   nur über `DefinitionProvider` sehen.
5. Tests zuerst gegen Simulator/Replay; Real-Fahrzeug bleibt Ausnahme.
