# Produktspezifikation §25–§33 — Coding Framework, Safety Layer, Datenschutz, UI, MVP, Phasen, Testing, Simulator, Observability

> **Aus `AGENTS.md` verschoben** (2026-09-22, AGENTS 2.0 — die Wurzel-Datei ist der
> Einstieg, die Volltexte liegen hier). Normativer Teil der Spezifikation: Bauen, Absichern, Bedienen.
> Dieser Kasten ist neu; alles darunter ist **wortgleich** der Stand aus
> `AGENTS.md` 1.44. Abschnitts- und Regelnummern bleiben gültig: `AGENTS 34.12`
> ist §34.12 in [`rules.md`](rules.md), `AGENTS 0.E E15` ist E15 in
> [`backlog.md`](backlog.md).

## 25. Coding Framework

Erst nach stabilem Read-only-System.

Architektur:

```text
Coding Definition
 ↓
Validation
 ↓
Preview
 ↓
Explicit User Confirmation
 ↓
Backup
 ↓
Write
 ↓
Verification
 ↓
Audit Log
```

Jede Änderung speichern:
- aktuelle Werte
- neue Werte
- ECU
- Definition/Version
- Risiko
- Backup
- Zeitpunkt
- Ergebnis

Zuerst nur niedrig-riskante Komfortfunktionen.

Dieser Ablauf ist seit ADR 0032 **ausführbarer Code** und nicht mehr nur ein
Diagramm: Validation/Preview → `describe()` der Operation, Confirmation +
Preconditions → `confirm`-Stufe mit `SafetyManager.requestPermit()`, Backup →
`prepare()`, Write → `execute()`, Verification → `verify()` (Re-Read, nicht
Glauben), Audit → `WritePort.history` plus `SafetyManager.audit`. Eine neue
Operation ist ein `WriteOperation`-Objekt und eine Zeile in
`createWritePort()` (`packages/core/src/writes/standard-operations.ts`) — die
Stufen und das Permit lassen sich dabei nicht umgehen.

Keine frühen Implementierungen zum Umgehen von SFD/SFD2 oder anderer Sicherheits-/Authentifizierungsmechanismen.

## 26. Safety Layer

Jede Schreiboperation muss über einen SafetyManager laufen. Seit ADR 0032 ist
das **strukturell** durchgesetzt und nicht nur eine Konvention: Der Lesepfad
(`DiagnosticEngine`, `DtcAccess`) hat keine Schreibmethode, und `WritePort`
erteilt kein Permit ohne `SafetyManager.evaluate()` — eine Operation, die eine
Vorbedingung hinzufügen möchte (Warnungen), kann keine entfernen
(fail-closed, AGENTS 26).

Seit ADR 0033 gilt dabei: **unbekannt ist nicht erfüllt.** Jede Vorbedingung
endet als *proven*, *violated* oder *unproven*; `unproven` blockiert wie eine
Verletzung und wird getrennt ausgewiesen (`SafetyCheckResult.unproven`,
`DtcClearPrecheckInfo.unproven`). Wer eine Vorbedingung nicht belegen kann, misst
sie — er überspringt sie nicht.

```text
SafetyManager
├── preconditions
├── voltage check
├── vehicle state
├── ECU/session validation
├── backup
├── confirmation
├── rollback availability
└── verification
```

Beispiele:
- Fahrzeug steht
- Batteriespannung ausreichend
- korrekter ECU-Typ
- korrekte Softwarevariante
- korrekte Definition
- sichere Session

Sobald DoIP produktiv genutzt wird, zusätzlich: Netzwerk-Preconditions prüfen (keine unautorisierten Geräte im selben Diagnose-Segment, TLS aktiv, Routing Activation erfolgreich).

## 27. Datenschutz

Fahrzeugdaten können personenbezogen sein. Daher von Anfang an vorsehen:
- lokale Speicherung als Standard
- Cloud optional
- explizite Zustimmung
- Datenlöschung
- Export
- Verschlüsselung sensibler Daten
- VIN/Session-Handling sauber dokumentieren
- bei DoIP zusätzlich: Netzwerkverkehr nicht unverschlüsselt über gemeinsam genutzte Netze senden

## 28. UI-Struktur

```text
Dashboard
├── Fahrzeug
│   ├── Fahrzeugdaten
│   ├── ECU Explorer
│   └── Scan
├── Diagnose
│   ├── Fehler
│   ├── Messwerte
│   ├── Live Data
│   └── Sessions
├── Analyse
│   ├── Graphs
│   ├── Compare
│   └── AI Analysis
├── Coding
├── Reports
└── Settings
```

UI soll später Web/Desktop/Mobile unterstützen können. Business Logic nicht in UI-Komponenten verankern.

## 29. MVP

### Muss funktionieren
- CAN-Adapter verbinden
- Adapterstatus
- Fahrzeugverbindung
- CAN Communication
- ISO-TP
- UDS
- ECU Identification
- VIN
- DTC lesen
- Live-DIDs lesen
- mehrere DIDs gleichzeitig
- Live Dashboard
- synchronisierte Graphen
- Recording
- CSV Export
- JSON Export
- Raw CAN Trace
- Session speichern

### Noch nicht nötig
- komplexes Coding
- SFD/SFD2-Umgehung
- Security-Access-Umgehung
- DoIP-Implementierung
- Cloud
- Mobile App
- Marketplace
- Community
- große KI-Schicht

## 30. Phasen

