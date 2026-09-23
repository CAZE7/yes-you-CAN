# Teil 0 · 0.B Betrieb — Befehle, die funktionieren

> **Aus `AGENTS.md` verschoben** (2026-09-22, AGENTS 2.0 — die Wurzel-Datei ist der
> Einstieg, die Volltexte liegen hier). Jeder Befehl hier ist gemessen; ein Befehl, der nicht läuft, ist ein Defekt (Regel 34.21).
> Dieser Kasten ist neu; alles darunter ist **wortgleich** der Stand aus
> `AGENTS.md` 1.44. Abschnitts- und Regelnummern bleiben gültig: `AGENTS 34.12`
> ist §34.12 in [`rules.md`](rules.md), `AGENTS 0.E E15` ist E15 in
> [`backlog.md`](backlog.md).

## 0.B Betrieb — Befehle, die funktionieren

Voraussetzung: Node.js ≥ 22 (siehe `engines` im Root-`package.json`, `.nvmrc`).

```bash
npm ci                # installiert exakt das Lockfile — kein npm install im CI-Kontext
npm run build         # tsc -b über alle Projekt-Referenzen (TypeScript 7 / tsgo)
npm run typecheck     # Build + strikter noEmit-Pass über Tests, Konfiguration, Specs und Frontend-JS
npx biome check .     # Lint + Format (Biome 1.9)
npm run check:deps   # Architektur-/Layer-Regel (tools/architecture/check-dependencies.mjs)
npm run check:manifests # `package.json` ⇔ tatsächliche Imports (ADR 0042)
npm test              # komplette Suite auf 6 Ebenen (unit / protocol / regression / replay / integration / architecture)
                      # das Projekt `architecture` führt dabei biome check + beide --noEmit-Pässe
                      # selbst aus (ADR 0029) — deshalb sind die Gates auch in der CI scharf
npm run test:unit     # nur Unit-Specs — die schnelle Feedback-Schleife
npm run test:coverage # Suite + V8-Coverage — global 90/80/90/90 als Projekt-Durchschnitt,
                      # per-file-Gates für core/protocols/adapters/transport/storage/
                      # charts/reports/ai (maßgeblich ist vitest.config.ts,
                      # ADR 0017/0020/0022) — grün
npm run demo          # Workbench mit Simulator auf http://localhost:8080
npm run formal:conform # Konformanz-Vektoren gegen TS (und Haskell, wenn Toolchain da — sonst NOT RUN) (ADR 0045)
npm run architecture:impact -- <datei|paket>  # Betroffene Pakete/ADRs/Tests aus der manifest-Kantengraph (ADR 0046)
npm run ai:context:changed  # .ai/generated/changed-context.md — Topic-Bundles der geänderten Pakete (ADR 0046)
```

Einzelnes Paket bauen bzw. einzelne Test-Datei ausführen:

```bash
npx tsc -b packages/transport/iso-tp
npx vitest run packages/storage/src/storage.spec.ts
```

Getestet wird **direkt der TypeScript-Quelltext**: Die Root-`vitest.config.ts`
aliasst die Workspace-Exporte von `./dist/...` auf `./src/...` (ADR 0010,
Schritt 1) — für Unit-, Protokoll-, Replay- und Regressions-Tests ist kein
Build nötig, kein stales `dist` möglich. **Ausnahme:** die Workbench-
Integrationstests (`apps/web/test/server.spec.ts`) beziehen den Chart-Kern
über `/lib` aus dem *kompilierten* `dist` von `@vdp/charts`; ohne Build
antwortet `/lib/index.js` mit 404 (gemessen 2026-09-11). Deshalb führen
`npm test` und `npm run test:coverage` den Build seit dem 2026-09-11 selbst
aus (Regel 34.26); `tsc -b` prüft zusätzlich Declaration-Maps und die
Abhängigkeitsrichtung. Das Frontend (`apps/web/public/*.js`) wird über das
eigene Projekt `tsconfig.frontend.json` mit `checkJs` typgeprüft und läuft
im Typecheck-Pass mit.

