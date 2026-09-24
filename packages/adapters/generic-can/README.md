# `@vdp/adapter-generic-can`

**Layer:** adapter · **Pfad:** `packages/adapters/generic-can/` ·
**Regeln-Quelle:** [`architecture/architecture.yaml`](../../../architecture/architecture.yaml)

## Purpose

Der Generic-CAN-Adapter: **wickelt einen beliebigen `CanBus` ein**, den der
Host liefert (virtueller Bus, Vendor-SDK, Bridge), normalisiert seine
Metadata — und besitzt die Adapter-Registry, die die Workbench für den
Adapter-Picker nutzt. Ausgangspunkt für neue Adapter.

## Responsibilities

- `GenericCanAdapter`: `CanBus`-Wrapper mit Tx/Rx-Zählern, CAN-FD-Prüfung,
  normalisiertem `AdapterInfo`/`AdapterCapabilities`
- `createGenericCanFactory({ id, displayName, create })` → `CanAdapterFactory`
- `createAdapterRegistry(factories)` → vorbefüllte `CanAdapterRegistry`

## Does NOT do

- keine Protokoll-Logik, keine Core-Kenntnis (Layer-Regel)
- keine Hardware-Treiber: die physikalische Seite bleibt injizierbar

## Public API

`src/index.ts`: `GenericCanAdapter`, `GenericCanOptions`,
`createGenericCanFactory`, `createAdapterRegistry` (+ `CanAdapterRegistry`).

## Dependencies

`@vdp/shared`, `@vdp/transport-can`.

## Data Flow

```text
Workbench/CLI → CanAdapterFactory.create(options) → GenericCanBus → (physikalische Seite)
```

## Important invariants

- **`CanBus`-Vertrag** aus `@vdp/transport-can` — kein zweites Bus-Interface.
- **Adapter-Kette:** Hardware-Spezifika nur hier (Leitplanke 0.D).
- **Eine wrapped Subscription statt je Hörer eine:** `rx` zählt *Bus*-Frames,
  nicht Listener-Auslieferungen — zwei Hörer am selben Frame sind ein Zähler.

## Tests

Co-lokatierte `src/*.spec.ts` (Gate 92/78).

## Examples

```ts
import { createGenericCanFactory, createAdapterRegistry } from "@vdp/adapter-generic-can";

const factory = createGenericCanFactory({
  id: "vendor-x",
  displayName: "Vendor X",
  create: () => myVendorCanBus, // jede CanBus-Implementierung
});
const registry = createAdapterRegistry([factory]);
const bus = registry.create("vendor-x");
```
