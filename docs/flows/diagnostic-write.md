# Flow: Diagnostischer Schreibvorgang (Write-Kette)

> Getrenntes Universum: **jede** Schreiboperation läuft gestuft über
> `WritePort` + `SafetyManager` (ADR 0032, AGENTS 26). Ein abgelehnter Write
> ist eine *Antwort mit Gründen*, kein Fehler (ADR 0018).

```text
Client (nur über Runtime)
  │  runtime.commands.dispatch(clearDtcs(...))  bzw. writes.precheck()/run()
  ▼
@vdp/application          ClearDtcCommand — Intent, keine Ausführung
  ▼
@vdp/runtime              registerRuntimeHandlers → DtcService
  ▼
@vdp/core (writes/)
  1. WriteOperation.describe()      — was genau würde geschrieben (ECU, DID/Routine, Wert)
  2. SafetyManager.evaluate()       — Risk-Policy (domain/risk.ts) + User-Confirm + Vehicle-State
  3. WriteOperation.prepare()       — nur lesendes Backup (Session-Switch erlaubt, kein Write)
  4. Permit erteilt → WriteOperation.execute()  — erst jetzt Bytes auf den Draht
  5. Audit: TransactionSnapshot in port.history + Domain-Events
  ▼
@vdp/protocols-uds        UdsClient.clearDiagnosticInformation() / writeDataByIdentifier() / startRoutine()
  ▼
ISO-TP → CAN → ECU        (positiv: 0x6x-Antwort; negativ: NRC als Daten zurück in das Ergebnis)
```

**Stufen und ihre Bedeutung:**

| Stufe | Darf schreiben? | Darf Session wechseln? | Wer entscheidet |
|---|---|---|---|
| `precheck` | Nein | Nein (Backup-Read übersprungen) | SafetyManager, mit *requestetem* Confirm |
| `prepare` | Nein | Ja (z. B. Extended-Session) | WriteOperation selbst |
| `execute` | **Ja** | — | nur nach Permit |

**Wichtige Kanten:**

- **Reads erreichen den WritePort nie:** `WritePort` ist ein eigener Port am
  Runtime (`runtime.writes`), keine Methode am Lesepfad (ADR 0032).
- **Vehicle-State zählt:** `WriteBinding.vehicleState` (Batterie, Getriebe, …)
  ist Teil der Precondition — ein „auto-off“ ohne belegten Zustand ist ein
  Defekt (ADR 0026).
- **Abgelehnt ≠ Fehler:** `WriteOperationResult` trägt `outcome` +
  `stages[]` mit Gründen; die UI zeigt das als Antwort (ADR 0018).
- **Sicherheit wird nicht umgangen:** Security Access läuft über
  `unlockSecurityAccess` mit registriertem Seed-Key-Algorithmus
  (provenance-pflichtig, ADR 0003) — nie hartkodiert (Leitplanke 0.D).
- **Audit:** jede Transaktion landet in `port.history` und im
  `EventAuditRecorder` — die Write-Kette ist rekonstruierbar (AGENTS 24).

**Verboten (Review-Blockade):** UI → direkter UDS-Write · Bypass des
WritePort · Write ohne Permit · NRC-Schlucken.
