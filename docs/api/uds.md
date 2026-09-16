# Public API: `@vdp/protocols-uds`

> Paket: [`packages/protocols/uds/`](../../packages/protocols/uds/README.md) ·
> Layer: **protocol** (importiert nur `@vdp/shared`) ·
> ADRs: [0013](../adr/0013-transport-transaction-scope.md),
> [0039](../adr/0039-fault-injection-at-the-link-seam.md),
> [0041](../adr/0041-uds-server-api-for-simulators.md)

UDS (ISO 14229) auf beiden Seiten des Drahts: Client für den Tester, Server
für den Simulator. Beide sprechen **nur durch eine Link-Seam** — der
Protokoll-Layer kennt weder `CanBus` noch Adapter.

## Primary API

| Symbol | Zweck |
|---|---|
| `UdsClient` | Der Tester: `diagnosticSessionControl`, `testerPresent`, `readDid`/`readDataByIdentifier`, `readDtcByStatusMask`, `readSupportedDtc`, `readDtcSnapshotRecord`, `clearDiagnosticInformation`, `writeDataByIdentifier`, `unlockSecurityAccess`, `routineControl`/`startRoutine`, `readVin`, `updateTiming`, `startTesterPresent` |
| `UdsServer` | Die ECU-Seite (für den Simulator): `start`/`stop`, `registerDid`, `registerWritableDid`, `setDtc`, `registerRoutine`, `registerSecurityAccess` — **die** offizielle Simulator-API (ADR 0041) |
| `UdsLink` | Die Seam: `send(payload: Uint8Array): Promise<Uint8Array>` — das ist alles, was ein Protokoll braucht |
| `RequestResponseLink` / `createRequestResponseLink()` | Baut einen `UdsLink` auf einem `MessageTransport` (Request/Response + NRC-Weitergabe) |
| `SID`, `DID`, `SESSION`, `RESET_TYPE`, `DTC_REPORT`, `ROUTINE_CONTROL_TYPE` | Die ISO-Konstanten (ISO 14229-1) |
| `Nrc`, `nrcName()` | Negative Response Codes als Daten (ADR 0018) |
| `decodeDtcStatus()` | Status-Byte → Bits (wird auch von der Workbench für die Fehlerspeicher-Anzeige verwendet — eine Dekodierung, keine Kopie) |
| `encodeDtcToBytes()` | DTC → ISO-14229-Byte (Simulator-/Testseite) |
| `parseSingleDidResponse()` / `parseMultiDidResponse()` / `didToBytes()` | Response-Parsing für ReadDataById |
| `UdsTiming`, `DEFAULT_UDS_TIMING` | P2/P2*/S3 als Daten, nie hartkodiert (AGENTS 9) |

## Beispiel: Client über eine Link-Seam

```ts
import { UdsClient } from "@vdp/protocols-uds";

// link ist im echten System die ISO-TP-Verbindung (MessageTransport);
// im Test der Simulator-Bus. Der Client merkt den Unterschied nicht.
const client = new UdsClient(link, { name: "engine", timing: { p2Ms: 50 } });

const raw = await client.readDid(0xf190); // VIN, Rohbytes
await client.diagnosticSessionControl(0x03); // extendedDiagnosticSession
const dtcs = await client.readDtcByStatusMask(0xff); // DtcRecord[] (Rohform)
await client.readDtcSnapshotRecord(dtcs[0]!.code, 0x01); // Freeze Frame
```

## Beispiel: Server für den Simulator

```ts
import { UdsServer } from "@vdp/protocols-uds";

const server = new UdsServer(serverLink, { name: "Engine Control" });
server.registerDid({
  did: 0xf190,
  value: () => vinBytes, // ReadDataById-Antwort (Closure: darf sich live ändern)
});
server.registerWritableDid({
  did: 0x2a01,
  value: () => adaptationValue,
  write: (payload) => {
    adaptationValue = payload; // undefined zurück = akzeptiert, NRC-Nummer = abgelehnt
  },
});
server.setDtc({ code: "P0420", status: 0x0f, snapshot: freezeFrameBytes });
server.start();
```

## Verträge

1. **Kein Bus, kein Adapter** — nur `UdsLink` (maschinell geprüft).
2. **Negativ-Antworten sind Daten**: NRC wird zurückgeliefert/weitergereicht,
   eine abgeschnittene Antwort ist ein Fehler, kein leerer Speicher (ADR 0039).
3. **Timing kommt von der ECU** (`updateTiming`), nie global hartkodiert.
4. **Simulatoren nutzen die Server-API** — Casts in interne Maps sind verboten
   (ADR 0041).
5. **KWP2000** teilt diese Primitive (`@vdp/protocols-kwp2000` importiert
   `@vdp/protocols-uds`); neu aufzubauen ist eine Verletzung der Doku.
