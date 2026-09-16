# Vertrag: UDS / Protokoll-Layer

**Verbindliche Quellen:** `packages/protocols/uds/README.md`,
[`../docs/api/uds.md`](../docs/api/uds.md),
[`../docs/flows/diagnostic-read.md`](../docs/flows/diagnostic-read.md),
ADR 0013/0039/0041, [`../architecture/architecture.yaml`](../architecture/architecture.yaml)
(`@vdp/protocols-*`).

## Die Regeln, die du nicht brechen darfst

1. **Link, nie Bus:** Protokolle sprechen durch `UdsLink`
   (`send(payload) → response`) — kein `CanBus`, kein Adapter
   (ADR 0031, maschinell).
2. **NRC ist Daten** (ADR 0018): Negativ-Antworten werden weitergereicht
   mit Grund; `0x78` (pending) wird behandelt, nicht geschluckt.
3. **Abgeschnittene Antwort = Fehler** (ADR 0039): nie „leer“ liefern —
   eine abgeschnittene Antwort ist ein Fehler mit Grund, kein leerer
   Fehlerspeicher.
4. **Timing kommt von der ECU** (`updateTiming` nach 0x10) — nie global
   hartkodiert (AGENTS 9).
5. **Simulatoren nutzen die Server-API** — `registerDid`,
   `registerWritableDid`, `setDtc`, `registerRoutine`,
   `registerSecurityAccess` (ADR 0041). Casts in interne Maps sind
   verboten (Review-Blockade).
6. **Eine DTC-Status-Dekodierung** (`decodeDtcStatus` aus
   `@vdp/protocols-uds`) — Core, Simulator und Workbench-View teilen sie;
   eine zweite ist ein Defekt.
7. **OEM-Spezifika gehören nicht hierher** — Hooks nach
   `@vdp/protocols-oem`, Daten nach Definition-Pakete.

## Wenn du einen neuen UDS-Service baust

→ [`.ai/tasks/add-uds-service.md`](../tasks/add-uds-service.md) (Schritt-
für-Schritt mit den Prüfungen).

## Weiter

- Transport-Seite: [`.ai/contracts/transport.md`](transport.md)
- Simulator: [`.ai/packages/simulator.md`](../packages/simulator.md)
- Kontext-Bundle: `npm run ai:context uds`
