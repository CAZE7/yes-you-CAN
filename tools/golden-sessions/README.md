# `@vdp/golden-sessions`

**Layer:** tool · **Pfad:** `tools/golden-sessions/` ·
**Regeln-Quelle:** [`architecture/architecture.yaml`](../../architecture/architecture.yaml)

## Purpose

Golden Sessions (ADR 0036): eine goldene Sitzung ist **Aufzeichnung +
Erwartung + Lauf**. Aufnahme gegen den Simulator, Replay über den echten
Core, Vergleich im **IR-Vokabular** — die Regressionssicherung der ganzen
Plattform.

## Responsibilities

- `cli.ts`: CLI (`--out`, `--verify`) — liest/schreibt die Fixture-Dateien
  (der eine Ort mit `node:fs` in diesem Tool)
- `record.ts`: Aufnahme gegen den Simulator
- `run.ts`: Replay über den Core + Vergleich
- `parse.ts`/`format.ts`: Session-Format (Aufzeichnung + Erwartung als Daten)
- `recipes.ts`: wiederverwendbare Aufnahme-Rezepte
- `ecu-identity.ts`: ECU-Identität im Vergleich
- `isobytes.ts`/`redact.ts`: ISO-Byte-Helfer, VIN-Redaktion

## Does NOT do

- keine Diagnose-Logik: der Vergleich nutzt die IR-Formen
- keine Schicht: nichts importiert `@vdp/golden-sessions`
- keine neuen Protokolle: Aufnahme und Replay fahren denselben Core

## Public API

`src/index.ts`: `cli.ts`, `record.ts`, `run.ts`, `parse.ts`, `format.ts`,
`recipes.ts`, `ecu-identity.ts`, `isobytes.ts`, `redact.ts`.

## Dependencies

`shared`, `diagnostic-ir`, `definitions`, `transport-can`,
`transport-iso-tp`, `core`, `simulators` (siehe `architecture.yaml`).

## Data Flow

```text
record: Simulator → echter Core → Session + RawTrace → Fixture (Aufzeichnung)
run:    Fixture → ReplayBus → echter Core → IR → Vergleich mit Erwartung
```

## Important invariants

- **Aufzeichnung + Erwartung sind Daten** (ADR 0036) — keine Logik in der
  Fixture.
- **Vergleich im IR-Vokabular** — nicht im Roh-Byte-Raum.
- **`node:fs` nur im CLI** (Regel in `architecture.yaml`).

## Tests

Co-lokatierte `src/*.spec.ts` + `tests/replay/` (fixture-driven).

## Examples

```bash
npm run golden:record   # nimmt gegen den Simulator auf, replays und verifiziert
```
