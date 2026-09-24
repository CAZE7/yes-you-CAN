# yes-you-CAN

[![CI](https://github.com/CAZE7/yes-you-CAN/actions/workflows/ci.yml/badge.svg)](https://github.com/CAZE7/yes-you-CAN/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](./package.json)
[![Tests](https://img.shields.io/badge/tests-2569%20passed-brightgreen)](#tests)
[![TypeScript](https://img.shields.io/badge/TypeScript-7%20%2F%20tsgo-blue)](./tsconfig.base.json)

Fahrzeugdiagnose-Plattform: CAN und DoIP lesen, Steuergeräte identifizieren, das
Fahrzeug aus VIN, Identifikationswerten und beantworteten Adressen bestimmen —
mit den Belegen je Kandidat statt einer Behauptung (ADR 0023) —, Fehlerspeicher
auslesen und je Code das Wissen **der bestimmten Variante** zeigen (Ursachen,
Messfenster, Reparaturhinweis — ADR 0024), Live-Messwerte aufzeichnen und als
Report exportieren, ohne Real-Fahrzeug testbar. Industriestandard-Toolchain: TypeScript 7/tsgo,
Vitest 5, Biome, tsc-Projekt-Referenzen, Architekturtests, strikte Security-Baseline
(ADR 0009) und deterministische Simulator/Replay-Tests statt Hardware-Abhängigkeit.

Die Spezifikation liegt in [`AGENTS.md`](AGENTS.md) — seit 2026-09-24 auf die Norm
reduziert (Chronik, Stand und Backlog stehen in
[`docs/changelog/agents-contract.md`](docs/changelog/agents-contract.md),
[`docs/architecture/status.md`](docs/architecture/status.md) und
[`docs/architecture/backlog.md`](docs/architecture/backlog.md)). Die Begründungen
für den Aufbau stehen in [`docs/adr/`](docs/adr/).

## Architektur lesen (auch für AI-Agenten)

Die Architektur hat eine feste Lesereihenfolge (ADR 0043) — jede Ebene ist
maschinengeprüft, Doku-Drift ist ein Fehler:

| Frage | Antwort |
|---|---|
| Wie ist das System aufgebaut? | [`ARCHITECTURE.md`](ARCHITECTURE.md) — Schichten, Verträge, Tests |
| Wo ändere ich für Aufgabe X? | [`docs/code-map.md`](docs/code-map.md) — „Where should I change this?“ |
| Welche Abhängigkeiten sind erlaubt? | [`architecture/architecture.yaml`](architecture/architecture.yaml) — die eine Regel; `npm run check:deps` |
| Was heißt dieser Begriff? | [`docs/glossary.md`](docs/glossary.md) — ein Begriff = eine Bedeutung |
| Wie sieht die öffentliche API aus? | [`docs/api/`](docs/api/) — IR, UDS, Transport, Evidence, Hypothesis, Runtime |
| Wie fließt eine Diagnose? | [`docs/flows/`](docs/flows/) — Read, Write, DTC, Recording/Replay, AI |
| Welche Invarianten nicht brechen? | [`.ai/invariants.md`](.ai/invariants.md) + [AGENTS §0.0](AGENTS.md) (AI Engineering Contract) |
| So benutzt man die API (ausführbar) | `tests/examples/*.example.ts` — laufen im Vitest-Projekt `integration` |

Für einen Arbeitskontext zu einem Thema (UDS, Transport, IR, DTC, Simulator,
AI, Formal): `npm run ai:context <topic>` → `.ai/generated/<topic>-context.md`
(generiert aus derselben Regel, nie committet). Auf Arbeitszweigen greift
`npm run ai:context:changed` — die Union der Topics, die die Git-Änderungen
berühren (Kern: `npm run architecture:impact`, ADR 0046).

## Schichten

Abhängigkeiten zeigen nur nach unten (ADR 0001, 0014) — und werden als
Architekturtests in CI erzwungen (ADR 0015, `npm run test:architecture`):

```
UI (apps/web)
  └─ Runtime (packages/runtime)  ← Kompositionsroot, headless nutzbar
       ├─ Application (packages/application): Command-Bus, Commands/Queries, Aktionen
       ├─ Domain (packages/domain): Verträge, Ports, Capabilities, Events
       └─ Diagnostic Engine (packages/core) — wird schrittweise in Services zerlegt
            ├─ Protocols  (uds, kwp2000, oem)
            ├─ Transport  (iso-tp, doip, can)
            │    └─ Adapters (elm327, canable, socketcan, generic-can, host)
            └─ Definitions (generisch, VAG, Mercedes, Simulator) + Fahrzeugauflösung
```

Die UI interpretiert keine CAN-Frames. OEM-Logik liegt nicht in der CAN-Schicht.
Ein Transport ist austauschbar, ohne dass die UDS-Engine davon weiß. Neue
Funktionalität landet als Kommando/Query/Aktion, nicht als Engine-Methode.

Kern-API ohne HTTP/DOM (ADR 0014):

```ts
import { createDiagnosticRuntime } from '@vdp/runtime';
import { readDtcs, connectVehicle } from '@vdp/application';

const runtime = createDiagnosticRuntime({ bus, definitions });
await runtime.commands.dispatch(connectVehicle());
const dtcs = await runtime.commands.dispatch(readDtcs());
```

Welches Fahrzeug dran ist, beantwortet eine Query — read-only, mit Belegen und
Widersprüchen je Kandidat (AGENTS 11.1, ADR 0023):

```ts
import { resolveVehicle } from '@vdp/application';

const resolution = await runtime.commands.query(resolveVehicle());
resolution.best;         // { brand, model, platform, score, engineIds, gearboxIds, … }
resolution.best.evidence;  // [{ kind: 'part-number', observed, expected, weight, reason }]
resolution.best.conflicts; // was gegen den Kandidaten spricht — bleibt sichtbar
resolution.unresolved;     // true, wenn kein Paket ein Fahrzeug deklariert — mit Grund in notes
```

Ist das Fahrzeug gebunden, trägt jeder gelesene Fehlercode das Wissen seiner
Variante — geschichtet über die paketweite Beschreibung, mit Scope, Notes und
Herkunft der angezeigten Aussage (AGENTS 20.1, ADR 0024):

```ts
const dtcs = await runtime.commands.dispatch(readDtcs());
dtcs[0].knowledge?.scope;        // 'vehicle-engine' | 'vehicle-gearbox' | 'vehicle' | 'package'
dtcs[0].knowledge?.patterns;     // [{ id, name, explanation, likelihood, repair, checks[] }]
dtcs[0].knowledge?.patterns[0].checks; // [{ signalId, name, expect, min, max, windowMs, measurable }]
dtcs[0].knowledge?.notes;        // was fehlt oder angenommen wurde — statt stiller Annahme
```

Ohne gebundenes Fahrzeug entsteht kein `knowledge`: die paketweite Beschreibung
steht dann am Record — sie als Variantenwissen auszugeben wäre genau die
Verwechslung, gegen die die Fahrzeugachse existiert.

## Pakete

| Paket | Zweck |
|---|---|
| `@vdp/shared` | Fehler, Byte/Hex, Logger (Raw-Logging opt-in), Events |
| `@vdp/domain` | Domänen-Verträge: Projektionen, Ports, Capabilities, Risiko-Policy, Ereigniskatalog (ADR 0014) |
| `@vdp/application` | Command-Bus, Commands/Queries, Capability-getriebene Aktionen (ADR 0014) |
| `@vdp/transport-can` | `CanFrame`, `CanBus`, Adapter-Registry, `ReplayTransport` |
| `@vdp/transport-iso-tp` | ISO 15765-2: SF/FF/CF/FC, STmin, Blockgröße, Timeouts |
| `@vdp/transport-doip` | ISO 13400-2: Routing Activation, Diagnose-Messages, Discovery |
| `@vdp/protocols-uds` | ISO 14229-1 Client **und** In-Prozess-Server |
| `@vdp/protocols-kwp2000` | ISO 14230 für Alt-ECUs |
| `@vdp/protocols-oem` | OEM-Erweiterungspunkte + Registry |
| `@vdp/definitions` | versioniertes Schema (v3: Fahrzeuge, Motoren, Getriebe, VIN-Matching, **DTC-Wissen pro Variante**), Validator, Migration v1→v2→v3, WMI-Referenz (ISO 3780), Resolver mit Belegen, Wissensauflösung nach Spezifität, Pakete mit Provenance (ADR 0023, 0024) |
| `@vdp/charts` | DOM-freie, getestete Graphen-Mathematik: Viewport, Cursor, Decimierung, Statistik (ADR 0011) |
| `@vdp/diagnostic-ir` | die eine Zwischenstufe zwischen Rohform und Projektion: Beobachtungen mit Beleg, Fenster, Belege und Hypothesen der Analyse (ADR 0034, 0037, 0038) |
| `@vdp/core` | Engine, ECU-Explorer, DTC-System (variantenbewusst: `setVehicle` schichtet Wissen über die Paketbeschreibung), Recorder, Logger, Safety |
| `@vdp/runtime` | `createDiagnosticRuntime`: Services, Command-Handler, Domänen-Events — headless (ADR 0014) |
| `@vdp/adapters-*` | ELM327, CANable (slcan), SocketCAN, generisch |
| `@vdp/storage` | Session-Repository, Migrationen, ZIP-Export |
| `@vdp/reports` | HTML- und PDF-Report (eigener PDF-Writer), inklusive Sektion „Observations & gaps“ (ADR 0037) |
| `@vdp/ai` | austauschbare Analyse-Provider mit VIN-Redaktion; der Input ist die Diagnostic IR (Belege, Hypothesen, Fahrzeugbestimmung) und jede Antwort nennt Versionen und zitiert Beleg-Ids (§22, ADR 0026, 0038) |
| `@vdp/simulators` | virtuelles Fahrzeug + virtuelles CAN-Netz |
| `@vdp/golden-sessions` | goldene Sitzungen: Aufnahme, Erwartung, Lauf — der Simulator liefert, der echte Core replayt (ADR 0036) |
| `@vdp/formal-conformance` | Konformanz-Vektoren für ISO-TP und Safety-Kette: dieselbe Datei für TypeScript und Haskell-Referenz, `npm run formal:conform` (ADR 0045) |
| `@vdp/trace-analyzer` | Offline-Trace-Analyse |
| `@vdp/definition-importer` | DBC/CSV/JSON → validiertes Definition-Paket |
| `@vdp/harvest` | ein Fahrzeug **read-only** auslesen und die Antworten behalten: Ernte-Datensatz, ODX-D/PDX-Beschreibung (ISO 22901-1 / ODX 2.2) und Definitions-Kandidat mit `observed`-Provenance; Gegenprüfung gegen `odxtools` (ADR 0058) |
| `@vdp/web` | Node HTTP + SSE, Vanilla-ESM-Oberfläche |

## Schnellstart

```bash
npm ci
npm run build
npm run demo          # Workbench auf http://localhost:8080
npm run harvest:demo  # ein Fahrzeug read-only auslesen → harvest-local/ (Datensatz, ODX, PDX, Kandidat)
```

`npm run demo` startet den Simulator: drei Steuergeräte, gesetzte Fehlercodes,
Live-Messwerte. Die Demo bestimmt das Fahrzeug aus der VIN und zeigt zu P0420
zwei Ausfallmuster mit fünf auswertbaren Messfenstern. Kein Adapter, kein
Fahrzeug.

Der Adapter „High-Fidelity Virtual Vehicle (5-ECU)" fährt zusätzlich ein
**Verhaltensmodell** (ADR 0040): Spannung, Anlasserlast, Lichtmaschine,
Motortemperatur, Räder und die Verdrahtung jedes Moduls — ein Fehler wird nicht
gesetzt, er entsteht, wenn ein Monitor eine Bedingung lange genug gemessen hat.
Dazu gibt es die **Szenario-Engine**: `GET /api/simulator/scenarios` listet den
Katalog, `POST /api/simulator/scenario {"id": "under-voltage-at-start"}` läuft ein
Szenario und meldet jede Prüfung mit Begründung. Seit 2026-09-16 liegt beides in der
Workbench: der Reiter „Szenarien“ wählt aus dem Katalog, startet den Lauf auf dem
gewählten Adapter und zeigt das Ergebnis als Urteil, Check-Liste, Fehlerspeicher,
Endzustand und Zeitlinie (Projektion in `apps/web/src/scenario-view.ts`; ein Adapter ohne
`runScenario` wird als ohne Szenarien ausgewiesen). Der Fehlerspeicher dekodiert dabei den
Statusbyte — 14 Zeilen sind das dokumentierte Vokabular des Fahrzeugs, gemeldet ist einer,
und die Note unter der Tabelle sagt genau das. Gemessen am laufenden Demo-Server:
der Lauf endet mit `passed: true` (8 Checks, u. a. `supplyVoltage < 11,5 → 10,7`),
und der sich anschließende `POST /api/dtc/scan` liest `B1001` mit Status `0x2E`
über UDS — geheilt, aber im Speicher, mit Beschreibung und Schweregrad aus dem
Definitions-Paket. Im Panel desselben Laufs steht dazu `bestätigt` (nicht „jetzt
fehlgeschlagen“) und `1 von 14 dokumentierten Codes sind im Fehlerspeicher gemeldet`.

Mit echtem Adapter:

```bash
node apps/web/dist/src/server.js --port=8080 --sessions=./sessions-local
```

### Zugriff schützen (ADR 0051)

Ohne Token ist jede der 37 `/api/`-Routen offen — am Prüfstand ohne Netz ist das
der Normalfall, im Netz nicht. Mit `--token=` (oder `VDP_API_TOKEN`) braucht jeder
API-Aufruf `Authorization: Bearer <token>` oder den Cookie aus einem einmaligen
Tausch:

```bash
node apps/web/dist/src/server.js --host=0.0.0.0 --token=bench-s3cret
# Browser einmalig: http://<host>:8080/?token=bench-s3cret  → 302 + httpOnly-Cookie
curl -H 'authorization: Bearer bench-s3cret' http://<host>:8080/api/state
```

Ohne Token antwortet jede Route mit `401` und einem Satz, der sagt, wie man sich
anmeldet — nicht mit Daten. Die Startwarnung nennt den Zustand: `authenticated:
true` oder, ohne Token, `listening on all interfaces with NO API token`. Der
Vergleich läuft in konstanter Zeit, der Cookie ist `HttpOnly; SameSite=Strict` und
endet mit dem Browser. Offen bleiben TLS und ein Rate-Limit
(`docs/standards/iso-21434-cybersecurity.md`, CY-04/CY-05).

## Fahrzeug auslesen (Ernte → ODX, ADR 0058)

Was ein Fahrzeug antwortet, kann diese Plattform jetzt aufnehmen — ohne Hardware zu
besitzen und ohne etwas am Fahrzeug zu ändern:

```bash
npm run build
node tools/harvest/dist/src/cli.js --print-plan              # was würde gefragt?
node tools/harvest/dist/src/cli.js --simulator --out ./harvest-local --verify-odx
node tools/harvest/dist/src/cli.js --adapter socketcan --channel can0 --out ./harvest
```

Ein Lauf schreibt vier Artefakte aus **einer** Beobachtung:

| Artefakt | Inhalt |
|---|---|
| `harvest.json` | der Datensatz: Plan, je ECU Dienste/DIDs/Fehlerspeicher, Verweigerungen gruppiert nach NRC, `unread` (deklarierte Adressen ohne Antwort), `gaps`, `notes`, VIN maskiert |
| `<container>.odx-d` | ODX 2.2: `BASE-VARIANT` je ECU, `DIAG-SERVICE` je beobachtetem Austausch als Byte-Rezept, `DTC-DOP`/`DTC` je Code, `ENV-DATA` je Freeze Frame, Adresse/Timing/Provenance als `SDGS` |
| `<container>.pdx` | dasselbe Dokument als ODX-Container (ZIP mit `index.xml`-Katalog) |
| `<oem>-definition.json` | Definitions-**Kandidat** für `@vdp/definitions`, `sourceType: "observed"`, plus `skipped[]` mit Grund |

Drei Grenzen, die das Werkzeug nicht überschreitet — und die es selbst ausspricht:

1. **Read-only.** Kein Schreibdienst wird gesendet (`0x14`, `0x27`, `0x28`, `0x2F`,
   `0x34`, `0x85` erscheinen als `not-probed` mit Grund); `0x2E` nur mit
   `--probe-writes`. Ein Test scannt die Quellen nach Schreibaufrufen.
2. **Beobachtung, kein Wissen.** Keine Skalierung, keine Einheiten, keine erfundenen
   Namen oder DTC-Bedeutungen; ein `asciiHint` ist ein Hinweis. Eine Bytelänge ohne
   dokumentierte Kodierung wird *kein* Signal, sondern ein `skipped`-Eintrag.
3. **ODX ist eine Beschreibung, kein Auszug.** Ein Auto enthält kein ODX — die Datei
   wird aus den Antworten geschrieben. Die ODX-C-Kommunikationsparameter fehlen
   (Abhängigkeitsentscheidung, ADR 0002/0010); die Adressierung steht als `SDG`, und
   das Dokument sagt das.

`--verify-odx` übergibt das Dokument **`odxtools`** (MIT, extern, keine Abhängigkeit
dieses Repos) und prüft Parse plus Encode-/Decode-Rundlauf: gemessen 2026-09-23 am
Simulator-Fahrzeug **29/29 Anfragen auf die gesendeten Bytes, 29/29 Antworten auf die
empfangenen Bytes, 0 Abweichungen**. Ohne installierte Bibliothek meldet die CLI
`odxtools NOT RUN` mit Grund und bleibt grün — ein Prüfer, der nicht laufen kann, ist
nicht durchgefallen.

Rechtlich (Kurzform, kein Rechtsrat): die **eigene Messung** am eigenen oder
beauftragten Fahrzeug ist der Normalfall jeder Diagnose. **Hersteller-ODX** ist für
unabhängige Akteure nach Art. 61 VO (EU) 2018/858 verpflichtend zugänglich und
maschinenlesbar, nach Art. 63 aber gebührenpflichtig (EuGH C-319/22; OLG Köln
6 U 58/24 gegen Registrierung + dauerhafte Online-Verbindung als Zugangshürde; seit
23.06.2026 VO (EU) 2026/699 zu sicheren Zugängen) — „kostenlos" ist dieser Weg nicht,
ein Importer dafür ist ein eigener Schritt mit Lizenz- und Provenance-Entscheidung.

## Entwicklung

```bash
npm ci                # exakt das Lockfile (Node >=22, engine-strict)
npm run build         # tsc -b über alle Projekt-Referenzen (TypeScript 7 / tsgo)
npm run typecheck     # Build + strikter noEmit-Pass über Tests, Konfiguration, Specs und Frontend-JS
npx biome check .     # Lint + Format (Biome 1.9): 2-space, 100-char, organizeImports
npm test              # Build + Vitest: alle 6 Ebenen (unit, protocol, regression, replay, integration, architecture)
npm run formal:conform # Konformanz-Vektoren gegen den Produktions-TS (Haskell-Vergleich nur mit Toolchain, sonst NOT RUN) (ADR 0045)
npm run architecture:impact -- <datei|paket>  # betroffene Pakete/ADRs/Tests, aus der einen Regel abgeleitet (ADR 0046)
npm run test:unit     # nur Unit-Specs — schnelle Feedback-Schleife
npm run test:coverage # Suite + V8-Coverage (global 90/80; per-file laut vitest.config.ts) — in der CI erzwungen seit ADR 0029 §6
npm run ci            # Build + Typecheck + Biome + Test — die Gates der CI ohne den Coverage-Lauf
```

Einzelnes Paket bzw. einzelne Test-Datei:

```bash
npx tsc -b packages/transport/iso-tp
npx vitest run packages/storage/src/storage.spec.ts
npx biome check --write .   # auto-fix
```

Qualitätstore: `npm run ci` prüft lokal genau das, was der Quality-Job der CI prüft —
`build` + `typecheck` + `biome check` + `check:deps` + `check:manifests` + `audit` —
plus die komplette Suite. Der Workflow `.github/workflows/ci.yml` läuft auf Node 22
und 24.

**Die Gates hatten zwei Träger, und der zweite ist seit heute Geschichte (ADR 0029 →
ADR 0059).** Vom 2026-09-14 bis 2026-09-24 lief `ci.yml` nur mit `npm ci` → `build` →
`npm test`, weil die GitHub-App keine Workflow-Dateien schreiben durfte. In dieser
Zeit trugen die Gates einen Zweitträger: der `architecture`-Projektlauf von `npm test`
führte `biome check .` und beide `--noEmit`-Pässe selbst aus und schlug mit deren
Ausgabe fehl (gemessen +2 s auf einen 22,6-s-Lauf). Seit heute steht dafür ein
eigener Quality-Job im Workflow — der Zweitträger ist damit Doppelung, nicht Tor.
Dazu ist jede Regel, die
nicht `error` ist, mit Umfang und Messung auf dem Rekord
([`tests/architecture/guardrails.test.ts`](tests/architecture/guardrails.test.ts), [Backlog E20](docs/architecture/backlog.md));
Produktionscode hat keinen Regel-Ausnahmepfad. Der 57-Punkte-Backlog gegen den gemessenen Stand liegt in
[`docs/architecture/master-backlog.md`](docs/architecture/master-backlog.md).

**Stand 2026-09-24 — die gehärtete CI aus ADR 0016 §3 liegt im Repository.** Die vier
Workflows sind seit heute auf `main`: `ci.yml` mit **Quality-Job** (`build` ·
`typecheck:all` · `check` · `check:deps` · `check:manifests` · `npm audit`) vor der
**Test-Matrix** auf Node 22 und 24, plus Coverage-Artefakt-Upload; dazu `codeql.yml`
(wöchentlich + auf jedem Push), `dependency-review.yml` (schlägt bei einer neuen
Abhängigkeit mit moderater oder schwererer Verwundbarkeit fehl) und der nächtliche
`hardware.yml`-Smoke auf `vcan0`.

Zwei Dinge sind trotzdem offen und stehen hier, statt sie zu übergehen:

1. **Die Coverage-Gates haben keinen eigenen Schritt.** `ci.yml` lädt `coverage/` als
   Artefakt hoch (`if: always()`), aber kein Schritt ruft `npm run test:coverage` als
   Tor auf. Getragen wird es von `tests/architecture/coverage-gate.test.ts`, das
   *innerhalb* von `npm test` genau dieses Kommando als Kindlauf startet (nur unter
   `CI`, mit Rekursionssperre, `retry: 0`) — ein Schritt, der 65 s kostet und den
   Build tatsächlich rot macht. Ein eigener Schritt wäre die ehrlichere Form; er
   braucht einen Commit in `.github/workflows/`.
2. **Die GitHub-App-Integration kann weiterhin keine Workflow-Dateien schreiben.**
   Gemessen 2026-09-24: `git push` → `refusing to allow a GitHub App to create or
   update workflow '.github/workflows/ci.yml' without 'workflows' permission`, über
   die API → `403`. Die vier Dateien sind heute vom Repository-Inhaber direkt
   gepusht worden; für einen Commit *über die App* fehlt das Recht weiterhin. Wer es
   freischalten will: GitHub → *Settings → Applications → Arena (GitHub App) →
   Repository Permissions → **Workflows: Read & write***.

Der Workflow deckt die lokalen Tore jetzt ab — `npm run ci` bleibt trotzdem das
Tor für einen Commit, denn es ist die einzige Form, die ohne GitHub läuft. Details in
[`CONTRIBUTING.md`](CONTRIBUTING.md) und [Backlog E10/E20](docs/architecture/backlog.md).

## Graphen

Zoom, Pan, Cursor, Marker, Zeitraumwahl, Min/Max/Ø/Delta, Ein-/Ausblenden und
synchronisierte Zeitachsen (AGENTS 16). Die Regeln dafür liegen DOM-frei in
`@vdp/charts` und laufen im Browser als dieselbe Datei, die die Unit-Tests
prüfen — der Server liefert sie unter `/lib/` aus (ADR 0011). Bedienung:
Mausrad zoomt am Cursor, Ziehen verschiebt, `Umschalt + Ziehen` wählt einen
Zeitraum aus, Doppelklick zeigt die gesamte Aufnahme.

## Tests

2569 bestandene Tests plus 8 dokumentierte Skips — davon 5 die optionale
`odxtools`-Gegenprüfung der Ernte, die ohne installierte Bibliothek ehrlich
überspringt (2575 insgesamt) / 181 geprüfte Dateien von 183 (2 CI-Träger
überspringen lokal, ADR 0029 §6) (`npm test` in 94 s; `npm run test:coverage`
in 107 s — gemessen 2026-09-24), Vitest 5 mit
Projektkonfiguration
(ADR 0010, Schritt 1 — ersetzt ADR 0008). Seit ADR 0043 gehören dazu 18
ausführbare Doku-Beispiele in `tests/examples/*.example.ts` (Projekt
`integration`) — sie zeigen die API so, wie sie benutzt wird. Der
`architecture`-Lauf prüft die Struktur *und*
führt die Quality-Gates aus (ADR 0029) — unter `CI` auch die Coverage-Gates, als
Kind-Lauf von `npm run test:coverage` (ADR 0029 §6), weil kein Workflow sie selbst
aufrufen kann ([Backlog E20](docs/architecture/backlog.md)) — einschließlich
`npm run check:manifests`, das verlangt, dass jedes `package.json` zu den
tatsächlichen Importen passt (ADR 0042). Unit-Specs liegen co-lokatiert neben dem
Code (`src/*.spec.ts`); Property-Tests laufen mit fast-check, Coverage-Gates mit
`npm run test:coverage` (global 90 % lines / 80 % branches als
Projekt-Durchschnitt, Ist 94,04 Statements / 85,88 Zweige / 95,83 Funktionen /
95,39 Zeilen — gemessen am Stand vom 2026-09-24 nach der Ernte (ADR 0058), und die letzten Stellen wandern mit
Last und Node-Version (86,59 bis 86,71 Zweige auf demselben Baum,
ADR 0029 §6) — seit ADR 0027 wird die ganze
Fläche gemessen: `packages/**/src`, `apps/web/src/**` und `tools/**`, weil die
Workbench-Schicht vorher in keiner Zahl vorkam; per-file-Gates für
`shared`/`core`/`protocols`/`adapters`/`transport`/`storage`/`charts`/`reports`/`ai` (95/85 seit 2026-09-14)/`diagnostic-ir` (95/85 seit ADR 0034)/`definitions`
und seit ADR 0027 eine **Bodenschwelle** für `apps/web/src/**`, am 2026-09-16 von
69/54 auf 75/66 und am selben Stand auf 76/72 gehoben, nachdem die nachgetesteten Randpfade der
Workbench (Freeze Frame, Body-Limit, Marker, Adapter-Absagen, dazu die Replay-Quellen, der
werfende Event-Listener und die Chaos-Arme von `backend.ts`) die dünnsten Dateien gehoben hatten —
erst Tests, dann Gate (ADR 0017); `tools/**` ist
gemessen, aber ohne Gate (dort steht `flaky-reporter.ts` — von keinem CI-Job aufgerufen, also gibt es keinen einzigen Flaky-Report aus der CI; die Datei selbst ist getestet: 100 % Statements, 86,66 % Zweige — [Backlog E9](docs/architecture/backlog.md));

Hardware-Module `serial`/`binding` ausgenommen — maßgeblich ist
`vitest.config.ts`, ADR 0017, 0020, 0022 und 0023). Test-Zeit ist ein Budget: Discovery läuft in Tests mit explizitem
`windowMs`/`probeDelayMs`, und statt fester Sleeps wird auf Bedingungen
gewartet (ADR 0019).
Ebenen nach AGENTS 31:

| Ebene | Ort |
|---|---|
| Unit | `packages/*/src/*.spec.ts`, `tools/*/src/*.spec.ts` |
| Integration | `tests/integration`, `apps/web/test` |
| Protokoll | `tests/protocol` |
| Replay | `tests/replay` |
| Regression | `tests/regression` |
| Architektur | `tests/architecture` — Abhängigkeitsgraph ist ein Test (ADR 0015); dazu das Link-Gate über alle 443 relativen Markdown-Links (ADR 0059) und das Tor, das den Rust-Referenz-Crate außerhalb jedes Gates hält (E25) |
| Hardware (vcan) | `tests/hardware` — `vcan0`, nightly/manual (`npm run test:hardware`) |

Der Regressionskatalog dokumentiert jeden gefundenen Fehler mit Symptom. Es
sind durchweg Laufzeit- und Wire-Level-Fehler, die ein Typchecker prinzipiell
nicht sehen kann. Nachgeprüft am Fall `findEcuByAddress`: mit zurückgebautem
Bug beendet `tsc -b packages/definitions` mit Exit-Code 0, der zugehörige
Regressionstest schlägt fehl. Der Compiler findet diese Klasse von Fehlern
nicht — der laufende Test schon.

## HTTP-API

| Route | Zweck |
|---|---|
| `GET /api/state` | gesamter Zustand |
| `GET /api/history` | gesamte Aufnahme (Samples + Marker) für die Graphen |
| `GET /api/stream` | SSE: Samples, Trace, DTCs, Marker, Fahrzeugbestimmung |
| `GET /lib/*` | kompiliertes `@vdp/charts` für den Browser (ADR 0011) |
| `POST /api/start` | Simulator verbinden, ECUs entdecken |
| `GET /api/simulator/scenarios` | Katalog der Fahrzeugszenarien (Ursachen, Erwartungen, Begründungen) |
| `POST /api/simulator/scenario` | ein Szenario auf dem 5-ECU-Fahrzeug laufen lassen (ADR 0040) |
| `POST /api/vehicle/resolve` | Fahrzeug bestimmen: Kandidaten mit Belegen und Widersprüchen (read-only) |
| `POST /api/dtc/scan` | Fehlerspeicher lesen — antwortet in zwei Hälften: `dtcs` (die Codes) und `unread` (die Module, die nicht geantwortet haben, mit `ecuName`, `rxId` und Grund). Ein Bus, an dem niemand antwortet, liefert eine leere Code-Liste **und** die Liste der stummen Module; das Panel zählt sie in der Zusammenfassung als ` · N× nicht gelesen` (ADR 0049) |
| `POST /api/dtc/snapshot` | Freeze Frame zu einem Code lesen: `rxId` als `0x7E8`, `7e8` oder Zahl, `code` Pflicht, Recordnummer optional (Default `0xff`); eine Adresse, die niemand auf dem Bus hat, ist `409` mit Satz, nicht `500` ([AGENTS 0.E](docs/architecture/backlog.md) E23) |
| `POST /api/chaos/inject` \| `/api/chaos/status` \| `/api/chaos/reset` | Rahmen verwerfen und Sequenzen korrumpieren **auf dem Bus der Sitzung** (seit 1.38; vorher zählte die Schicht nebenan, [Backlog E24](docs/architecture/backlog.md)): `dropBurst` mit oder ohne `dropBurstCanId` (ohne = die nächsten N Rahmen dieser Verbindung), `dropRate` als Bruchteil 0…1, Korruptur je Antwort-Id; `status` meldet Ziel und Reichweite des Bursts (`dropBurstTarget`, `dropBurstScope`), ohne offene Verbindung antwortet der Aufruf `409` mit Satz statt stumm zu tun |
| `POST /api/live/start` \| `/stop` | Live-Messung |
| `POST /api/analyze` | Analyse (lokaler Regel-Provider) — nennt, über welches Auto sie spricht, auf welcher Fassung sie beruht und welche Belege sie gelesen hat |
| `POST /api/session/save` | Session persistieren |
| `GET /api/sessions` | gespeicherte Sessions |
| `GET /api/export/*` | CSV, JSON, HTML, PDF |

## Grenzen

Bewusst **nicht** enthalten (AGENTS 29): Complex Coding, Umgehung von
SFD/Security Access, Cloud, Mobile, Marketplace.

Eine Ernte (ADR 0058) liest, was ein Steuergerät ohne Security Access hergibt: was
hinter `0x27` liegt, bleibt zu, und DIDs, die erst in einer erweiterten Sitzung
antworten, erscheinen ohne `--session` als Verweigerung mit NRC statt als Wert. Die
geschriebene ODX-Datei beschreibt Beobachtetes, nicht Dokumentiertes — wer
Skalierung, Einheiten oder DTC-Bedeutungen braucht, braucht eine Quelle
(`standard`/`licensed`) und nicht eine größere Ernte.

Die mitgelieferten VAG- und Mercedes-Pakete sind `example-placeholder` mit
erfundenen Werten und werden vom Validator entsprechend gekennzeichnet
(ADR 0003). Sie sind keine Fahrzeugwahrheit. `simulatorPackage` beschreibt das
virtuelle Fahrzeug des Simulators und ist nur in Simulator-/Replay-Betrieb aktiv;
gegen echte Hardware bleibt die OEM-neutrale Baseline stehen (ADR 0023). Ihr
Variantenwissen ist als `own` gekennzeichnet und aus öffentlichen
SAE-J1979-Semantiken begründet; weil das Baseline-Paket keine Lambda-Sonden
definiert, erfindet es auch keine — ein Prüfschritt referenziert nur Signale, die
das Paket tatsächlich deklariert, und beobachtet den Fehler, zu dem er gehört
(ADR 0024, 0025). Nicht jeder Code bekommt Variantenwissen: `U0121`
(Kommunikation mit dem ABS-Modul verloren) bedeutet für jeden Motor und jedes
Getriebe dasselbe, bleibt also paketweit — und die Antwort sagt das, statt
allgemeinen Text als Variantenwissen auszugeben.
