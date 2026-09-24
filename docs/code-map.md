# Code-Map — „Where should I change this?“

Die Aufgabe→Stelle-Karte des Repositories. Ein Coding-Agent liest diese Datei,
bevor er Sucht durch den Baum beginnt. Jede Zeile nennt die **primäre** Stelle
und die **Sekundärstellen**, die fast immer mitspielen. Die Abhängigkeits-
fragen („darf das Paket das importieren?“) beantwortet
[`architecture/architecture.yaml`](../architecture/architecture.yaml) —
nicht diese Datei.

## Aufgaben → primäre Stelle

| Aufgabe | Primäre Stelle | Sekundär / mitlaufen |
|---|---|---|
| UDS-Service hinzufügen (Client) | `packages/protocols/uds/src/services.ts` + `client.ts` | `server.ts` (Server-Seite), `tests/protocol/`, `packages/core` (Fallback-Service-Katalog, falls der Engine es ausliest) |
| UDS-Service für den Simulator/Server definieren | `packages/protocols/uds/src/server.ts` (`registerDid`, `registerWritableDid`, `setDtc`) | `tools/simulators/src/virtual-vehicle.ts`, `tests/protocol/` (ADR 0041: nie Casts in interne Maps) |
| NRC / Negativ-Antwort verhalten | `packages/protocols/uds/src/nrc.ts` | `client-engine.ts` (Retry-Logik), `tests/protocol/` |
| ECU-Session-Verhalten (Timing, S3, TesterPresent) | `packages/protocols/uds/src/session-state.ts` + `timing.ts` | `client.ts` |
| CAN-Adapter hinzufügen | `packages/adapters/<neuer>/` (neues Workspace-Paket) | `packages/adapters/host/src/catalog.ts` (Probe), `CanAdapterFactory` aus `@vdp/transport-can`, `architecture/architecture.yaml` (Package platzieren!), `package.json` (workspaces) |
| Bus-Vertrag ändern | `packages/transport/can/src/bus.ts` | alle Adapter, `packages/core/src/diagnostics/ecu-links.ts`, `architecture.yaml` |
| ISO-TP-Parameter / Segmentierung | `packages/transport/iso-tp/src/{connection,params}.ts` | `tests/protocol/` |
| DoIP-Verhalten | `packages/transport/doip/src/` | `packages/runtime/src/transport.ts` (`DoipEcuLinkFactory`), `tests/integration/doip-engine.test.ts` |
| Neues IR-Objekt / neue Observations-Form | `packages/diagnostic-ir/src/` (neues Modul + Export in `index.ts`) | `packages/core/src/session/observation.ts` (Erzeugung), `packages/runtime/src/mappers.ts`, `docs/api/diagnostic-ir.md`, ADR (Regel 34.15) |
| DTC-Analyse / -Ablauf | `packages/core/src/dtc/` (scanner, freeze-frame, clear) | `packages/diagnostic-ir/src/dtc.ts`, `packages/runtime/src/dtc-service.ts` (`DtcService`, ADR 0049 aus `services.ts` geteilt), `docs/flows/dtc-analysis.md` |
| Scan über alle Module / „wer hat nicht geantwortet?" | `packages/core/src/diagnostics/dtc-access.ts` (`scanAll` → `DtcScanReport`) | `packages/runtime/src/dtc-service.ts`, `packages/application/src/queries.ts` (`GetDtcScanGaps`), `apps/web/src/dtc-view.ts` + `public/app.js` (`#dtc-unread`), ADR 0049 |
| DTC-Wissen (Varianten, Beschreibungen) | `packages/definitions/src/<oem>/` | `packages/definitions/src/validate.ts` (Qualitäts-Gates, ADR 0025), `tools/definition-importer/` |
| Evidence / Hypothesen-Logik | `packages/core/src/evidence/{collect,hypotheses,guided-diagnosis}.ts` | `packages/diagnostic-ir/src/evidence.ts`, `packages/runtime/src/evidence-service.ts` |
| AI-Analyse / Provider | `packages/ai/src/` | `apps/web/src/analysis-input.ts` (Input-Bau inkl. `recordingId`/`scenario`), ADR 0038/0046 (Kontrakt) |
| Write-Operation hinzufügen | `packages/core/src/writes/` (neues `WriteOperation`-Modul) | `createWritePort`-Wiring in `packages/runtime/src/runtime.ts`, `SafetyManager`-Policy in `packages/domain/src/risk.ts`, ADR 0032/AGENTS 26 |
| UI-View / -Panel | `apps/web/src/views.ts` (Wire-Contract) + `apps/web/public/` | `apps/web/src/backend.ts`, `apps/web/test/`, ADR 0030 |
| Neue HTTP-Route | `apps/web/src/server.ts` | `apps/web/src/route-input.ts` (Grammatik-Prüfung), `apps/web/src/backend.ts` |
| Statische Dateien, MIME, Sicherheits-Header | `apps/web/src/static-assets.ts` (ADR 0049 aus `server.ts` geteilt) | `apps/web/src/paths.ts` (Containment, ADR 0009), `apps/web/test/static-assets.spec.ts` |
| Was der Prozess auf stdout schreibt | `packages/shared/src/logger.ts` (`createLogger`, `ConsoleSink`) | `apps/web/src/server.ts` (`createServerLogger`, `VDP_LOG_LEVEL`) — der Sink hängt am Einstieg, nie in einem Konstruktor |
| Simulator-Verhalten (Fahrzeug-Modell) | `tools/simulators/src/vehicle-model.ts` + `vehicle-state.ts` | `vehicle-wiring.ts`, `vehicle-monitors.ts`, `tests/integration/scenario-chain.test.ts` |
| Szenario hinzufügen | `scenarios/*.json` (der Katalog selbst, ADR 0048) | `tools/simulators/src/scenario-file.ts` (Grammatik) + `scenario-library.ts` (Lader), `scenarios/README.md` |
| Fault-Injection / Chaos | `tools/simulators/src/{faulty-link,chaos-lab}.ts` | `apps/web/src/backend.ts` (Chaos-Schalter, ADR 0029) |
| Recording / Replay | `packages/core/src/logging/session-logger.ts` | `packages/storage/src/{repository,zip}.ts`, `tools/golden-sessions/`, `tests/replay/` |
| Session-Schema / Migration | `packages/core/src/session/session.ts` | `packages/storage/src/migrations.ts`, ADR 0007 |
| Fahrzeugauflösung (VIN → Fahrzeug) | `packages/runtime/src/vehicle-resolution.ts` | `packages/definitions/src/resolve.ts`, ADR 0023/0026 |
| Chart-Rendering | `packages/charts/src/` | `apps/web/public/` (DOM-Teil) |
| Bericht (PDF/HTML) | `packages/reports/src/` | `apps/web/src/backend.ts` |
| Definition-Import / OEM-Daten | `tools/definition-importer/src/` | `packages/definitions/src/json.ts` + `validate.ts` |
| Fahrzeug auslesen (Ernte) / ODX-/PDX-Export | `tools/harvest/src/{harvest,plan,fault-memory}.ts` | `tools/harvest/src/odx/` (ODX-D-/PDX-Schreiber + `verify.ts` Gegenprüfung), `tools/harvest/src/definition.ts` (Kandidat), `docs/flows/harvest.md`, ADR 0058 |
| Beobachtete Daten als Quelle kennzeichnen | `packages/definitions/src/schema.ts` (`Provenance.sourceType: "observed"`, Provenance je Signal/DTC/ECU) | `packages/definitions/src/{json,validate,evidence}.ts`, `apps/web/src/vehicle-view.ts` (Label), ADR 0058 |
| DTC-Verfügbarkeitsmaske / `0x19`-Unterfunktionen | `packages/protocols/uds/src/{client,dtc,server}.ts` | `packages/core/src/diagnostics/ecu-session.ts` (`dtcAvailabilityMask`), `packages/diagnostic-ir/src/dtc.ts`, `docs/api/uds.md` |
| Dependency-Regel ändern | `architecture/architecture.yaml` | `npm run check:deps`, ADR (Regel 34.15) |
| Vertrag (Open/Closed-Grenze) markieren oder ändern | `architecture/architecture.yaml` → `contracts` (`why`, `entry` für Modul-Verträge, `docs` für die Seite) | `architecture/public-api.json` neu messen (`npm run check:api -- --update`, **nach** `npm run build`), `docs/api/<naht>.md`, `docs/flows/open-core-boundary.md`, ADR 0059 |
| Fremdcode-Lizenzrichtlinie ändern | `architecture/architecture.yaml` → `licenses` (zwei Geltungsbereiche, je `why`) | `npm run check:licenses`, ADR 0060, `docs/standards/csms.md` |
| Doku-Link oder Naht-Seite anfassen | die betroffene `.md` selbst | `tests/architecture/docs.test.ts` (tote Links, Anker, ADR-Register, `docs` je Vertrag) |
| Veröffentlichen (Scope, Trockenlauf, Provenance) | `docs/operations/registry.md` | `check-package-manifests.mjs` (`publishable-*`-Regeln), `docs/architecture/open-core-phase-0-rights.md` (Rechte sind die Voraussetzung, nicht der Nachtrag) |
| Neues Workspace-Paket | `packages/<name>/` mit `package.json` + `tsconfig.json` | `architecture.yaml` (`packages` + ggf. `topics`), Root-`tsconfig.json` (references), `tsconfig.typecheck.json` (paths), `vitest.config.ts` (falls neue Test-Ebene), `package-lock.json` (npm install) |
| Neues Testbeispiel / ausführbare Doku | `tests/examples/` | `vitest.config.ts` (Projekt `integration` pickt `tests/examples/**/*.example.ts` auf) |
| AI-Kontext-Bundle anpassen | `architecture/architecture.yaml` → `topics` | `tools/architecture/ai-context.mjs`, `tests/architecture/ai-context.test.ts` |
| Impact einer Änderung bestimmen | `npm run architecture:impact -- <datei\|paket>` | `tools/architecture/impact.mjs` (Rückwärtsschluss der `mayImport`-Kanten aus dem Manifest), `npm run ai:context:changed` (`.ai/generated/changed-context.md`), ADR 0046 |
| Szenariodatei (.json) ändern / ergänzen | `tools/simulators/src/scenario-file.ts` (`parseScenarioFile` — die Grammatik) | `tools/simulators/scenario.schema.json` + `scenarios/README.md` (dieselbe Grammatik, im selben PR), `tests/integration/scenario-file.test.ts`, ADR 0046 |
| Konformanz-Vektor ändern / ergänzen | `tools/formal-conformance/vectors/{isotp,safety}.json` (der Vertrag) | `tools/formal-conformance/src/{vectors,isotp-runner,safety-runner}.ts`, `formal/*.hs` (Referenzseite — dieselbe Datei, keine Abschrift!), `npm run formal:conform`, ADR 0045 |
| Formales Referenzmodell (Haskell) ändern | `formal/` (Runner: `formal/README.md`) | Dieselbe Vektordatei, `tests/protocol/formal-conformance.test.ts` (Skip mit Grund ohne Toolchain), ADR 0045 |

