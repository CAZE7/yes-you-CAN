# AGENTS.md — Vehicle Diagnostics Platform

> **Version:** 1.47 · **Letzte Änderung:** 2026-09-24
> **Changelog:** [`docs/changelog/agents-contract.md`](docs/changelog/agents-contract.md) —
> die Milestone-Geschichte dieses Vertrags, ausgelagert am 2026-09-24, weil sie 65 % der
> Bytes dieser Datei war und keine Norm enthält. Was gilt, steht hier.
> **Stand (0.A):** [`docs/architecture/status.md`](docs/architecture/status.md) ·
> **Backlog (0.E):** [`docs/architecture/backlog.md`](docs/architecture/backlog.md)
>
> **Geltungsordnung:** Diese Datei ist normativ für das *Produkt*. ADRs in `docs/adr/` sind normativ für *Architektur- und Toolchain-Entscheidungen*. Bei Widerspruch zwischen Dokumentation und Repository gilt das Repository — und die Differenz wird im selben PR dokumentiert (Regel 34.24).

---

# Teil 0 — Für Coding Agents: zuerst lesen

Dieser Teil steht bewusst vor der Spezifikation. Er sagt dir, *was schon existiert*, *wie du arbeitest* und *wo die harten Grenzen sind*. Die Abschnitte 0–36 dahinter bleiben die normative Produktspezifikation.

## 0.0 AI Engineering Contract (verbindlich, ADR 0043)

Dieses Repository ist ein **AI-natives Repository** gebaut: die Architektur
steht einmal, maschinenlesbar, in [`architecture/architecture.yaml`](architecture/architecture.yaml)
(Layer, `mayImport`-Kanten, AI-Context-Topics), und die Doku-Ebene
([`ARCHITECTURE.md`](ARCHITECTURE.md), Package-READMEs, `docs/code-map.md`,
`docs/glossary.md`, `docs/api/*`, `docs/flows/*`, [`.ai/`](.ai/README.md))
verweist darauf — keine zweite Regel-Kopie existiert, eine zweite Kopie ist
ein Defekt (ADR 0031/0042/0043).

**Vor jeder Codeänderung — in dieser Reihenfolge:**

1. Lies `architecture/architecture.yaml` → Layer + `mayImport` deines Pakets.
2. Lies die Package-`README.md` des Ziel-Pakets (v. a. „Does NOT do“).
3. Identifiziere die architektonische Grenze, die du berührst (siehe
   [`ARCHITECTURE.md` → „Die harten Verträge“](ARCHITECTURE.md)).
4. Finde die **bestehende** Abstraktion (Code-Map-Zeile, dann `docs/api/*`).
5. Erstelle **keine** doppelte Abstraktion — eine zweite Kopie einer
   Vokabel/Regel/Logik ist ein Review-Defekt.
6. Führe die relevanten Tests aus (`npm run test:unit` als Mindestschleife,
   dazu die Projekt-Suite der betroffenen Ebene).
7. Führe `npm run check:deps` **und** `npm run check:manifests` aus — beides
   ist Teil von `npm run ci` und fällt bei einer Regelverletzung.
8. Bei Architektur-/Toolchain-Änderung: ADR im neuen Template (ADR 0043,
   inkl. *Affected packages* / *Forbidden implementations* / *AI
   implementation notes*) — und im selben PR: YAML + ARCHITECTURE.md +
   betroffene READMEs (Regel 34.24).

**Verboten (jeder Punkt bricht ein Review):**

- WritePort umgehen: ein Write nur als `WriteOperation` hinter
  `WritePort`/`SafetyManager` (ADR 0032, AGENTS 26).
- Direkter Transport-/Bus-Zugriff aus der UI (Regel 34.4) — die UI spricht
  über Runtime + Command Bus.
- Private Implementation-Casts: z. B. in interne `UdsServer`-Maps
  (ADR 0041), in `DiagnosticEngine`-Innereien aus dem Runtime heraus
  (ADR 0014), in Simulator-Felder aus Tests (ADR 0040).
- Neue Dependency ohne Begründung und ADR-Notiz (ADR 0002/0010, Regel
  34.20) — gilt auch für Dev-Dependencies und Parser-Bibliotheken.
- Duplicierte Protokoll-Logik: eine UDS-/DTC-Status-/Dekodierungs-Stelle
  (Glossar „Verbotene Doppelnamen“; `decodeDtcStatus` ist *die* Stelle).
- Evidenz neu bauen außerhalb `collectEvidence`/`EvidenceService`
  (ADR 0038) — UI/Report/AI *zitieren* Item-Ids, sie sammeln nicht.
- `mayImport` erweitern, um „eine kleine Abhängigkeit“ zu erlauben: das ist
  eine Architekturentscheidung — ADR + YAML, nicht nur YAML (Regel 34.15).

