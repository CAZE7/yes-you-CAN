# `packages/protocols/` — Protokoll-Schicht

Die Diagnose-Protokolle des Systems, getrennt nach Standard:

| Paket | Inhalt | README |
|---|---|---|
| [`uds/`](uds/README.md) | `@vdp/protocols-uds` — UDS (ISO 14229): Client **und** Server über der Link-Seam | ✓ |
| [`kwp2000/`](kwp2000/README.md) | `@vdp/protocols-kwp2000` — Legacy-ECUs über den UDS-Primitiven | ✓ |
| [`oem/`](oem/README.md) | `@vdp/protocols-oem` — Hersteller-Hooks, nur dort, wo Definitionen schweigen | ✓ |

## Gemeinsame Regeln (maschinell geprüft)

- **Link, nie Bus:** ein Protokoll spricht durch `UdsLink`, nie durch
  `CanBus` oder einen Adapter (ADR 0031, Layer-Regel in
  [`architecture/architecture.yaml`](../../architecture/architecture.yaml)).
- **Portabel:** keine `node:`-Builtins.
- **NRC ist Daten** (ADR 0018), abgeschnittene Antworten sind Fehler
  (ADR 0039).
- **Keine OEM-Logik im Standard-Code** — OEM-Abweichungen gehören in
  `oem/` (Hooks) oder in Definition-Pakete (Daten).

## Dazugehörig

- API-Doku: [`docs/api/uds.md`](../../docs/api/uds.md)
- Flows: [`docs/flows/diagnostic-read.md`](../../docs/flows/diagnostic-read.md)
- Tests: `tests/protocol/` (Konformanz, Projekt `protocol`)
- Neue UDS-Service: [`docs/code-map.md`](../../docs/code-map.md) +
  [`.ai/tasks/add-uds-service.md`](../../.ai/tasks/add-uds-service.md)
