# Migrations-Roadmap zur Zielarchitektur

Stand: 2026-09-12 · Bezug: ADR 0014, ADR 0015, ADR 0023

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
| 5. Event-Bus | geschlossener Ereigniskatalog + In-Memory/Recording-Bus | ✅ + echter Konsument: `EventAuditRecorder` zeichnet jede Domain-Event als Audit-Trail auf | `@vdp/domain`, `@vdp/runtime` |
| 6. Capability-System | Vokabular + UDS-Service-Abbildung + Aktionen-Registry | ✅ | `@vdp/domain`, `@vdp/runtime`, `@vdp/application` |
| 7. Architekturtests | Importgraph als Test, Node-Builtin-Verbot, UI-Import-Verbot | ✅ | `tests/architecture` |
| 8. `DiagnosticEngine` zerlegen | Implementierungen unter die Ports ziehen, Engine in Services auflösen | 🟡 Orchestrierung liegt in den Runtime-Services (identify, freeze-frame, precheck, marker, statistics, history, sample-stream); vollständiges Command-/Query-Vokabular registriert; der Escape-Hatch `runtime.engine` ist entfernt — kein Code außerhalb von `@vdp/runtime` erreicht die Engine noch. Offen bleibt die Auflösung der Engine-Klasse in kleinere Kollaborateure (ADR 0014 Phase 4) | `packages/core` → `@vdp/runtime`-Services |
| 8a. Transport-Seam (CAN ↔ DoIP) | Engine bezieht ECU-Links über eine injizierbare `EcuLinkFactory`; `DoipEcuLinkFactory` liefert DoIP-Links (Routing-Aktivierung + UDSonIP). CAN bleibt Default, Discovery ist CAN-basiert | ✅ | `@vdp/core`, `@vdp/runtime`, `@vdp/transport-doip` |
| 9. Frontend gegen Runtime | Web-App dispatcht Commands/Queries statt Engine-Aufrufe | ✅ `DemoBackend` hält nur noch Transport, Rohspur und Präsentation; jede Fahrzeugoperation läuft über den Command-/Query-Bus. `apps/web` ist zusätzlich `@vdp/core`-frei: `SessionLogger`, Rohspur- und Session-Daten laufen über die Storage-Naht (`@vdp/storage`); die Implementierungen wandern in den Schritten 10–13 weiter nach unten | `apps/web` |
| 10. Definitions als Daten | Pakete aus JSON/Datei/Cloud hinter `DefinitionProvider` statt Import | 🟡 teilweise: `parseDefinitionPackage` lädt + validiert JSON zu typisierten Paketen (SemVer/Provenance erzwungen); Datei-/Cloud-Provider offen | `packages/definitions` |
| 11. Observability | Korrelations-/Action-Ids durchgängig in Traces & Logs | ⏳ | Events tragen die Ids bereits |
| 12. Offline-first + Sync-Vertrag | `entityId`/`revision`/`updatedAt`/`deviceId` auf Entities | ⏳ | `@vdp/domain`, `@vdp/storage` |
| 13. Deterministischer Simulator als Virtual Vehicle | Gateway + mehrere ECUs mit Zuständen, Szenarien als Tests | teilweise | `tools/simulators` |
| 14. Fahrzeugschicht: Schema v2 + Resolver | Fahrzeuge, Plattformen, Motoren/Getriebe und VIN-Matching als Daten; Bestimmung des verbundenen Fahrzeugs aus VIN, Identifikationswerten und beantworteten Adressen — Kandidaten mit Belegen und Widersprüchen | ✅ Query `vehicle.resolve` über Port `DefinitionProvider.resolveVehicle` bis ins Workbench-Panel; WMI-Referenz (ISO 3780) mit eigener Provenance; Simulator-Paket macht die Demo auflösbar; per-file-Gate `definitions` 85/80 (ADR 0023) | `packages/definitions`, `packages/domain`, `packages/application`, `packages/runtime`, `apps/web` |
| 15. DTC-Wissen pro Fahrzeugvariante | Fehlertexte, Ursachen, Messwerte-Sollbereich und Prüfschritte je Fahrzeug/Motor statt je Paket | ⏳ steht auf Schritt 14: `vehicles[]` liefert die Variante, `dtcKnowledge` fehlt noch | `packages/definitions`, `packages/core` |
| 16. Geführte Diagnose | Prüfabläufe als Daten (Symptom → Hypothesen → Messschritt → Auswertung), Verbraucher von Schritt 15 | ⏳ | `packages/definitions`, `packages/runtime`, `apps/web` |

