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
| 15. DTC-Wissen pro Fahrzeugvariante | Fehlertexte, Ursachen, Messwerte-Sollbereich und Prüfschritte je Fahrzeug/Motor statt je Paket | ✅ Schema v3: `vehicles[].dtcKnowledge[]` mit `patterns[]` (Ursachen, `likelihood`, Reparaturhinweis) und `checks[]` (Messpunkt, Erwartung, `min`/`max`/`windowMs`); `findDtcKnowledge` löst nach Spezifität (Motor 16 · Getriebe 8 · ECU 4 · angenommen 2/1) und sammelt breitere Muster statt sie zu verdrängen; `DtcScanner.setVehicle` schichtet Variantenwissen über die paketweite Beschreibung, `connect()` bindet das aufgelöste Fahrzeug sofort; Scope/Notes/`measurable`/Provenance machen sichtbar, woraus eine Aussage besteht (ADR 0024). Simulator-Variante trägt echtes Wissen zu P0420/P0300/P0171/P0700/P0715/C0035, `U0121` bewusst ohne (ein Kommunikationscode bedeutet für jede Variante dasselbe); Gates für Einträge und Quellen (kein Stellvertreter-Signal, Fenster als Messbedingung, Provenance je Quellentyp, ADR 0025) | `packages/definitions`, `packages/core`, `packages/domain`, `packages/runtime`, `apps/web` |
| 16. Geführte Diagnose | Prüfabläufe als Daten (Symptom → Hypothesen → Messschritt → Auswertung), Verbraucher von Schritt 15 | ⏳ steht auf Schritt 15: `patterns[]` sind die Hypothesen, `checks[]` die Messschritte mit auswertbarem Fenster, Pattern-IDs sind je Fahrzeug eindeutig und damit adressierbar; offen ist die Ablaufsteuerung (messen → Fenster bewerten → Ergebnis je Muster), was „nicht prüfbar" für einen Ablauf bedeutet, und wie eine Beziehung zwischen zwei Messpunkten ausgedrückt wird — heute stehen für „linke gegen rechte Radgeschwindigkeit" zwei Checks mit demselben Fenster nebeneinander und die Beziehung im `expect`-Text (ADR 0025) | `packages/definitions`, `packages/runtime`, `apps/web` |

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

## Ergebnis der Wissensschicht (Schritt 15, 2026-09-13)

- **Schema v3 statt Wissens-Nebenmodell.** `vehicles[].dtcKnowledge[]` liegt im
  Paket neben den ECUs; `migrate.ts` verkettet jetzt v1 → v2 → v3 und der
  v3-Schritt hebt nur die Version — Wissen darf fehlen, und eine Migration
  erfindet nichts. Eingebaute Pakete deklarieren `CURRENT_SCHEMA_VERSION` statt
  einer Zahl, damit ein Bump nicht an drei Stellen nachgezogen werden muss.
- **Auflösung nach Spezifität, nicht nach Reihenfolge.** `findDtcKnowledge`
  gewichtet Motor 16 · Getriebe 8 · ECU 4 · angenommen 2/1. Ein Eintrag für einen
  anderen Motor ist kein schwacher Treffer, sondern keiner. Muster werden über
  **alle** zutreffenden Einträge gesammelt (spezifischster zuerst, IDs je Fahrzeug
  eindeutig), weil eine motorspezifische und eine variantenweite Ursache sich
  ergänzen, statt sich zu verdrängen.
- **Eine bewusste Ausnahme.** Ist der Antriebsstrang nicht eingeengt und deklariert
  die Variante genau einen Motor, gilt der darauf gescopete Eintrag — unter allem
  Bestätigten und mit Note. Sind mehrere deklariert, wird abgelehnt: ohne Beleg
  wäre die Wahl ein Münzwurf. Praktisch heißt das: Nur-VIN zeigt das Wissen des
  einzigen dokumentierten Motors, nach dem Lesen der Identifikations-DIDs
  verschwindet Annahme samt Note.
- **Schichtung statt Ersetzen.** `EcuDefinition.dtcs[]` bleibt die Basis (sie trägt
  Enable-Bedingungen und Snapshot-Referenzen); `DtcScanner.setVehicle` legt
  Variantenwissen darüber und `enrich(...)` merged `relatedSignals` — Paket plus
  Variante, eindeutig, nur im Paket definierte IDs. `connect()` bindet sofort, weil
  VIN und Identifikation dann gelesen sind; `disconnect()` löst, damit Wissen die
  Sitzung nicht überlebt. Ohne gebundenes Fahrzeug entsteht **kein** `knowledge`.
