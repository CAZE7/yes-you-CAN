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
zurückgebaut werden.

### 5. Keine Build-Orchestrierung auf Vorrat (kein Turborepo, kein Nx)

`tsc -b` über 25 Projekte, Biome unter einer Sekunde, Suite ~22 s: es gibt
keinen gemessenen Flaschenhals. Turborepo/Nx würde eine Caching-Schicht mit
eigener Invalidierungslogik einführen — genau die Fehlerklasse, gegen die dieses
Repository gated —, um ein Problem zu lösen, das noch nicht existiert. Der
Architekturtest schlägt fehl, sobald ein Orchestrator als Abhängigkeit, als
Konfigurationsdatei oder in einem Skript auftaucht; die Entscheidung muss dann
bewusst neu getroffen werden.

## Konsequenzen

- **Sofort schärfer:** 5 Regeln `warn`/`off` → `error` ohne eine Zeile
  Produktionsänderung; 5 weitere Fundstellen behoben (3 Regeln neu `error`).
  Produktionscode kennt keine Regel-Ausnahmen mehr.
- **Sichtbar statt still:** jede `off`-Entscheidung hat Ort, Umfang und Zahl. Der
  Guardrail-Test ist der Grund, warum die nächste Abschwächung nicht mehr
  unbemerkt passieren kann — und er hat beim Schreiben sofort zwei Format- und
  eine `noUnusedTemplateLiteral`-Verletzung in seinem eigenen PR gefunden.
- **Was offen bleibt:** E10 (Workflow-Recht), E20 (Workflow führt `npm test`,
  nicht `npm run ci` — durch §4 heute gleichwertig, aber die Gleichwertigkeit
  hängt an einem Test), E18/E19 (die zwei gemessenen Strictness-Lücken), E11/E16
  (Dateien knapp über ihren Coverage-Gates).
- **Was ausdrücklich nicht passiert:** keine zusätzliche Tooling-Ebene
  (ESLint, Orchestrator, weitere Scanner) ohne Befund. Reihenfolge bleibt:
  bestehende Architektur → härtere Guardrails → reale Fahrzeugdaten →
  reproduzierbare Diagnosefälle (`docs/architecture/master-backlog.md`).
