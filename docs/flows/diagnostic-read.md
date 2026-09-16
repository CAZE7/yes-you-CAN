# Flow: Diagnostischer Lesevorgang (DID/Signal)

> Pipeline: `UI → Runtime → UDS → ISO-TP → CAN` und zurück — mit der
> Rohebene, die bei jeder Stufe erhalten bleibt.

```text
Client (Workbench / CLI / Agent)
  │  runtime.commands.dispatch(readDid(ecuId, 0xf190))
  ▼
@vdp/application          readDid() — Command, nur Domänen-Vokabular
  ▼
@vdp/runtime              DtcService/VehicleService-Handler (handlers.ts)
  ▼
@vdp/core                 DiagnosticEngine → EcuHandle (diese ECU, diese Link-Factory)
  ▼
@vdp/protocols-uds        UdsClient.readDid() → Request 0x22 F1 90, Response-Parsing
  ▼                        NRC 0x78 → Retry, 0x7x → Fehler mit Grund (ADR 0018/0039)
@vdp/transport-iso-tp     IsoTpConnection.send() → Segmentation (ISO 15765-2)
  ▼
@vdp/transport-can        CanBus.send(CanFrame) / subscribe()
  ▼
@vdp/adapter-*            Hardware (oder der virtuelle Bus des Simulators)
  ▼
ECU (oder UdsServer im Simulator, ADR 0041)
```

Auf dem Rückweg wird in Stufen **dekodiert, nie überschrieben**:

```text
CanFrame (Roh)
  ▼  IsoTpConnection: Reassembly → UDS-Response-Bytes (Roh)
UdsClient: Response-Prüfung (0x62 + DID), NRC-Auswertung
  ▼  packages/core/src/measurements/decoder.ts
DecodedSignal { raw: Uint8Array, rawHex, rawValue, value, unit, did, ecu }
  ▼  packages/core/src/session/observation.ts
SignalReading (IR) mit evidence: proven({ origin: "ecu-response", serviceId: 0x22, raw, at })
  ▼  packages/runtime/src/mappers.ts
MeasurementReading (domain) → Command-Bus-Response → UI
```

**Wichtige Kanten auf dem Weg:**

- **Roh + dekodiert nebeneinander** (ADR 0004): ein `RawDidReading`/
  `MeasurementReading` trägt immer `rawHex` neben dem Wert.
- **Evidenz wird am Core gebaut** (`session/observation.ts`), nicht in der UI.
- **Events auf dem Weg:** `did-read`, `ecu-discovered`, `measurements-recorded`
  auf dem Domain-Event-Bus → `runtime.audit` (AGENTS 10).
- **Discovery zuerst:** `connectVehicle` → Probe mit Zeitbudget (ADR 0019) →
  `EcuSummary` mit Capabilities; erst dann sind Reads gegen eine ECU erlaubt.

**Wer wo greift (Details):** [`docs/code-map.md`](../code-map.md) Zeilen
„UDS-Service hinzufügen“, „Bus-Vertrag ändern“.
