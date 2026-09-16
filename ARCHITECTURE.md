# ARCHITECTURE.md — Einstiegspunkt für Menschen und KI-Agenten

> **Eine Datei zum Verstehen des ganzen Systems.** Wer nach dem Lesen dieser
> Datei nicht weiß, wo etwas ist, warum es dort ist und welche Verträge gelten,
> hat nicht alle Abschnitte gelesen — oder das System hat sich geändert
> (Regel 34.24: Doku, die vom Stand abweicht, ist ein Defekt).
>
> **Maschinenlesbare Quelle der Abhängigkeitsregeln:** [`architecture/architecture.yaml`](architecture/architecture.yaml).
> Dort stehen die Kanten (`mayImport`), die Layer-Zuordnung und die AI-Context-Topics —
> genau einmal. Diese Datei *erklärt* das System; sie darf die Kanten nicht neu
> aufzählen. Bei Widerspruch gilt das YAML, das der Dependency-Checker prüft.
>
> **AI-Agenten:** Starte hier. Dann package-README → ADR → `docs/code-map.md`.
> Die vorbereiteten Lesepakete liegen unter [`.ai/`](.ai/README.md), generierbare
> Kontext-Bundles mit `npm run ai:context <topic>`.

## 1. Was ist das?

yes-you-CAN ist eine modulare, hersteller-unabhängige Fahrzeugdiagnose-Plattform
für CAN / ISO-TP / UDS / DoIP: ein Diagnosekern, der über austauschbare
Transporte mit Steuergerichten spricht, Sitzungen aufzeichnet, Fehlerspeicher
gegen Variantenwissen auflöst, Messwerte dekodiert, Berichte rendert und
diagnostische Belege an austauschbare Analyse-Provider (heute: lokale Heuristik,
morgen: Modell-Gateway) übergibt — ohne dass ein Analyse-Provider je ein
Fahrzeug berühren kann.

Die harte Regel dahinter: **Lese- und Schreibpfad sind getrennt.** Alles, was
liest (UI, Reports, Analyse), bekommt Observations mit Beleg aus dem
Diagnostic IR. Alles, was schreibt, läuft über `WritePort` + `SafetyManager`
(ADR 0032, AGENTS 26). Die Abhängigkeitsrichtung macht das maschinell
durchsetzbar (`npm run check:deps`).

## 2. Schichten — von unten nach oben

```text
System
├── foundation      @vdp/shared, @vdp/charts
├── contract        @vdp/domain, @vdp/diagnostic-ir, @vdp/definitions
├── application     @vdp/application
├── protocol        @vdp/protocols-uds, @vdp/protocols-kwp2000, @vdp/protocols-oem
├── transport       @vdp/transport-can, @vdp/transport-iso-tp, @vdp/transport-doip
├── adapter         @vdp/adapter-* (generic-can, elm327, canable, socketcan, host)
├── core            @vdp/core
├── runtime         @vdp/runtime
├── persistence     @vdp/storage
├── presentation    @vdp/reports
├── AI              @vdp/ai
├── UI              @vdp/web (apps/web)
└── tool            @vdp/simulators, @vdp/golden-sessions,
                    @vdp/trace-analyzer, @vdp/definition-importer
```

Die Layer-Definitionen (wofür jeder Name gut ist) stehen in
[`architecture/architecture.yaml`](architecture/architecture.yaml) → `layers`.
Die zulässigen Kanten pro Paket stehen dort unter `packages.*.mayImport` —
**jedes Paket, das nicht in `mayImport` genannt ist, ist verboten.**

### foundation — `@vdp/shared`, `@vdp/charts`

- **Purpose:** Primbausteine für den ganzen Baum (Bytes, Fehler, Events, Ids,
  Logger) und ein DOM-freies Chart-Kernpaket.
