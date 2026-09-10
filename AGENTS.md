# AGENTS.md — Vehicle Diagnostics Platform

> **Version:** 1.1 · **Letzte Änderung:** 2026-09-10
> **Changelog:**
> - 1.1: Norm-Referenzen ergänzt (ISO 14229-2, ISO 15765-2, ISO 13400-1/2/3, ISO 3779), UDS-Timing-Parameter, DoIP-Discovery-Flow, Glossar, DoIP-Netzwerksicherheit.
> - 1.0: Erste Fassung.

## 0. Glossar

| Begriff | Bedeutung |
|---|---|
| ECU | Electronic Control Unit — Steuergerät im Fahrzeug |
| DID | Data Identifier — adressierbarer Datenpunkt in einem Steuergerät (z. B. Kühlmitteltemperatur) |
| DTC | Diagnostic Trouble Code — gespeicherter Fehlercode |
| UDS | Unified Diagnostic Services, ISO 14229 — Anwendungsschicht-Protokoll für Diagnose |
| ISO-TP / DoCAN | ISO 15765-2 — Transportprotokoll, das UDS-Nachrichten über 8-Byte-CAN-Frames segmentiert |
| DoIP | Diagnostic communication over Internet Protocol, ISO 13400 — Diagnose über Ethernet/IP statt CAN |
| VIN | Vehicle Identification Number, ISO 3779 — eindeutige 17-stellige Fahrzeugkennung |
| SFD / SFD2 | Security Fault Detection — herstellerseitiger Schutzmechanismus gegen unautorisierte Codierung/Freischaltung |
| P2 / P2\* | UDS-Timing-Parameter: max. Antwortzeit einer ECU (P2) bzw. nach „Response Pending“ (P2\*) |

## 1. Ziel

Dieses Repository soll langfristig eine moderne, modulare, herstellerübergreifende Kfz-Diagnoseplattform werden — funktional ungefähr in der Klasse von Carly/OBDeleven, aber mit eigener, sauberer Architektur und späterer KI-gestützter Diagnose.

Der **erste Release muss mit einem normalen CAN-Adapter funktionieren**. Die Architektur darf dadurch aber niemals auf CAN-only festgelegt werden.

Langfristig vorbereiten auf:
- CAN / CAN-FD
- DoIP
- mehrere Adapter
- mehrere Hersteller
- UDS / weitere Diagnoseprotokolle
- ECU Explorer
- Live-Messwerte
- synchronisierte Graphen
- Logging / Replay / Exporte
- DTC-Diagnose
- Reports
- ausgewählte Komfortcodierungen
- KI-Diagnose
- optional Cloud/Mobile/Desktop

## 2. Architekturprinzip

Nicht „CAN-Logger plus spätere Erweiterungen“ bauen, sondern eine Plattform:

```text
UI
 ↓
Application Layer
 ↓
Diagnostic Engine
 ↓
Transport Layer
 ↓
Adapter Layer
 ↓
Vehicle
```

Die Schichten müssen entkoppelt sein. UI darf niemals CAN-Frames direkt interpretieren. Herstellerlogik gehört nicht in die CAN-Schicht.

**Begründung der Trennung Transport ↔ Diagnostic Engine:** ISO 14229-2 definiert UDS-Sessiondienste explizit *transportunabhängig* — dieselbe UDS-Logik muss über CAN (via ISO 15765-2) oder DoIP (via ISO 13400) laufen können, ohne dass der Diagnosekern etwas vom Transport weiß. Das ist keine Design-Präferenz, sondern folgt direkt aus dem Normstandard.

## 3. Empfohlene Repository-Struktur

```text
apps/
  web/
  desktop/
packages/
  core/
    vehicle/
    session/
    diagnostics/
    measurements/
    dtc/
    logging/
  transport/
    can/
    iso-tp/
    doip/
  adapters/
    generic-can/
    socketcan/
    elm327/
    canable/
  protocols/
    uds/
    kwp2000/
    oem/
  definitions/
    schema/
    generic/
    vag/
    mercedes/
  storage/
  reports/
  ai/
  shared/
tools/
  definition-importer/
  trace-analyzer/
  simulators/
tests/
docs/
AGENTS.md
```

