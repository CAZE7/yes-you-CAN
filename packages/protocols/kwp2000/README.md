# `@vdp/protocols-kwp2000`

**Layer:** protocol · **Pfad:** `packages/protocols/kwp2000/` ·
**Regeln-Quelle:** [`architecture/architecture.yaml`](../../../architecture/architecture.yaml)

## Purpose

KWP2000 (ISO 14230) für Legacy-ECUs: dieselben Primitiven wie UDS, anderes
Adress-/Service-Format. Bewusst als **Teilmenge über `@vdp/protocols-uds`**
gebaut — Legacy-ECUs teilen die UDS-Primitiven (Regel in `architecture.yaml`).

## Responsibilities

- `Kwp2000Client` über der UDS-Primitiv-Schicht (inkl. Fault-Records)
- KWP-Konstanten: `KWP_SID`, `KWP_LOCAL_ID`, `KWP_FAULT_STATUS`,
  `kwpServiceName()` (`services.ts`)
- KWP-spezifische Details (Adressierung, Timing)

## Does NOT do

- keine UDS-Logik neu erfinden: Primitiven kommen aus `@vdp/protocols-uds`
- keine Bus-/Adapter-Kenntnis (Link-Seam wie im UDS-Paket)
- keine I/O, keine `node:`-Builtins (portabel)

## Public API

`src/index.ts`: `client.ts`, `client-engine.ts`, `services.ts`.

## Dependencies

`@vdp/shared`, `@vdp/protocols-uds`.

## Data Flow

```text
Core (EcuHandle für KWP-ECU) → Kwp2000-Client → UDS-Primitiven → Link → (ISO-TP) → Bus
```

## Important invariants

- **Über, nicht neben UDS:** ein drittes Primitiv-Vokabular wäre ein Defekt.
- **Portabel + Layer-Regel:** kein Adapter-/Transport-Import (maschinell).

## Tests

Co-lokatierte `src/*.spec.ts` (Gate 90/75) + `tests/protocol/`.

## Examples

```ts
import { Kwp2000Client } from "@vdp/protocols-kwp2000"; // über dieselbe Link-Seam

const client = new Kwp2000Client(link, { name: "legacy-ecu" });
```
