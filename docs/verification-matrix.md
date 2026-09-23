# Verifikations-Matrix (AGENTS 35, ADR 0029)

Welcher Befehl beweist welche Behauptung, gemessen am Stand dieses Commits.
Wer „grün" sagt, ohne den Befehl dahinter zu schreiben, sagt es ohne Beweis
(AGENTS 34.21: Messung vor Behauptung). Die Matrix wird von
`scripts/check-verification-matrix.mjs` gegen den aktuellen Repo-Stand
abgeglichen — Befehle, die nicht (mehr) existieren, fallen, und Befehle, die
in der Matrix fehlen, aber im Repo liegen, werden nachgereicht.

| Behauptung | Befehl | Projekt / Suite | Schwelle | Soll-Stand |
| --- | --- | --- | --- | --- |
| Code baut | `npm run build` | `tsc -b tsconfig.json` | exit 0 | 28 Pakete gebaut, 0 Fehler |
| Typecheck (Strenge Suite, alle Specs/Tests) | `npx tsc --noEmit -p tsconfig.typecheck.json` | `tsconfig.typecheck.json` | exit 0 | 0 Fehler |
| Typecheck Frontend (Server, ohne Specs) | `npx tsc --noEmit -p tsconfig.frontend.json` | `tsconfig.frontend.json` | exit 0 | 0 Fehler |
| Biome-Lint + Format | `npx biome check .` | repo-weit | exit 0 | 494 Dateien, 0 Fehler, 0 Infos |
| Abhängigkeitsgraph (keine Pakete über die Schicht hinaus) | `npm run check:deps` | `tools/architecture/check-dependencies.mjs` | exit 0 | 28 Pakete, 83 Kanten, 0 Verstöße |
| Paket-Manifeste stimmen mit Imports überein | `npm run check:manifests` | `tools/architecture/check-package-manifests.mjs` | exit 0 | 28 Pakete, 0 Verstöße |
| Alle Tests auf den passenden Ebenen | `npm test` | `unit protocol regression replay integration architecture` | exit 0 | 2412 passed, 3 skipped, 1 Datei skipped |
| Quality Gates (Biome + beide strict noEmit als Test) | `npm test -- --project architecture` | `tests/architecture/guardrails.test.ts` | passed | der Test ruft `biome check .` + beide `tsc --noEmit`-Läufe; fällt wenn eine Schwelle rot ist |
| Coverage global ≥ 90/80/90/90 | `npm run test:coverage` | global (Statements/Branches/Functions/Lines) | ≥ Schwellen | gemessen am Commit (siehe `docs/agents/implementation-status.md`) |
| Coverage Pakete `protocols/*` ≥ 90/75 | `npm run test:coverage` | `vitest.config.ts` per-file `protocols/*` | ≥ Schwellen | gemessen |
| Coverage `apps/web/src` ≥ 76/72 | `npm run test:coverage` | `vitest.config.ts` per-file `apps/web/src` | ≥ Schwellen | gemessen (ADR 0017) |
| ISO-TP Trace-Replays (eigene Spec, drei candump-Fixtures) | `npx vitest run --project integration tests/integration/iso-tp-trace.spec.ts` | `integration` | passed | 25 Tests (3 Fixtures × Struktur/Bytes/Live) |
| Property-Tests für die Session-Zustandsmaschine | `npx vitest run --project unit packages/protocols/uds/src/session-state.properties.spec.ts` | `unit` | passed | 11 Properties, ≥ 1000 numRuns |
| NRC 0x78 stress (maxPendingResponses-Budget) | `npx vitest run --project unit packages/protocols/uds/src/client.spec.ts -t "NRC 0x78"` | `unit` | passed | 4 Tests (10/11 Pendings, negatives Ende, Counter-Stellen) |
| IsoTpConnection Edge-Cases | `npx vitest run --project unit packages/transport/iso-tp/src/connection.spec.ts` | `unit` | passed | 40 Tests |
| Replay-Aufnahme (Aufnahme selbst) | `npm run traces:record` | `scripts/record-trace-fixtures.mjs` | exit 0 | 3 Fixtures geschrieben |
| Replay-Aufnahme (Determinismus) | `md5sum tests/fixtures/traces/*.log` | Fingerabdruck | byte-identisch zum vorherigen Lauf | die drei md5-Summen aus dem Commit-Body |
| Doc-Beispiele lauffähig (runnable documentation, ADR 0043) | `npx vitest run --project integration tests/examples/` | `integration` | passed | die vier Standardpfade als Beispiel-Tests |
| Markdown-Links im Repo (kein gebrochener Verweis) | `npm run check:docs` | `scripts/check-docs-links.mjs` | exit 0 | 134 Dateien, 0 gebrochen |
| Strukturierte Diagnose-Logs in den oberen Schichten | `npm test` | `core` Suite | passed | die Diagnostics-Suite besteht, was beweist, dass die Logger-Konvention hält |

## Wie die Matrix aktuell gehalten wird

`scripts/check-verification-matrix.mjs` liest diese Tabelle, läuft jeden
Befehl und prüft Exit-Code und (für Coverage-Schwellen) die `coverage/`
Zusammenfassung. Das Skript ist absichtlich klein — es ersetzt keine
Pipeline, es pinbelt die Befehle fest, die in `AGENTS.md §35` und im
PR-Template als „Verifikation" stehen.

```bash
node scripts/check-verification-matrix.mjs
```

## Coverage-Schwellen und ihre Quellen

Die Schwellen sind nicht geraten:

- **Global** 90/80/90/90: Schwellwert aus ADR 0029 §6, gemessen am Head mit
  dem Träger-Job (`npm run test:coverage`). Im `architecture:impact`-Output
  als Vergleichswert hinterlegt.
- **`protocols/*`** 90/75: historisch 90/72 (siehe `vitest.config.ts`-Diff),
  auf 90/75 gehoben, weil die T4-PBT-Suite die Statement-Coverage der
  Session-Maschine auf >95 % getrieben hat (siehe T4 Commit-Body).
- **`apps/web/src`** 76/72: Boden aus ADR 0017, gehoben von 69/54 → 75/66 →
  76/72 in den drei vorhergehenden Commits (T1-Stand siehe Implementation
  Status).

Schwellen sinken nie (ADR 0017: Boden, kein Ziel). Steigen erfordern einen
belegten Messwert und einen Kommentar an der geänderten Zeile.

## Was nicht in der Matrix steht

- CI-Workflows (`ci.yml`, `release.yml`): die Sandbox kann keine
  Workflow-Dateien pushen (E10/E20), und die Matrix würde Befehle
  auflisten, die hier nicht laufen. Die Architektur-Suite prüft die
  wichtigsten Surrogate (`biome check`, beide `tsc --noEmit`, `npm test`).
- Hardware-Smoke (`tests/hardware/vcan.test.ts`): läuft manuell
  (`npm run test:hardware`), braucht `vcan0`. Die Matrix listet ihn nicht,
  weil er per Definition nicht auf jedem Host grün sein muss.
- Haskell-Conformance-Gate: gleicher Grund, plus eigener Compiler-Workspace
  (ADR 0045).
