# 0005 — Simulator und Replay statt Real-Fahrzeug

Status: accepted · Datum: 2026-09-10 · Bezug: AGENTS 19, 31.4, 31.5, 31.6

## Kontext

Ein Diagnose-Stack, der nur am echten Fahrzeug testbar ist, wird nicht getestet.
Gleichzeitig darf ein Simulator keine Fehler verstecken, die ein reales Steuergerät
produzieren würde.

## Entscheidung

Drei Bausteine:

1. **`VirtualVehicle`** — ein UDS-Server pro ECU über einem virtuellen CAN-Netz,
   mit NRC 0x78, deterministischem Seed und setzbaren DTCs.
2. **`ReplayTransport`** — spielt eine aufgezeichnete Konversation ab und meldet
   **Abweichungen** statt sie stillschweigend zu glätten: `no-recorded-request`
   und `payload-differs`.
3. **Regression-Katalog** (`tests/regression`) — jeder gefundene Protokollfehler
   wird zu einem Test mit Symptombeschreibung.

## Konsequenzen

- Vier echte Protokollfehler wurden erst durch laufende Tests gefunden, vom
  Compiler keiner: FF-Escape nur am PCI-Nibble geprüft, Flow-Control-Race,
  nicht durchgesetzte Blockgröße beim Empfang, als Response dekodierter Request.
- Ein Test-Harness, das `server.handle()` vollständig erwartet, macht den
  P2\*-Timeout-Pfad untestbar — der Test fiel aus, ohne den Fehler zu zeigen.
  Harnesses sind Teil der Aussagekraft, nicht nur Infrastruktur.
- Replay ersetzt kein Echtfahrzeug; es belegt Reproduzierbarkeit, keine
  Fahrzeugwahrheit.
