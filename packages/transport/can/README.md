# `@vdp/transport-can`

**Layer:** transport · **Pfad:** `packages/transport/can/` ·
**Regeln-Quelle:** [`architecture/architecture.yaml`](../../../architecture/architecture.yaml)

## Purpose

Die Rahmen-Ebene (AGENTS 6): was ein CAN-Frame ist, was ein Bus ist und wie
Adapter sich anpluggen. Sitzt *unter* ISO-TP, *über* der Hardware — und ist
die Fuge, an der Simulator und echter Bus austauschbar sind.

## Responsibilities

- `CanFrame`-Typ + `createFrame()` (DLC-Prüfung, CAN-FD-Längen)
- `CanFilter` + `frameMatchesFilters()` (Adress-Filter für `subscribe`)
- **`CanBus`-Vertrag**: `info`, `capabilities`, `open/close/send/subscribe`
- `CanAdapterFactory` + `CanAdapterRegistry` (Adapter-Plug-in)
- `AdapterInfo`/`AdapterCapabilities` (was ein Bus über sich sagt)
- `ReplayBus`/Time-Travel: eine aufgezeichnete Frame-Sequenz als Bus
  (Replay-Grundlage, ADR 0005)

## Does NOT do

- keine Protokolle (UDS & Co. sitzen darüber — Layer-Regel)
- keine Hardware-Logik (das sind `@vdp/adapter-*`)
- keine `node:`-Builtins (portabel; Hardware bleibt im Adapter)
- keine Diagnose-Logik

## Public API

`src/index.ts`: `bus.ts`, `replay.ts`, `time-travel.ts`, `frame.ts`,
`transport.ts` komplett — siehe [`docs/api/transport.md`](../../../docs/api/transport.md).

## Dependencies

Nur `@vdp/shared`.

## Data Flow

```text
Adapter (packages/adapters/*) implementiert CanBus
  ↑
ISO-TP (IsoTpConnection) segmentiert/desegmentiert über CanBus
  ↑
Core (EcuHandle/Link-Factory) — und ReplayBus für die Wiedergabe
```

## Important invariants

- **`CanBus` ist der einzige Bus-Begriff** des Systems — ein zweites
  Bus-Interface ist ein Defekt (Glossar: „Bus“).
- **Transaktionssperre pro Verbindung** gehört zu ISO-TP, nicht hierher
  (ADR 0013).
- **Portabel:** keine `node:`-Builtins (maschinell).

## Tests

Co-lokatierte `src/*.spec.ts` (Projekt `unit`, Gate 88/72).

## Examples

```ts
import { createFrame, frameMatchesFilters, type CanBus, type CanFilter } from "@vdp/transport-can";

const frame = createFrame({ id: 0x7e8, data: new Uint8Array([0x02, 0x32, 0xf1, 0x90]) });
const filter: CanFilter = { id: 0x7e8, mask: 0x7ff };
frameMatchesFilters(frame, [filter]); // true

const off = bus.subscribe((f) => console.log(f.id), [filter]); // → unsubscribe
```
