# `@vdp/harvest`

**Layer:** tool · **Pfad:** `tools/harvest/` ·
**Regeln-Quelle:** [`architecture/architecture.yaml`](../../architecture/architecture.yaml) ·
**Entscheidung:** [ADR 0058](../../docs/adr/0058-harvest-as-observation.md)

## Purpose

Ein Fahrzeug **read-only** auslesen und die Antworten als Beobachtung behalten —
und diese Beobachtung in drei Formen schreiben, die andere Werkzeuge lesen können:
einen Ernte-Datensatz (JSON), eine ODX-Beschreibung (ISO 22901-1 / ASAM ODX 2.2,
als `.odx-d` und als `.pdx`-Container) und einen Definitions-Kandidaten
(`@vdp/definitions`-Paket mit `sourceType: "observed"`).

Das ist der fehlende Weg von einem realen Fahrzeug zu Daten: jeder andere Inhalt
dieses Repos ist entweder handgeschrieben (`packages/definitions/src/<oem>/`) oder
simuliert (`tools/simulators`).

```bash
# ohne Hardware — dasselbe Programm, dieselben Artefakte
node tools/harvest/dist/src/cli.js --simulator --out ./harvest-local --verify-odx

# am Fahrzeug (SocketCAN, vcan0/can0)
node tools/harvest/dist/src/cli.js --adapter socketcan --channel can0 --out ./harvest

# erst zeigen, was gefragt würde
node tools/harvest/dist/src/cli.js --print-plan
```

## Responsibilities

- `harvestVehicle({ bus, definitions, plan, identity })`: Discovery → Dienste →
  Identifikation → DID-Sweep → Fehlerspeicher, je Stufe mit eigener Fehlerbehandlung
- `resolveHarvestPlan()` / `describeHarvestPlan()`: der Frageplan als Daten
  (Bereiche, Budgets, Recordnummern, `probeWriteSupport`)
- `readFaultMemory()` / `readSnapshotRecords()` / `readExtendedRecords()`: der
  `0x19`-Ablauf in der Reihenfolge, die jede spätere Stufe billiger macht
- `renderOdxHarvest()` / `createPdx()` / `renderPdxCatalog()`: die ODX-Projektion
- `expectationsOf()` + `verifyOdxDocument()`: Gegenprüfung gegen `odxtools`
  (extern, optional, `NOT RUN` ist nie ein Grün)
- `definitionCandidate()`: Beobachtung → validierbares Definition-Paket, mit
  `skipped[]` für alles, was keine dokumentierte Kodierung hat
- `redactVin()`, `printableAscii()`, `ecuIdOf()`: die kleinen Regeln, die an drei
  Stellen dieselbe Antwort geben müssen

## Does NOT do

- **nicht schreiben**: kein `0x14`, `0x27`, `0x28`, `0x2F`, `0x34`, `0x85`, und
  `0x2E` nur mit `--probe-writes` (dann steht es im Datensatz)
- **nicht deuten**: keine Skalierung, keine Einheiten, keine Signalnamen, keine
  DTC-Bedeutungen — ein `asciiHint` ist als Hinweis gekennzeichnet
- **nicht validieren**: die Regeln stehen in `@vdp/definitions/validate.ts`
- **nicht persistieren**: die CLI schreibt Dateien, die Bibliothek liefert Daten
- **kein ODX-Parser**: gelesen wird nur, was dieses Werkzeug selbst geschrieben hat
- **keine ODX-C-Kommunikationsparameter**: die Adressierung reist als `SDG`, und das
  Dokument sagt das selbst (Abhängigkeitsentscheidung, ADR 0002/0010)
- **keine Schicht**: nichts importiert `@vdp/harvest`

## Public API

