# Vertrag: Transport / Adapter

**Verbindliche Quellen:** `packages/transport/*/README.md`,
[`../docs/api/transport.md`](../../docs/api/transport.md),
[`../docs/flows/diagnostic-read.md`](../../docs/flows/diagnostic-read.md),
ADR 0001/0013/0039, [`../architecture/architecture.yaml`](../../architecture/architecture.yaml)
(`@vdp/transport-*`, `@vdp/adapter-*`).

## Die Regeln, die du nicht brechen darfst

1. **`CanBus` ist der eine Bus-Begriff** des Systems
   (`info`, `capabilities`, `open/close/send/subscribe`) — ein zweites
   Bus-Interface ist ein Defekt (Glossar: „Bus“).
2. **Transports kennen keine Protokolle** (Layer-Regel, maschinell):
   ISO-TP segmentiert Bytes, es weiß nicht, was `0x22` ist.
3. **Protokolle kennen keine Busse** (die andere Richtung derselben Regel).
4. **Adapter implementieren den Bus-Vertrag** + `CanAdapterFactory`
   (`id`, `displayName`, `create`, `isAvailable?`) — der Engine wird ein
   neuer Adapter nie bewusst (ADR 0001, Regel 34.6).
5. **Transaktionssperre pro Verbindung** (ADR 0013) — nicht pro Anfrage;
   das sitzt in `IsoTpConnection`.
6. **`node:`-Builtins nur in `adapter-host`** (Serial/OS) — die anderen
   Adapter sind stream-/binding-injizierbar (maschinell).
7. **Hardware-Spezifika bleiben im Adapter** (Leitplanke 0.D): keine
   OEM-Logik in der CAN-Schicht, keine CAN-Logik in der UI.
8. **Abgeschnittene/ungültige Segmente sind Fehler** (ADR 0039) — mit Grund,
   nie still.

## Wenn du eine neue Hardware anbindest

→ [`.ai/tasks/add-can-adapter.md`](../tasks/add-can-adapter.md) (neues
Workspace-Paket, Host-Katalog, YAML-Eintrag, Tests).

## Weiter

- UDS-Seite: [`.ai/contracts/uds.md`](uds.md)
- Simulator (virtueller Bus): [`.ai/packages/simulator.md`](../packages/simulator.md)
- Kontext-Bundle: `npm run ai:context transport`
