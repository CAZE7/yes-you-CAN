# 0026 — Guardrails, die beißen: Fehler statt Warnungen, Entscheidungen auf dem Rekord, Gates im Testlauf

Status: accepted · Datum: 2026-09-14 · Bezug: ADR 0016 §1, ADR 0015, ADR 0017, AGENTS 34.19, 34.21, 34.24, 35; Backlog 0.E E10/E20

## Kontext

Die Infrastruktur ist vorhanden: Biome, striktes TypeScript, Architekturtests,
GitHub-CI auf Node 22 und 24, CODEOWNERS, Dependabot, 1300 Tests. Das ist nicht
das Problem. Zwei Dinge sind es — beide am 2026-09-14 gemessen:

1. **Regeln, die nicht gaten.** `biome check` schlägt bei `error` fehl, nicht bei
   `warn`. Die vier Regeln, die dieses Repository als *wichtig* benennt —
   `noUnusedVariables`, `noUnusedImports`, `noExplicitAny`, `noNonNullAssertion`
   — standen auf `warn`, ebenso `noUnnecessaryContinue`. Sieben weitere Regeln
   standen auf `off`, **ohne dass irgendwo stand, worauf sich diese Entscheidung
   stützt**: eine Abschaltung ohne Grund ist von einem Zufall nicht zu
   unterscheiden, und der nächste, der sie einschaltet, weiß nicht, was er
   auslöst. Gemessen: dieselben vier Regeln als `error` erzeugen **0 Fundstellen**
   in 298 Dateien — die Härte war kostenlos, sie war nur nicht beschlossen.
2. **Gates, die niemand ausführt.** `ci.yml` fuhr `npm ci` → `npm run build` →
   `npm test`. `npm run ci` (build · typecheck · check · test) existierte, aber
   kein Workflow rief es auf: **Biome und beide `--noEmit`-Pässe liefen in der CI
   nie**. Ein Spec mit Typfehler oder ein Verstoß gegen die Formatregeln konnte
   grün mergen, weil `tsc -b` Specs und `apps/web/public/*.js` nicht prüft. Die
   Workflow-Dateien sind mit der aktuellen GitHub-App-Installation nicht
   änderbar (gemessen 2026-09-14, `git push`: `refusing to allow a GitHub App to
   create or update workflow .github/workflows/ci.yml without 'workflows'
   permission`; E10). Dieses ADR löst die Hälfte, die ohne diese Berechtigung
   lösbar ist, und benennt die andere.

Der Leitsatz, den dieses ADR festschreibt: **das Problem ist nicht zu wenig
Linter, sondern zu weiche Regeln** — und Hardening, das niemand ausführt, ist
Dokumentation, kein Gate.

## Entscheidung

### 1. Ein Linter, und der ist scharf (kein ESLint, keine zweite Regelwelt)

Biome bleibt der einzige Linter; ESLint daneben wäre ein zweites Vokabular für
dieselbe Frage. Die vier genannten Regeln plus `noUnnecessaryContinue` sind
`error` (0 Fundstellen außerhalb von Tests, gemessen 2026-09-14, 298 Dateien).
Zusätzlich wurden drei Regeln von `off` auf `error` gehoben, weil sie **echte
Fundstellen** hatten:

| Regel | Fundstellen | davon Produktion | Konsequenz |
|---|---|---|---|
| `noImplicitAnyLet` | 1 | `doip/transport.ts:253` (`let header;`) | Typ annotiert (`DoipHeader`) |
| `noShadowRestrictedNames` | 2 | `reports/report.ts:273` (`escape`) | Helfer heißt jetzt `escapeHtml` — der deprecated Global `escape` war ohnehin kein Name für HTML-Escaping; die Testfundstelle ebenso umbenannt |
| `noUnusedTemplateLiteral` | 2 | `definitions/resolve.ts:388,392` | Template ohne Interpolation → String |

Drei Regeln, die vorher **global** `off` waren, sind jetzt `error` und nur für
Testquellen abgeschaltet (`noDelete`, `noAssignInExpressions`, `useConst`), und
`noConsoleLog` ist `error` außer für `scripts/**` und
`packages/shared/src/logger.ts` — die Datei, die die Konsole *ist*
(`ConsoleSink`). Damit gilt: **Produktionscode hat keinen Ausnahmepfad**, jede
Lockerung ist auf einen nicht-produktiven Bereich verengt und benannt.