## Regelmuster (wiederkehrende Fragen)

- **Neue Hardware?** → Adapter-Paket + Host-Katalog + `architecture.yaml`.
  Der Engine muss das nicht merken (ADR 0001, Regel 34.6).
- **Neuer Hersteller?** → Definition-Paket (`packages/definitions/src/<oem>/`) +
  Subpath-Export + (optional) OEM-Hooks in `@vdp/protocols-oem`. OEM-Logik
  gehört nie in CAN-Schicht oder UI (Leitplanke 0.D).
- **Neue Messgröße / Signal?** → Definition-Paket (Daten, nicht Code) +
  Decoder-Check in `packages/core/src/measurements/decoder.ts` (falls das
  Format neu ist).
- **Etwas „schnell in die UI“?** → Nein. Der Weg ist: domain → application →
  runtime-Handler → (UI). Direktzugriff auf Engine/Transport aus der UI ist
  eine Review-Blockade (Regel 34.4).
- **Etwas „schnell in die KI“?** → Nein. Die KI liest `EvidenceSet` +
  Hypothesen über `runtime.evidence` / `collectEvidence`; alles andere ist
  eine zweite Kopie der Belege (ADR 0038).
- **Neue Konstante / Enum, die zwei Schichten brauchen?** → `@vdp/shared`
  (Primitiv) oder die tiefste gemeinsame Schicht — nie in beide Kopien.
