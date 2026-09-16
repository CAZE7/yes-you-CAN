# `@vdp/shared`

**Layer:** foundation · **Pfad:** `packages/shared/` ·
**Regeln-Quelle:** [`architecture/architecture.yaml`](../../architecture/architecture.yaml)

## Purpose

Die gemeinsame Basis des gesamten Baums: Byte-Handling, Fehler-Vokabular,
Events, Ids und der Logger. Jedes andere Paket loggt, parsen und id-bildet
über dieses — eine zweite Vokabel wäre ein Defekt.

## Responsibilities

- Bytes ↔ Hex ↔ ASCII (`bytes.ts`, `bytes-ascii.ts`)
- Fehler mit Code und Kontext (`errors.ts`, inkl. `MemorySink` für Tests)
- Domain-Event-Transport (`events.ts`)
- Typisierte Ids mit Präfixen (`ids.ts`)
- Logger mit Levels, Sinks und `child()` (`logger.ts`)

## Does NOT do

- keine Diagnose, kein Protokoll, kein Transport
- keine I/O, keine `node:`-Builtins, **keine Abhängigkeiten**
- keine Geschäftslogik, keine Zeit (Clocks gehören in `@vdp/domain`)

## Public API

`src/index.ts` exportiert `bytes.ts`, `errors.ts`, `events.ts`, `ids.ts`,
`logger.ts` komplett. Wichtige Namen: `fromHex`, `toHex`, `ErrorMessage`,
`createLogger`, `MemorySink`, `EventBus`-Primitiven, Id-Präfix-Hilfen.

## Dependencies

Keine. (`mayImport: []` — die einzige solche Schicht neben `@vdp/charts`.)

## Data Flow

Basisrichtung: **alle → shared**. shared importiert niemanden.

## Important invariants

- **Dependency-frei** (ADR 0002, Leitplanke 0.D) — der Dependency-Checker fällt.
- **100 % Linien-Coverage** ist per-file-Gate (`vitest.config.ts`) — eine neue
  Zeile kommt mit ihrem Test.
- Fehler werden nie still geschluckt; der Logger ist die einzige
  Ausgabe-Schicht (AGENTS 33).

## Tests

Co-lokatierte `src/*.spec.ts` (Projekt `unit`).

## Examples

```ts
import { createLogger, fromHex, toHex, MemorySink } from "@vdp/shared";

const sink = new MemorySink();
const log = createLogger("demo", { level: "DEBUG" }, [sink]);
log.info("frame", { hex: toHex(fromHex("02 03 04")) });
```
