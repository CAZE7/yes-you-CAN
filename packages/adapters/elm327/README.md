# `@vdp/adapter-elm327`

**Layer:** adapter · **Pfad:** `packages/adapters/elm327/` ·
**Regeln-Quelle:** [`architecture/architecture.yaml`](../../../architecture/architecture.yaml)

## Purpose

Der ELM327-Adapter: das Serial-Protokoll (Commands wie `AT`, `ST`, Hex-
Frames) und der Stream-Handler für ELM327-Kabel — die Basis, auf der
`@vdp/adapter-canable` aufbaut.

## Responsibilities

- ELM327-Protokoll-Codierung (`protocol.ts`): Requests, Antworten, Fehler
- `ByteStream`-Vertrag + Stream-Parsing mit Resync (`stream.ts`)
- `Elm327Adapter` (`CanBus`-Implementierung) +
  `createElm327Factory(stream, defaults?)` → `CanAdapterFactory` (`adapter.ts`)

## Does NOT do

- keine Protokoll-(UDS)-Logik — ELM327 ist eine *Schnittstelle*, kein
  Diagnose-Protokoll
- keine CAN-FD/Extended-Features jenseits dessen, was ELM327 trägt
- keinen direkten `node:`-TTY-Zugriff: der Stream wird injiziert
  (Tests fahren ihn mit einem gewöhnlichen Buffer)

## Public API

`src/index.ts`: `adapter.ts` (`Elm327Adapter`, `Elm327Options`,
`createElm327Factory`), `protocol.ts`, `stream.ts` (`ByteStream`,
Stream-Primitiven) komplett.

## Dependencies

`@vdp/shared`, `@vdp/transport-can`.

## Data Flow

```text
Serial-Stream (injectiert) → ELM327-Stream → Protocol → CanFrame → CanBus-Vertrag
```

## Important invariants

- **Stream injizierbar** (AGENTS 31: kein echter TTY-Test im `unit`-Projekt).
- **CANable teilt diesen Stream** (`@vdp/adapter-canable` importiert dieses
  Paket) — eine zweite ELM327-Parsing-Kopie ist ein Defekt.

## Tests

Co-lokatierte `src/*.spec.ts` (Gate 92/78; `protocol.ts`/`stream.ts` bei
100/100 gemessen, ADR 0016).

## Examples

```ts
import { createElm327Factory } from "@vdp/adapter-elm327";

// der Stream kommt vom Host (adapter-host/serial.ts); isAvailable = stream.isOpen()
const factory = createElm327Factory(mySerialStream);
const bus = factory.create({ /* Elm327Options-Defaults */ }); // CanBus
```
