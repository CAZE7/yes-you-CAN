# Branch-Hygiene — Inventar und Regel

> Stand: 2026-09-22 · Ausgeführt auf `main` @ `dc310e5` (Release v0.1.0)
> Verlinkt aus [`CONTRIBUTING.md`](../../CONTRIBUTING.md) → *Workflow*.

Ein Remote-Branch ist ein offenes Versprechen: jemand könnte darauf arbeiten.
Branches, deren Inhalt in `main` angekommen ist, halten dieses Versprechen nicht
mehr — sie kosten Überblick (jeder `git branch -r` wird zur Suchaufgabe) und sie
verstecken die Frage, ob ihre Commits wirklich im Produkt gelandet sind.

## Regel

1. **Inventar vor jeder Löschung.** Jeder Remote-Branch außer `main` wird mit
   SHA, letztem Commit, Anzahl Commits vor/hinter `main` und der Anzahl
   *patch-eindeutiger* Commits (`git cherry main <branch>`) erfasst. Die Tabelle
   landet im PR-Body **und** in dieser Datei — eine Löschung ohne Inventar ist
   nicht nachvollziehbar und damit nicht erlaubt.
2. **Klassifikation (a) fully merged:** `git merge-base --is-ancestor <branch> main`
   ist wahr *oder* `git cherry` meldet 0 eindeutige Commits und der Tree-Diff zu
   `main` ist leer → Branch löschen, kein Tag. Der Inhalt ist im Produkt.
3. **Klassifikation (b) unmerged mit einzigartigen Commits:** Branch als
   annotiertes Tag `archive/<branch-mit-slash-als-minus>` pinnen (Tag-Message:
   SHA, Datum, Subject, Anzahl eindeutiger Commits, Grund), **dann** löschen.
   Ein Tag ist billig, ein verlorener Commit ist es nicht.
4. **Offene PRs werden vor der Löschung kommentiert**, mit dem Tag und dem
   `git switch -c`-Befehl, der den Stand zurückbringt.
5. **Zielzustand:** `git branch -r` zeigt ≤ 4 Branches (`main`, `HEAD` und die
   Arbeitsbranches des laufenden Runs). Arbeitsbranches eines Runs sind die
   dokumentierte Ausnahme; sie fallen beim Merge ihrer PRs weg.
6. **Nie gelöscht wird:** `main`, die Arbeitsbranch der laufenden Session und
   jede Branch, deren Klassifikation nicht in der Tabelle steht.

## Run 2026-09-22 — Inventar (27 Branches)

Gemessen mit `git cherry origin/main <branch>` (patch-Äquivalenz) und
`git merge-base --is-ancestor` (Erreichbarkeit). `main` hatte zu diesem
Zeitpunkt 189 Commits; alle 27 Branches stammen aus derselben Entwicklungslinie
(`arena/*` = Session-Arbeitsbranches, zwei davon thematische Branches).

