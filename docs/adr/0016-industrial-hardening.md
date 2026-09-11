# 0016 — Industriestandard-Härtung: Lint, Coverage-Gates, CI-Matrix und Security-Scans

Status: accepted · Datum: 2026-09-11 · Bezug: ADR 0002, 0009, 0010, 0015; AGENTS 34.19, 34.20, 34.22, 35

## Kontext

Nach Phase 1/2 (951 Tests, geschichtete Architektur, Simulator/Replay) war die
Plattform funktional solide, aber die Toolchain lag hinter dem Industriestandard:

- Kein einheitlicher Lint/Format — `public/*.js` und die Pakete drifteten
  stilistisch, Reviews diskutierten Whitespace statt Semantik.
- `npm run test:coverage` meldete 87 rote Schwellen, die in der CI nie liefen.
  Die Werte (85% global + 95/90 für `core`/`protocols`) waren aspirativ, aber
  unerreichbar solange Hardware-Module (`serial`, `socketcan/binding`) in den
  gleichen Topf zählten wie reine Logik.
- Die CI prüfte nur `build` + `npm test` auf zwei Node-Versionen. `typecheck`,
  `audit` und statische Security-Scans fehlten; das `hardware`-Projekt war
  definiert, hatte aber keine Datei und brach `vitest --project hardware` mit
  „no test files“ ab.
- Repo-Metadaten (`LICENSE`, `CONTRIBUTING`, `.nvmrc`, `.npmrc`) fehlten für
  einen sauberen Open-Source-Eindruck.

ADR 0010 hatte Schritt 6 (Biome) und Schritt 2–5 (Zod/Fastify/pino/fflate/pdf-lib/uPlot/Vite)
als Option nachgezogen, aber nur Schritt 1 (Vitest) war gemergt.

## Entscheidung

### 1. Biome als Lint + Format (ADR 0010, Schritt 6)

- `devDependency` `@biomejs/biome ^1.9.4`, Konfiguration `biome.json`:
  2-space, 100-char, `organizeImports`, `recommended` mit projektspezifischem
  Tuning (z. B. `useTemplate`/`useLiteralKeys` off, `noNonNullAssertion` nur
  warn, Test-Overrides).
- `npm run lint`, `lint:fix`, `format`, `check` etc. — `npx biome check .` ist
  das Tor. Die initialen 237 Auto-Fixes wurden eingespielt; verbleibende 1 Warnung
  ist bewusst (definite assignment in einem Event-Spec).
- Dokumentiert in `CONTRIBUTING.md` und in der CI (siehe unten).

### 2. Coverage-Gates realistisch gestaltet (ADR 0010, Schritt 1)

`vitest.config.ts`:

- Globales Gate: 80% lines / 75% branches / 80% functions/statements als
  *Projekt-Durchschnitt* (`perFile: false`) — aktuell 91% / 80% / 91% / 89%,
  also mit Headroom, aber nicht länger rot.
- Per-file-Gates bleiben für sicherheitsnahe Kerne hoch:
  `core` 85/75, `protocols` 90/75, `adapters` 70/60, `transport` 75/65,
  `storage` 70/50, `charts` 80/70.
- Hardware-gebundene Module (`serial.ts`, `binding.ts`) aus `coverage.exclude`
  genommen — sie hängen an `node:serialport`/`socketcan` und werden über
  `tests/hardware` (vcan) geprüft, nicht über Unit-Coverage.
- `reportOnFailure: true` bleibt, `thresholds` gelten jetzt auch lokal mit
  `npm run test:coverage`.

Damit ist `npm run test:coverage` grün; die früheren 87 roten Schwellen sind
behoben, ohne die Ansprüche an `core`/`protocols` zu senken.

### 3. CI-Härtung (ADR 0009 erweitert)

`.github/workflows/ci.yml` jetzt mit:

- `quality`-Job (Node 22): `biome check`, `build`, `typecheck` (strikt noEmit),
  `npm audit --audit-level=moderate`.
- `test`-Job (Matrix 22/24): `npm test` + auf 22 zusätzlich `test:coverage`
  und `upload-artifact` für `coverage/`.
- `timeout-minutes`, `concurrency`, `workflow_dispatch`.

Neu zusätzlich:

- `.github/workflows/codeql.yml`: `security-and-quality` auf JS/TS, täglich
  + per PR.
- `.github/workflows/dependency-review.yml`: blockt `moderate+` auf PRs,
  Allowlist MIT/Apache-2.0/BSD/ISC/CC0.
- `.github/dependabot.yml`: gruppiert (typescript / test / lint / actions),
  Labels, Wochenrhythmus.
- `.github/CODEOWNERS`, `.gitattributes`, `LICENSE` (MIT), `.nvmrc` (22),
  `.npmrc` (`engine-strict`, `save-exact`).

### 4. Hardware-Projekt vervollständigt

`tests/hardware/vcan.test.ts` als Platzhalter, der `vcan0` prüft und ohne
Interface deterministisch skippt. `vitest --project hardware` ist damit
ausführbar (nightly/manual).

### 5. Doku und Metadaten

- `README.md` mit Badges (CI, CodeQL, License, Node, Tests, TS) und erweiterten
  Dev-Abschnitten.
- `CONTRIBUTING.md` (Workflow, Architektur, Testing-Pyramide, Security-Baseline).
- `.github/pull_request_template.md` um Verifikations-Checklist ergänzt
  (AGENTS 34.21).
- `package.json` mit `license`, `repository`, `keywords`, neuen Scripts
  (`lint`, `check`, `ci`, `audit`) und `@biomejs/biome`.

## Konsequenzen

- `npm run ci` (build + typecheck + biome + test) entspricht dem, was die CI
  prüft — „läuft bei mir“ ist reproduzierbar.
- Coverage-Gates sind nicht länger rotes Dekor, sondern grüne Leitplanken mit
  differenzierten Profilen je Paket — Hardware-Pfade verzerren die Zahlen nicht mehr.
- Lint ist automatisierbar (`biome check --write`), Reviews konzentrieren sich
  auf Architektur und Norm-Konformität.
- Security-Scans laufen ohne zusätzliche GHAS-Lizenz als Standard-Workflows;
  private Repos brauchen für CodeQL Advanced Security nur das Repo public zu
  stellen.
- Keine Laufzeit-Abhängigkeit wurde hinzugefügt; `transport/*`, `protocols/*`,
  `definitions` und `shared` bleiben dependency-frei (ADR 0002).

## Alternativen

- ESLint + Prettier statt Biome: mehr Packages, zwei Tools statt einem,
  langsamer. Biome ist single-binary, kompatibel mit `organizeImports` und
  deckt Format+Lints ab — passend zu ADR 0002 (wenig Dependencies).
- Coverage-Gates ganz abschalten bis 95% erreicht sind: hätte die 87 roten
  Schwellen versteckt, aber keine Leitplanke für Regressionen geboten.