**Für Themen statt Baumsuchen:** `npm run ai:context uds|transport|
diagnostic-ir|dtc|simulator|ai` erzeugt das passende Kontext-Bundle
(Architektur-Regeln, Pakete, Public APIs, ADRs, Flows, Beispiele) — oder
lies das kuratierte Paket unter [`.ai/`](.ai/README.md).


## 0.A Umsetzungsstand

**Ausgelagert:** [`docs/architecture/status.md`](docs/architecture/status.md). Der Stand
ist ein Snapshot mit Datum, keine Norm — er wandert mit jedem PR, der ihn ändert
(Regel 34.24). Die Nummerierung bleibt, damit „AGENTS 0.A" weiter auflösbar ist.
## 0.B Betrieb — Befehle, die funktionieren

Voraussetzung: Node.js ≥ 22 (siehe `engines` im Root-`package.json`, `.nvmrc`).

```bash
npm ci                # installiert exakt das Lockfile — kein npm install im CI-Kontext
npm run build         # tsc -b über alle Projekt-Referenzen (TypeScript 7 / tsgo)
npm run typecheck     # Build + strikter noEmit-Pass über Tests, Konfiguration, Specs und Frontend-JS
npx biome check .     # Lint + Format (Biome 1.9)
npm run check:deps   # Architektur-/Layer-Regel (tools/architecture/check-dependencies.mjs)
npm run check:manifests # `package.json` ⇔ tatsächliche Imports (ADR 0042)
npm test              # komplette Suite auf 6 Ebenen (unit / protocol / regression / replay / integration / architecture)
                      # das Projekt `architecture` führt dabei biome check + beide --noEmit-Pässe
                      # selbst aus (ADR 0029) — deshalb sind die Gates auch in der CI scharf
npm run test:unit     # nur Unit-Specs — die schnelle Feedback-Schleife
npm run test:coverage # Suite + V8-Coverage — global 90/80/90/90 als Projekt-Durchschnitt,
                      # per-file-Gates für core/protocols/adapters/transport/storage/
                      # charts/reports/ai (maßgeblich ist vitest.config.ts,
                      # ADR 0017/0020/0022) — grün
npm run demo          # Workbench mit Simulator auf http://localhost:8080
npm run formal:conform # Konformanz-Vektoren gegen TS (und Haskell, wenn Toolchain da — sonst NOT RUN) (ADR 0045)
npm run architecture:impact -- <datei|paket>  # Betroffene Pakete/ADRs/Tests aus der manifest-Kantengraph (ADR 0046)
npm run ai:context:changed  # .ai/generated/changed-context.md — Topic-Bundles der geänderten Pakete (ADR 0046)
```

Einzelnes Paket bauen bzw. einzelne Test-Datei ausführen:

```bash
npx tsc -b packages/transport/iso-tp
npx vitest run packages/storage/src/storage.spec.ts
```

Getestet wird **direkt der TypeScript-Quelltext**: Die Root-`vitest.config.ts`
aliasst die Workspace-Exporte von `./dist/...` auf `./src/...` (ADR 0010,
Schritt 1) — für Unit-, Protokoll-, Replay- und Regressions-Tests ist kein
Build nötig, kein stales `dist` möglich. **Ausnahme:** die Workbench-
Integrationstests (`apps/web/test/server.spec.ts`) beziehen den Chart-Kern
über `/lib` aus dem *kompilierten* `dist` von `@vdp/charts`; ohne Build
antwortet `/lib/index.js` mit 404 (gemessen 2026-09-11). Deshalb führen
`npm test` und `npm run test:coverage` den Build seit dem 2026-09-11 selbst
aus (Regel 34.26); `tsc -b` prüft zusätzlich Declaration-Maps und die
Abhängigkeitsrichtung. Das Frontend (`apps/web/public/*.js`) wird über das
eigene Projekt `tsconfig.frontend.json` mit `checkJs` typgeprüft und läuft
im Typecheck-Pass mit.

## 0.C Workflow (verbindlich)

1. Kleiner, thematisch reiner Branch von `main` — ein PR behandelt genau ein Thema.
2. PR-Template ausfüllen; es kodiert die Definition of Done (Abschnitt 35) und die Leitplanken.
3. Die CI muss auf **Node 22 und 24 grün** sein. Kein Merge auf Rot, kein „lokal läuft es“.
4. Commit-Messages im Stil des Verlaufs: `<scope>: <was>` als Betreff, im Body die *Begründung* und — bei Verhaltensbehauptungen — die *Messung* (Testlauf, Build-Output, Zahlen).
5. Architektur- oder Toolchain-Entscheidungen werden als ADR in `docs/adr/` festgehalten (Regel 34.15); ein überholter ADR wird durch einen neuen als `superseded` markiert, nie gelöscht.
6. Behauptungen über Verhalten werden durch Messung belegt, nicht geschätzt (Regel 34.21).