- **Allowed dependencies:** keine.
- **Forbidden dependencies:** alles. `@vdp/shared` importiert buchstäblich nichts.
- **Main entry points:** `packages/shared/src/index.ts`, `packages/charts/src/index.ts`.
- **Important contracts:** Alle Pakete loggen, parsen und id-bilden über
  `@vdp/shared` — eine zweite Byte- oder Fehler-Vokabel ist ein Defekt.
- **Tests:** `packages/shared/src/*.spec.ts` (100 % Linien-Coverage ist
  per-file-Gate), `packages/charts/src/*.spec.ts`.

### contract — `@vdp/domain`, `@vdp/diagnostic-ir`, `@vdp/definitions`

- **Purpose:** Reine Datenverträge ohne I/O: Domänenmodell und Ports
  (`domain`), die diagnostische Zwischenrepräsentation mit Provenance
  (`diagnostic-ir`, ADR 0034/0037), und OEM-Wissen als validierte Daten
  (`definitions`, ADR 0003/0023/0024).
- **Allowed dependencies:** `@vdp/shared` (und für `domain`: nur das).
- **Forbidden dependencies:** Protokolle, Transporte, Adapter, `node:`-Builtins,
  `@vdp/core`, `@vdp/runtime` — die Layer bleiben portabel und stabil.
- **Main entry points:** `packages/domain/src/index.ts`,
  `packages/diagnostic-ir/src/index.ts`, `packages/definitions/src/index.ts`
  + Subpath-Exports `./generic`, `./vag`, `./mercedes`.
- **Important contracts:** Ein Begriff = eine Bedeutung (siehe
  [`docs/glossary.md`](docs/glossary.md)). `DiagnosticObservation`-Typen tragen
  immer `evidence: Evidence` — `proven` (mit Herkunft) oder `unproven` (mit
  Grund). Fehlende Evidenz ist ein Fehlschlag, keine Warnung (ADR 0033).
- **Tests:** co-lokatierte `*.spec.ts`; `diagnostic-ir` mit per-file-Gate 95/85.

### application — `@vdp/application`

- **Purpose:** Das *Was*: Commands, Queries, der Command Bus und
  capabilities-getriebene Actions. Wie ausgeführt wird, ist Sache des Runtime.
- **Allowed dependencies:** `@vdp/domain`.
- **Forbidden dependencies:** Protokolle, Transporte, I/O, `@vdp/core`,
  `@vdp/runtime`.
- **Main entry point:** `packages/application/src/index.ts` (`CommandBus`,
  `CommandKinds`, `QueryKinds`, `ActionRegistry`).
- **Important contracts:** Clients sprechen ausschließlich über diesen Bus;
  der Runtime registriert die Handler (`registerRuntimeHandlers`).
- **Tests:** `packages/application/src/*.spec.ts`.

### protocol — `@vdp/protocols-uds`, `@vdp/protocols-kwp2000`, `@vdp/protocols-oem`

- **Purpose:** Diagnose-Protokolle: UDS-Client *und* UDS-Server (ISO 14229),
  KWP2000 als UDS-Teilmenge, OEM-Hooks als Lückenfüller (ADR 0041).
- **Allowed dependencies:** `@vdp/shared` (kwp2000 zusätzlich `protocols-uds`).
- **Forbidden dependencies:** Busse, Adapter, Transporte — ein Protokoll spricht
  durch eine *Link*-Seam (`UdsLink`), nie durch eine `CanBus` (ADR 0031).
- **Main entry points:** `packages/protocols/uds/src/index.ts`
  (`UdsClient`, `UdsServer`, `IsoTpUdsLink`, NRCs, Timing),
  `packages/protocols/oem/src/index.ts`.
- **Important contracts:** Negativ-Antworten sind Daten mit NRC, keine
  Exception ohne Grund (ADR 0018/0039). Der `UdsServer` hat eine
  Simulator-API (`registerDid`, `registerWritableDid`, `setDtc`) — Casts in
  interne Maps sind verboten (ADR 0041).
- **Tests:** `packages/protocols/*/src/*.spec.ts` (per-file-Gate 90/75),
  Konformanz-Suite `tests/protocol/`.

