# `@vdp/transport-doip`

**Layer:** transport · **Pfad:** `packages/transport/doip/` ·
**Regeln-Quelle:** [`architecture/architecture.yaml`](../../../architecture/architecture.yaml)

## Purpose

DoIP (ISO 13400) als **Transport-Alternative**: der Link präsentiert sich
CAN-artig, damit der ganze Diagnose-Stack (Core, UDS, ISO-TP-Logik) darüber
läuft, ohne eine Zeile zu ändern (Transport-Seam, AGENTS 5/36).

## Responsibilities

- DoIP-Nachrichten-Codierung (`message.ts`)
- ECU-Discovery auf DoIP (`discovery.ts`)
- `DoIpTransport`: der Bus-artige Link für die Runtime

## Does NOT do

- keine Protokoll-Logik (DoIP ist ein Link, kein Diagnose-Protokoll)
- keine CAN-Spezifika: DoIP zieht nie `transport-iso-tp` oder UDS herein
- keine Hardware-`node:`-Builtins (portabel; die TCP-Seite gehört zum
  Adapter/App-Setup)

## Public API

`src/index.ts`: `message.ts`, `transport.ts`, `discovery.ts`.
Verbindung zum System: `createDoipEcuLinkFactory()` aus `@vdp/runtime`.

## Dependencies

`@vdp/shared`, `@vdp/transport-can`.

## Data Flow

```text
createDoipEcuLinkFactory() (runtime/transport.ts)
  → EcuLinkFactory: je ECU ein DoIP-basierter Link
  → Core behandelt ihn wie jeden anderen Link (UDS darüber)
```

## Important invariants

- **Can-artig, nicht CAN:** der Vertrag ist der des Bus-Layers, nicht die
  Frames (Regel in `architecture.yaml`: kein Protokoll-Import).
- **Seam bleibt Seam:** neue DoIP-Verhalten ändern dieses Paket + die
  Factory im Runtime — nie den Core.
- **Getestet:** `tests/integration/doip-engine.test.ts` (ganzer Stack
  über DoIP).

## Tests

Co-lokatierte `src/*.spec.ts` + `tests/integration/doip-engine.test.ts`.

## Examples

```ts
import { createDoipEcuLinkFactory } from "@vdp/runtime";

const runtime = createDiagnosticRuntime({
  linkFactory: createDoipEcuLinkFactory({ /* DoIP-Optionen */ }),
  definitions: [pkg],
});
```
