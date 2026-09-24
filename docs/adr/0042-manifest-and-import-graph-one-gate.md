# ADR 42 — `package.json` ist eine Behauptung über Importe; ein Werkzeug prüft sie

- Status: akzeptiert (2026-09-15)
- Kontext: AGENTS 34.20 (Dependency-Disziplin nach ADR 0010), ADR 0031 (Architekturregel als Werkzeug mit einer Quelle), ADR 0015 (Struktur ist ein Test), Master-Backlog P0 #2 (Nachbarfrage)
- Betrifft: `tools/architecture/check-package-manifests.mjs` (neu), `package.json` und `tsconfig.json` von acht Paketen, `tests/architecture/manifests.test.ts`

## Problem

`check-dependencies.mjs` (ADR 0031) beantwortet: *darf* Paket A Paket B importieren.
Offen blieb die andere Hälfte: **weiß das Manifest davon?** In einem gehosteten Workspace
ist die Frage unsichtbar, weil npm alles in den Root-`node_modules` legt. Die Suite war grün
mit folgenden Abweichungen (gemessen mit einem Erste-Schnitt-Scanner über
`src/**/*.ts`, Prod/Test getrennt):

| Befund | Paket | Warum es trotzdem lief |
|---|---|---|
| Produktionsimport, nicht deklariert | `@vdp/web` → `@vdp/diagnostic-ir` (`analysis-input.ts`) | Hoisting |
| Produktionsimport, nicht deklariert | `@vdp/ai` → `@vdp/diagnostic-ir` (`heuristic.ts`, `types.ts`) | Hoisting |
| Produktionsimport, nicht deklariert | `@vdp/reports` → `@vdp/diagnostic-ir` (`report.ts`) | Hoisting |
| Produktionsimport, nicht deklariert | `@vdp/trace-analyzer` → `@vdp/transport-can` (`index.ts`) | Hoisting |
| Deklariert, von nichts importiert | `@vdp/ai` → `@vdp/core` | tote Kante im Graph |
| Deklariert, von nichts importiert | `@vdp/diagnostic-ir` → `@vdp/shared` | dito |
| Deklariert, von nichts importiert | `@vdp/protocols-oem` → `@vdp/shared`, `@vdp/protocols-uds` | die Schichtregel sagt `mayImport: []` — das Manifest widersprach ihr |
| Deklariert, von nichts importiert | `@vdp/reports` → `@vdp/shared` | dito |
| Deklariert, von nichts importiert | `@vdp/trace-analyzer` → `@vdp/core`, `@vdp/transport-iso-tp` | dito |
| Nur Tests importieren es, production deklariert | `@vdp/transport-doip` → `@vdp/protocols-uds` | `dependencies` statt `devDependencies` |

Vier falsche „fehlende" Kanten, sechs falsche „vorhandene". Für `npm audit`, Renovate,
einen License-Scanner und GitHub's Dependency-Graph sind das Aussagen über ein Paket, die
nicht stimmen — und für jeden, der ein Paket aus dem Workspace lösen wollte (ADR 0010
Schritt 7, Publish-Frage), bricht der Import ohne Deklaration, bzw. der Build zieht ein
Paket nach, das niemand braucht.

Zwei Fallen für jeden Checker, der aus diesem Fund einen Guard baut:

- `apps/web` serviert `@vdp/charts` durch
  `createRequire(import.meta.url).resolve("@vdp/charts")` — keine `from`-Klausel, aber eine
  tragende Kante. Ein reiner Import-Leser verlangt ihre **Entfernung**.
- Prosa ist voll von Import-ähnlichen Zeichenketten. Ein erster Entwurf meldete
  `@vdp/simulators` importiere ein Paket namens `misfire`, weil ein Kommentarsatz
  „… says \"no start\" from \"misfire\" …" enthielt. Ein Checker, der Erfindungen meldet,
  wird übersehen; einer, der sie überieht, ist kein Tor.

## Entscheidung

1. **Ein zweites Werkzeug, dieselbe Form** (ADR 0031): `tools/architecture/check-package-manifests.mjs`,
  `npm run check:manifests`, Exit 0/1/2, `--json` für Tests. Es **liest** den Workspace, es
  wiederholt keine Schichtregel — geprüft durch einen Test, dass die Datei kein `mayImport`
  und keine Allow-Liste enthält.
2. **Vier Regeln, eine pro Richtung der Abweichung**:
   `missing-production-dependency`, `unused-production-dependency`, `test-only-dependency`,
   `dep-version-drift`/`unknown-workspace-dependency` (`@vdp/*`-Ranges sind Lockstep, sonst
   ist die Zahl eine Lüge).
