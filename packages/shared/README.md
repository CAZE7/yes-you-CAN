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
- Portabler Digest über Bytes oder Text (`hash.ts` → `sha256Hex`, SHA-256 nach
  FIPS 180-4 — die Antwort auf „hat sich die Aufnahme geändert?", ohne
  `node:crypto` in einer portablen Schicht; ADR 0044)
- Typisierte Ids mit Präfixen (`ids.ts`)
- Logger mit Levels, Sinks und `child()` (`logger.ts`)

## Does NOT do

- keine Diagnose, kein Protokoll, kein Transport
- keine I/O, keine `node:`-Builtins, **keine Abhängigkeiten**
- keine Geschäftslogik, keine Zeit (Clocks gehören in `@vdp/domain`)

## Public API

`src/index.ts` exportiert `bytes.ts`, `errors.ts`, `events.ts`, `hash.ts`, `ids.ts`,
`logger.ts` komplett. Wichtige Namen: `fromHex`, `toHex`, `ErrorMessage`,
`createLogger`, `MemorySink`, `sha256Hex`, `EventBus`-Primitiven, Id-Präfix-Hilfen.

## Dependencies

Keine. (`mayImport: []` — die einzige solche Schicht neben `@vdp/charts`.)

## Data Flow

Basisrichtung: **alle → shared**. shared importiert niemanden.

## Important invariants

- **Dependency-frei** (ADR 0002, Leitplanke 0.D) — der Dependency-Checker fällt.
- **100 % Linien-Coverage** ist per-file-Gate (`vitest.config.ts`) — eine neue
  Zeile kommt mit ihrem Test.
- **Der Digest ist eine Referenz, kein Akzent.** `sha256Hex` liefert byte-identisch
  das, was `createHash("sha256")` liefert (getestet gegen die Referenzimplemen-
  tierung und gegen die veröffentlichten Vektoren von FIPS 180-4) — ein gespeicherter
  Digest, der nach einer Umbenennung nicht mehr prüft, ist eine verlorene Aufnahme.
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
