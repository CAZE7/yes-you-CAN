# `@vdp/formal-conformance` — shared vectors, two readers

> Layer: **tool** · ADRs: [0045](../../docs/adr/0045-formal-reference-conformance-vectors.md) ·
> Manifest-Einträge: `architecture/architecture.yaml` → `packages["@vdp/formal-conformance"]`

## Purpose

Eine Test-Definition, zwei Prüfungen: die Vektoren in `vectors/` beschreiben
ISO-15765-2-Transkripte (Empfang, Senden, Timeouts, Flow Control) und die
Write-Safety-Kette (Regeltabelle, Stufenfluss, Reihenfolge-Tabelle) in einer
kanonischen, implementierungs-freien Sprache. Dieselben Dateien laufen gegen

- die **Produktions-Implementierung** (`IsoTpConnection`, `SafetyManager`,
  `WritePort`, `DiagnosticTransaction`) — in `npm test` (Projekt `protocol`),
  auf dem Scripted-Bus *und* auf der Virtual-CAN-Leitung (beweist die
  Bus-Unabhängigkeit; dasselbe Muster gilt für SocketCAN/CANable — `CanBus`
  ist die Nahtstelle);
- die **Haskell-Referenz** in [`formal/`](../../formal/README.md) — über
  `npm run formal:conform -- --compare`, wo `runghc`/`ghc` existiert; die
  Abweichung wird als `Vektor · Input · TS · Haskell · Difference` ausgegeben.

## Does NOT do

- Keine Protokoll-Logik. Das Paket segmentiert nicht selbst — es füttert die
  echten Klassen und vergleicht Ergebnisse.
- Keine zweite IR, kein Diagnose-Vokabular: Ergebnisse sind kanonische
  Protokoll-/Safety-Beobachtungen, keine `DiagnosticObservation`s.
- Keine CI-Abhängigkeit von Haskell: ohne Toolchain ist der Vergleich ein
  sichtbar übersprungener Test, nicht Grün.
- Kein `node:`-Import außer in `cli.ts` (Dateien lesen, Treiber spawnen) —
  die Kernlogik ist pure und in Unit-Specs ohne Dateisystem prüfbar.
- Kein UI-Consumer; `apps/web` importiert dieses Paket nicht.

## Public API

| Export | Zweck |
|---|---|
| `runIsoTpVector(vector, time, pair?)` | ein rx/tx-Vektor gegen die echte `IsoTpConnection`; kanonisches Ergebnis |
| `runSafetyVector(vector)` | precheck/flow/stages-Vektor gegen die echte Safety-Kette |
| `parseIsoTpVectorFile(text)` / `parseSafetyVectorFile(text)` | strenge Leser der Vektordateien (Pfade in Fehlern) |
| `ConformancePair`, `ScriptedPair` | die Bus-Nahtstelle; die Virtual-CAN-Implementierung lebt im Protokoll-Suite-Test |
| `encodeFrame` / `decodeFrame` / `canonicalJson` / `diffPaths` | die kanonische Kodierung und der Vergleich |
| `compareAgainstExpectations` / `compareRecordSets` / `formatDiff` | Reporting-Maschinerie (auch für den Haskell-Lauf) |
| `runConformanceCli(argv, io)` | der Kern von `npm run formal:conform` mit injiziertem io |

## Invariants

- **Ein Vektor, ein Fakt:** `expect` gehört zur Vektordatei, nicht zu einem
  Test. Beide Leser werden gegen dasselbe Feld geprüft; die
  Differential-Vergleichung vergleicht zusätzlich Leser untereinander.
- **Kein Raten:** Fehler ohne Klasse, Frames ohne Kodierung und Ergebnisse
  ohne Vektorzeile sind Run-Fehler — ein Harness, der rät, konformiert nicht.
- **unproven ⊆ failed** wird auf jedem Safety-Lauf nachgerechnet, nicht nur
  in den Erwartungen (ADR 0033 als Lebend-Invariante).
- Stummes Verwerfen beim Parsen ist ausgeschlossen: ein Vektor, der ohne
  Fehlermeldung fiele, lässt die Datei selbst durchfallen.

## Tests

`src/*.spec.ts` (Unit: Codec, Parser-Positiv/+Negativ, Runner auf der
Produktions-`IsoTpConnection` und Safety-Kette, CLI-Kern mit Fake-io) ·
`tests/protocol/formal-conformance.test.ts` (Gate: alle Vektoren gegen
Produktion + Haskell wo vorhanden) · `tests/protocol/formal-conformance-bus.test.ts`
(dieselben Vektoren über das Virtual-CAN-Netz) ·
`tests/hardware/socketcan-conformance.test.ts` (vorbereiteter Hardware-Arm,
skipped ohne vcan0/Binding).
