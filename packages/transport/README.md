# `packages/transport/` — Transport-Schicht

Die Ebenen unter den Protokollen: Rahmen, Segmentation, Link-Alternativen.

| Paket | Inhalt | README |
|---|---|---|
| [`can/`](can/README.md) | `@vdp/transport-can` — `CanFrame`, **`CanBus`-Vertrag**, Adapter-Registry, Replay | ✓ |
| [`iso-tp/`](iso-tp/README.md) | `@vdp/transport-iso-tp` — Segmentation nach ISO 15765-2 | ✓ |
| [`doip/`](doip/README.md) | `@vdp/transport-doip` — DoIP (ISO 13400) als CAN-artiger Link | ✓ |

## Gemeinsame Regeln (maschinell geprüft)

- **Keine Protokolle:** die Transport-Ebenen kennen kein UDS (Layer-Regel
  in [`architecture/architecture.yaml`](../../architecture/architecture.yaml)).
- **Portabel:** keine `node:`-Builtins (Hardware bleibt in
  `packages/adapters/`).
- **`CanBus` ist der eine Bus-Begriff** des Systems (Glossar: „Bus“).

## Dazugehörig

- API-Doku: [`docs/api/transport.md`](../../docs/api/transport.md)
- Flow: [`docs/flows/diagnostic-read.md`](../../docs/flows/diagnostic-read.md)
- Neuer CAN-Adapter: [`docs/code-map.md`](../../docs/code-map.md) +
  [`.ai/tasks/add-can-adapter.md`](../../.ai/tasks/add-can-adapter.md)