### 2. Jede nicht-`error`-Regel trägt ihren Grund, und tote Gründe fallen auf

`tests/architecture/guardrails.test.ts` liest `biome.json` und verlangt für jede
explizit konfigurierte Regel: `error` — oder eine Zeile in `JUSTIFIED_RULES` mit
Umfang **und** dem Befund, der sie offen hält. Vier Regeln bleiben global `off`,
jede mit Messung:

- `useExhaustiveDependencies` — es gibt keine Hooks; die Workbench ist Vanilla-ESM über dem DOM (ADR 0006).
- `noControlCharactersInRegex` — slcan-Rahmen *enthalten* Steuerzeichen (BEL U+0007 wird vor dem Parsen entfernt).
- `useTemplate` — 18 Fundstellen in 7 Dateien: lange Fachtexte werden mit `+` umbrochen, um im 100-Zeichen-Budget zu bleiben; Biome nennt den Fix selbst *unsafe*.
- `useLiteralKeys` — 37 Fundstellen in 10 Dateien: `record["key"]` auf ungeprüftem `Record<string, unknown>` hält die Grenze sichtbar.
- `noForEach` — 2 Fundstellen, reine Stilmeinung.

Der Test verbietet außerdem **Override-Blöcke außerhalb von Test-Quellen und
benannten Nicht-Produktionsdateien** und schlägt fehl, wenn ein Grund stehen
bleibt, obwohl die Konfiguration ihn nicht mehr macht: Begründungen, die ihren
Befund überleben, sind stillgelegte Ausnahmen.

### 3. Strictness wird geerbt; jede Abschwächung steht mit Messung auf dem Rekord

`strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`,
`verbatimModuleSyntax` und `forceConsistentCasingInFileNames` sind in
`tsconfig.base.json` **true** und dürfen von keinem Workspace-Projekt
zurückgenommen werden (Test). Nicht-strikte Flags sind nur über `RELAXED_FLAGS`
zulässig, jeweils mit Zahl:

| Datei | Flag | Befund am 2026-09-14 |
|---|---|---|
| `tsconfig.base.json` | `exactOptionalPropertyTypes: false` | 27 Fehler in 13 Produktionsdateien (Build) + 61 im Typecheck-Projekt = **88**, konzentriert in den Parsern, die optionale Felder kopieren (`json.ts`, `mappers.ts`). Das ist eine semantische Arbeit an der Roh→dekodiert-Grenze (ADR 0004), kein Konfigurationsschalter → 0.E **E18** |
| `tsconfig.frontend.json` | `noImplicitAny: false` | **110** Fehler in 4 Dateien (104 × TS7006) in `apps/web/public/*.js` ohne JSDoc-Typen; die Frontend-Schicht ist Rendering über typisierten View-Projektionen (Roadmap-Schritt 9) → 0.E **E19** |

### 4. Die Gates laufen im Testlauf — heute, ohne Workflow-Recht

`npm test` ist der Träger: der `architecture`-Projektlauf führt `biome check .`,
`tsc --noEmit -p tsconfig.typecheck.json` und `tsc --noEmit -p
tsconfig.frontend.json` selbst aus und schlägt mit deren Ausgabe fehl. Damit
erzwingt die CI genau die Gates, die `npm run ci` deklariert, ohne dass ein
Workflow geändert werden muss. Gemessen auf warmem Baum: **0,82 s + 0,83 s +
0,31 s ≈ 2 s** auf einen ~22-s-Lauf; `npm run test:unit` bleibt unberührt, weil
das Projekt dort nicht läuft. Ein Test pinnt außerdem, dass `ci.yml` weiterhin
`npm ci`, `npm test` und die Matrix `[22, 24]` fährt — wer `npm test` aus dem
Workflow entfernt, entfernt sonst still die Gates.

`npm run ci` bleibt das lokale Tor; sobald die `workflows`-Berechtigung da ist
(E10), gehört der Quality-Job direkt in den Workflow, und dieser Test darf
zurückgebaut werden. Für die Coverage-Gates gilt dasselbe Muster seit 2026-09-16 —
aber als eigener Punkt, weil sie nicht kostenlos sind: §6.

