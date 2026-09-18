# `@vdp/transport-iso-tp`

**Layer:** transport · **Pfad:** `packages/transport/iso-tp/` ·
**Regeln-Quelle:** [`architecture/architecture.yaml`](../../../architecture/architecture.yaml)

## Purpose

Segmentation nach ISO 15765-2 über der CAN-Rahmen-Ebene: eine UDS-Nachricht
wird in Frames zerlegt und wieder zusammengesetzt — mit dem richtigen
Timing (BS/STmin) und der richtigen Fehlerhaltung bei abgeschnittenen
Antworten (ADR 0039).

## Responsibilities

- `IsoTpConnection`: `open/close`, `send(payload) → response`, `stats`
  — Request/Response auf der Bus-Seam, Single-/Multi-Frame in beide Richtungen
- `IsoTpTiming`/`IsoTpParams` + `DEFAULT_TIMING` (BS, STmin/STmax, MaxFds)
- Transaktionssperre **pro Verbindung** (ADR 0013): eine offene Transaktion
  blockiert andere Anfragen auf derselben Verbindung — nicht pro Anfrage
- Fehler-Klassen für abgeschnittene/ungültige Segmente (Daten, nicht
  stiller Leerlauf)
- Wire-Guards nach ISO 15765-2: leere Payload und Classic-CAN > 4095 Bytes
  sind Absagen beim `send`, Fluchtzeichen-/DL-Verletzungen im Kopf-Byte
  werden im Empfang verworfen — strukturierte Details (Klasse + `tooLong`,
  `sequenceError`, `overflow`) statt Prosa; die Vektoren dazu sind der
  gemeinsame Maßstab mit der Haskell-Referenz (`@vdp/formal-conformance`,
  ADR 0045)

## Does NOT do

- keine Protokoll-Kenntnis (es segmentiert Bytes, es weiß nicht, was 0x22 ist)
- keine Bus-Implementierung (es braucht einen `CanBus`)
- keine Hardware/`node:`-Builtins (portabel)

## Public API

`src/index.ts`: `connection.ts`, `params.ts` — siehe
[`docs/api/transport.md`](../../../docs/api/transport.md).

## Dependencies

`@vdp/shared`, `@vdp/transport-can`.

## Data Flow

```text
UdsClient (protocols-uds) → send(payload)
  → IsoTpConnection: Single-Frame | FirstFrame+ConsecutiveFrames
  → CanBus.send(CanFrame)   (TX-Id ← rxId-1, RX-Filter auf TX-Id)
  ← Frames → Reassembly (STmin/BS-Respekt, Timeout)
  → Response-Payload (oder Fehler mit Grund)
```

## Important invariants

- **Transaktionssperre pro Verbindung** (ADR 0013) — nicht pro Anfrage.
- **Abgeschnittene Antwort = Fehler** (ADR 0039): nie „leer“ liefern.
- **Timing als Daten** (`IsoTpTiming`), nie hartkodiert (AGENTS 9).
- **Portabel + Layer-Regel:** kein Protokoll-Import (maschinell).

## Tests

Co-lokatierte `src/*.spec.ts` (Gate 88/72; schwächste gemessene Datei
`connection.ts` — das Gate bleibt knapp, ADR 0020).

## Examples

```ts
import { IsoTpConnection, DEFAULT_TIMING } from "@vdp/transport-iso-tp";

const conn = new IsoTpConnection(bus, 0x7e0, 0x7e8, { ...DEFAULT_TIMING });
await conn.open();
const response = await conn.send(new Uint8Array([0x22, 0xf1, 0x90]));
await conn.close();
```