`src/index.ts`: `harvestVehicle`, `HarvestReport` und die Beobachtungstypen,
`resolveHarvestPlan`/`describeHarvestPlan`/`findWriteRequests`,
`readFaultMemory`/`readSnapshotRecords`/`readExtendedRecords`, `nrcOf`/`isOrdinaryRefusal`,
`renderOdxHarvest`/`odxDiagLayerContainer`/`expectationsOf`/`observedServicesOf`,
`createPdx`/`pdxFilesOf`/`renderPdxCatalog`, `verifyOdxDocument`/`verificationCounts`,
`definitionCandidate`/`harvestProvenance`/`encodingOf`, XML-Bausteine
(`element`, `textElement`, `renderXml`, `odxShortName`, …), `runCli`/`parseCli`/`usage`/`EXIT`.

## Dependencies

`shared`, `definitions`, `protocols-uds`, `transport-can`, `transport-iso-tp`,
`core`, `storage`, `adapter-host`, `simulators` (siehe `architecture.yaml`).
Node-Builtins sind nur in `cli.ts` und `odx/verify.ts` erlaubt — dieselbe Grenze,
die `@vdp/golden-sessions` zieht.

`odxtools` (Python, MIT) ist **keine** Abhängigkeit: ein externer Prüfer, den
`--verify-odx` benutzt, wenn er installiert ist (`pip install odxtools`, oder
`VDP_ODX_PYTHON`/`--odx-python` auf einen Interpreter zeigen lassen).

## Data Flow

```text
CanBus (Adapter · Simulator · Replay)
  ▼
EcuDiscovery (@vdp/core)          → antwortende Adressen + stumme Deklarationen
  ▼
je ECU: IsoTpConnection → UdsClient
  ├─ probeSupportedServices       → serviceProbes (inkl. „never sent" mit Grund)
  ├─ readDid (F1xx, F4xx, Paket)  → HarvestedDid{rawHex,byteLength,asciiHint,stable}
  │                                 + DidRefusalGroup{origin,nrc,count,Bereich}
  └─ readFaultMemory              → dtcCount, Verfügbarkeit, 0x19 0x03, Codes,
                                    Snapshots/erweiterte Aufzeichnungen (roh)
  ▼
HarvestReport  (eine Beobachtung, eine Quelle)
  ├─ harvest.json                 → Datensatz mit Plan, Zählern, Lücken, Notes
  ├─ *.odx-d / *.pdx              → ODX-Projektion (BASE-VARIANT je ECU, DIAG-SERVICE
  │                                 je beobachtetem Austausch, DTC-DOP, ENV-DATA)
  └─ <oem>-definition.json        → Definitions-Kandidat + skipped[] (mit Grund)
```

## Important invariants

- **Read-only ist prüfbar, nicht gemeint**: `FORBIDDEN_HARVEST_SERVICES` +
  `findWriteRequests()` + ein Test, der die eigenen Quellen nach Schreibaufrufen
  scannt (`harvest.spec.ts`).
- **Eine Verweigerung ist kein Wert**: `requestOutOfRange` wird zur Gruppe mit NRC,
  ein Timeout zur Lücke in `gaps` — nie zu einem DID mit 0 Byte (ADR 0033).
- **Beide Hälften eines Laufs**: `ecus` und `unread`, `dids` und `didRefusals`,
  `dtcs` und `gaps` (ADR 0049 eine Ebene tiefer).
- **Provenance auf jeder Ebene**: Paket, ECU, DTC, Signal — `observed`, mit Datum,
  Quelle und den Bytes im Klartext der Notiz (AGENTS 24, ADR 0058).
- **VIN maskiert**, außer `--keep-vin`; `identity.vinRedacted` sagt es im Datensatz
  (AGENTS 30).
- **`NOT RUN` ≠ bestanden**: fehlt `odxtools`, meldet die CLI es mit Grund und bleibt
  grün; ein Test zählt die übersprungene Prüfung nicht als bestandene.
- **Ein ECU-Id, eine Regel**: `ecuIdOf()` — Datensatz, ODX und Kandidat benennen
  dasselbe Modul gleich, sonst sind die Artefakte nicht zusammenführbar.