Die konkrete Technologie darf dem bestehenden Repository angepasst werden. Die Verantwortlichkeiten müssen erhalten bleiben.

## 4. Adapter-Abstraktion

Diagnosecode darf nie von einem bestimmten Adapter abhängen.

```ts
interface VehicleTransport {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(data: Uint8Array): Promise<void>;
  receive(timeoutMs?: number): Promise<Uint8Array | null>;
  getStatus(): ConnectionStatus;
}
```

Später müssen mindestens möglich sein:
- Generic CAN
- SocketCAN
- CANable
- PCAN
- Vector
- ELM327/OBDLink
- DoIP
- eigener Adapter

Capability-Modell vorsehen:

```ts
interface AdapterCapabilities {
  can: boolean;
  canFd: boolean;
  doip: boolean;
  isoTpOffload: boolean;
  channels: number;
}
```

## 5. Kommunikationsschichten

Strikt trennen, mit Normreferenz pro Schicht:

```text
CAN Frame          (physikalisch, kein Standard nötig)
 ↓
ISO-TP             ISO 15765-2 — Segmentierung/Reassembly für 8-Byte-CAN-Payloads
 ↓
UDS Session Layer  ISO 14229-2 — transportunabhängige Session-/Timing-Dienste
 ↓
UDS Application    ISO 14229-1 — Diagnostic Services (0x10, 0x22, 0x19, ...)
 ↓
OEM/ECU Definition — herstellerspezifische Interpretation der DIDs/DTCs
 ↓
Decoded Diagnostic Data
```

DoIP muss später als alternativer Transport unterhalb der UDS-Schicht eingefügt werden können:

```text
                 Diagnostic Engine
                        │
                 Transport Interface
                  ┌─────┴─────┐
                 CAN         DoIP
              (ISO 15765-2) (ISO 13400)
```

Die UDS-Engine darf nicht wissen, ob sie CAN oder DoIP verwendet — das ist durch ISO 14229-2 explizit vorgesehen.

## 6. CAN-Layer

CAN bleibt reine Transport-/Frame-Schicht.

```ts
interface CanFrame {
  timestamp: number;
  id: number;
  extended: boolean;
  fd: boolean;
  dlc: number;
  payload: Uint8Array;
  channel: string;
}
```

Keine UDS- oder Herstellerlogik in dieser Schicht.

## 7. ISO-TP (ISO 15765-2)

Eigenständige Implementierung bzw. gekapselte Library für:
- Single Frame
- First Frame
- Consecutive Frame
- Flow Control
- Timeouts
- Retries
- Fehlerzustände

## 8. DoIP-Layer (ISO 13400)

Muss als eigenständiger Transport unterhalb der UDS-Schicht implementiert werden, mit folgendem Ablauf:

```text
1. UDP Vehicle Identification / Announcement
   → Discovery im lokalen Netz, Fahrzeug meldet VIN + Logical Address
2. TCP-Verbindungsaufbau
   → Standard-Port 13400, TLS-Variante Port 3496
3. Routing Activation Request/Response
   → Tester authentisiert sich, ECU-Routing wird freigeschaltet
4. UDS-Payload über TCP (UDSonIP, ISO 14229-5)
```

**Sicherheitshinweis:** DoIP läuft über Ethernet/IP und hat damit eine grundsätzlich andere Angriffsfläche als CAN. Netzwerksegmentierung, keine offene Diagnoseschnittstelle ins allgemeine Fahrzeugnetz und TLS-Nutzung sind vorzusehen, sobald DoIP implementiert wird (siehe auch Abschnitt 25 Safety Layer und Abschnitt 26 Datenschutz).

## 9. Diagnosekern

Abstraktionen vorsehen für:
- DiagnosticSession
- DiagnosticService
- DiagnosticRequest
- DiagnosticResponse
- DiagnosticResult
- DiagnosticError

