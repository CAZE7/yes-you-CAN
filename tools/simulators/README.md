# `@vdp/simulators`

**Layer:** tool · **Pfad:** `tools/simulators/` ·
**Regeln-Quelle:** [`architecture/architecture.yaml`](../../architecture/architecture.yaml)

## Purpose

Das virtuelle Fahrzeug (ADR 0005/0040): ein Fahrzeug, das **über den Draht**
wie ein echtes ECU-Stack antwortet — Verhaltensmodell, Szenario-Engine,
Fault-Injection, Chaos-Lab. Der Grund, warum jede Funktion ohne echtes
Fahrzeug testbar ist (Regel 34.9).

## Responsibilities

- `virtual-vehicle.ts`: `VirtualVehicle` — virtuelles CAN-Netz,
  `testerBus` für den Engine, ECUs nach Definition-Paket
- `virtual-can.ts`: `createVirtualCanNetwork` (mehrere Bus-Teilnehmer)
- `vehicle-model.ts`/`vehicle-state.ts`: das **Verhaltensmodell** in
  Modellzeit (Ursache → Wirkung, z. B. Batterie 11,0 V → BCM-Monitor
  latched) — ADR 0040
- `vehicle-signals.ts`/`vehicle-wiring.ts`: Signal-Tabelle + Wiring
- `vehicle-monitors.ts`: die Monitore, die Fehler *latchen*
- `high-fidelity-vehicle.ts`: `HighFidelityVehicle` + `highFidelityPackage`
- `scenarios.ts`: `VehicleScenario`, `runScenario` (liefert `ScenarioRun`,
  **assertet nie**), `applyCause`/`undoCause`
- `scenario-catalog.ts`: `SCENARIO_CATALOG` + `findScenario`
- `faulty-link.ts`: Fault-Injection an der **Link-Seam** (ADR 0039)
- `chaos-lab.ts`: `CanChaosBus` (Frame-Drops, Korruption) für die Workbench

## Does NOT do

- keine Assertions in `runScenario` (das Ergebnis ist Daten, `ScenarioRun`)
- keinen Draht-Bypass: der Simulator antwortet als ECU *über CAN/ISO-TP/UDS*,
  Tests poken nie Simulator-Felder direkt (ADR 0040)
- keine Diagnose-Logik: er *erzeugt* Verhalten, er *diagnostiziert* nicht
- keine Importierung durch Schichten: ein Tool, keine Schicht — nichts
  importiert `@vdp/simulators` als Runtime-Dependency

## Public API

`src/index.ts`: alle obigen Module (inkl. `HEARTBEAT_IDS`,
`SCENARIO_CATALOG`, `createRandom`).

## Dependencies

`shared`, `core`, `definitions`, `protocols-uds`, `transport-can`,
`transport-iso-tp` (siehe `architecture.yaml`).

## Data Flow

```text
VehicleScenario (Steps + Expectations)
  → runScenario: Modellzeit voran, Ursachen anwenden, Erwartung prüfen
  → ScenarioRun { checks, unexpected, passed, finalState, timeline }
oder: HighFidelityVehicle (Modell + Monitors) + testerBus
  → UdsServer (ADR 0041) → echter Core → Scan → IR
```

## Important invariants

- **Antwort über den Draht** (ADR 0040) — eine Feld-Manipulation im Test
  ist ein Defekt.
- **`runScenario` assertet nie** — er liefert `ScenarioRun`.
- **Fault-Injection sitzt an der Link-Seam** (ADR 0039).
- **Determinismus:** `createRandom(seed)`, Modellzeit statt Wanduhr.

## Tests

Co-lokatierte `src/*.spec.ts` (Projekt `unit`; `tools/**` ohne per-file-
Gate — siehe `vitest.config.ts`), E2E-Kette
`tests/integration/scenario-chain.test.ts`.

## Examples

Ausführbar: [`tests/examples/simulator-scenario.example.ts`](../../tests/examples/simulator-scenario.example.ts)
und [`tests/examples/dtc-analysis.example.ts`](../../tests/examples/dtc-analysis.example.ts).
