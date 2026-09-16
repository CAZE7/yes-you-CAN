# `@vdp/adapter-canable`

**Layer:** adapter · **Pfad:** `packages/adapters/canable/` ·
**Regeln-Quelle:** [`architecture/architecture.yaml`](../../../architecture/architecture.yaml)

## Purpose

Der CANable-Adapter: CANable-/CANtact-Kabel (slcan-Protokoll), die über die
ELM327-`ByteStream`-Schicht von `@vdp/adapter-elm327` sprechen — mit
CANable-spezifischer Kommando-Erweiterung (`slcan.ts`).

## Responsibilities

- slcan-Kommandos über der geteilten ELM327-Stream-Schicht (`slcan.ts`)
- `CanableAdapter` (`CanBus`-Implementierung) +
  `createCanableFactory(stream, defaults?)` → `CanAdapterFactory` (`adapter.ts`)

## Does NOT do

- keine eigene ELM327-Parsing-Kopie (die kommt aus `@vdp/adapter-elm327`)
- keine Protokoll-(UDS)-Logik, keine Core-Kenntnis
- keinen direkten `node:`-TTY-Zugriff (Stream injizierbar)

## Public API

`src/index.ts`: `adapter.ts` (`CanableAdapter`, `CanableOptions`,
`createCanableFactory`), `slcan.ts` (SL-Can-Kommando-Primitiven) komplett.

## Dependencies

`@vdp/shared`, `@vdp/transport-can`, `@vdp/adapter-elm327`.

## Data Flow

```text
Serial-Stream (aus elm327: ByteStream) → slcan-Erweiterung → CanableAdapter → CanBus-Vertrag
```

## Important invariants

- **Geteilter Stream:** `elm327` ist die gemeinsame Basis — eine zweite
  Parsing-Kopie hier ist ein Defekt (Regel in `architecture.yaml`).
- **Adapter-Kette:** Hardware-Spezifika nur hier.

## Tests

Co-lokatierte `src/*.spec.ts` (Gate 92/78).

## Examples

```ts
import { createCanableFactory } from "@vdp/adapter-canable";

const factory = createCanableFactory(mySerialStream); // ByteStream aus @vdp/adapter-elm327
const bus = factory.create({ /* CanableOptions-Defaults */ }); // CanBus
```
