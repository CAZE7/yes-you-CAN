# 0007 — JSON + NDJSON mit versionierten Migrationen

Status: accepted · Datum: 2026-09-10 · Bezug: AGENTS 10, 17, 34.13, 34.14

## Kontext

Eine Session darf bei einem Absturz nicht verloren gehen, und eine vor Jahren
gespeicherte Session muss noch lesbar sein.

## Entscheidung

Eine Session ist ein Verzeichnis:

```
sessions/<id>/session.json         Metadaten, ECUs, DTC-Snapshots, Aktionen
sessions/<id>/measurements.ndjson  Messwerte, append-only
sessions/<id>/trace.ndjson         Roh-Trace, append-only
sessions/<id>/log.ndjson           Diagnose-Log, append-only
```

NDJSON für die Datenströme, weil ein Absturz dann nicht die ganze Aufnahme
ungültig macht und Replay inkrementell lesen kann.

Schema-Änderungen laufen über eine `MigrationRegistry`; jede Migration geht
exakt eine Version weiter und wird beim Laden protokolliert. Eine Session aus
einer neueren Version wird abgelehnt statt geraten.

Session-IDs werden vor Dateisystemzugriffen auf `[A-Za-z0-9._-]` geprüft
(Path-Traversal).

## Konsequenzen

- `SessionRepository` ist ein Interface; `MemorySessionRepository` erlaubt
  Tests ohne Dateisystem.
- ZIP-Export (ADR 0002) bündelt alle vier Dateien für die Übergabe.
- NDJSON ist nicht indiziert — für Werkstatt-Session-Größen ausreichend, für
  Datenbanken über viele Fahrzeuge nicht.
