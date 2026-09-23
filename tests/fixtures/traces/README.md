# Trace-Fixtures (candump-Logs)

Aufgezeichnete CAN-Traces im Format `candump -l` (SocketCAN-Log). Sie sind die
Zeugen für `tests/integration/iso-tp-trace.spec.ts`: ein Trace ist eine
Bus-Aufnahme, keine Erwartungstabelle — deshalb steht in jedem Kopf, woher die
Bytes stammen, wie die Zeilen zu lesen sind und welche Transaktionen sie zeigen.

| Datei | Inhalt | Rahmen | Dauer |
| --- | --- | --- | --- |
| `single-frame-uds.log` | TesterPresent (unterdrückt), DiagnosticSessionControl 0x03, ReadDataByIdentifier 0xF186 | 5 | 4 ms |
| `multi-frame-read-data-by-identifier.log` | VIN 0xF190 (20 Byte) und Ersatzteilnummer 0xF187 (13 Byte), je First Frame + Flow Control + Consecutive Frames | 9 | 8 ms |
| `response-pending.log` | NRC 0x78 und 25 ms später die echte Antwort auf ReadDataByIdentifier 0xF18C | 3 | 26 ms |

Identifier-Paar in allen drei Dateien: `0x7E0` Tester (tx), `0x7E8` Steuergerät
(rx), 11-Bit, CAN 2.0A, MTU 8, kein Padding.

## Herkunft

Aufgenommen mit `scripts/record-trace-fixtures.mjs` aus dem Stack dieses
Repositorys: `UdsServer` und `UdsClient` hinter je einer `IsoTpConnection` auf
einem virtuellen Draht. Kein reales Fahrzeug, keine reale Hardware (ADR 0005) —
aber echte Wire-Bytes der Referenzimplementierung statt abgetippter Erwartungen.

Weil die Fixtures aus derselben Implementierung stammen, die sie testen, prüft
die Spec sie dreifach:

1. **Struktur** — `tests/helpers/iso-tp-frames.ts` liest jedes PCI-Byte direkt
   nach ISO 15765-2 und setzt die Nachrichten selbst zusammen, ohne das
   Transportpaket zu importieren.
2. **Bytes** — die erwarteten Nutzlasten in der Spec sind wörtliches Hex/ASCII
   aus ISO 14229-1 (Dienste, DIDs, NRCs), nicht aus einem Dekoder abgelesen.
3. **Live** — dieselbe Konversation läuft gegen einen echten `UdsServer`, und
   die Frames auf dem virtuellen Bus müssen den aufgezeichneten gleich sein.
   Driftet die Implementierung vom Trace weg, fällt dieser Test, auch wenn das
   Replay selbst noch grün ist.

## Neu aufnehmen

```bash
npm run build                          # das Skript importiert die gebauten Pakete
node scripts/record-trace-fixtures.mjs  # schreibt alle drei Dateien neu
```

Die Aufnahme ist deterministisch: virtuelle Uhr (1-ms-Raster, Epoche
2026-09-22T00:00:00Z), feste DIDs, feste Response-Pending-Lücke von 25 ms. Ein
zweiter Lauf muss bit-identische Dateien liefern (`md5sum` vergleichen) — sonst
ist eine Uhr oder ein Zufallswert in die Aufnahme gerutscht.

Ein neuer Trace gehört nur dann hierher, wenn er etwas zeigt, das die anderen
nicht zeigen (ein eigener Fall von Flow Control, ein Fehlerbild, eine andere
Adressierung). Kopfzeilen mit Herkunft, Format und Aufbau sind Pflicht: ein
Trace ohne Erklärung ist ein Rätsel, kein Zeuge.

## Warum `*.log` trotzdem im Repo liegt

`.gitignore` ignoriert `*.log` (Build- und Debug-Ausgaben). Die Negation
`!tests/fixtures/traces/*.log` nimmt genau dieses Verzeichnis wieder aus, denn
`candump -l` schreibt nun einmal `*.log` — die Fixtures sollen die Endung eines
echten Logs behalten, statt eine Kunstendung zu tragen.
