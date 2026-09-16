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
| DTC-Analyse / -Ablauf | `packages/core/src/dtc/` (scanner, freeze-frame, clear) | `packages/diagnostic-ir/src/dtc.ts`, `packages/runtime/src/services.ts` (`DtcService`), `docs/flows/dtc-analysis.md` |
| DTC-Wissen (Varianten, Beschreibungen) | `packages/definitions/src/<oem>/` | `packages/definitions/src/validate.ts` (Qualitäts-Gates, ADR 0025), `tools/definition-importer/` |
| Evidence / Hypothesen-Logik | `packages/core/src/evidence/{collect,hypotheses,guided-diagnosis}.ts` | `packages/diagnostic-ir/src/evidence.ts`, `packages/runtime/src/evidence-service.ts` |
| AI-Analyse / Provider | `packages/ai/src/` | `apps/web/src/analysis-input.ts` (Input-Bau), ADR 0038 (Kontrakt) |
| Write-Operation hinzufügen | `packages/core/src/writes/` (neues `WriteOperation`-Modul) | `createWritePort`-Wiring in `packages/runtime/src/runtime.ts`, `SafetyManager`-Policy in `packages/domain/src/risk.ts`, ADR 0032/AGENTS 26 |
| UI-View / -Panel | `apps/web/src/views.ts` (Wire-Contract) + `apps/web/public/` | `apps/web/src/backend.ts`, `apps/web/test/`, ADR 0030 |
| Neue HTTP-Route | `apps/web/src/server.ts` | `apps/web/src/route-input.ts` (Grammatik-Prüfung), `apps/web/src/backend.ts` |
| Simulator-Verhalten (Fahrzeug-Modell) | `tools/simulators/src/vehicle-model.ts` + `vehicle-state.ts` | `vehicle-wiring.ts`, `vehicle-monitors.ts`, `tests/integration/scenario-chain.test.ts` |
| Szenario hinzufügen | `tools/simulators/src/scenario-catalog.ts` | `scenarios.ts` (`VehicleScenario`-Form), `scenarios.spec.ts` |
| Fault-Injection / Chaos | `tools/simulators/src/{faulty-link,chaos-lab}.ts` | `apps/web/src/backend.ts` (Chaos-Schalter, ADR 0029) |
| Recording / Replay | `packages/core/src/logging/session-logger.ts` | `packages/storage/src/{repository,zip}.ts`, `tools/golden-sessions/`, `tests/replay/` |
| Session-Schema / Migration | `packages/core/src/session/session.ts` | `packages/storage/src/migrations.ts`, ADR 0007 |
| Fahrzeugauflösung (VIN → Fahrzeug) | `packages/runtime/src/vehicle-resolution.ts` | `packages/definitions/src/resolve.ts`, ADR 0023/0026 |
| Chart-Rendering | `packages/charts/src/` | `apps/web/public/` (DOM-Teil) |
| Bericht (PDF/HTML) | `packages/reports/src/` | `apps/web/src/backend.ts` |
| Definition-Import / OEM-Daten | `tools/definition-importer/src/` | `packages/definitions/src/json.ts` + `validate.ts` |
| Dependency-Regel ändern | `architecture/architecture.yaml` | `npm run check:deps`, ADR (Regel 34.15) |
| Neues Workspace-Paket | `packages/<name>/` mit `package.json` + `tsconfig.json` | `architecture.yaml` (`packages` + ggf. `topics`), Root-`tsconfig.json` (references), `tsconfig.typecheck.json` (paths), `vitest.config.ts` (falls neue Test-Ebene), `package-lock.json` (npm install) |
| Neues Testbeispiel / ausführbare Doku | `tests/examples/` | `vitest.config.ts` (Projekt `integration` pickt `tests/examples/**/*.example.ts` auf) |
| AI-Kontext-Bundle anpassen | `architecture/architecture.yaml` → `topics` | `tools/architecture/ai-context.mjs`, `tests/architecture/ai-context.test.ts` |

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