- **Ehrlichkeit als Datenmodell.** `scope` (vehicle-engine / vehicle-gearbox /
  vehicle / package), `notes[]` (kein Variantenwissen · nur Text · kein
  Zahlenfenster · Antriebsstrang angenommen · Fahrzeug nicht deklariert),
  `checks[].measurable` und `knowledgeProvenance` als Quelle **der angezeigten**
  Aussage (Entry → sonst Fahrzeug, aber nur wenn ein Entry gewann → sonst Paket).
  Der Provenance-Fehler fiel erst in der laufenden Demo auf: paketweit beschriebene
  Codes (C0035, U0121, P0700) trugen die Herkunft des Fahrzeugs und verliehen
  damit einer Variante eine Aussage, die sie nicht getroffen hatte.
- **Keine erfundenen Messpunkte.** `genericPackage` definiert keine Lambda-Sonden
  (PID 0x14–0x1B), also prüft das Katalysator-Muster über Kraftstoffkorrektur und
  Kühlmitteltemperatur und sagt im Text, was das belegt und was nicht. Eine
  erfundene Signal-ID hätte einen Prüfschritt erzeugt, der nie laufen kann.
- **Naht bis in die UI.** `DtcInfo.knowledge` (Domain) → `toDtcKnowledge`
  (`runtime/mappers.ts`) → `DtcView.knowledge` über
  `apps/web/src/dtc-knowledge-view.ts`, dessen Scope- und Likelihood-Labels gegen
  die Union-Typen der Definitionsschicht typisiert sind (ein neuer Scope bricht den
  Build, statt als Rohschlüssel beim Bediener anzukommen). `public/app.js` enthält
  damit kein Vokabular mehr: Muster als Karten, Messpunkte als Tabelle (Messpunkt ·
  Erwartung · Fenster · Bewertung), Reparaturhinweise als solche gelabelt, Notes
  als Warnungen.
- **Was ein Eintrag tragen muss (ADR 0025).** Provenance wird je Quellentyp
  geprüft: `licensed` ohne `license` ist ein Fehler, ohne `version`/`retrievedAt`
  eine Warnung; `standard` ohne Ausgabe warnt; `community` — vorher die einzige
  Kategorie ohne Regel — warnt über ungeklärte Rechte; ein `retrievedAt`, das kein
  ISO-8601-Datum ist, ist ein Fehler. Auf dem Dateipfad verschwindet kein
  Provenance-Feld mehr still: `coerceProvenance` kopierte `notes` nicht, ein
  geladenes lizenziertes Paket verlor also den Satz, der seine Lizenz einschränkt
  (Regressionseintrag, Biss belegt). Und in den Daten selbst: kein
  Stellvertreter-Signal mehr — P0715 „intermittierend" prüfte 30 s die
  Öltemperatur und nannte es einen Dropout-Wächter, obwohl das Paket kein
  Eingangsdrehzahlsignal definiert; jetzt sagt das Muster, was es nicht messen
  kann, und prüft nur die Bedingung. Beide Fehler waren unsichtbar für den
  Compiler: optionale Felder und ein Window ohne Bedeutung sind typkorrekt.
- **Wissen 4 → 6 Codes.** Neu P0700 (drei Muster, das dritte ohne Check, weil kein
  Signal dieses Pakets einen Selbsttest entscheidet; das Gangfenster 3…4 liest die
  `enumMapping` des Pakets) und C0035 (drei auswertbare Fenster 45…55 km/h über 5 s
  — linke Ecke, rechte Ecke, OBD-Geschwindigkeit aus einem anderen Steuergerät —
  plus ein 30-s-Wächter ohne Grenze, also „nur manuell beurteilbar"). `U0121`
  bleibt bewusst ohne Eintrag; ein Test zählt beschriebene gegen dokumentierte
  Codes, damit die Lücke benannt bleibt.
- **Messung.** Suite 1223 → **1300 Tests** in 90 Dateien (25,17 s), Coverage
  global 96,48 Statements / 89,67 Zweige / 97,86 Zeilen, `packages/definitions`
  99,08 Zeilen / 94,15 Zweige, `knowledge.ts` 100 Zeilen / 96,98 Zweige,
  `scanner.ts` 100 / 87,8. Ende-zu-Ende belegt: der Integrationstest scannt nach
  dem Connect und sieht `scope: "vehicle-engine"`, zwei Muster und `notes: []`;
  der Server-Test sieht dieselbe Antwort über HTTP inkl. der deutschen Labels.
  Die Demo zeigt P0420 mit zwei Mustern und fünf auswertbaren Fenstern, P0715 über
  die Getriebe-Achse und C1234 ohne Wissen (Note statt Raten).

**Nächster Schritt (16):** Geführte Diagnose verbraucht dasselbe Wissen — `patterns[]`
sind die Hypothesen, `checks[]` die Messschritte mit auswertbarem Fenster, und eine
Pattern-ID ist je Fahrzeug eindeutig, also adressierbar. Offen ist die
Ablaufsteuerung (messen → Fenster bewerten → Ergebnis je Muster) und was
„nicht prüfbar" für einen Ablauf bedeutet.

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
