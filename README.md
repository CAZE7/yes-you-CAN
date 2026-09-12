# yes-you-CAN

[![CI](https://github.com/CAZE7/yes-you-CAN/actions/workflows/ci.yml/badge.svg)](https://github.com/CAZE7/yes-you-CAN/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](./package.json)
[![Tests](https://img.shields.io/badge/tests-1066%20passed-brightgreen)](#tests)
[![TypeScript](https://img.shields.io/badge/TypeScript-7%20%2F%20tsgo-blue)](./tsconfig.base.json)

Fahrzeugdiagnose-Plattform: CAN und DoIP lesen, Steuergeräte identifizieren,
Fehlerspeicher auslesen, Live-Messwerte aufzeichnen und als Report exportieren —
ohne Real-Fahrzeug testbar. Industriestandard-Toolchain: TypeScript 7/tsgo,
Vitest 5, Biome, tsc-Projekt-Referenzen, Architekturtests, strikte Security-Baseline
(ADR 0009) und deterministische Simulator/Replay-Tests statt Hardware-Abhängigkeit.

Die Spezifikation liegt in [`AGENTS.md`](AGENTS.md), die Begründungen für den
Aufbau in [`docs/adr/`](docs/adr/).

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
            └─ Definitions (generisch, VAG, Mercedes)
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
| `@vdp/definitions` | versioniertes Schema, Validator, Pakete mit Provenance |
| `@vdp/charts` | DOM-freie, getestete Graphen-Mathematik: Viewport, Cursor, Decimierung, Statistik (ADR 0011) |
| `@vdp/core` | Engine, ECU-Explorer, DTC-System, Recorder, Logger, Safety |
| `@vdp/runtime` | `createDiagnosticRuntime`: Services, Command-Handler, Domänen-Events — headless (ADR 0014) |
| `@vdp/adapters-*` | ELM327, CANable (slcan), SocketCAN, generisch |
| `@vdp/storage` | Session-Repository, Migrationen, ZIP-Export |
| `@vdp/reports` | HTML- und PDF-Report (eigener PDF-Writer) |
| `@vdp/ai` | austauschbare Analyse-Provider mit VIN-Redaktion |
| `@vdp/simulators` | virtuelles Fahrzeug + virtuelles CAN-Netz |
| `@vdp/trace-analyzer` | Offline-Trace-Analyse |
| `@vdp/definition-importer` | DBC/CSV/JSON → validiertes Definition-Paket |
| `@vdp/web` | Node HTTP + SSE, Vanilla-ESM-Oberfläche |

## Schnellstart

```bash
npm ci
npm run build
npm run demo          # Workbench auf http://localhost:8080
```

`npm run demo` startet den Simulator: drei Steuergeräte, gesetzte Fehlercodes,
Live-Messwerte. Kein Adapter, kein Fahrzeug.

Mit echtem Adapter:

```bash
node apps/web/dist/src/server.js --port=8080 --sessions=./sessions-local
```

## Entwicklung

```bash
npm ci                # exakt das Lockfile (Node >=22, engine-strict)
npm run build         # tsc -b über alle Projekt-Referenzen (TypeScript 7 / tsgo)
npm run typecheck     # Build + strikter noEmit-Pass über Tests, Konfiguration, Specs und Frontend-JS
npx biome check .     # Lint + Format (Biome 1.9): 2-space, 100-char, organizeImports
npm test              # Build + Vitest: alle 6 Ebenen (unit, protocol, regression, replay, integration, architecture)
npm run test:unit     # nur Unit-Specs — schnelle Feedback-Schleife
npm run test:coverage # Suite + V8-Coverage (global 90/80 als Durchschnitt; per-file laut vitest.config.ts, ADR 0020)
npm run ci            # Build + Typecheck + Biome + Test — entspricht der CI
```

Einzelnes Paket bzw. einzelne Test-Datei:

```bash
npx tsc -b packages/transport/iso-tp
npx vitest run packages/storage/src/storage.spec.ts
npx biome check --write .   # auto-fix
```

Qualitätstore: `npm run ci` prüft lokal genau das, was die CI prüft —
`build` + `typecheck` + `biome check` + die komplette Suite. Der Workflow
`.github/workflows/ci.yml` läuft auf Node 22 und 24 (`npm ci` → `build` →
`npm test`).

**Stand 2026-09-12, bewusst offen (AGENTS 0.E, E10):** die gehärtete CI aus
ADR 0016 §3 — Quality-Job (`lint` · `build` · `typecheck` · `npm audit`) vor der
Test-Matrix, Coverage-Lauf mit Artefakt-Upload, `codeql.yml`,
`dependency-review.yml` und der nächtliche `hardware.yml`-Smoke auf `vcan0` —
ist fertig entwickelt, aber nicht im Repository: GitHub lehnt den Push von
Workflow-Dateien ab, solange die GitHub-App-Installation keine
`workflows`-Berechtigung hat (gemessen 2026-09-12:
`refusing to allow a GitHub App to create or update workflow
.github/workflows/ci.yml without 'workflows' permission`). Bis dahin gilt:
`npm run ci` ist das Tor, nicht der Workflow. Details in
[`CONTRIBUTING.md`](CONTRIBUTING.md).

## Graphen

Zoom, Pan, Cursor, Marker, Zeitraumwahl, Min/Max/Ø/Delta, Ein-/Ausblenden und
synchronisierte Zeitachsen (AGENTS 16). Die Regeln dafür liegen DOM-frei in
`@vdp/charts` und laufen im Browser als dieselbe Datei, die die Unit-Tests
prüfen — der Server liefert sie unter `/lib/` aus (ADR 0011). Bedienung:
Mausrad zoomt am Cursor, Ziehen verschiebt, `Umschalt + Ziehen` wählt einen
Zeitraum aus, Doppelklick zeigt die gesamte Aufnahme.

## Tests

1066 Tests in ~23 s, Vitest 5 mit Projektkonfiguration (ADR 0010, Schritt 1 —
ersetzt ADR 0008). Unit-Specs liegen co-lokatiert neben dem Code
(`src/*.spec.ts`); Property-Tests laufen mit fast-check, Coverage-Gates mit
`npm run test:coverage` (global 90 % lines / 80 % branches als
Projekt-Durchschnitt, Ist 97,4 Zeilen / 87,8 Zweige; per-file-Gates für
`shared`/`core`/`protocols`/`adapters`/`transport`/`storage`/`charts`/`reports`/`ai`;
Hardware-Module `serial`/`binding` ausgenommen — maßgeblich ist
`vitest.config.ts`, ADR 0017, 0020 und 0022). Test-Zeit ist ein Budget: Discovery läuft in Tests mit explizitem
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
| Architektur | `tests/architecture` — Abhängigkeitsgraph ist ein Test (ADR 0015) |
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
| `GET /api/stream` | SSE: Samples, Trace, DTCs, Marker |
| `GET /lib/*` | kompiliertes `@vdp/charts` für den Browser (ADR 0011) |
| `POST /api/start` | Simulator verbinden, ECUs entdecken |
| `POST /api/dtc/scan` | Fehlerspeicher lesen |
| `POST /api/live/start` \| `/stop` | Live-Messung |
| `POST /api/analyze` | Analyse (lokaler Regel-Provider) |
| `POST /api/session/save` | Session persistieren |
| `GET /api/sessions` | gespeicherte Sessions |
| `GET /api/export/*` | CSV, JSON, HTML, PDF |

## Grenzen

Bewusst **nicht** enthalten (AGENTS 29): Complex Coding, Umgehung von
SFD/Security Access, Cloud, Mobile, Marketplace.

Die mitgelieferten VAG- und Mercedes-Pakete sind `example-placeholder` mit
erfundenen Werten und werden vom Validator entsprechend gekennzeichnet
(ADR 0003). Sie sind keine Fahrzeugwahrheit.
