# `@vdp/web` (Workbench)

**Layer:** ui · **Pfad:** `apps/web/` ·
**Regeln-Quelle:** [`architecture/architecture.yaml`](../../architecture/architecture.yaml)

## Purpose

Die Workbench (AGENTS 16, ADR 0006): Node-HTTP-Server + SSE + Vanilla-ESM-
Frontend. Sie spricht zum Fahrzeug **ausschließlich über den Runtime**
(Command Bus / Services) und ist die Spitze des Baums — niemand importiert
sie.

## Responsibilities

- `server.ts`: HTTP-Server, Security-Baseline (ADR 0009), Routen,
  `--demo`-Modus (Simulator), `vdp-web`-Bin
- `backend.ts`: Service-Orchestrierung für die UI (Session, Replay, Chaos-
  Schalter, Report-Export, Analyse)
- `views.ts`: **Wire-Contract** — die geteilten Typen für Frontend/Server
  (ADR 0030: Frontend wird gegen diesen Contract typgeprüft)
- `route-input.ts`: Grammatik-Prüfung der Routen-Parameter
  (`HttpError`, `parseCanId`, `parseBurstCount`, `parseDropRate`)
- `adapters.ts`: Adapter-Auswahl über `@vdp/adapter-host`
- `analysis-input.ts`: baut den `AnalysisInput` für `@vdp/ai` aus der
  laufenden Session
- `*-view.ts`: die View-Logik (ecu, dtc, dtc-knowledge, trace, scenario,
  vehicle)
- `public/`: Vanilla-ESM-Frontend (`app.js`, `api.js` mit JSDoc-Typen aus
  `views.ts`, `index.html`)

## Does NOT do

- **keine CAN-/UDS-Logik** (Leitplanke 0.D, Regel 34.4) — alles läuft über
  Runtime
- **keinen direkten Transport-Zugriff** (der Bus kommt als injizierter
  `CanBus`/`linkFactory`)
- **keine Evidenz-Neuerfindung**: die Analyse bekommt das IR-`EvidenceSet`
  (ADR 0037/0038)
- **keine Persistenz-Details**: Sessions laufen über `@vdp/storage`

## Public API

Die App ist ein Bin/Server (`dist/src/server.js`, `vdp-web`), kein
importierendes Paket. Der für Außenstehende relevante „Contract“ ist
`src/views.ts` (Wire-Contract) — ADR 0030.

## Dependencies

`shared`, `domain`, `application`, `runtime`, `diagnostic-ir`, `definitions`,
`protocols-uds` (nur Vokabular), `transport-can`, `storage`, `reports`, `ai`,
`simulators`, `adapter-host` (siehe `architecture.yaml`).

## Data Flow

```text
Browser (public/app.js)
  ⇄ HTTP + SSE ⇄ server.ts → backend.ts
    → runtime.commands.dispatch / runtime.evidence / writes
    → storage (Sessions) · reports (Export) · ai (Analyse)
```

## Important invariants

- **Security-Baseline** (ADR 0009): localhost-Default, Security-Header,
  Body-Limit, GET-only-Stream. Neue Endpunkte übernehmen sie.
- **Read-only vor Write**; abgelehnte Writes sind Antworten mit Grund
  (ADR 0018), keine HTTP-Fehler.
- **Wire-Contract typgeprüft** (ADR 0030): `public/*.js` gegen `views.ts`.
- **per-file-Gate 76/72** (Bodenschwelle, ADR 0017: erst Tests, dann Gate).

## Tests

`test/*.spec.ts` (Integration, `--demo`-Server: `server-paths`,
`backend-paths`, `markup`, `adapters`), per-file-Gate 76/72.

## Examples

```bash
npm run demo            # Workbench + Simulator auf http://localhost:8080
```