> **Nachtrag 2026-09-24 — dieser Punkt ist erledigt, aber nicht so, wie er hier
> steht.** Der Quality-Job existiert inzwischen wirklich: `ci.yml` führt `build`,
> `typecheck:all`, `check`, `check:deps`, `check:manifests` und `npm audit` in
> einem eigenen Job vor der Test-Matrix. Der Zweitträger, der Biome und beide
> `--noEmit`-Pässe ein zweites Mal in der Suite ausführte, war damit Doppelung
> und ist **auf eine Selbstbeschreibung zurückgebaut**: `guardrails.test.ts` liest
> den Workflow-Text und fällt, wenn eines der Tore seinen Träger verliert. Die
> Berechtigung selbst ist weiterhin **nicht** da — die Dateien stehen vom Inhaber
> auf `main` (`f6abf86`), nicht von der App. Details in
> [E20](../architecture/backlog.md) und [ADR 0059](0059-the-contract-is-readable-again.md).

### 5. Keine Build-Orchestrierung auf Vorrat (kein Turborepo, kein Nx)

`tsc -b` über 25 Projekte, Biome unter einer Sekunde, Suite ~22 s: es gibt
keinen gemessenen Flaschenhals. Turborepo/Nx würde eine Caching-Schicht mit
eigener Invalidierungslogik einführen — genau die Fehlerklasse, gegen die dieses
Repository gated —, um ein Problem zu lösen, das noch nicht existiert. Der
Architekturtest schlägt fehl, sobald ein Orchestrator als Abhängigkeit, als
Konfigurationsdatei oder in einem Skript auftaucht; die Entscheidung muss dann
bewusst neu getroffen werden.

### 6. Der Coverage-Gate bekommt denselben Träger — CI-only, weil er die Suite doppelt

§4 gilt für Tore, die nichts kosten (Biome und zwei `tsc`-Durchläufe ≈ 2 s). Die
Coverage-Schwellen aus ADR 0027/0028 waren davon ausgenommen: `npm test` läuft ohne
`--coverage`, kein Workflow führt `npm run test:coverage` aus, und `ci.yml` ist mit
dieser App nicht schreibbar — zum dritten Mal gemessen 2026-09-16, wortgleich zu E10:
`refusing to allow a GitHub App to create or update workflow
'.github/workflows/ci.yml' without 'workflows' permission'`. Ein Schwellwert, den
niemand ausführt, ist ein Wunschzettel in der Konfiguration: weder ein Sinken der
Coverage noch ein Absenken des Bodens fällt auf.

Neu: `tests/architecture/coverage-gate.test.ts`. Nur unter `CI`, und das Kind ist
wörtlich `npm run test:coverage`, damit Tor und Kommando nicht zwei Definitionen
derselben Zahl werden. Vier Einbauten, die erst der Lauf gezeigt hat: Rekursionssperre
`VDP_COVERAGE_CHILD=1` (`test:coverage` fährt das Projekt `architecture` und damit
diesen Test selbst); `VITEST_JUNIT_FILE` wird dem Kind genommen (zwei Schreiber an
einer CI-Artefaktdatei sind schlechter als keine); `retry: 0` gegen den CI-Default
zwei, weil ein Retry hier keine neu versuchte Behauptung ist, sondern eine zweite
volle Suite — gemessen dreimal dieselbe Threshold-Meldung und 203 s statt 65 s; und
eine `::notice` pro Zweig (derselbe Kanal, den `tools/test-reporters/flaky-reporter.ts`
nutzt), weil die Job-Logs mit diesen Zugangsdaten nicht abrufbar sind. Ein Tor, das
nichts berichtet, ist von einem Tor, das nicht lief, nicht zu unterscheiden.