Initial relevante UDS-Services (ISO 14229-1):
- 0x10 Diagnostic Session Control
- 0x11 ECU Reset
- 0x19 Read DTC Information
- 0x22 Read Data By Identifier
- 0x27 Security Access (zunächst nur abstrahieren)
- 0x2E Write Data By Identifier (später)
- 0x31 Routine Control (später)
- 0x3E Tester Present
- 0x14 Clear Diagnostic Information
- 0x2F Input Output Control (später)

**Timing-Parameter (ISO 14229-2) verbindlich abbilden:**
- `P2Client`: maximale Wartezeit auf die erste ECU-Antwort.
- `P2*Client`: maximale Wartezeit nach einer „Response Pending“ (NRC 0x78)-Antwort.
- Diese Werte müssen konfigurierbar pro ECU/Definition Package sein, nicht global hartkodiert, da Steuergeräte unterschiedliche Timeouts melden können.

Read-only zuerst.

## 10. Vehicle Session

Jede Fahrzeugverbindung ist eine Session.

```ts
interface VehicleSession {
  id: string;
  startedAt: Date;
  vehicle?: VehicleIdentity;
  adapter: AdapterInfo;
  transport: TransportInfo;
  selectedEcus: EcuSession[];
}
```

Sessions müssen speicherbar und später wieder öffnbar sein.

Session umfasst später:
- VIN/Fahrzeugidentität
- ECU-Liste
- DTC-Snapshot
- Messwertaufzeichnungen
- Raw Trace
- Diagnoseaktionen
- User Notes
- Reports

## 11. Fahrzeugidentität

Nicht nur Modellname speichern.

```text
VIN            (ISO 3779, 17-stellig, inkl. Prüfziffer)
Hersteller
Marke
Modell
Baujahr/Model Year
Plattform
Motor
Getriebe
ECUs
```

VIN automatisch erkennen, wenn verfügbar. Prüfziffer-Validierung (ISO 3779 Position 9) einbauen, um Lesefehler von Übertragungsfehlern zu unterscheiden.

## 12. ECU Explorer

Nach dem Verbinden möglichst systematisch erreichbare ECUs erkennen und darstellen.

```text
ECU
├── Name
├── Adresse
├── Protokoll
├── Identification
├── Part Number
├── Software Version
├── Hardware Version
├── VIN
├── Supported Services
├── DTCs
└── Available Measurements
```

Discovery nicht auf einen Hersteller hardcoden.

## 13. OEM-/Diagnosedefinitionen

Hersteller-/ECU-spezifische Informationen dürfen nicht in UI und Diagnosecode verstreut werden.

Normalisiertes Modell vorsehen:

```text
Definition Package
 ↓
Parser/Importer
 ↓
Normalized Diagnostic Model
 ↓
Diagnostic Engine
```

Das Modell soll u. a. aufnehmen können:
- OEM
- ECU
- DID
- Service
- Request
- Response
- Byte-/Bit-Offset
- Length
- Endianness
- signed/unsigned
- Scaling
- Offset
- Unit
- Min/Max
- Enum Mapping
- Beschreibung
- Version
- Source/Provenance

Definition Packages selbst müssen semantisch versioniert werden (z. B. SemVer), damit Sessions, die mit einer älteren Definition aufgezeichnet wurden, nachvollziehbar bleiben, auch wenn sich die Definition später ändert.

## 14. Messwert-Engine

Raw Response darf nie direkt in der UI interpretiert werden.

```text
Raw Response
 ↓
Decoder
 ↓
Signal
 ↓
Value + Unit
 ↓
UI / Logger / Analysis
```

Beispiel:

```json
{
  "id": "engine.coolant_temperature",
  "ecu": "engine",
  "did": "0x1234",
  "offset": 0,
  "length": 2,
  "encoding": "uint16",
  "scale": 0.1,
  "offsetValue": -40,
  "unit": "°C"
}
```

## 15. Parallel-Livewerte

Mehrere Signale müssen gleichzeitig aufgezeichnet werden können.

Jeder Datenpunkt braucht einen präzisen Timestamp:

