# yes-you-CAN

Fahrzeugdiagnose-Plattform: CAN und DoIP lesen, Steuergeräte identifizieren,
Fehlerspeicher auslesen, Live-Messwerte aufzeichnen und als Report exportieren —
ohne Real-Fahrzeug testbar.

Die Spezifikation liegt in [`AGENTS.md`](AGENTS.md), die Begründungen für den
Aufbau in [`docs/adr/`](docs/adr/).

## Schichten

Abhängigkeiten zeigen nur nach unten (ADR 0001):

```
UI (apps/web)
  └─ Application / Diagnostic Engine (packages/core)
       ├─ Protocols  (uds, kwp2000, oem)
       ├─ Transport  (iso-tp, doip, can)
       │    └─ Adapters (elm327, canable, socketcan, generic-can)
       └─ Definitions (generisch, VAG, Mercedes)
```

Die UI interpretiert keine CAN-Frames. OEM-Logik liegt nicht in der CAN-Schicht.
Ein Transport ist austauschbar, ohne dass die UDS-Engine davon weiß.

## Pakete

| Paket | Zweck |
|---|---|
| `@vdp/shared` | Fehler, Byte/Hex, Logger (Raw-Logging opt-in), Events |
| `@vdp/transport-can` | `CanFrame`, `CanBus`, Adapter-Registry, `ReplayTransport` |
| `@vdp/transport-iso-tp` | ISO 15765-2: SF/FF/CF/FC, STmin, Blockgröße, Timeouts |
| `@vdp/transport-doip` | ISO 13400-2: Routing Activation, Diagnose-Messages, Discovery |
| `@vdp/protocols-uds` | ISO 14229-1 Client **und** In-Prozess-Server |
| `@vdp/protocols-kwp2000` | ISO 14230 für Alt-ECUs |
| `@vdp/protocols-oem` | OEM-Erweiterungspunkte + Registry |
| `@vdp/definitions` | versioniertes Schema, Validator, Pakete mit Provenance |
| `@vdp/core` | Engine, ECU-Explorer, DTC-System, Recorder, Logger, Safety |
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
npm run build         # tsc -b über alle Projekt-Referenzen
npm test              # build + node scripts/test.mjs
npm run test:only     # nur testen, ohne neuen Build
```

Einzelnes Paket:

```bash
npx tsc -b packages/transport/iso-tp
node --test packages/transport/iso-tp/dist/test/*.test.js
```

## Tests

266 Tests, `node:test` auf kompiliertem Output, keine Test-Abhängigkeit
(ADR 0008). Ebenen nach AGENTS 31:

| Ebene | Ort |
|---|---|
| Unit | `packages/*/test`, `tools/*/test`, `apps/*/test` |
| Integration | `tests/integration` |
| Protokoll | `tests/protocol` |
| Replay | `tests/replay` |
| Regression | `tests/regression` |

Der Regressionskatalog dokumentiert jeden gefundenen Protokollfehler mit
Symptom — vier davon fand der Compiler nicht, sondern erst der laufende Test.

## HTTP-API

| Route | Zweck |
|---|---|
| `GET /api/state` | gesamter Zustand |
| `GET /api/stream` | SSE: Samples, Trace, DTCs |
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
