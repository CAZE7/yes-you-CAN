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
- **Die Werte einer Aufnahme sind reproduzierbar, die Zeitachse ist es nicht**
  (ADR 0052). Nachgemessen am 2026-09-22: zwei `npm run golden:record`-Läufe auf
  demselben Baum unterscheiden sich in **0 Wertzeilen** — vorher in **44**
  (`abs.wheel_speed` 40,76 → 40,78, `engine.rpm` 831,3 → 832, `maf` 4,23 → 4,24,
  Kühlmittel-Rohwert `0C FD` → `0D 00`). Ursache war eine Zeile: `signalValue`
  leitete jedes sich entwickelnde Signal aus `Date.now() - startedAt` ab. Die Uhr
  des Signalmodells ist jetzt injizierbar (`VirtualVehicleOptions.clock`), und der
  Recorder gibt eine eigene vor, die er in 50-ms-Schritten je Phase weiterschaltet —
  gestaffelt statt eingefroren, damit die Fixtures weiter ein fahrendes Auto zeigen
  und ein `equal` ein `equal` bleibt.
- **Was übrig bleibt, ist die Zeitachse des Traces** — 1782 `"timestamp"`- und 1690
  `"t"`-Zeilen. Sie stammen aus `createFrame`'s Default
  (`transport/can/src/frame.ts:61`) über die ISO-TP-Verbindung. Der Versuch, auch
  dort die Uhr zu injizieren, ist **gemessen gescheitert**: die ISO-TP-Timer brauchen
  eine echte Uhr, die Aufnahme lief 359 s und endete mit EXIT 1 statt 3,6 s und 0.
  Ein Trace hält fest, *wann* etwas geschah — die Wanduhr ist dort kein Defekt.
  Folge für die Praxis: nach einem `golden:record` gehört `git diff` gelesen; ein
  Diff aus lauter Zeitstempeln ist keiner gegen den Code, ein Diff mit Werten schon.

## Tests

Co-lokatierte `src/*.spec.ts` + `tests/replay/` (fixture-driven).

## Examples

```bash
npm run golden:record   # nimmt gegen den Simulator auf, replays und verifiziert
```