3. **Produktionsfläche ist, was das Manifest bindet** — `src/**` ohne `*.spec.ts`/
   `*.test.ts`, plus `test|tests/` desselben Pakets als Testquelle. Test-Quellen müssen
   Workspace-Pakete **nicht** deklarieren: npm verlinkt sie alle, und eine devDependency auf
   den halben Workspace sagt nichts. Was ein Test braucht und `dependencies` steht, ist
   aber eine falsche Aussage über die Produktionsfläche → `test-only-dependency`.
4. **Anker statt Heuristik beim Lesen**: jedes Specifier-Muster ist an eine Zeilenposition
   gekettet (Kommentar-Sterne stehen im Weg) oder an das schließende Klammerpaar eines
   Calls; `resolve("@vdp/…")` zählt mit. Prosa kann damit nicht mehr als Import gelesen
   werden — positiv wie negativ getestet.
5. **Das Root-Manifest ist ausgenommen, und das ist eine Entscheidung:**
   `typescript` wird als `tsc` aufgerufen, `@vitest/coverage-v8` von vitest aus
   `coverage.provider` geladen, `@types/*` von TypeScript selbst aufgelöst. Ein
   Namensabgleich würde alle drei melden und nie recht haben. Geprüft wird am Root nur,
   dass es **keine** `dependencies` trägt (der Root ist Tooling, kein Shipping-Paket).
6. **Tsconfig-Referenzen mitziehen**: `apps/web`/`ai`/`reports`/`trace-analyzer`/`oem`/
   `diagnostic-ir`/`transport-doip` — Referenzen sind Build-Reihenfolge und würden nach
   einer Manifestkorrektur eine Kante behaupten, die es nicht mehr gibt.
7. **Das Tor ist `npm run ci`** (nicht `ci.yml`; [AGENTS 0.E](../architecture/backlog.md) E10/E20: Workflow-Dateien sind
   mit der aktuellen App nicht schreibbar), und der `architecture`-Testlauf führt das
   Werkzeug aus wie die anderen Gates auch (Muster ADR 0029): pinned wiring + grüner Lauf auf
   diesem Baum + sieben Fixtures, die beweisen, dass es beißt — inklusive der beiden
   Negativfassaden „resolve zählt" und „Prosa zählt nicht".

## Messprotokoll dieses Laufs

- Vorher: `12 manifest violation(s)` auf diesem Baum (Liste oben, nach Regel sortiert).
- Nachher: `manifest rule: 27 packages checked, imports and package.json agree.` (EXIT 0).
- `npm ci && npm run build && npm run typecheck && npm run check && npm run check:deps &&
  npm run check:manifests && npm test` → EXIT 0, 1901 Tests in 128 Dateien (vorher 1802 in
  124), Suite ~38 s.
- Stand des PR-Kopfs (Szenario-Linie und die Spec für `chaos-lab`/`vehicle-state` kamen danach
  dazu): 1939 Tests in 130 Dateien, 52,3 s, `npm run ci` EXIT 0. Das Guard-Tor selbst meldet
  unverändert „27 packages checked, imports and package.json agree." — die neuen Dateien haben
  keine Manifest-Kante berührt, und dass der Guard das grüne Licht trotzdem trägt, ist der
  Punkt dieses Tores.
- Lockfile im selben Commit regeneriert (`npm install`, 7 insertions / 12 deletions) —
  Regel 34.20 verlangt das bei Dependency-Änderungen, auch wenn hier nichts Drittes hinzu-
  oder weggefallen ist.
- Biss-Probe: `packages/one` ohne `dependencies`, aber mit
  `import { two } from "@vdp/two"` → genau `missing-production-dependency`; identisches
  Fixture mit `dependencies: {"@vdp/two": "^0.0.3"}` → `dep-version-drift`; kaputtes JSON
  → Exit 2 (nicht „grün").

## Konsequenzen

- Ein neues Paket im Workspace ist ab jetzt an zwei Orten meldepflichtig:
  `dependency-rules.json` (wo es stehen darf) und sein Manifest (was es importiert). Der
  zweite Ort wird von einem Werkzeug gelesen, nicht von einem Reviewer.
- `@vdp/transport-doip` hat als erstes Paket eine `devDependencies`-Zeile. Das ist kein
  Musterzwang, sondern die honeste Antwort auf „nur Tests brauchen das Protokoll"; die
  Schichtregel bleibt davon unberührt, weil Testquellen in ihr nicht zählen.
- Wer die `@vdp/web`-→`charts`-Kante je „aufräumen" will: sie ist keine Importkante, sondern
  eine Servierkante. Der Test, der sie erhält, ist die Fixture in
  `tests/architecture/manifests.test.ts`.