## Ergebnis der Engine-Zerlegung (Schritt 8/9, 2026-09-12)

- **Vollständiges Vokabular:** neue Commands `ecu.identify`, `dtc.freeze-frame`,
  `marker.add`; neue Queries `dtc.clear-precheck`, `signal.list`, `marker.list`,
  `measurement.statistics`, `measurement.anomalies`, `recording.get`,
  `measurement.status`. Damit deckt der Bus jede Backend-Operation ab.
- **`apps/web` ist engine-frei:** `DemoBackend` besitzt nur noch Transportauswahl,
  Rohspur und Präsentation. Sichtbare Nebeneffekte der alten Direktzugriffe sind
  messbar behoben: der Live-Start rief `LiveDataEngine.run()` doppelt auf
  (SSE-Fehler `live data engine is already running` bei jedem Start) und nahm
  jedes Sample doppelt auf (Messung vorher: 322 Samples, 276 eindeutig; nachher:
  0 Duplikate). Der Sample-Strom liest jetzt die bereits aufgenommenen Runden
  (`PollRoundResult.samples`) statt ein zweites Mal zu recorden.
- **Eine bewusste Angleichung:** eine abgelehnte Fehlerspeicher-Löschung ist jetzt
  ein Ergebnis (`ok: false` + Gründe), kein HTTP-Fehler mehr — die Safety-Kette
  beantwortet Vorbedingungen als Daten (AGENTS 26), der Precheck zeigt dieselben
  Gründe vorab.
- **`apps/web` ist `@vdp/core`-frei:** `SessionLogger`, `RawTraceEntry` und
  `VehicleSessionData` kommen über die Storage-Naht (`@vdp/storage`); der
  CSV/JSON-Export bleibt über `rawExport()`, dem dokumentierten Export-Seam der
  Measurement-Services. Die Implementierungen wandern mit den Schritten 10–13
  weiter nach unten.
- **`dispose()` schließt den Bus auch nach einem fehlgeschlagenen Connect** —
  vorher blieb der Transport halb offen und der nächste Versuch scheiterte mit
  „already open“.
- **Nacharbeit 2026-09-12 (offene Punkte geschlossen):**
  - Der Escape-Hatch `runtime.engine` ist aus der öffentlichen Runtime-Fläche
    entfernt; die Integrationsteste beziehen die Session-Id über `session.get`.
  - Ein Absturz des Poll-Loops bleibt nicht mehr unsichtbar: `LiveDataEngine`
    meldet Loop-Crashes über `onError`, der Measurement-Service publiziert
    daraus `diagnostic-error`, und das Backend leitet das Ereignis als
    SSE-`error` weiter (Regel 34.25; Einheitstest mit injizierter Uhr).
  - Sample-Streams dürfen vor dem Start abonnieren: Der Service puffert die
    Listener bis zur nächsten Live-Engine — der Stream-Test ist dadurch
    deterministisch (jede Runde wird beobachtet, `streamed === recorded`).
  - Abgelehnte Fehlerspeicher-Löschungen tragen ihre Gründe bis in die
    HTTP-Antwort (`cleared: false` + `reasons`, ADR 0018; eigener
    Server-Test). Precheck und Schreibzugriff werten nachweisbar dieselbe
    Kette aus.