### transport — `@vdp/transport-can`, `@vdp/transport-iso-tp`, `@vdp/transport-doip`

- **Purpose:** Rahmen-Ebene (`CanFrame`, `CanBus`-Vertrag, Registry),
  Segmentation nach ISO 15765-2, DoIP-Link nach ISO 13400 als CAN-artige
  Bus-Alternative.
- **Allowed dependencies:** `@vdp/shared` (+ `transport-can` für ISO-TP/DoIP).
- **Forbidden dependencies:** Protokolle (Regel „transports are the frame
  layer; protocols sit above them“), Adapter, `node:`-Builtins (portabel).
- **Main entry points:** `packages/transport/{can,iso-tp,doip}/src/index.ts`.
- **Important contracts:** `CanBus` ist der Vertrag für alle Adapter
  (`open/close/send/subscribe`); ISO-TP hält die Transaktionssperre pro
  Verbindung (ADR 0013); abgeschnittene Antworten sind Fehler, keine leeren
  Speicher (ADR 0039).
- **Tests:** co-lokatierte Specs (per-file-Gate 88/72).

### adapter — `@vdp/adapter-*`

- **Purpose:** Hardware- und Schnittstellenspezifisches: ELM327/CANable über
  Serial, SocketCAN, Generic-CAN, Host-Katalog mit Probing (`adapter-host`).
- **Allowed dependencies:** `@vdp/shared`, `@vdp/transport-can` (+ peer-Adapter
  für CANable/Host).
- **Forbidden dependencies:** Protokolle und `@vdp/core` — Hardware-Spezifika
  bleiben unter dem Protokoll.
- **Main entry points:** `packages/adapters/*/src/index.ts`; Probing-Katalog:
  `packages/adapters/host/src/catalog.ts`.
- **Important contracts:** Ein Adapter implementiert `CanBus` und liefert
  `CanAdapterFactory` (`id`, `displayName`, `create`, `isAvailable`) — neue
  Hardware steckt in die Registry, berührt nicht den Engine (Regel 34.6).
  `node:`-Builtins (tty, os, …) sind nur hier erlaubt.
- **Tests:** co-lokatierte Specs (per-file-Gate 92/78); Hardware-Smoke
  `tests/hardware/vcan.test.ts` (manuell).

### core — `@vdp/core`

- **Purpose:** Der Diagnosekern: Session (`VehicleSessionData`), ECU-Discovery,
  UDS-Orchestrierung über die Link-Factory, DTC-Scan/Tracking mit Varianten-
  wissen, Messwert-Engine, `WritePort` + Safety, Session-Logger, Evidenz-
  Sammlung in IR-Form.
- **Allowed dependencies:** `shared`, `diagnostic-ir`, `definitions`,
  `protocols-uds`, `protocols-oem`, `transport-can`, `transport-iso-tp`.
- **Forbidden dependencies:** `runtime`, `storage`, `reports`, `ai`, `web` —
  der Kern ist die breiteste Schicht *unter* dem Runtime und weiß nicht, wer
  ihn bedient.
- **Main entry point:** `packages/core/src/index.ts`
  (`DiagnosticEngine`, `DtcScanner`, `collectEvidence`, `createWritePort`, …).
- **Important contracts:** Roh und dekodiert bleiben getrennt (ADR 0004);
  jede Beobachtung bekommt IR-Form mit Provenance
  (`dtcObservationOf`, `sessionObservationOf`); Schreiboperationen existieren
  nur als `WriteOperation` hinter `WritePort` (ADR 0032); fehlende Evidenz
  schlägt fehl (ADR 0033).
- **Tests:** co-lokatierte Specs (per-file-Gate 88/80) +
  `tests/protocol/`, `tests/replay/`, `tests/regression/`.

### runtime — `@vdp/runtime`