## 0.D Leitplanken in Kurzform

Die Vollversion steht in Abschnitt 34 — diese Punkte brechen ein Review garantiert:

- **Niemals:** CAN-/UDS-Logik in der UI · OEM-Logik in der CAN-Schicht · monolithische Diagnoseklasse · Secrets im Code · ungeklärte Fremddaten aus Wettbewerbsprodukten · Umgehung von SFD/Security Access · Merge auf roter CI · Absenken der Security-Baseline aus ADR 0009.
- **Immer:** Roh und dekodiert strikt getrennt (ADR 0004) · Read-only vor Write · jede Schreiboperation über den SafetyManager (Abschnitt 26) · jeder gefundene Fehler wird ein Regressionstest *mit Symptombeschreibung* · Provenance-Metadaten bei Daten (Abschnitt 24) · ISO-Nummer im Kommentar bei Norm-Details (Regel 34.18).
- **Dependencies:** `transport/*`, `protocols/*`, `definitions` und `shared` bleiben dependency-frei (ADR 0002). Infrastruktur-Dependencies nur nach ADR 0010: Maintenance-Nachweis, Lizenz-Check (MIT/Apache-2.0/BSD), lokal regeneriertes Lockfile im selben PR.


## 0.E Offene Verbesserungen — Backlog

**Ausgelagert:** [`docs/architecture/backlog.md`](docs/architecture/backlog.md). Prioritäten
**P1** = Qualität/CI-kritisch, **P2** = Korrektheit/Konsistenz, **P3** = Hygiene/Refactoring.
Jeder Eintrag nennt den Befund mit Messung (Regel 34.21). Die Nummerierung bleibt, damit
„AGENTS 0.E E10" weiter auflösbar ist.

---

# Produktspezifikation (Abschnitte 0–36, normativ)

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

> **Stand 2026-09-11:** Der tatsächliche Baum entspricht dieser Struktur. `apps/desktop` existiert noch nicht (Phase 3); die Definition-Pakete `schema/generic/vag/mercedes` sind im Paket `@vdp/definitions` gebündelt statt als Unterordner. `packages/adapters/host` (Node-Host-Bindings, s. 0.A) und `packages/diagnostic-ir` (Beobachtungen mit Beleg, ADR 0031) existieren zusätzlich.

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

Verbindlich für den Input (ADR 0026, since 1.14): die Analyse weiß, **wovon** sie
spricht. `vehicle` trägt das bestimmte Fahrzeug samt Beleglage (score, trust,
provenance) oder den Grund, warum nichts bestimmt ist — nie den VIN (HTTP-Provider
verlassen die Box, AGENTS 27). Pro Code trägt der Input `hint`, `scope`, `conditions`
und `measure` mit `measurable`; die Antwort zitiert diese Felder, statt sie zu
übersetzen: ein dokumentiertes Messfenster wird zur Messanweisung, ein Check ohne Zahl
bleibt eine Beurteilung durch einen Menschen, und ein Code ohne Scan-Record sagt genau
das. Konfidenz ist eine Obergrenze: fehlende Belege senken sie, vorhandene Belege heben
sie nicht.

## 23. Knowledge Base

Später eigene strukturierte Wissensbasis:

