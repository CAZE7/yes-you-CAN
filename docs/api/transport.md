# Public API: Transport (`@vdp/transport-can`, `@vdp/transport-iso-tp`, `@vdp/transport-doip`)

> Pakete: [`packages/transport/can/`](../../packages/transport/can/README.md),
> [`packages/transport/iso-tp/`](../../packages/transport/iso-tp/README.md),
> [`packages/transport/doip/`](../../packages/transport/doip/README.md) ·
> Layer: **transport** · ADRs: [0001](../adr/0001-layered-architecture.md),
> [0013](../adr/0013-transport-transaction-scope.md)

Die Rahmen-Ebene unter den Protokollen: was ein Frame ist, was ein Bus ist,
wie Segmentation (ISO 15765-2) und DoIP (ISO 13400) dazu passen. Alle drei
Pakete sind **portabel** (keine `node:`-Builtins) und kennen **kein**
Protokoll.

## `@vdp/transport-can`

| Symbol | Zweck |
|---|---|
| `CanFrame` | `id`, `data: Uint8Array`, `dlc`, `extended`, `timestamp` |
| `createFrame()` | Frame-Bau mit DLC-Prüfung |
| `CanFilter`, `frameMatchesFilters()` | Adress-Filter für `subscribe` — die **eine** Semantik, die jeder Adapter nutzt: Maske gegen `id`, und ein Filter, der `extended` angibt, meint es |
| `CanBus` | **Der** Bus-Vertrag: `info`, `capabilities`, `open()`, `close()`, `isOpen()`, `send(frame)`, `subscribe(listener, filters?) → unsubscribe` |
| `CanAdapterFactory`, `CanAdapterRegistry` | Adapter-Plug-in: `id`, `displayName`, `create(options?)`, `isAvailable?()` |
| `AdapterInfo`, `AdapterCapabilities` | Was ein Bus über sich sagt (Typ, Channels, CAN-Fähigkeit) |
| `ReplayBus` / Time-Travel | Replay einer aufgenommenen Frame-Sequenz (für Tests/Replay) |

**Verträge:** Transports kennen keine Protokolle (maschinell). Ein neuer
Adapter implementiert `CanBus` + `CanAdapterFactory` und bleibt in
`packages/adapters/<name>/` (siehe [`docs/code-map.md`](../code-map.md)).

## `@vdp/transport-iso-tp`

| Symbol | Zweck |
|---|---|
| `IsoTpConnection` | Segmentierung/Reassembly über `CanBus`: `open()`, `close()`, `send(payload) → response`, `stats` |
| `IsoTpTiming` / `DEFAULT_TIMING` | BS/STmin/STmax/MaxFds als Daten (ISO 15765-2) |
| `DEFAULT_MAX_RECEIVE_BYTES` / `maxReceiveBytes` | Empfangs-Puffergrenze (Default 64 KiB): ein First Frame darüber hinaus wird mit Flow Control **Overflow** beantwortet (ISO 15765-2 Table 14) |
| `IsoTpStats` | Zähler (Frames, Segmente, Fehler) |

**Verträge:** Die Transaktionssperre gilt pro Verbindung, nicht pro Anfrage
(ADR 0013); eine abgeschnittene/fehlende Antwort ist ein Fehler mit Grund
(ADR 0039).

## `@vdp/transport-doip`

| Symbol | Zweck |
|---|---|
| `DoIpTransport` | DoIP-Link, der sich als CAN-artiger Bus präsentiert (für die Transport-Seam des Runtime) |
| `discovery` | ECU-Discovery auf DoIP (ISO 13400) |
| `message` | DoIP-Nachrichten-Codierung |

**Verträge:** DoIP zieht nie die Protokoll-Schicht herein (Regel in
`architecture.yaml`). Nutzung über `createDoipEcuLinkFactory()` aus
`@vdp/runtime` (Transport-Seam, AGENTS 5/36).

## Beispiel: Bus + ISO-TP zusammen

```ts
import { type CanBus, createFrame } from "@vdp/transport-can";
import { IsoTpConnection, DEFAULT_TIMING } from "@vdp/transport-iso-tp";

// bus: ein Adapter (SocketCAN, ELM327, …) oder der virtuelle Bus des Simulators
await bus.open();
const connection = new IsoTpConnection(bus, 0x7e0, 0x7e8, { ...DEFAULT_TIMING });
await connection.open();
const response = await connection.send(new Uint8Array([0x22, 0xf1, 0x90]));
await connection.close();
```
