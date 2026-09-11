# 0008 — node:test auf kompiliertem Output

Status: superseded (2026-09-11) · Datum: 2026-09-10 · Bezug: AGENTS 31, 35, 34.10 · Ersetzt durch ADR 0010, Schritt 1 (Vitest), gemergt als PR #9

## Ersetzung

Schritt 1 von ADR 0010 (Vitest + V8-Coverage, gemergt als PR #9 am
2026-09-11) hat die `node:test`-Orchestrierung auf `dist/**/*.test.js`
ersetzt: Vitest-Projektkonfiguration, Unit-Specs co-lokatiert neben dem
Code, Tests direkt auf den TypeScript-Quellen via Workspace-Aliases.
Dieser ADR bleibt als Entscheidungsprotokoll erhalten (Konvention: ADRs
werden superseded markiert, nie gelöscht).

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