- **Purpose:** Kompositions-Wurzel: `createDiagnosticRuntime` verdrahtet Engine,
  Services, Command Bus, Events, Audit und injizierte Ports (Clock, Ids,
  Store, Definitionen). Headless — Web, CLI, Mobile und KI-Agenten komponieren
  dasselbe Objekt.
- **Allowed dependencies:** `shared`, `diagnostic-ir`, `domain`, `application`,
  `core`, `definitions`, `protocols-uds`, `transport-can`, `transport-doip`
  (Transport-Seam).
- **Forbidden dependencies:** `storage` (Persistenz gehört zur App über den
  Port), `reports`, `ai`, `web`, HTTP/DOM.
- **Main entry point:** `packages/runtime/src/runtime.ts` →
  `DiagnosticRuntime` (`vehicle`, `ecus`, `dtc`, `measurements`,
  `signalAnalysis`, `writes`, `evidence`, `session`, `safety`, `definitions`,
  `actions`, `commands`, `events`, `audit`, `dispose`).
- **Important contracts:** Der Public Surface ist *Services + Command Bus* —
  die Engine ist internes Detail (ADR 0014). Evidenz kommt von genau einer
  Stelle: `runtime.evidence` (ADR 0038).
- **Tests:** `packages/runtime/src/*.spec.ts`, `tests/integration/runtime.test.ts`.

### persistence — `@vdp/storage`

- **Purpose:** Session-Persistenz (JSON/NDJSON), versionierte Migrations,
  ZIP-Export, Repository-Vertrag (`SessionRepository`).
- **Allowed dependencies:** `@vdp/shared`, `@vdp/core` (Session-Verträge).
- **Forbidden dependencies:** `runtime`, `web` — Persistenz hängt *unter* der
  Runtime; die App persistiert über dieses Paket und bleibt `@vdp/core`-frei
  in der Speicher-Angelegenheit.
- **Main entry point:** `packages/storage/src/index.ts`
  (`FileSystemSessionRepository`, `MemorySessionRepository`, `parseTraceLines`).
- **Important contracts:** Migrations sind versioniert (ADR 0007); alte
  Sessions bleiben lesbar (Regel 34.14); `node:fs` ist hier erlaubt — das ist
  der Dateizugriff der Plattform.
- **Tests:** `packages/storage/src/*.spec.ts` (per-file-Gate 95/80).

### presentation — `@vdp/reports`, (foundation) `@vdp/charts`

- **Purpose:** Berichte (PDF + HTML-Sektionen) und Chart-Rendering für
  produzierte Daten.
- **Allowed dependencies:** `core` + `diagnostic-ir` (Reports); Charts: keine.
- **Forbidden dependencies:** Fahrzeuge, Transporte, `runtime`, `web` —
  Presentation druckt, was der Kern produziert, und liest dafür das IR direkt,
  statt Evidenz-Vokabeln zu kopieren (ADR 0037).
- **Main entry points:** `packages/reports/src/index.ts`,
  `packages/charts/src/index.ts`.
- **Tests:** co-lokatierte Specs (per-file-Gate: Reports 95/80, Charts 90/75).

### AI — `@vdp/ai`

- **Purpose:** Analyse-Provider-Abstraktion: lokaler Heuristik-Provider aus
  der Dose, HTTP-Provider für beliebige Modell-Gateways, `AnalysisService`
  mit Quellen-Label und Provenance (Prompt-Version, Runtime-Version,
  Definition-Version).
- **Allowed dependencies:** `@vdp/shared`, `@vdp/diagnostic-ir`. **Genau diese
  zwei** — der Guardrail-Test rechnet die Transitiv-Hülle und fällt, sobald
  ein Lese-Layer Schreibfähigkeit erreicht (ADR 0038).
