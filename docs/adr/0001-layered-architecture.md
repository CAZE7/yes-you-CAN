# 0001 — Geschichtete Architektur mit fester Abhängigkeitsrichtung

Status: accepted · Datum: 2026-09-10 · Bezug: AGENTS 2, 5, 36

## Kontext

Diagnose-Software scheitert selten am Protokoll, sondern an Kopplung: OEM-Logik
sickert in die CAN-Schicht, die UI dekodiert Frames selbst, und ein
Adapterwechsel zieht Änderungen durch alle Ebenen.

## Entscheidung

Feste Schichten, Abhängigkeiten zeigen nur nach unten:

```
UI (apps/web) → Application → Diagnostic Engine (core)
              → Transport (iso-tp, doip) → Adapter (elm327, canable, socketcan) → Fahrzeug
```

Konkret:

- `protocols/uds` kennt nur `@vdp/shared` — kein Transport, keine Definitionen.
- `definitions` ist ein Blatt-Paket ohne Abhängigkeiten.
- Adapter hängen nur an `shared` + `transport-can`.
- Die UI bekommt ausschließlich bereits dekodiert Werte.

Der Austausch eines Transports (CAN ↔ DoIP) erfolgt über `VehicleTransport`;
die UDS-Engine wird dafür nicht angefasst (`createRequestResponseLink` bridgt
einen Message-Transport auf das `UdsLink`-Interface).

## Konsequenzen

- Ein neuer Adapter ist ein Paket, keine Änderung am Kern.
- OEM-Spezifika brauchen einen definierten Ort (siehe ADR 0003) — sie können
  nicht mehr „irgendwo" landen.
- Zirkuläre Projektverweise sind unmöglich; `tsc -b` erzwingt die Richtung.
  Das hat praktisch dazu geführt, dass der Simulator-Test für die OEM-Hooks im
  `tests`-Workspace liegt und nicht in `core`, weil `simulators` von `core` abhängt.
