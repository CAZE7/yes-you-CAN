# `@vdp/protocols-uds`

**Layer:** protocol · **Pfad:** `packages/protocols/uds/` ·
**Regeln-Quelle:** [`architecture/architecture.yaml`](../../../architecture/architecture.yaml)

## Purpose

UDS (ISO 14229) auf **beiden Seiten** des Drahts: der `UdsClient` für den
Tester und der `UdsServer` für den Simulator. Beide sprechen nur durch eine
**Link-Seam** — das Protokoll kennt weder Bus noch Adapter (ADR 0031).

## Responsibilities

- **Client** (`client.ts`, `client-engine.ts`): alle Standard-Service
  (Session Control, TesterPresent, Read/Write DID, DTC-Read incl.
  Snapshot/Extended Data, Clear, Routine Control, Security Access, ECU Reset),
  Timing-Adaption (P2/P2* von der ECU), NRC-Handling mit Retry für
  transient NRCs, Pending-Response-Guard
- **Server** (`server.ts`): ECU-Seite mit offizieller Simulator-API
  (`registerDid`, `registerWritableDid`, `setDtc`, `registerRoutine`,
  `registerSecurityAccess`), Session-Maschine (ISO 14229-1 §10.2)
  (ADR 0041)
- **Link-Seam** (`link.ts`, `link-adapter.ts`): `UdsLink`-Vertrag,
  `RequestResponseLink` auf einem `MessageTransport`
- **Konstanten & Dekodierung** (`services.ts`, `nrc.ts`, `dtc.ts`,
  `timing.ts`, `session-state.ts`, `security.ts`): `SID`, `DID`, `SESSION`,
  NRCs als Daten, `decodeDtcStatus`, `encodeDtcToBytes`

## Does NOT do

- keinen Bus-/Adapter-Zugriff (nur `UdsLink` — maschinell geprüft)
- keine Diagnose-Orchestrierung (das orchestriert `@vdp/core`)
- keine I/O, keine `node:`-Builtins (portabel)
- keine OEM-Spezialfälle im Code (die gehören in `@vdp/protocols-oem`
  als Hooks oder in Definition-Pakete)

## Public API

`src/index.ts` — vollständig in
[`docs/api/uds.md`](../../../docs/api/uds.md) dokumentiert.

## Dependencies

Nur `@vdp/shared`.

## Data Flow

```text
Client-Seite:  UdsClient.request() → UdsLink.send() → (ISO-TP) → Bus
Server-Seite:  Bus → (ISO-TP) → UdsServerLink.onMessage → UdsServer → Antwort
```

## Important invariants

- **Link, nie Bus** (ADR 0031) — der Dependency-Checker fällt.
- **NRC ist Daten** (ADR 0018): Negativ-Antworten werden als solche
  weitergereicht; abgeschnittene Antworten sind Fehler (ADR 0039).
- **Timing kommt von der ECU** (`updateTiming`), nie global hartkodiert.
- **Simulatoren nutzen die Server-API** — Casts in interne Maps sind
  verboten (ADR 0041).
- **Eine DTC-Status-Dekodierung** (`decodeDtcStatus`) — Core, Simulator
  und Workbench-View teilen sie.

## Tests

Co-lokatierte `src/*.spec.ts` (Gate 90/75) + Konformanz-Suite
`tests/protocol/` (Projekt `protocol`).

## Examples

```ts
import { UdsClient, UdsServer } from "@vdp/protocols-uds";

// Tester-Seite
const client = new UdsClient(link, { name: "engine" });
await client.diagnosticSessionControl(0x03);
const vinBytes = await client.readDid(0xf190);

// ECU-Seite (Simulator)
const server = new UdsServer(serverLink, { name: "Engine Control" });
server.registerDid({ did: 0xf190, value: () => vinBytes });
server.start();
```