> **Stand 2026-09-12:** Phase 1 ist implementiert und durch 1066 Tests auf sechs Ebenen abgesichert. Die Engine-Zerlegung (Roadmap-Schritte 8/9) ist vollzogen: `apps/web` spricht ausschließlich über das Command-/Query-Vokabular der Runtime mit dem Fahrzeug, ist `@vdp/core`-frei, und kein Code außerhalb von `@vdp/runtime` erreicht die Engine mehr (Backlog E8 erledigt; Rest: Auflösung der Engine-Klasse selbst, ADR 0014 Phase 4). Phase 2 läuft: OEM-Definition-Pakete existieren als gekennzeichnete Platzhalter, Reports und Session-Persistenz sind gebaut, das DTC-System (Freeze Frames, First/Last-Seen, Safety-gated Clear) ist fertig, die Graphen sind nach AGENTS 16 umgesetzt, die erste KI-Analyse ist ein lokaler Heuristik-Provider hinter der Provider-Abstraktion. Industriestandard-Härtung (ADR 0016) ist gemergt: Biome, Coverage-Gates grün, CI-Matrix mit Quality + Security, `LICENSE`/`CONTRIBUTING`/`CODEOWNERS`.

### Phase 1
```text
CAN Adapter
 → ISO-TP
 → UDS
 → ECU Explorer
 → Live Data
 → Graphs
 → Logging
 → Export
```

### Phase 2
```text
Multi-ECU
 → OEM Definition Packages
 → DTC/Freeze Frames
 → Reports
 → Session Compare
 → erste KI-Analyse
```

### Phase 3
```text
DoIP
 → weitere Adapter
 → mehrere Hersteller
 → Coding Framework
 → Service Functions
 → Mobile/Desktop Ausbau
```

### Phase 4
```text
Carly-like Feature Set
 → Guided Diagnostics
 → AI Knowledge Base
 → Workshop Mode
 → Community/Fleet Features
 → Commercial Definition Packages
```

## 31. Testing

Mindestens:
- Unit Tests
- Integration Tests
- Protocol Tests
- Simulator Tests
- Replay Tests
- Regression Tests

Jeder gefundene Protokoll-/Decoderfehler soll möglichst als reproduzierbarer Testfall festgehalten werden.

## 32. Simulator

Vor echter Fahrzeughardware ein virtueller ECU-Simulator. Er beantwortet nicht nur
Diagnosefragen — er **verhält sich wie ein Fahrzeug**, damit eine Diagnose etwas hat, das
sie finden kann (ADR 0040).

```text
Virtual ECU
├── Identification
├── VIN
├── DIDs            ← registerDid()/registerWritableDid(), keine Casts in interne Maps
├── DTCs            ← setDtc()/removeDtc(): der Fehlerspeicher ist API
├── UDS sessions
├── timing
└── responses

Virtual Vehicle (HighFidelityVehicle)
├── VehicleBehaviourModel      ← Versorgung, Motor, Räder, Integration in Modellzeit
│   ├── monitors[]             ← Bedingung + Debounce + Hysterese, dokumentierte Codes nur
│   ├── ModuleWiring           ← power-cut / supply-resistance / connector-loose / bus-open
│   └── vehicle-signals        ← eine Abbildung Modellzustand → Signal-Id (DID, Freeze Frame, Live)
├── VirtualCanNetwork.impair() ← Störungen auf dem Draht, beide Richtungen, zählbar
└── HEARTBEAT_IDS + gateway-ear ← „lost communication" ist eine Messung eines Nachbarn
```

```text
Application
 ↓
Simulator  (Ursache → Modell → Reaktion des Moduls)
 ↓
UDS
 ↓
ISO-TP
 ↓
Virtual CAN
```

**Regeln für den Simulator:**

1. Ein Fehler wird nicht gesetzt, er entsteht: eine Ursache (Spannung, Widerstand,
   Sensorabweichung, Leitungsstörung) ändert einen physikalischen Zustand, und eine
   Monitorregel lacht den Code, wenn der Zustand länger als der Debounce anhält.
2. Ein Modul dokumentiert nur, was sein Definitions-Paket kennt. Ein undokumentierter Code
   wird nicht aufgezeichnet — sonst meldet ein Scan eine Zahl ohne Erklärung (AGENTS 20.1).
3. Modellzeit ist eigen: `advance(ms)` in festen Schritten; dieselbe Anzahl Schritte liefert
   dasselbe Ergebnis, unabhängig davon, wie der Aufrufer schneidet. Wer die Szenarien im
   Demo-Takt laufen lässt, pausiert den Realtime-Loop für die Dauer des Laufs.
4. Ein Szenario ist Daten (`VehicleScenario`): Ursachen mit Modellzeit, Bedingungen am
   Zustand, Erwartungen an den Fehlerspeicher — mit `because`. Dasselbe Objekt treibt Test,
   Simulation und Workbench; `closedWorld` macht jeden nicht vorhergesagten Latch zu einem
   Fehlschlag.
5. Was der Simulator über UDS antwortet, ist die einzige Wahrheit für einen Test:
   erst die Kette `Ursache → 0x19 → IR → Evidence` beweist, dass ein Fehler gefunden werden
   kann und nicht nur gesetzt wurde (AGENTS 31, 34.9).

## 33. Observability

Strukturierte Logs für:
- Connection
- CAN
- ISO-TP
- UDS
- ECU
- Decoder
- UI
- AI

Level:
`ERROR`, `WARN`, `INFO`, `DEBUG`, `TRACE`

Raw protocol logging optional.

