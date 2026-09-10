# 0004 — Rohdaten und Dekodierung strikt getrennt

Status: accepted · Datum: 2026-09-10 · Bezug: AGENTS 14, 15, 17, 18, 34.7

## Kontext

Sobald ein dekodierter Wert den Rohwert ersetzt, ist ein Dekodierfehler nicht
mehr nachvollziehbar — genau dann, wenn es darauf ankommt.

## Entscheidung

Jeder dekodiert Wert trägt seine Rohbytes mit:

```ts
interface DecodedSignal { raw: Uint8Array; rawHex: string; rawValue: …; value: … }
```

- Der Roh-Trace zeichnet unveränderte Frames auf, inklusive Richtung (`tx`/`rx`).
- Exporte liefern beides: `measurements.csv` (dekodiert) und `raw-trace.csv`
  (roh) als getrennte Dateien; `session.json` enthält beides nebeneinander.
- Die UI zeigt im Roh-Trace nur Frames und kennzeichnet sie als roh. Sie
  interpretiert nichts.
- Requests werden nie als Responses dekodiert — der Trace-Analyzer führt
  `direction` mit, weil ein Request `22 F1 90` sonst als positive Antwort
  erscheint.

## Konsequenzen

- Ein Dekodierfehler ist immer am Rohwert erkennbar.
- Replay-Tests können byte-genau vergleichen (ADR 0005).
- Der Trace wächst schneller; er ist deshalb gedeckelt (`maxTraceEntries`) und
  die Aufnahme streamt als NDJSON (ADR 0007).