## Ergebnis der Fahrzeugschicht (Schritt 14, 2026-09-12)

- **Schema v2 statt Nebenmodell.** `vehicles[]` liegt im Paket neben ECUs, DIDs
  und Signalen; `migrate.ts` hebt v1 → v2, Validator und JSON-Parser prüfen
  Referenzen, Duplikate und VIN-Zeichen semantisch. Kein Fahrzeugwissen in
  `core` — die Abhängigkeitsrichtung bleibt Test (`tests/architecture`).
- **Resolver mit Belegen.** `VehicleResolver` gewichtet 16 Kriterien
  (Teilenummer 4 · WMI/Motor-Getriebekennung/ECU-Abdeckung 3 · VDS/Softwarestand/
  Modellangabe/unerwartetes Steuergerät 2 · Rest 1), `score` ist der Anteil
  bestätigter Gewichte, `ecu-coverage` zählt anteilig. Jeder Kandidat trägt
  `evidence[]` **und** `conflicts[]` mit `observed`/`expected`/`weight`/`reason`;
  Provenance bricht Gleichstände (ADR 0003), Platzhalter drängen sich nicht vor.
- **Attributionsregel.** Widersprechen kann nur ein Wert, dessen DID als
  Teilenummer, Software- oder Hardwarestand dokumentiert ist
  (`identificationKindForLabel`); Seriennummern und unbekannte DIDs stützen bei
  Treffer und sind sonst neutral. Ohne die Regel bestraft der Resolver Fahrzeuge
  für Werte, die er nicht versteht.
- **Namensraum je Paket.** Identifikationsfakten tragen `oem` plus nacktes
  ECU-Id, weil die Engine `"<oem>:<id>"` speichert und zwei Pakete dasselbe Id
  tragen dürfen.
- **Naht bis ins Panel.** `DefinitionProvider.resolveVehicle` (Domain) →
  `vehicle.resolve` (Application) → `VehicleService.resolve` mit Faktensammlung
  in `packages/runtime/src/vehicle-resolution.ts` → `POST /api/vehicle/resolve`
  + SSE-Ereignis `vehicle` + `apps/web/src/vehicle-view.ts` (Übersetzung der
  Kriterium-Schlüssel, gegen die Union-Typen der Definitionsschicht typisiert).
- **Simulator ehrlich gemacht.** ASCII-Signale antworteten alle mit der VIN —
  auch die Teilenummer unter 0xF187. Jetzt liefert nur 0xF190 die VIN, jedes
  andere ASCII-Signal `<ECU-ID>-<DID>`; `simulatorPackage` deklariert genau
  diese Werte, und ein Kopplungstest in `tools/simulators` rechnet die Antworten
  aus den Definitionen nach (er hat die Hex-Groß-/Kleinschreibung als echten
  Fehler gefunden). Gegen echte Hardware bleibt `genericPackage` aktiv.
- **Messung.** Suite 1066 → **1223 Tests** in 88 Dateien (24,73 s), Coverage
  global 96,26 Statements / 89,08 Zweige, `packages/definitions` 98,68 Zeilen /
  92,87 Zweige; neues per-file-Gate `definitions` 85/80, Biss belegt
  (`lines: 99` → `EXIT=1` mit `migrate.ts (87.5%)` und `validate.ts (96.07%)`).
  Die Demo bestimmt das simulierte Fahrzeug mit score 1,00 aus 11 Belegen und 0
  Widersprüchen; derselbe Bus mit fremder VIN ergibt score 0,39 mit vier
  benannten VIN-Widersprüchen (Integrationstest).

**Nächste Schritte (15/16):** DTC-Wissen pro Variante und geführte Diagnose als
Verbraucher desselben Wissens. Beides braucht keine neue Architektur — es
braucht `vehicles[]` als Anker, und der steht jetzt.

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