Was diese Zeile wert war, ist die zweite Hälfte der Geschichte: der erste Anlauf maß
40 s pro Bein, und das las sich als „das Kind läuft hier nie". Die Annotations
antworteten in einem Lesegang — `mode=armed (CI=true)`, dann `mode=measured` mit
28 bis 36 s pro Bein. Sechs Messläufe später sind es vierzehn Werte, zwei pro Kopf, alle
Beine `success`: 27,6 / 28,1 / 28,2 / 28,7 / 32,0 / 34,3 / 35,0 / 35,0 / 35,1 / 35,2 / 35,5 /
35,8 / 36,3 / 38,0 s. Die untere Kante liegt seither unverändert, die obere ist auf 38,0 s
gerutscht — am Kopf 0c17922, dem mit der größten Suite und der angehobenen
`apps/web/src`-Schwelle (1.36); ob das der Grund ist, ist nicht gemessen, gemessen ist die
Folge: **eine Spanne, die über Köpfe hinweg gebildet wird, muss mit den Köpfen wachsen**,
sonst steht am Ende eine bequeme Zahl, die keine Messung mehr ist. Welches Bein oben liegt, wechselt:
Node 22 führte drei Runden, in der vierten lag Node 24 vorn (36,3 s gegen 35,1 s), in der
fünften wieder Node 22 (28,7 s gegen 28,2 s) — ein Muster aus drei Stichproben war eine
Überziehung, und die fünfte Runde erledigt auch die zweite Vermutung: die
94,68/86,59/96,02-Stufe war *vier Läufe lang* die von Node 22; an diesem Kopf meldet
Node 22 94,77 / 86,71 / 96,05 und Node 24 94,71 / 86,63 / 96,03, die Stufen sind also
über die Beine gewandert — und am Kopf 0c17922 ist es wieder umgekehrt (Node 22
95,06 / 87,03 / 96,33 gegen Node 24 95,00 / 86,94 / 96,31, dieselbe Tabelle bis auf die
Wanderung der letzten Stelle). Zwei Effekte, und keiner ist eine
Konstante. Die Runner sind schneller als die Entwicklungssandbox, die
für dieselbe Kind-Suite 66 s braucht; die Kosten, die gegen
`npm run ci` sprechen, sind also maschinenabhängig und stehen mit beiden Zahlen da.

**Nachtrag am Kopf `c419100` (1.37): der Selbstbericht war nicht zu lesen, und deshalb
steht hier eine andere Zahl.** Die 14 Werte oben sind die Sekunden, die
`coverage-gate.test.ts` über `::notice` meldet; diese Runde war weder der Log
verfügbar (`gh run view --log --job 104677105260` → `failed to get run log: Get
"https://results-receiver.actions.githubusercontent.com/…"`) noch die Annotation
(`check-runs/<id>/annotations` leer) — der Kanal des Selbstberichts ist die Log-Datei,
und die ist von hier nicht abrufbar. Erreichbar war die Steps-Zeit der Jobs
(`actions/jobs/<id>`, `started_at`/`completed_at`): der Schritt „Run the full test
suite" — `npm test`, und in ihm der Träger-Kindlauf — brauchte 41 s auf beiden Beinen
(Node 22 05:28:52→05:29:33, Node 24 05:28:57→05:29:38), der ganze Job 57 s bzw. 56 s.
Diese Zahl wird **nicht** in die Liste der 14 aufgenommen: ein Schritt und ein
Selbstbericht sind zwei verschiedene Größen, und eine Spanne mit einem
nicht vergleichbaren Wert fortzuschreiben wäre genau die Bequemlichkeit, die der
Abschnitt sonst einfordert. Was sie trägt: beide Beine grün mit der angehobenen
`apps/web/src`-Schwelle 76/72, also gilt der neue Boden auch auf der Runner-Maschine
und nicht nur im ruhigen Lokal-Lauf.

Zweiter Kopf mit derselben Einschränkung (1.38, `6ef2ba1`): beide Beine grün,
Testschritt 42 s auf beiden Beinen (gegen 41 s / 41 s am Kopf `56c0a98`) — dass die
beiden Beine hier gleichauf liegen, ist ein Wertepaar, kein Muster: über die 14
Trägersekunden oben wechselt die Führung weiter. Der neue Boden 76/72 gilt damit auch
auf diesem Kopf, und die ausgezogene Grammatikdatei (`route-input.ts`, 100/100/100/100)
ist dort genauso gemessen wie lokal.
Der Selbstbericht war auch diesmal nicht zu lesen, aus einem etwas anderen Grund als
oben notiert: `actions/jobs/<id>/logs` löst inzwischen auf einen signierten Blob auf,
und der Abruf endet mit `EOF`; `annotation_count` desselben Jobs ist leer.