```json
{
  "timestamp": "2026-09-10T11:20:31.481Z",
  "signal": "engine.rpm",
  "value": 2384,
  "unit": "rpm"
}
```

Raw value und decoded value getrennt speichern.

**Nebenläufigkeit:** Da mehrere DIDs quasi-parallel abgefragt werden (Polling oder ECU-seitiges Multi-Response), muss die Implementierung klar festlegen, ob Requests sequenziell pro ECU-Session serialisiert werden (UDS erlaubt i. d. R. keine parallelen Requests auf derselben Session) oder ob mehrere ECU-Sessions parallel über getrennte Transport-Channels laufen.

## 16. Graph-System — zentrale Funktion

Das Produkt soll eine deutlich bessere Messwertanalyse ermöglichen als einfache Diagnose-Apps.

Pflicht:
- beliebig viele Signale
- gemeinsame Zeitachse
- Zoom
- Pan
- Cursor
- Marker
- Zeitraum auswählen
- automatische Skalierung
- individuelle Y-Achsen
- Ein-/Ausblenden
- Min/Max/Durchschnitt
- Delta
- Event-Marker

Später:
- DTC-Marker auf Zeitachse
- Diagnoseaktionen als Marker
- Session-Vergleich
- synchronisierte Cursor über mehrere Charts

Beispiel:

```text
Zeit ─────────────────────────────────────>

RPM       /───────\________
Boost     /───────\________
Lambda    ────────\____/───
                    │
                    ▼
                 DTC event
```

## 17. Logging

Von Anfang an sauber entwerfen.

Speichern:
- Session Metadata
- Fahrzeugidentität
- ECU
- Signal
- Timestamp
- Raw Data
- Decoded Value
- Unit
- DTC Events
- Requests/Responses
- Adapter Metadata

Exporte:
- CSV
- JSON
- ZIP Session Package
- PDF Report

Später ggf. Parquet/API/Cloud.

## 18. Raw CAN Trace

Zusätzlich zum dekodierten Messwert-Logging muss optional ein kompletter Raw-Trace möglich sein:

```text
timestamp
can_id
direction
dlc
payload
channel
```

Damit müssen Diagnoseprobleme später reproduzierbar analysierbar sein.

## 19. Trace Replay

Gespeicherte CAN/UDS-Traces müssen später wieder abgespielt werden können:

```text
Recorded Trace
 ↓
Replay Engine
 ↓
Diagnostic Engine
```

Das ist wichtig für Entwicklung und Regressionstests ohne Fahrzeug.

## 20. DTC-System

DTC-Datenmodell:

```text
Code
Raw Code
ECU
Status
Description
Severity
Freeze Frame / Environment Data
First Seen
Last Seen
Related Signals
```

Funktionen:
- Scan all ECUs
- Read DTCs
- Details
- Snapshot
- Before/After Compare
- Clear DTCs mit expliziter Bestätigung

## 21. Diagnosebericht

Automatische Reports vorsehen:
- Fahrzeug
- VIN
- Datum
- Laufleistung
- ECU Overview
- DTC Summary
- Messwert-Anomalien
- Sessions
- Notes
- Empfehlungen

PDF exportieren.

## 22. KI-Schicht

KI als austauschbaren Service abstrahieren.

```ts
interface DiagnosticAnalysisProvider {
  analyze(input: DiagnosticAnalysisInput): Promise<DiagnosticAnalysisResult>;
}
```

Architektur:

```text
Diagnostic Data
 ↓
Analysis Service
 ↓
AI Provider
 ├── Cloud Model
 └── Local Model
```

KI soll später:
- DTCs erklären
- Symptome zusammenfassen
- relevante Messwerte auswählen
- nächste Diagnoseschritte vorschlagen
- Logs/CSV/JSON analysieren
- Graphen analysieren
- zeitliche Korrelationen erkennen
- Berichte erstellen

Antworten müssen klar unterscheiden zwischen:
- Fact
- Observation
- Hypothesis
- Recommendation

Keine Scheinsicherheit bei Diagnosen.

## 23. Knowledge Base

