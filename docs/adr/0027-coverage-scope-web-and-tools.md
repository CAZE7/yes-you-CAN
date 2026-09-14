# 0027 — Was gemessen wird: Workbench und Tools in der Coverage

Status: accepted · Datum: 2026-09-14 · Bezug: AGENTS 31, 34.21, 34.24; ADR 0016, 0017, 0020, 0022

## Kontext

`vitest.config.ts:186` setzte `coverage.include` auf `['packages/**/src/**/*.ts']`.
Damit lag alles unter `apps/` und `tools/` außerhalb jeder Messung — obwohl genau dort
die Schichten wohnen, die ein Ergebnis ansprechen und Daten importieren. Gemessen:

- `apps/web/src` waren 6 Dateien / 3 218 Zeilen (backend.ts 1338, server.ts 646,
  adapters.ts 138, vehicle-view.ts 235, dtc-knowledge-view.ts 200, paths.ts 54,
  analysis-input.ts 114) und **77 Tests** in `apps/web/test` — alle grün, keine Zeile
  davon in einer Coverage-Zahl. Nach der Ausweitung: `apps/web/src` 80,63 Statements /
  74,41 Zweige / 81,16 Funktionen / 82,76 Zeilen; schwächste Dateien `server.ts`
  66,18/65,53 (Zeilen 69,63) und `adapters.ts` 72/54,54 (Funktionen 60).
- `tools/**` analog unsichtbar: `definition-importer` 95,32/70,9, `simulators`
  92,05/82,03, `trace-analyzer` 94,52/75,25 — and the include pattern
  `tools/**/src/**/*.ts` **verfehlt `tools/test-reporters/flaky-reporter.ts`**
  (Zeilen 29-101), weil die Datei nicht unter `src/` liegt.
- Zwei Regeln, die das bisher verdeckt hat, waren damit nicht einhaltbar: 34.21
  (Messung vor Behauptung) für jede Aussage über die Web-Schicht, und ADR 0017
  (Gate nur mit Tests) — ein Gate, das eine Datei nicht sieht, kann dort nicht beißen.

Ein Finding, das die Ausweitung sofort zeigt: `flaky-reporter.ts` misst **0 %**. Es
hat keinen Test, weil nichts es ausführt — die gehärteten CI-Workflows, die es
auftreten ließen, sind nicht pushbar (E10). Die Zahl ist die Wahrheit über E10, nicht
über die Datei.

## Entscheidung

1. **`coverage.include` = `packages/**/src/**/*.ts`, `apps/web/src/**/*.ts`,
   `tools/**/*.ts`.** Für `tools` bewusst ohne `src/`-Segment, sonst bleibt
   `test-reporters/` unsichtbar — die Lücke, die dieser ADR schließt, dürfte nicht durch
   ein Musterfortsetzen neu entstehen.
2. **Spezifikationen bleiben in der Messung.** `**/*.spec.ts` wird *nicht* neu
   ausgenommen: eine Ausnahmeliste, die die Zahl hebt, während sie „besser gemessen"
   heißt, ist genau der in 0.E E16/E17 beschriebene Selbstbetrug.
3. **Die zwei bestehenden Ausnahmen werden generalisiert, nicht erweitert:**
   `packages/**/src/index.ts` → `**/src/index.ts` (Barrels re-exportieren nur) und
   `packages/**/src/**/types.ts` → `**/src/**/types.ts` (Typ-Only-Module haben keine
   ausführbare Zeile). Beide galten bisher nur für `packages/**` und hätten für
   `tools/simulators/src/index.ts` (Barrel, 0 %) und `apps/web/src`-Typdateien zu
   Scheinbefunden geführt. Der Grund ist derselbe — deshalb dieselbe Regel, nicht eine
   neue Ausnahme pro Paket.
4. **Bodenschwelle für die neue Fläche, nicht Zielwert:** `apps/web/src/**` per-file
   69 Zeilen / 54 Zweige, gemessen **ein** Punkt unter dem schwächsten Wert
   (`server.ts` 69,63 / `adapters.ts` 54,54). Ein Gate, das heute schon bei „Code
   verschieben" rot würde, wäre kein Messinstrument, und ein erfundener Zielwert
   (90/80) wäre eine Ansage ohne Boden. Dass es beißt, ist gemessen: auf 99/99 gestellt
   → `EXIT=1` mit `adapters.ts 54,54`, `analysis-input.ts 97,36`, `backend.ts 89,61`,
   `paths.ts 91,66` im Fehlertext; auf 69/54 → `EXIT=0`.
5. **`tools/**` wird gemessen und bekommt kein Gate.** Die 0 % von
   `flaky-reporter.ts` sind E10s Rückstand; eine Ausnahme für die Datei würde die Zahl
   heben und das Argument verlieren. Der Kommentar in `vitest.config.ts` nennt die
   gemessenen Werte je Tool-Datei, damit die Zahl bei einem neuen Diff nicht verschwindet.
6. **Die globalen Zahlen verändern sich — und das ist der Befund, nicht ein Fehler.**
   96,59 / 89,68 / 97,58 / 97,94 → **94,51 / 87,4 / 95,61 / 95,92**, weil zwei
   Schichten mitgezählt werden, die vorher nicht existierten. Die globalen Schwellen
   (90/80/90/90) bleiben eingehalten. Dokumentation, die die früheren Zahlen ohne
   diesen Satz weitergibt, wäre nach 34.24 ein Defekt.
7. **Was offen bleibt, steht im Backlog:** die zwei dünnen Dateien der Web-Schicht sind
   neuer Eintrag **E17** (nachtesten, dann Gate anheben — ADR 0017: erst Tests, dann
   Gate), `flaky-reporter.ts` bleibt Teil von E10.

## Konsequenzen

- Jede Datei der Workbench und der Tools kann jetzt ein roter Lauf sein. Ein `git mv`
  von Logik aus `backend.ts` nach `apps/web/public/app.js` (ein in 0.E genannter
  Nicht-Erfolg) würde die Zahl nicht mehr verbessern, sondern verschieben — und die
  Browser-Dateien bleiben außerhalb, weil sie von `tsc` mit `checkJs` und von den
  HTTP-Tests abgedeckt werden, nicht von v8.
- Die Messung braucht ihre Zeit: `npm run test:coverage` 30,65 s → 31,4 s, Suite bleibt
  1351 Tests / 91 Dateien grün, `npm run ci` unverändert das verbindliche Tor (ohne
  Coverage-Anteil, ADR 0016).
- `tools/simulators` trägt weiterhin die Test-Infrastruktur der halben Suite; seine
  94,9/82,0 sind jetzt sichtbar, wo sie als Importquelle von Tests zählen.
