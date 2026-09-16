# `@vdp/adapter-socketcan`

**Layer:** adapter · **Pfad:** `packages/adapters/socketcan/` ·
**Regeln-Quelle:** [`architecture/architecture.yaml`](../../../architecture/architecture.yaml)

## Purpose

Der SocketCAN-Adapter (Linux): nativer SocketCAN-Zugriff über eine
**injizierbare Binding-Schicht** (`SocketCanBinding`) — die eigentliche
Socket-Bindung ist `binding.ts` und wird von den Tests mit einem virtuellen
Gegenstück ersetzt (`vcan`, `tests/hardware/`).

## Responsibilities

- SocketCAN-`CanBus`-Implementierung (`SocketCanAdapter`, `adapter.ts`)
- `SocketCanBinding`-Vertrag für den Socket-Zugriff (`binding.ts`)
- `createSocketCanFactory(binding, defaults?)` → `CanAdapterFactory`
  (`isAvailable` meldet `process.platform === "linux"`)

## Does NOT do

- keine Protokoll-Logik, keine Core-Kenntnis (Layer-Regel)
- keine Windows/macOS-Pfade: SocketCAN ist Linux — die Verfügbarkeit wird
  gemeldet, nicht vermutet

## Public API

`src/index.ts`: `adapter.ts` (`SocketCanAdapter`, `SocketCanOptions`,
`createSocketCanFactory`), `binding.ts` (`SocketCanBinding`) komplett.

## Dependencies

`@vdp/shared`, `@vdp/transport-can`.

## Data Flow

```text
vcan0/can0 (Linux) → SocketCanBinding (injectierbar) → SocketCanAdapter → CanBus-Vertrag
```

## Important invariants

- **Binding injizierbar** (ADR 0016 §2): `binding.ts` ist Coverage-exkludiert,
  weil der Socket nicht testbar ist — alles drumherum ist es (Gate 92/78).
- **Hardware-Tests sind manual:** `tests/hardware/vcan.test.ts`
  (`npm run test:hardware`), nie Teil des normalen `npm test`.

## Tests

Co-lokatierte `src/*.spec.ts` (virtueller Binding) + `tests/hardware/vcan.test.ts`.

## Examples

```ts
import { createSocketCanFactory } from "@vdp/adapter-socketcan";

const factory = createSocketCanFactory(myLinuxBinding); // SocketCanBinding
const bus = factory.create({ /* z. B. interface "vcan0" */ }); // CanBus
await bus.open();
```