Später eigene strukturierte Wissensbasis:

```text
DTC Definitions
DID Definitions
ECU Information
Vehicle Variants
Known Failure Patterns
Measurement Relationships
Repair Information
Legal/Licensed Documentation
Community Knowledge
```

Jede Quelle braucht Provenance.

```json
{
  "sourceType": "licensed",
  "source": "OEM documentation",
  "license": "...",
  "version": "...",
  "retrievedAt": "..."
}
```

## 24. Datenherkunft / Commercial Readiness

Von Anfang an Source-/License-Metadaten vorsehen.

Keine ungeklärten Daten aus kommerziellen Wettbewerbsprodukten übernehmen. Insbesondere keine direkte Kopie von Datenbanken oder proprietären Definitionen aus Carly, OBDeleven, VCDS, XENTRY, ODIS, VCP etc., sofern keine entsprechenden Rechte vorliegen.

Eigenes Datenmodell, eigene Softwarelogik und sauber dokumentierte/lizenzierte Quellen bevorzugen.

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

Keine frühen Implementierungen zum Umgehen von SFD/SFD2 oder anderer Sicherheits-/Authentifizierungsmechanismen.

## 26. Safety Layer

Jede Schreiboperation muss über einen SafetyManager laufen.

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

Vor echter Fahrzeughardware einen virtuellen ECU-Simulator schaffen.

```text
Virtual ECU
├── Identification
├── VIN
├── DIDs
├── DTCs
├── UDS sessions
├── timing
└── responses
```

Beispiel:

```text
Application
 ↓
Simulator
 ↓
UDS
 ↓
ISO-TP
 ↓
Virtual CAN
```

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

## 34. Regeln für Coding Agents

Der Coding Agent MUSS:

1. Das bestehende Repository zuerst analysieren.
2. Bestehende Architektur wiederverwenden, statt parallel ein zweites System zu bauen.
3. Keine monolithische Diagnoseklasse erstellen.
4. Keine CAN-/UDS-Logik direkt in UI-Komponenten schreiben.
5. Herstellerdaten in Definition Packages kapseln.
6. Interfaces für austauschbare Adapter/Transporte/AI-Provider verwenden.
7. Raw und decoded data getrennt halten.
8. Neue Funktionen testbar implementieren.
9. Für Tests Simulator/Replay statt echtes Fahrzeug verwenden.
10. Jede Diagnoseoperation sauber loggen.
11. Read-only vor Write-Funktionen priorisieren.
12. Sicherheitsmechanismen nicht umgehen.
13. Datenbankmigrationen versionieren.
14. Alte gespeicherte Sessions möglichst kompatibel halten.
15. Architekturentscheidungen dokumentieren.
16. Keine Secrets/API-Keys in den Quellcode schreiben.
17. Keine proprietären Konkurrenzdaten ungeklärt übernehmen.
18. Bei Unklarheit über Norm-Details (UDS-Service-Byte, DTC-Format, DoIP-Header) die relevante ISO-Nummer im Code-Kommentar referenzieren, statt Annahmen zu treffen.

## 35. Definition of Done

Eine Funktion gilt erst als fertig, wenn mindestens vorhanden sind:

```text
Implementation
+ Error Handling
+ Unit/Integration Tests
+ Logging
+ UI Integration
+ Documentation
```

Nicht nur „läuft bei mir“.

## 36. Oberstes Architekturziel

Das MVP darf klein sein. Die Architektur darf nicht klein gedacht sein.

Ziel:

```text
             Web / Desktop / Mobile
                      │
                Application Core
                      │
                Diagnostic Engine
                      │
             Transport Abstraction
                ┌─────┴─────┐
               CAN         DoIP
            (ISO 15765-2) (ISO 13400)
                │            │
             Adapter      Ethernet
                └─────┬──────┘
                      │
                    Vehicle
```

**Das Projekt ist keine CAN-Logger-App. Es ist eine erweiterbare Fahrzeugdiagnoseplattform, deren erste Ausbaustufe lediglich über einen normalen CAN-Adapter arbeitet.**