## Artefakte und Exit-Codes

| Code | Bedeutung |
|---|---|
| 0 | gelaufen, Artefakte geschrieben — auch wenn das Fahrzeug alles verweigert hat |
| 2 | Benutzung (unbekanntes Flag, `--out` fehlt, kaputter Wert) |
| 3 | kein Bus (Adapter fehlt, Gerät belegt, Datei unlesbar) |
| 4 | Artefakt konnte nicht geschrieben werden |
| 5 | `--verify-odx`: die Referenzimplementierung hat das Dokument abgelehnt |
| 6 | kein Steuergerät hat geantwortet — Datensatz ja, ODX/PDX nein |

## Tests

Co-lokatierte `src/**/*.spec.ts` (Projekt `unit`): Plan und Read-only-Regel,
Beobachtungsmodell, ODX-Struktur und Escaping, PDX-Container, Definitions-Kandidat,
CLI-Grammatik und Exit-Codes, Ernte gegen ein echtes UDS-Stack (`VirtualVehicle`),
Gegenprüfung gegen `odxtools` (bedingt, mit Biss-Test).

```bash
npx vitest run --project unit tools/harvest
VDP_ODX_PYTHON=$(which python3) npx vitest run --project unit tools/harvest  # mit Gegenprüfung
```

## Examples

```ts
import { harvestVehicle, renderOdxHarvest, definitionCandidate, expectationsOf, verifyOdxDocument } from "@vdp/harvest";

const report = await harvestVehicle({ bus, definitions: [genericPackage] });
report.counts;            // { ecusAnswered, addressesUnread, didsRead, didsRefused, … }
report.ecus[0].didRefusals; // [{ origin: "identification", nrc: 49, count: 116, firstDid, lastDid }]
report.unread;            // deklarierte Adressen ohne Antwort — die zweite Hälfte

const odx = renderOdxHarvest(report);
const candidate = definitionCandidate(report, { oem: "harvest" });
candidate.skipped;        // Beobachtungen ohne dokumentierte Kodierung, mit Grund

const check = verifyOdxDocument(odx, { expectations: expectationsOf(report) });
check.state;              // "verified" | "failed" | "not-run" — nie stillschweigend grün
```

## Rechtlicher Rahmen (Kurzform, kein Rechtsrat)

- **Eigene Messung am eigenen/beauftragten Fahrzeug:** Lesen über die OBD-Schnittstelle
  ist der Normalfall jeder Diagnose; dieses Werkzeug sendet ausschließlich Lese- und
  Sondenanfragen. Security Access wird nicht umgangen (AGENTS 0.D) — was hinter
  `0x27` liegt, bleibt zu.
- **Herstellerdokumentation (ODX/PDX, Reparatur- und Wartungsinformationen):**
  Zugang ist für unabhängige Akteure nach Art. 61 VO (EU) 2018/858 verpflichtend,
  maschinenlesbar und nicht diskriminierend; Art. 63 erlaubt angemessene,
  verhältnismäßige Gebühren (EuGH C-319/22; OLG Köln 6 U 58/24 — Registrierung und
  dauerhafte Online-Verbindung als Zugangshürde sind unzulässig; seit 23.06.2026
  VO (EU) 2026/699 zu sicheren Zugängen). **Kostenlos ist das nicht.** Ein Importer
  für solche Pakete ist ein eigener Schritt mit Lizenz- und Provenance-Entscheidung.
- **Fremde ODX-Pakete weitergeben:** Rechte klären, bevor sie ein Kunde sieht —
  `validate.ts` warnt bei `licensed` ohne Lizenz und bei `community`-Daten.
- **Personenbezug:** VIN, Standort und Fahrverhalten sind personenbezogen (AGENTS 30).
  Default ist maskiert; `--keep-vin` ist die Ausnahme und wird im Datensatz vermerkt.
