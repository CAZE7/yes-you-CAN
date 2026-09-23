# Produktspezifikation §9–§21 — Diagnosekern, Session, Fahrzeugidentität, ECU Explorer, Definitionen, Messwerte, Graphen, Logging, Trace, Replay, DTC, Bericht

> **Aus `AGENTS.md` verschoben** (2026-09-22, AGENTS 2.0 — die Wurzel-Datei ist der
> Einstieg, die Volltexte liegen hier). Normativer Teil der Spezifikation: der Diagnosepfad.
> Dieser Kasten ist neu; alles darunter ist **wortgleich** der Stand aus
> `AGENTS.md` 1.44. Abschnitts- und Regelnummern bleiben gültig: `AGENTS 34.12`
> ist §34.12 in [`rules.md`](rules.md), `AGENTS 0.E E15` ist E15 in
> [`backlog.md`](backlog.md).

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
- Fahrzeugbestimmung aus Belegen (§11.1, ADR 0026): welche Variante mit welchem score,
  welchen Belegen und welchen Widersprüchen sie dran war
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

### 11.1 Bestimmung aus Belegen (verbindlich, ADR 0023)

Fahrzeugidentität wird bestimmt, nicht geraten:

1. **Eingabe** ist, was bekannt ist: VIN, Identifikationswerte je Steuergerät
   (mit `ecu`, `oem`, `did`, `value`), die Adressen, die geantwortet haben, und
   was der Bediener oder eine frühere Session angibt (`declared`).
2. **Ausgabe** ist eine Rangliste von Kandidaten mit `score` (Anteil der
   bestätigten Gewichte an allen geprüften) sowie `evidence[]` und `conflicts[]`
   — je Kriterium `observed`, `expected`, `weight`, `reason` — dazu `unresolved`,
   `notes` und `unexplained`.