```text
DTC Definitions            ✅ EcuDefinition.dtcs[] (paketweit)
DID Definitions            ✅ EcuDefinition.dids[] mit Signalpfad
ECU Information            ✅ EcuDefinition (Adresse, Protokoll, Enable-Bedingungen)
Vehicle Variants           ✅ vehicles[] (§13.1, ADR 0023)
Known Failure Patterns     ✅ vehicles[].dtcKnowledge[].patterns[] (§13.2, ADR 0024)
Measurement Relationships  ✅ patterns[].checks[] mit min/max/windowMs
Repair Information         ✅ patterns[].repair, gelabelt als Hinweis (§24)
Legal/Licensed Documentation ✅ Präsenz aller Lizenzpflichten auf beiden Wegen (Paket,
                                      Fahrzeug, Wissenseintrag) — welche Lizenz weitergegeben
                                      werden darf, prüft kein Code (§24, Menschenentscheid)
Community Knowledge        ⏳ Datenweg ist die Datei (`sourceType: "community"` warnt auf
                                      beiden Wegen), ein Erfassungspfad in der Workbench
                                      existiert nicht und wird nicht vorgetäuscht
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

Verbindlich für die Wissensbasis:

- Wissen liegt **im Paket bei den Fahrzeugen**, nicht in einer Engine
  (ADR 0024): es versioniert mit dem Paket, bleibt in Sessions und Reports
  nachvollziehbar und braucht keinen zweiten Ablageort.
- Provenance je **Eintrag**, nicht je Paket: dokumentiertes und beispielhaftes
  Wissen dürfen nebeneinander stehen.
- **Gates nach Quellentyp** (ADR 0025): `licensed` braucht `license` (Fehler) und
  soll `version` plus `retrievedAt` tragen (Warnung) — ohne Stand und Datum ist ein
  Widerruf nicht bemerkbar. `standard` ohne Ausgabe (`version` oder `notes`) warnt,
  `community` warnt immer über ungeklärte Rechte. Ein `retrievedAt`, das kein
  ISO-8601-Datum ist, ist ein Fehler.
- **Beide Wege, dieselben Regeln — und dasselbe Werkzeug.** Der JSON-Parser ruft
  denselben Validator und verwirft kein Provenance-Feld still: ein Feld, das vorhanden,
  aber kein String ist, schlägt strukturell fehl (Regressionseintrag: `notes` ging auf
  dem Dateipfad verloren). Seit 2026-09-14 gilt das auch für `tools/definition-importer`:
  sein `importJson` las nur `ecus`/`signals` und gab ein Dokument mit `vehicles[]`
  als `valid: true`, `errors: []` und **ohne** die Fahrzeugachse zurück — die zweite,
  schwächere Koerzion war genau der Klasse, die 34.2 verbietet; der Weg geht jetzt durch
  `parseDefinitionPackage`. Abweichung mit Begründung: ein abgelehntes Dokument wird dort
  geworfen statt als `valid: false` zurückgegeben — ein Ergebnis, das ein Skript
  überlesen kann, ist für „ich verstehe diese Datei nicht" die falsche Form.
- Ein Reparaturhinweis ohne Provenance ist eine Warnung — an dieser Kategorie
  können Rechte Dritter hängen (§24).
- Fehlendes Wissen ist ein Zustand (`notes: []` bzw. `scope: "package"`), kein
  Raten: keine erfundenen Ursachen, keine erfundenen Messpunkte.

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
19. Die CI ist Teil der Fertigstellung: Ein Change ist erst fertig, wenn der Workflow auf Node 22 und 24 grün ist (ADR 0009). Kein Merge auf Rot, kein Umgehen der Checks.
20. Dependency-Disziplin nach ADR 0010: `transport/*`, `protocols/*`, `definitions` und `shared` bleiben dependency-frei. Infrastruktur-Dependencies nur mit Maintenance-Nachweis, Lizenz-Check (MIT/Apache-2.0/BSD) und lokal regeneriertem Lockfile im selben PR.
21. Messung vor Behauptung: Aussagen über Verhalten („der Compiler fängt das“, „alle Tests grün“) nur mit Beleg aus einem tatsächlichen Lauf — Testausgabe, Build-Log oder gezielte Gegenprobe im Commit oder PR.
22. Die Security-Baseline aus ADR 0009 nicht absenken: localhost-Default, Security-Header, Body-Limit, GET-only-Stream. Neue Endpunkte übernehmen die Baseline; Abweichungen brauchen einen eigenen ADR.
23. Kleine, thematisch reine PRs mit ausgefülltem Template; die Commit-History bleibt lesbar und begründet.
24. Bei Widerspruch zwischen dieser Datei (oder einem ADR) und dem Repository gilt das Repository — und die Differenz wird im selben PR dokumentiert, der den Stand ändert. Dokumentation, die vom Stand abweicht, ist ein Defekt.
25. Kein stilles Fehler-Schlucken: leere `catch {}`-Blöcke sind unzulässig. Ein Fehler wird entweder behandelt oder mindestens strukturiert (Level `debug`) mit Grund geloggt (AGENTS 33). Bestehende Verstöße listet 0.E; wer eine solche Stelle berührt, beseitigt sie im selben PR.
26. `npm test` und `npm run test:coverage` führen den Build selbst aus, weil die Workbench-Integrationstests den kompilierten Chart-Kern über `/lib` aus `dist` beziehen. Diesen Build-Anteil nicht umgehen oder als „überflüssig“ entfernen — ohne ihn antwortet `/lib/index.js` mit 404 (gemessen 2026-09-11). Ein Lauf gegen fehlendes `dist` ist nicht „grün“ und darf nicht als Beleg gemeldet werden (Regel 34.21).

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

Zusätzlich seit v1.2:

```text
+ CI grün auf Node 22 und 24 (ADR 0009)
+ Verifikationsbeleg im PR (Testlauf, Build-Output oder Messung — Regel 34.21)
+ bei neuer Dependency: ADR-0010-Nachweise (Maintenance, Lizenz, Lockfile)
+ bei Norm-Details: ISO-Referenz im Code-Kommentar (Regel 34.18)
+ bei geändertem Verhalten: AGENTS.md-Tabelle 0.A und betroffene Doku im selben PR nachgezogen (Regel 34.24)
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

