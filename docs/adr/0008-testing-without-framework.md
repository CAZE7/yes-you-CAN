# 0008 — node:test auf kompiliertem Output

Status: accepted · Datum: 2026-09-10 · Bezug: AGENTS 31, 35, 34.10

## Kontext

Test-Frameworks sind die größte Quelle von Abhängigkeiten und die häufigste
Ursache für „lokal grün, CI rot".

## Entscheidung

`node:test` + `node:assert/strict` auf den von `tsc -b` erzeugten
`dist/**/*.test.js`. `scripts/test.mjs` sammelt alle Test-Dateien über
`packages/`, `tools/`, `tests/` und `apps/` und startet einen einzigen Runner.

Test-Ebenen nach AGENTS 31: unit (je Paket), integration
(`tests/integration`), protocol (`tests/protocol`), simulator/replay
(`tests/replay`), regression (`tests/regression`).

## Konsequenzen

- Getestet wird der kompilierte Output, nicht der Quelltext — ein Build-Fehler
  kann nicht von einer grünen Suite verdeckt werden.
- Keine Watch-Magie: `npm test` ist `build && test`.
- Assertionsfallen sind dokumentiert, weil sie mehrfach auftraten: `toHex`
  liefert Großbuchstaben *und* Leerzeichen; DLCs müssen aus der echten
  Bytezahl abgeleitet werden, nicht aus einer Vorstellung des Payloads; bei
  Reihenfolgeabhängigkeit `.some(...)` statt fester Indizes.