Dritter Befund aus demselben Vergleich: der Ist-Wert atmet. 94,74 / 86,66 / 96,09 /
96,04 lokal im ruhigen Lauf, 86,67 Zweige unter Last, und auf dem Node-22-Bein
94,68 / 86,59 / 96,02 gegen 94,74 / 86,66 / 96,04 auf Node 24 — derselbe Commit.
Ursache ist ein einzelner Zweig in `tools/simulators/src/chaos-lab.ts` (der
Realtime-`sleep`-Fallback, Zeile 58: in Unit-Läufen bewusst nie erwartet, bei Last
dann und wann doch, 91,66 ↔ 93,33 Zweige dieser Datei). Die Lastverschiebung ist
innerhalb eines Beamts messbar (Node 24 meldete auf demselben Commit 86,66 dreimal und
86,67 einmal); der Abstand *zwischen* den Nodes (86,59/86,60 Zweige, 94,68 Statements,
96,02 Zeilen auf Node 22 gegen 94,74 / 96,04 auf Node 24, in allen vier Läufen) war ein
zweiter Effekt — im fünften Lauf ist er umgekehrt (94,77 / 96,05 auf Node 22 gegen 94,71 /
96,03 auf Node 24, Kopf 391f04f), also ist auch er ein Momentwert und keine
Laufwerkseigenschaft. Die Spanne über alle fünf Runden: Statements 94,68–94,77, Zweige
86,59–86,71, Zeilen 96,02–96,05. Der nächste Push (nur Doku, kein Code) trennt die beiden
Erklärungen sauber: Node 24 meldete auf demselben Stand *exakt* dieselbe Tabelle
(94,71 / 86,63 / 96,03), Node 22 wackelte um 0,02 Zweige (86,71 → 86,69) — dasselbe
Messobjekt, ein Bein reproduzierbar, das andere von seiner Auslastung abhängig. Die
Träger-Dauer blieb in beiden Fällen in der Spanne (32,0 s und 35,2 s). Beides
verschiebt keinen Boden — die Böden bleiben 80/90. Wer eine Coverage-Zahl in die
Dokumentation schreibt, schreibt einen Momentwert hin; die Tore bleiben Böden mit
Abstand (80 Zweige, 90 Zeilen) und werden keine Zusicherung auf die letzte Kommastelle.

Biss gemessen: `lines` auf 99 gehoben (Ist 96,04) → genau dieser Test fällt als
einziger seines Projekts, mit der Meldung des Kindes im Text. Bewusst **nicht** in
`npm run ci` aufgenommen, weil das lokal eine halbe Suite obendrauf in der Schleife
vor jedem Push wäre; `npm run test:coverage` bleibt der eigene Weg, der Testlauf ist
der CI-Weg.

## Konsequenzen

- **Sofort schärfer:** 5 Regeln `warn`/`off` → `error` ohne eine Zeile
  Produktionsänderung; 5 weitere Fundstellen behoben (3 Regeln neu `error`).
  Produktionscode kennt keine Regel-Ausnahmen mehr.
- **Sichtbar statt still:** jede `off`-Entscheidung hat Ort, Umfang und Zahl. Der
  Guardrail-Test ist der Grund, warum die nächste Abschwächung nicht mehr
  unbemerkt passieren kann — und er hat beim Schreiben sofort zwei Format- und
  eine `noUnusedTemplateLiteral`-Verletzung in seinem eigenen PR gefunden.
- **Was offen bleibt:** E10 (Workflow-Recht — die Dateien liegen, das Recht
  weiterhin nicht), E20 (Workflow führt `npm run test:coverage` nicht als
  eigenen Schritt), E18/E19 (die zwei gemessenen Strictness-Lücken), E11/E16
  (Dateien knapp über ihren Coverage-Gates). **Nachtrag 2026-09-24:** §4 und §6
  stehen oben; der §4-Träger ist zurückgebaut, der §6-Träger bleibt, weil ein
  Artefakt-Upload mit `if: always()` kein Tor ist.
- **Was ausdrücklich nicht passiert:** keine zusätzliche Tooling-Ebene
  (ESLint, Orchestrator, weitere Scanner) ohne Befund. Reihenfolge bleibt:
  bestehende Architektur → härtere Guardrails → reale Fahrzeugdaten →
  reproduzierbare Diagnosefälle (`docs/architecture/master-backlog.md`).
