# `packages/adapters/` — Adapter-Schicht

Hardware- und Schnittstellenspezifisches: hier implementiert jeder Adapter
den **`CanBus`-Vertrag** aus `@vdp/transport-can` und liefert eine
`CanAdapterFactory`. Der Engine muss ein neuer Adapter nie bewusst werden
(ADR 0001, Regel 34.6).

| Paket | Schnittstelle | README |
|---|---|---|
| [`generic-can/`](generic-can/README.md) | Wrapper für jeden `CanBus` (Vendor-SDK, virtueller Bus) + Adapter-Registry | ✓ |
| [`elm327/`](elm327/README.md) | ELM327/Kabel über Serial (`ByteStream`) | ✓ |
| [`canable/`](canable/README.md) | CANable/CANtact (slcan) über die ELM327-Stream-Schicht | ✓ |
| [`socketcan/`](socketcan/README.md) | SocketCAN (Linux) über injizierbare `SocketCanBinding` | ✓ |
| [`host/`](host/README.md) | Serial-TTY, Probing-Katalog, Adapter-Auswahl (der Host-Kontakt) | ✓ |

## Gemeinsame Regeln (maschinell geprüft)

- **Keine Protokolle, kein Core** (Layer-Regel in
  [`architecture/architecture.yaml`](../../architecture/architecture.yaml)).
- **Hardware-Spezifika bleiben hier** (Leitplanke 0.D).
- **`node:`-Builtins nur in `host`** (Serial/OS) — die anderen Adapter sind
  stream-injizierbar.

## Dazugehörig

- API: [`docs/api/transport.md`](../../docs/api/transport.md)
  (Bus-Vertrag)
- Neue Hardware: [`docs/code-map.md`](../../docs/code-map.md) +
  [`.ai/tasks/add-can-adapter.md`](../../.ai/tasks/add-can-adapter.md)
- Hardware-Test (manual, vcan): `tests/hardware/vcan.test.ts`
