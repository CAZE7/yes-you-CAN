# ADR 0028 — Die Architekturregel ist ein Werkzeug mit einer Quelle, keine Prosa mit einem Testanhängsel

- Status: akzeptiert (2026-09-14)
- Kontext: AGENTS 28 („Der Dependency Graph sollte eine harte Regel bekommen"), AGENTS 34.21 („Messung vor Behauptung"), Master-Backlog P0 #2 und P1 #22
- Betrifft: `tools/architecture/dependency-rules.json`, `tools/architecture/check-dependencies.mjs`, `tests/architecture/dependencies.test.ts`, `package.json` (`check:deps`, `ci`)

## Problem

Die Regel existierte, aber sie existierte **doppelt und an der falschen Stelle**: als
`ALLOWED_VDP_DEPS`-Literal in `tests/architecture/dependencies.test.ts` und als Prosa in
AGENTS 28. Wer sie änderte, musste beide lesen; wer sie verletzte, erfuhr es erst, wenn jemand
die Suite laufen ließ. Und sie war **nicht überall dieselbe Regel**, weil ein Test eine Regel
nicht ausführen kann, sondern nur Aussagen über sie treffen kann.

Der zweite Befund ist der schlimmere, weil er sich als grüner Test tarnt: Der Test prüfte
„protocols never import adapters" mit dem Präfix `@vdp/adapters`. Die Adapterpakete heißen aber
`@vdp/adapter-elm327`, `@vdp/adapter-host`, … — kein Paketname beginnt mit `@vdp/adapters`. Die
Regel konnte **nie feuern**. Dasselbe Präfix stand in der Portabilitätsliste für
`@vdp/domain`/`@vdp/application`. Ein Test, der eine Regel behauptet, die nichts fangen kann,
ist von einem Test ohne Regel nicht zu unterscheiden — und er sieht genauso grün aus.

## Entscheidung

1. **Die Regel ist eine Datei.** `tools/architecture/dependency-rules.json` enthält die Platzierung
   jedes Pakets (`mayImport` **und** `why`), die Node-Builtin-Ausnahmen, die UI-Regel, die
   Layer-Präfixregeln und die Portabilitätsregeln. Ein zweiter Ort für dieselben Kanten darf nicht
   entstehen; der Test prüft, dass das Werkzeug die Kanten nicht selbst mitschreibt.

2. **Die Regel ist ein Werkzeug.** `tools/architecture/check-dependencies.mjs` baut den echten
   Importgraphen (Workspace-Layout wie das Root-Manifest, `src/**/*.ts`, ohne Specs), wertet die
   JSON aus und endet mit Exit 1 bei jedem Verstoß. Es läuft als `npm run check:deps` **vor** dem
   Testlauf und ist damit Teil von `npm run ci`. Der Exit-Code ist dreiwertig: `0` sauber,
   `1` Verstoß, `2` Regeldatei unbrauchbar (`--root`, `--rules`, `--json`).

3. **Der Test bewacht das Werkzeug, statt es zu wiederholen.** Die Suite ruft
   `check-dependencies.mjs --json` auf und stellt Aussagen über dessen Ergebnis an: dass jedes
   Paket platziert ist, dass die Kanten stimmen, dass domain/application protocol-frei bleiben,
   dass DoIP keine Protokolle zieht — und dass das Werkzeug verdrahtet ist (`check:deps` in
   `npm run ci`).

4. **Eine Regel muss feuern können.** Das Werkzeug behandelt ein Präfix, das auf kein reales Paket
   passt, als eigenen Verstoß (`blind-prefix`). Genau dieser Check hätte den `@vdp/adapters`-Fehler
   am Tag seiner Entstehung gefunden. Zusätzlich verlangt jede Platzierung und jede Regel ein
   `why`; ein Tippfehler in einem Regelschlüssel ist ein Fehler, keine stille Nichtregel
   (`checkSchema`).

5. **Kein dependency-cruiser (Backlog #22 wird anders erfüllt).** dependency-cruiser brächte eine
   zweite Regel-DSL und eine Konfiguration, die die Allowlist erneut ausdrückt — dieselbe
   Duplizierung, die dieser ADR auflöst, nur mit einer Abhängigkeit mehr. Die hier gebrauchte
   Regel ist klein, projektspezifisch und in einer JSON vollständig beschrieben; ein Werkzeug von
   ~330 Zeilen, das der Architekturtest selbst gegen Fixture-Bäume fährt, ist dem Paket an dieser
   Stelle überlegen. Die Entscheidung ist der ESLint-Entscheidung aus ADR 0026 verwandt: **kein
   zweites Vokabular für dieselbe Frage.** Sobald eine Regel entsteht, die Datei-Ebenen,
   Zyklen über Laufzeitpfade oder Type-only-Kanten braucht, ist dependency-cruiser neu zu
   bewerten — dann mit diesem Text als Grundlage.

6. **Der Beweis, dass es beißt, ist Teil der Suite.** Zwei Fixture-Bäume unter `tmpdir()`:
   ein verbotener Import muss Exit 1 und beide Enden nennen, derselbe Import erlaubt muss Exit 0
   ergeben, ein Präfix ohne Treffer muss als `blind-prefix` gemeldet werden, eine kaputte
   Regeldatei muss Exit 2 ergeben. Ohne diesen Beleg wäre das Werkzeug nur eine weitere
   Behauptung.

## Konsequenzen

- Eine Regeländerung ist ein Diff in einer Datei; der Review sieht `mayImport` **und** `why`.
- Ein Verstoß wird rot, bevor jemand Tests liest (`npm run check:deps`, ~0,13 s über den Baum).
- Neue Pakete können nicht „zufällig" im Graphen landen: fehlende Platzierung ist ein Verstoß
  (`unplaced-package`), ein Eintrag ohne Paket ebenso (`stale-package`).
- Die Testsuite schrumpfte inhaltlich von „Regel + Behauptung" auf „Behauptung über das
  Werkzeug" und wuchs um die Belege, die vorher fehlten (Fixture-Negativfälle, Verdrahtung,
  blinde Präfixe).
- Preis: ein Werkzeug mehr im Baum, das gepflegt werden muss. Er ist klein, hat eine Quelle und
  wird von der Suite selbst gegen Fehlverhalten gefahren — die Alternative (zwei Orte für eine
  Regel) hat sich bereits als teurer erwiesen.