3. **Kein Kandidat ohne Beleg.** `score <= 0` erscheint nicht. Ein leeres
   Ergebnis ist eine gültige Antwort und trägt einen Grund („kein Paket deklariert
   Fahrzeugdefinitionen"), nie eine leere Maske.
4. **Widersprüche bleiben sichtbar.** Sie werden nicht verrechnet, nicht
   versteckt und nicht zu einer „Konfidenz" zusammengeschmolzen.
5. **Attributionsregel.** Ein Identifikationswert kann nur widersprechen, wenn
   seine DID im Paket als Teilenummer, Software- oder Hardwarestand dokumentiert
   ist. Werte ohne dokumentierte Art (Seriennummern, Werkstattcodes) stützen bei
   Treffer und sind sonst neutral.
6. **Namensraum.** Identifikationsfakten tragen `oem` und das nackte ECU-Id;
   Belege aus einem fremden Paket zählen nicht.
7. **Angaben wiegen weniger als der Bus.** `declared` ist ein Kriterium mit
   eigenem Gewicht, kein Filter: widerspricht die Busspur, gewinnt die Busspur,
   und der Widerspruch steht im Ergebnis.
8. **Provenance bricht nur Gleichstände** (ADR 0003): `own`/`standard`/`licensed`
   1,0 · `community` 0,8 · `reverse-engineered` 0,6 · `example-placeholder` 0,3.
   Ein Treffer auf Platzhalterdaten muss als solcher gekennzeichnet sein.
9. **Read-only.** Auflösung schreibt nichts auf den Bus und ändert keine Session
   (§25/§26 bleiben unberührt). Sie ist eine Query, kein Command.

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

Das Zeitbudget der Discovery ist explizit und gehört zum Command-Vokabular:
`windowMs` begrenzt die beiden Hörphasen, `probeDelayMs` die Pause zwischen zwei
Einzelprobes — insgesamt `windowMs + Kandidaten × probeDelayMs` (ADR 0019).
Realverkehr fährt den Default (1200 ms / 15 ms), Simulator und Tests ein kleines
Budget, weil `VirtualCanNetwork` ohne `latencyMs` verzögerungsfrei antwortet.

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

### 13.1 Fahrzeuge im Paket (Schema v2, ADR 0023)

Zusätzlich zu ECUs, DIDs und Signalen trägt ein Paket `vehicles[]`: Marke,
Modell, Plattform, Generation, Karosserieformen, Modelljahre, `vinMatch`
(WMI-Liste, VDS-Muster, Modelljahr- und Werkzeichen), Motoren und Getriebe mit
Kennungen (`codes`) sowie je Fahrzeug die zugehörigen ECUs mit Teilenummern,
Softwareständen und optional `engine`/`gearbox`/`optional`.

Verbindlich:

- **Schema-Version und Migration.** `schemaVersion` ist Pflicht; ältere Pakete
  werden über einen expliziten Schritt gehoben (`migrate.ts`), nie über
  stillschweigende Annahmen. Eine unterstützte Version ohne Migrationsschritt ist
  ein Fehler.
- **Semantische Prüfung.** Unbekannte ECU-/Motor-/Getriebereferenzen, doppelte IDs
  und VIN-Matching mit in VINs verbotenen Zeichen (I, O, Q) sind Fehler, keine
  Warnungen; fehlende Einheiten und leere Enum-Mappings sind Warnungen.
- **Referenzdaten getrennt.** Standardwissen (WMI nach ISO 3780) liegt mit eigener
  Provenance neben den OEM-Paketen, nicht in der Engine.
- **Provenance je Fahrzeug.** Ein Paket darf dokumentierte und beispielhafte
  Fahrzeuge mischen; die Herkunft wird je Fahrzeug angegeben und erreicht die UI
  (§24).

### 13.2 DTC-Wissen pro Variante (Schema v3, ADR 0024)

Ein Fahrzeug trägt `dtcKnowledge[]`: je `code` mit optional `ecu`/`engine`/`gearbox`
(Scope) Texte, `patterns[]` (Ursache, Erklärung, `likelihood`, `repair`) und darin
`checks[]` (`signal`, `expect`, `min`/`max`, `windowMs`).

Verbindlich:

- **Auflösung nach Spezifität.** `findDtcKnowledge(packages, query)` gewichtet
  Motor 16 · Getriebe 8 · ECU 4 · angenommen 2/1. Ein Eintrag für einen anderen
  Motor ist kein schwacher Treffer, sondern keiner. Muster werden über alle
  zutreffenden Einträge gesammelt (spezifischster zuerst), Texte kommen aus dem
  spezifischsten Eintrag, sonst aus der Definition des lesenden Steuergeräts.
- **Nur deklarierte Signale.** Eine Prüfung referenziert ein Signal aus dem Paket.
  Fehlt das Signal, fehlt die Prüfung — eine erfundene Signal-ID erzeugt einen
  Prüfschritt, der nie laufen kann.
- **Kein Stellvertreter-Signal.** Ein Check muss den Fehler beobachten können, zu
  dem er gehört. Kann das Paket ihn nicht beobachten, sagt das Muster das in
  `explanation` und prüft nur die Bedingung, unter der der Fehler auftritt
  (ADR 0025).
- **Fenster sind Messbedingungen.** `min`/`max` nennen die Bedingung im
  `expect`-Text (Testgeschwindigkeit, Temperatur), nicht eine Toleranz aus einer
  Kalibrierung. Ein numerisches Fenster für ein Enum-Signal ist nur zulässig, wenn
  es die `enumMapping` desselben Pakets liest.
- **Eine Lücke ist eine Entscheidung.** Ein Code ohne Varianteneintrag bleibt
  paketweit, wenn die Variante nichts beitragen kann (ein Kommunikationscode
  bedeutet für jeden Motor dasselbe). Beschriebene und dokumentierte Codes werden
  gegeneinander gezählt, damit die Differenz benannt bleibt (ADR 0025).
- **Annahme nur bei Eindeutigkeit.** Ohne Eingrenzung des Antriebsstrangs gilt ein
  motor-/getriebegescoper Eintrag nur, wenn genau ein Motor (bzw. Getriebe)
  deklariert ist; dann steht er unter allem Bestätigten und mit Note.
- **Pattern-IDs sind je Fahrzeug eindeutig.** Damit sind Muster global adressierbar
  (Verbraucher: Schritt 16, Geführte Diagnose).
- **Provenance je Eintrag.** Wissen ohne Herkunft ist ein Fehler; ein
  Reparaturhinweis ohne Provenance ist eine Warnung (§24, Rechtefrage).
- **Migration erfindet nichts.** v2→v3 hebt die Version; Wissen darf fehlen, dann
  bleibt die paketweite Beschreibung stehen (§20.1).

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

Über das Fahrzeug gebundenes Variantenwissen (§13.2, ADR 0024) erweitert den
Datensatz:

```text
Scope (vehicle-engine / vehicle-gearbox / vehicle / package)
Fahrzeug (id, name, Provenance der angezeigten Aussage)
Bedingungen (wann der Code setzt)
Ausfallmuster (id, name, Erklärung, likelihood, Reparatur, Checks)
Notes (kein Variantenwissen / nur Text / kein Zahlenfenster / angenommen)
Checks (Signal, Erwartung, min/max, windowMs, measurable)
```

Funktionen:
- Scan all ECUs
- Read DTCs
- Details
- Snapshot
- Before/After Compare
- Clear DTCs mit expliziter Bestätigung

### 20.1 Variantenwissen und Ehrlichkeit (ADR 0024)

- **Schichtung statt Ersetzen.** `EcuDefinition.dtcs[]` bleibt die Basis (sie trägt
  Enable-Bedingungen und Snapshot-Referenzen); Variantenwissen überschreibt
  Description/Severity/Hint und merged `relatedSignals`.
- **Bindung.** `DtcScanner.setVehicle(context)` schaltet es ein, `connect()` bindet
  das aufgelöste Fahrzeug sofort, `resolve(hints)` bindet neu, `disconnect()` löst.
  Ein Scanner, der ein Fahrzeug trägt, darf beim Verbinden kein paketweites Wissen
  zeigen.
- **Ohne gebundenes Fahrzeug entsteht kein `knowledge`.** Die paketweite
  Beschreibung steht bereits am Record; sie als Variantenwissen auszugeben wäre
  genau die Verwechslung, gegen die die Fahrzeugachse existiert.
- **Die Aussage verrät ihre Quelle.** `scope`, `notes[]`, `checks[].measurable` und
  `knowledgeProvenance` (Entry → sonst Fahrzeug, aber nur wenn ein Entry gewann →
  sonst Paket) machen sichtbar, woraus ein Satz besteht und welche Messung er
  nicht trägt.

## 21. Diagnosebericht

Automatische Reports vorsehen:
- Fahrzeug
- Vehicle determination (§11.1, ADR 0026): Beleglage, trust, Abdeckung, weitere Kandidaten
- VIN
- Datum
- Laufleistung
- ECU Overview
- DTC Summary
- Variant knowledge (§20.1, §23): Scope, Ursache-Reihenfolge, Messfenster, Quelle,
  offene Punkte — und der Unterschied zwischen „nichts dokumentiert" und „nie gefragt"
- Messwert-Anomalien
- Sessions
- Notes
- Empfehlungen

PDF exportieren.