| # | Branch | SHA | Letzter Commit | ahead | behind | eindeutige Commits | Klasse | Aktion | Begründung |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `arena/01a08b23-yes-you-can` | `6bf37e3b` | 2026-09-10 | 0 | 183 | 0 | (a) merged | gelöscht | Vorfahr von `main`; `apps/web: drop the 'log' member from BackendEvent` ist über die nachfolgende Linie in `main` |
| 2 | `arena/01a08cc7-yes-you-can` | `c28015ee` | 2026-09-10 | 0 | 178 | 0 | (a) merged | gelöscht | Vorfahr von `main` (DTC-Marker-Status) |
| 3 | `arena/01a08d1e-yes-you-can` | `938cdc58` | 2026-09-10 | 0 | 175 | 0 | (a) merged | gelöscht | Vorfahr von `main` (Freeze Frames, safety-gated clear) |
| 4 | `arena/01a08f21-yes-you-can` | `9e696bef` | 2026-09-11 | 0 | 166 | 0 | (a) merged | gelöscht | Vorfahr von `main` (Vitest-Reporter-Fix) |
| 5 | `arena/01a08f68-yes-you-can` | `5410a0fa` | 2026-09-11 | 0 | 161 | 0 | (a) merged | gelöscht | Vorfahr von `main` (Serialisation-Gaps) |
| 6 | `arena/01a0900b-yes-you-can` | `3f28f87a` | 2026-09-11 | 0 | 158 | 0 | (a) merged | gelöscht | Vorfahr von `main` (AGENTS v1.2 — Fortführung, ersetzt PR #6) |
| 7 | `arena/01a0908a-yes-you-can` | `7715facf` | 2026-09-11 | 0 | 155 | 0 | (a) merged | gelöscht | Vorfahr von `main` (Transport-Seam DoIP) |
| 8 | `arena/01a09119-yes-you-can` | `4317d1e9` | 2026-09-11 | 0 | 153 | 0 | (a) merged | gelöscht | Vorfahr von `main` (Biome, Coverage-Gates) |
| 9 | `arena/01a091b8-yes-you-can` | `8ab151a4` | 2026-09-12 | 0 | 151 | 0 | (a) merged | gelöscht | Vorfahr von `main` (Engine-Zerlegung) |
| 10 | `arena/01a0964d-yes-you-can` | `ddc0d0fc` | 2026-09-12 | 0 | 131 | 0 | (a) merged | gelöscht | Vorfahr von `main` (Ist-Zustand/Backlog) |
| 11 | `arena/01a09708-yes-you-can` | `ea402d64` | 2026-09-13 | 0 | 115 | 0 | (a) merged | gelöscht | Vorfahr von `main` (ADR 0025) |
| 12 | `arena/01a09aa0-yes-you-can` | `11b1c121` | 2026-09-14 | 0 | 104 | 0 | (a) merged | gelöscht | Vorfahr von `main`; Head des gemergten PR #19 |
| 13 | `arena/01a09ccf-yes-you-can` | `ee5a1ba4` | 2026-09-14 | 0 | 92 | 0 | (a) merged | gelöscht | Vorfahr von `main` (Guardrail-Linie) |
| 14 | `arena/01a09edd-yes-you-can` | `54a1538b` | 2026-09-14 | 0 | 90 | 0 | (a) merged | gelöscht | Vorfahr von `main` (Diagnostic IR, Evidence Engine) |
| 15 | `arena/01a0a3d5-yes-you-can` | `053e718f` | 2026-09-15 | 0 | 86 | 0 | (a) merged | gelöscht | Vorfahr von `main` (Chaos-Metrics-Härtung) |
| 16 | `arena/01a0a450-yes-you-can` | `88c1aa4d` | 2026-09-16 | 0 | 46 | 0 | (a) merged | gelöscht | Vorfahr von `main` (CI-Dokumentation) |
| 17 | `arena/01a0aa01-yes-you-can` | `2d8fa726` | 2026-09-16 | 0 | 44 | 0 | (a) merged | gelöscht | Vorfahr von `main` (AI-Kontextschicht) |
| 18 | `arena/01a0aa51-yes-you-can` | `aced123f` | 2026-09-16 | 0 | 42 | 0 | (a) merged | gelöscht | Vorfahr von `main` (Szenarien, Trace-Integrität) |
| 19 | `arena/01a0aa73-yes-you-can` | `197602ac` | 2026-09-18 | 0 | 40 | 0 | (a) merged | gelöscht | Vorfahr von `main` (Formal-Conformance-Vektoren) |
| 20 | `arena/01a0b41c-yes-you-can` | `8911675f` | 2026-09-18 | 1 | 41 | 1 | **(b) unmerged** | Tag `archive/arena-01a0b41c`, dann gelöscht | 1 Commit nicht in `main`: Roh-Trace-Digest als Primitiv in `@vdp/shared` (ADR 0044). Head des offenen PR #25 — Kommentar mit Wiederherstellungsweg hinterlassen |
| 21 | `arena/01a0b421-yes-you-can` | `929f0808` | 2026-09-18 | 2 | 41 | 2 | **(b) unmerged** | Tag `archive/arena-01a0b421`, dann gelöscht | 2 Commits nicht in `main`: portable SHA-256 + Coverage-Gate-Runde. Head des offenen PR #26 — Kommentar hinterlassen |
| 22 | `arena/01a0b83d-yes-you-can` | `b5210672` | 2026-09-19 | 0 | 15 | 0 | (a) merged | gelöscht | Vorfahr von `main` (Formal-Flow `proven`) |
| 23 | `arena/01a0bf42-yes-you-can` | `30966d2e` | 2026-09-20 | 1 | 14 | 1 | **(b) unmerged** | Tag `archive/arena-01a0bf42`, dann gelöscht | 1 Commit nicht in `main`: `web: ten honesty fixes without invented OEM data`. Head des offenen PR #29 — Kommentar hinterlassen |
| 24 | `arena/01a0c7cd-yes-you-can` | `b8bfde99` | 2026-09-22 | 0 | 6 | 0 | (a) merged | gelöscht | Vorfahr von `main`; Head des gemergten PR #32 (TLS, Rate-Limit, CSMS) |
| 25 | `arena/01a0c994-yes-you-can` | `ad762e53` | 2026-09-22 | 0 | 1 | 0 | (a) merged | gelöscht | Vorfahr von `main`, Tree-Diff zu `main` leer (`Release v0.1.0`-Gate-Protokoll) |
| 26 | `chore/ci-security-baseline` | `ccee80c6` | 2026-09-10 | 0 | 181 | 0 | (a) merged | gelöscht | Vollständig in `main` via PR #2 (MERGED); `git diff main…branch` leer. Inhalt für T9 geprüft: die gehärtete Workflow-Variante existiert **nicht** — `ci.yml` ist auf beiden Ständen identisch (nur `npm ci` → `build` → `test`) |
| 27 | `docs/agents-md-v1-2` | `102d11dc` | 2026-09-10 | 1 | 180 | 1 | **(b) unmerged** | Tag `archive/docs-agents-md-v1-2`, dann gelöscht | 1 Commit nicht in `main`: AGENTS.md v1.2 als Fortführungs-Leitfaden; dieselbe Fassung ist über Branch #6 (`3f28f87a`, merged) in `main` gekommen — der Commit hier ist ein Dublikat mit eigenem Tree |

### Ergebnis

- 27 Branches gelöscht, 4 Archive-Tags angelegt und gepusht (`git tag -l 'archive/*'`).
- `git branch -r` unmittelbar danach: **2** (`origin/HEAD -> origin/main`,
  `origin/main`) — Ziel ≤ 4 erfüllt.
- 3 offene PRs (#25, #26, #29) schließen mit ihren Head-Branches; jeder trägt
  einen Kommentar mit Tag und Wiederherstellungsbefehl, jeder Stand ist als Tag
  im Repository erreichbar.
- Kein Commit wurde vernichtet: jeder der 27 Branches ist entweder Vorfahr von
  `main` oder als Tag gepinnt.

### Wiederherstellen eines archivierten Standes

```bash
git fetch origin tag archive/arena-01a0b41c
git switch -c arena/01a0b41c-yes-you-can archive/arena-01a0b41c
git push -u origin arena/01a0b41c-yes-you-can   # PR wieder öffnen
```
