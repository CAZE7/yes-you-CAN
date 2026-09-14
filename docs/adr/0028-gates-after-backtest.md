# 0028 — Gates nach dem Nachtesten, nicht nach dem Gefühl

Status: accepted · Datum: 2026-09-14 · Bezug: AGENTS 31, 34.21, 34.24; ADR 0017, 0020, 0022, 0025, 0027

## Kontext

ADR 0017 hat die Regel gesetzt: **erst Tests, dann Gate.** ADR 0020 und 0022 haben sie
angewandt, und 0.E E16/E11 dokumentierten seither dieselbe Situation — Dateien, die nur
wenig über ihrem Gate liegen und deshalb bei jeder Berührung rot werden *ohne* Mangel,
während die eigentlichen Unbeobachtetheiten unsichtbar bleiben. Gemessen am Stand vor
diesem ADR (Gesamtlauf `npm run test:coverage`):

| Datei | gemessen | Gate | Puffer |
|---|---|---|---|
| `core/src/diagnostics/ecu-session.ts` | 85,58 Z / 71,26 Zw | core 85/65 | **+0,58** — knappste Datei im Baum, keine eigene Spec |
| `adapters/elm327/src/protocol.ts` | 96,29 / 76,00 | adapters 85/75 | +1,00 Zweige |
| `transport/can/src/bus.ts` | 87,50 / 100 | transport 85/70 | +2,50 Zeilen |
| `adapters/elm327/src/stream.ts` | 88,23 / 100 | adapters 85/75 | +3,23 Zeilen |
| `reports/src/report.ts` | 100 / 79,48 | reports 95/75 | +4,48 Zweige |
| `ai/src/heuristic.ts` | 94,87 / 79,48 | ai 90/75 | +4,87 Zweige |

E11 benannte bei `ecu-session.ts` zugleich, **was** fehlte: keine Spec, die
`EcuDiagnosticSession` direkt adressiert, kein UDS-Test-Double für Fehlerfälle, und als
Folge unbeobachtet `probeSupportedServices`, NRC-Behandlung und die
Timing-Übernahme aus der Session-Antwort (ISO 14229-2).

## Entscheidung

1. **Zuerst nachgetestet, dann angehoben — in dieser Reihenfolge, in diesem Commit.**
   Neu: `packages/core/src/diagnostics/ecu-session.spec.ts` (19 Tests, Stub-Double des
   `UdsClient`), Guard-Kette und `isElmError`-Äste in `elm327.spec.ts` (+9),
   `MemoryByteStream`-Ränder (+4), `packages/transport/can/src/bus.spec.ts` neu (5).
2. **Neue Gates** (`vitest.config.ts`, alle per file): `core` 85/65 → **88/80**,
   `adapters` 85/75 → **92/78**, `transport` 85/70 → **88/72**, `reports` 95/75 →
   95/**80**, `ai` 90/75 → **95/85** (letzteres bereits mit ADR 0026/Nachtrag).
   `protocols` (90/75), `storage` (95/80), `shared` (100/95), `charts` (90/75),
   `definitions` (85/80) bleiben, weil ihre schwächsten Dateien sich nicht bewegt haben.
3. **Puffergröße ist eine Aussage, kein Wunsch.** Jede Zahl ist ein bis drei Punkte unter
   dem im Gesamtlauf gemessenen schwächsten Wert der Gruppe — bewusst so eng, dass eine
   neue Datei ohne Test rot wird. Der Preis wird offen getragen: dieselbe Maßnahme
   erzeugt neue dünste Stellen, und sie stehen in 0.E E16 mit Zahl statt in einer
   Konfigurationsdatei, die niemand liest (`engine.ts` 82,10 gegen 80; `clear.ts` 90,24
   gegen 88; `iso-tp/connection.ts` 75,62 gegen 72; `ai/http.ts` 87,71 gegen 85).
4. **Beißen ist gemessen, nicht behauptet (34.21).** Für jede geänderte Gruppe gilt das
   Verfahren von ADR 0022: Schwellen kurz auf einen unmöglichen Wert (99/99) setzen,
   Coverage-Lauf → `EXIT=1` mit Datei und Zahl im Fehlertext. Abgedruckt in `vitest.config.ts`
   und hier:
   `ERROR: Coverage for branches (90.32%) does not meet "packages/reports/**/src/**" threshold (99%) for packages/reports/src/pdf.ts` und
   `ERROR: Coverage for branches (78.39%) does not meet … for packages/reports/src/report.ts`.
   Danach zurückgesetzt und grün gefahren: 1404 Tests / 94 Dateien, `EXIT=0`, global
   94,91 Statements / 88,02 Zweige / 96,25 Funktionen / 96,26 Zeilen.
5. **Was nicht getan wurde:** keine Datei neu ausgenommen, kein `?? 0`-Arm als
   „nicht testbar" deklariert, kein `it.skip`, kein Gate gesenkt, um Grün zu bekommen.
   Eine Zeile bleibt in `ecu-session.ts` unbedeckt (251, der Decoder-liefert-nichts-Zweig);
   sie bleibt unbedeckt, statt mit einem Test zugedeckt zu werden, der nichts behauptet.

## Konsequenzen

- `ecu-session.ts` verliert seinen Sonderstatus: 99,09 Zeilen / 90,80 Zweige, eigene
  Spec, und die Datei, die am ehesten „aus Versehen rot" war, ist es jetzt nur noch,
  wenn tatsächlich Abdeckung fehlt.
- E11 ist aus 0.E entfernt (erledigt); E16 bleibt als Ratchet-Eintrag auf P3 mit den
  neuen dünnsten Stellen — das ist der vorgesehene Zustand, nicht ein Restproblem.
- Der nächste Zuwachs in einer dieser Gruppen löst einen Coverage-Fehler aus, bevor er
  in einer Demo auffällt. Das war das Ziel.