- **Forbidden dependencies:** `core`, `runtime`, Transporte, Protokolle,
  Adapter — eine Analyse schlägt vor, die Write-Kette entscheidet
  (AGENTS 22, P0 #16).
- **Main entry point:** `packages/ai/src/index.ts`
  (`AnalysisService`, `AnalysisInput`, `AnalysisResult`, Provider).
- **Important contracts:** Faktische Eingabe = `EvidenceSet` + Hypothesen +
  Versionen; Befunde zitieren Item-Ids; ein Zitat auf ein nicht existierendes
  Item fällt weg; keine Konfidenz, die der Beleg nicht trägt.
- **Tests:** `packages/ai/src/*.spec.ts` (per-file-Gate 95/85).

### UI — `@vdp/web` (`apps/web`)

- **Purpose:** Die Workbench: Node-HTTP-Server + SSE + Vanilla-ESM-Frontend.
  Sie spricht zum Fahrzeug ausschließlich über den Runtime (Command Bus).
- **Allowed dependencies:** siehe `architecture.yaml` (Runtime, Domain,
  Application, IR, Definitions, UDS für das Vokabular, Storage, Reports, AI,
  Simulators, `adapter-host` für die Bus-Auswahl).
- **Forbidden dependencies:** keine — die UI importiert niemanden; sie ist die
  Spitze. Dagegen gilt: kein CAN/UDS-Logik *in* der UI (Regel 34.4), kein
  direkter Transport-Zugriff aus der UI.
- **Main entry points:** `apps/web/src/server.ts` (HTTP),
  `apps/web/src/backend.ts` (Services), `apps/web/public/` (Frontend),
  `apps/web/src/views.ts` (Wire-Contract, typgeprüft gegen `public/*.js`,
  ADR 0030).
- **Important contracts:** Security-Baseline (ADR 0009: localhost-Default,
  Header, Body-Limit, GET-only-Stream); abgelehnte Writes sind Antworten mit
  Grund, keine HTTP-Fehler (ADR 0018); Frontend ist gegen den Wire-Contract
  typgeprüft (ADR 0030).
- **Tests:** `apps/web/test/*.spec.ts` (Integration, `--demo`-Server),
  per-file-Gate 76/72.

### tool — `@vdp/simulators`, `@vdp/golden-sessions`, `@vdp/trace-analyzer`, `@vdp/definition-importer`

- **Purpose:** Virtuelles Fahrzeug mit Verhaltensmodell + Szenario-Engine +
  Fault-Injection (ADR 0039/0040), Aufzeichnung/Replay mit Erwartung
  (ADR 0036), Offline-Trace-Analyse, Definition-Import.
- **Allowed dependencies:** siehe `architecture.yaml` — Tools dürfen breit
  lesen, weil *nichts sie importiert*.
- **Forbidden dependencies:** nichts über die Manifest-Kanten hinaus; aber:
  ein Tool ist keine Schicht — kein `packages/*` darf `@vdp/simulators` o. Ä.
  als Runtime-Dependency deklrieren (CI-Gate über die Import-Graph-Prüfung).
- **Main entry points:** `tools/simulators/src/index.ts`
  (`VirtualVehicle`, `HighFidelityVehicle`, `SCENARIO_CATALOG`, `runScenario`),
  `tools/golden-sessions/src/cli.ts`, `tools/trace-analyzer/src/index.ts`.
- **Important contracts:** Der Simulator antwortet wie ein echtes
  ECU-Stack *über den Draht* — Tests poken nie Simulator-Felder direkt
  (ADR 0040); `runScenario` assertet nie, er liefert `ScenarioRun`;
  Fault-Injection sitzt an der Link-Seam (ADR 0039).
- **Tests:** co-lokatierte Specs, `tests/replay/` (Goldens), E2E-Kette
  `tests/integration/scenario-chain.test.ts`.

## 3. Die harten Verträge (maschinell geprüft)

| Vertrag | Wo geprüft | Was „beißen“ heißt |
|---|---|---|
| Abhängigkeitsgraph (`mayImport`) | `npm run check:deps` → `tests/architecture/dependencies.test.ts` | Verbotene Kante = Build-FAIL |
| Layer-Regeln (protocols ≠ adapters, transports ≠ protocols, …) | dito | dito |
| Portabilität (domain/application ohne I/O, `node:`-Builtins nur 4 Pakete) | dito | `node:fs` in `@vdp/core` = FAIL |
| UI wird von niemandem importiert | dito | `@vdp/web` in einer Dependency = FAIL |
| AI bleibt lese-fähig, nie schreib-fähig (Transitiv-Hülle) | `tests/architecture/guardrails.test.ts` | `@vdp/ai` kann `@vdp/core` erreichen = FAIL |
| `package.json` ⇔ tatsächliche Imports | `npm run check:manifests` → `tests/architecture/manifests.test.ts` | Tote/fehlende Dependency = FAIL |
| Hygiene (kein `any`, keine fixen Sleeps, Zeilen-Budgets) | `tests/architecture/hygiene.test.ts` | Violation = FAIL |
| Coverage-Gates (global 90/80/90/90 + per-file) | `npm run test:coverage` (+ CI-Träger ADR 0029) | Schwelle unter = FAIL |
| Lint + Format + Typecheck | `npm run check`, `npm run typecheck` (im `architecture`-Projekt mitlaufen) | — |

## 4. Wo ändere ich was?

Die kurze Antwort auf „Where should I change this?“:
[`docs/code-map.md`](docs/code-map.md). Die längere Antwort pro Paket: die
`README.md` im jeweiligen Package-Verzeichnis (Standard-Sektionen Purpose /
Does NOT do / Public API / Invariants).

## 5. Datenflüsse

Vollständige Pipeline-Karten (CAN-Frame → … → Analyse):

- [`docs/flows/diagnostic-read.md`](docs/flows/diagnostic-read.md)
- [`docs/flows/diagnostic-write.md`](docs/flows/diagnostic-write.md)
- [`docs/flows/dtc-analysis.md`](docs/flows/dtc-analysis.md)
- [`docs/flows/recording-replay.md`](docs/flows/recording-replay.md)
- [`docs/flows/ai-analysis.md`](docs/flows/ai-analysis.md)

## 6. Begriffe

[`docs/glossary.md`](docs/glossary.md) — ein Begriff = eine Bedeutung. Wenn du
`DiagnosticData`, `Reading` oder `Measurement` in einer neuen Datei siehst,
steht dort drin, was sie heißen *dürfen*.

## 7. Entscheidungs-Historie

[`docs/adr/`](docs/adr/README.md) — 42 ADRs, nie gelöscht, nur `superseded`.
Die neuen ADRs tragen Pflicht-Abschnitte *Affected packages*, *Forbidden
implementations*, *Migration*, *Tests* und *AI implementation notes*
(vorabgebildet in [ADR 0043](docs/adr/0043-ai-context-layer.md)).

## 8. Ausführung & Gates

```bash
npm ci && npm run build && npm run typecheck   # Kompilierung + strikter noEmit
npm run check                                  # biome (Lint + Format)
npm run check:deps && npm run check:manifests  # Architektur-Gates
npm test                                       # 6 Ebenen (unit … architecture)
npm run test:coverage                          # Coverage-Gates
npm run ci                                     # alles in einem Tor
npm run demo                                   # Workbench + Simulator
```

Details und die Belege: [AGENTS.md §0.B](AGENTS.md) und ADR 0010/0016/0029.

## 9. Wie diese Datei gepflegt wird

- Diese Datei **restatet keine Kanten** — Kanten stehen nur in
  `architecture/architecture.yaml`.
- Ändert sich eine Schicht, ein Layer oder ein Vertrag: YAML + diese Datei +
  betroffene package-README + ADR in *einem* PR (Regel 34.24).
- Neue ADRs folgen dem Template aus ADR 0043 (inkl. *Affected packages* und
  *AI implementation notes*).
- AI-Agenten: Lies [`.ai/README.md`](.ai/README.md) für die vorbereiteten
  Lesepakete und [`docs/code-map.md`](docs/code-map.md) für die
  Aufgabe-→Stelle-Karte.
