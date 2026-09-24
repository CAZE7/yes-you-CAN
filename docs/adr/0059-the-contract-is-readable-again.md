# ADR 0059 — Der Vertrag ist wieder lesbar: Chronik, Stand und Backlog sind nicht die Norm

Status: accepted · Datum: 2026-09-24 · Bezug: ADR 0043 (AI-Context-Layer), ADR 0031
(eine Regel, eine Quelle), AGENTS 34.21 (Messung vor Behauptung), AGENTS 34.24 (das
Repository gewinnt über die Dokumentation)

## Problem

`AGENTS.md` ist die normative Produktspezifikation **und** der AI Engineering
Contract (AGENTS §0.0). Gemessen am 2026-09-24:

| Größe | Wert |
|---|---|
| Bytes | **248.497** |
| Zeilen | 1.461 |
| längste Zeile | **7.653 Zeichen** |
| durchschnittliche Zeilenlänge | 172 Zeichen |
| davon Chronik (61 Versions-Bullets) | 162.192 B = **65,3 %** |
| davon 0.A „Umsetzungsstand" | 14.336 B |
| davon 0.E „Offene Verbesserungen" | 26.684 B |
| **eigentliche Norm** (Teil 0 + Abschnitte 0–36) | ≈42 KB = **17 %** |

Drei Konsequenzen, alle keine Vermutung:

1. **Ein Coding-Agent kann den Vertrag nicht in einem Kontext lesen.** 248 KB
   Text ist größer als das Fenster, in dem er arbeiten soll — und 83 % davon
   sind Verlauf und Status, keine Norm. Genau die Datei, die sagen soll *was
   gilt*, beginnt mit 65 % *was geschah*.
2. **Ein Reviewer kann die Datei nicht reviewen.** Ein PR, der einen
   Changelog-Bullet anhängt, zeigt einen Diff über eine 8-KB-Zeile. Dass der
   Inhalt stimmt, hilft niemandem, der die Änderung prüfen soll.
3. **Die Norm wird von der Chronik verdrängt.** Wer `AGENTS.md` öffnet, sucht
   eine Regel und findet einen Milestone-Bericht. Die Geltungsordnung am Kopf
   sagt „diese Datei ist normativ" — und liefert dann 162 KB Belege dafür, dass
   sie stattdessen ein Protokoll ist.

Der blinde Fleck dabei: die Datei war *nicht* unsortiert. Jeder Bullet ist eine
gemessene Aussage, jeder Eintrag im Backlog ein Befund mit Datum. Das Problem
war nicht die Disziplin, sondern die **Mischung von drei Textarten mit
verschiedener Halbwertszeit** in einer Datei:

| Textart | Halbwertszeit | Beispiel |
|---|---|---|
| Norm | Jahre | „Abhängigkeiten zeigen nur nach unten" |
| Stand | ein PR | „0.A: DoIP 🚧, Coverage 94,07/85,93" |
| Chronik | für immer, aber nur rückwärts gelesen | „1.46: Der Weg von einem realen Fahrzeug …" |

## Entscheidung

**Drei Textarten, drei Dateien — und eine Nummerierung, die überlebt.**

| Was | Wohin | Warum dort |
|---|---|---|
| Norm (Teil 0, Abschnitte 0–36) | bleibt in `AGENTS.md` | die Geltungsordnung sagt es, und jede Referenz `AGENTS 7`, `AGENTS 34.21` zeigt weiter dorthin |
| Chronik (61 Versions-Bullets) | [`docs/changelog/agents-contract.md`](../changelog/agents-contract.md) | rückwärts gelesen, wächst monoton, wird nie gesucht wenn man eine Regel braucht |
| Stand (0.A „Umsetzungsstand") | [`docs/architecture/status.md`](../architecture/status.md) | ein Snapshot mit Datum — wandert mit jedem PR, der ihn ändert (34.24) |
| Backlog (0.E „Offene Verbesserungen") | [`docs/architecture/backlog.md`](../architecture/backlog.md) | ein Arbeitsvorrat mit Priorität — kein Vertrag |

**Die Abschnittsnummern 0.A und 0.E bleiben.** `AGENTS.md` behält an ihrer
Stelle einen Zeiger, und der Zeiler sagt, warum die Nummerierung bleibt: jedes
„AGENTS 0.E E10" in Code-Kommentaren, ADRs, Tests und Issue-Texten bleibt
auflösbar. 24 Dateien mit solchen Verweisen wurden im selben Zug auf die neue
Adresse nachgezogen — als Markdown-Link in `.md`, als Pfad in Klammern in
`.ts`, damit ein Kommentar nicht auf einen Renderer angewiesen ist.

**Was nicht passiert:** die Norm wird nicht in Einzeldateien zerschlagen. Eine
Regel pro Datei wäre ein zweiter Index, und ein Index ist eine zweite Regel
(ADR 0031).

## Why

- **Lesbarkeit ist die Funktion, nicht die Kosmetik.** Ein AI-natives Repository
  (ADR 0043) lebt davon, dass der Agent den Vertrag liest, statt zu raten. Ein
  Vertrag, der nicht in ein Fenster passt, wird nicht gelesen — er wird
  geraten, und geraten wird gegen die Norm.
- **Halbwertszeit trennt die Dateien, nicht die Disziplin.** Chronik und Stand
  ändern sich bei jedem PR; die Norm ändert sich bei jeder Entscheidung. Drei
  Rhythmen in einer Datei heißt: jeder PR berührt die Datei, in der die
  beständigen Regeln stehen.
- **Der Schnitt ist reversibel und beweisbar.** Kein Satz der Norm wurde
  umformuliert; die Abschnitte 0–36 stehen unverändert und in derselben
  Reihenfolge. Wer die Aufteilung anders will, verschiebt Dateien, keine
  Bedeutungen.

## Alternatives

| Alternative | Warum nicht |
|---|---|
| Alles lassen, wie es ist | Die Messung steht oben: 83 % Verlauf/Status, längste Zeile 7.653 Zeichen. Das ist keine Stilfrage. |
| Nur die Chronik auslagern | Der größte Hebel (65 %), aber 0.A (14 KB, längste Zeile 3.734) und 0.E (27 KB, längste Zeile 3.427) blieben — und 0.A ist genau der Abschnitt, der bei jedem PR veraltet und damit die Geltungsordnung ad absurdum führt. |
| Die Norm in `docs/spec/NN-*.md` aufteilen | 36 Dateien plus ein Index. Der Index wäre eine zweite Kopie der Regel, *wo* etwas steht — der Fehler, den ADR 0031 für den Abhängigkeitsgraphen schon benannt hat. |
| `AGENTS.md` auf eine reine Startseite reduzieren | Dann zeigt `AGENTS 34.21` ins Nichts, und ~28 bestehende Verweise müssten umgeschrieben statt aufgelöst werden. |

## Affected packages

Keine. Das ist eine reine Dokumentationsentscheidung — `check:deps`,
`check:manifests`, `tsc -b`, Biome und die Suite sehen keine Kante.

Betroffen sind 24 Dateien mit Verweisen auf die ausgelagerten Abschnitte:
`README.md`, `RUN-BRIEF-2026-09-13.md`, `apps/web/src/views.ts`,
`packages/runtime/src/{sample-stream,vehicle-resolution}.ts`,
`packages/storage/src/storage.spec.ts`,
`tests/architecture/{coverage-gate,guardrails,hygiene}.test.ts`,
`tools/simulators/src/{chaos-lab.ts,chaos-lab.spec.ts}`, 13 ADRs,
`docs/architecture/master-backlog.md`, `docs/standards/{README,conformance}.md`.

## Forbidden implementations

- **Kein zweiter Index.** Wer `AGENTS x.y` sucht, liest `AGENTS.md`. Es darf
  keine Datei geben, die zusätzlich behauptet, wo welche Regel steht.
- **Keine Norm in der Chronik.** Ein Changelog-Bullet beschreibt, was gebaut
  und gemessen wurde. Steht in ihm eine Regel, gehört die Regel nach
  `AGENTS.md` — und der Bullet verweist auf sie.
- **Keine Behauptung über den Stand ohne Datum.** 0.A ist ein Snapshot. Eine
  Zeile ohne Messdatum ist eine Behauptung (34.21).
- **Kein Verschieben der Abschnittsnummern.** 0.A und 0.E bleiben 0.A und 0.E,
  auch ausgelagert. Die Nummer ist der Bezeichner, nicht die Datei.

## Migration

Erledigt am 2026-09-24, in dieser Reihenfolge:

1. Auslagern der drei Blöcke (Chronik, 0.A, 0.E) mit Zeilengrenzen, keine
   Umformulierung.
2. Zeiler in `AGENTS.md` mit je einem Satz, *warum* die Nummerierung bleibt.
3. Nachziehen der 24 Verweis-Dateien (Markdown-Link bzw. Pfad in Klammern).
4. Neues Tor `tests/architecture/links.test.ts`: 443 relative Links in 148
   Markdown-Dateien, 0 kaputt — zehn waren es vor dem Schnitt, sechs in
   `.ai/contracts/*.md`, vier in `docs/standards/conformance.md`.
5. Nebenbefund beim Auslagern: die 61 Chronik-Bullets trugen nur **46
   verschiedene Versionen** — 1.0–1.12 und 1.38 standen doppelt darin. 13 der 14
   Doppelungen byte-identisch und entfernt; 1.38 hat zwei *verschiedene* Einträge
   unter derselben Nummer, beide bleiben stehen (Eintrag 1.48 in der Chronik). Ein
   Schnitt, der eine doppelte Zeile findet, entfernt sie — er kopiert sie nicht in
   die neue Datei.

## Tests

| Tor | Was es bewacht |
|---|---|
| [`tests/architecture/links.test.ts`](../../tests/architecture/links.test.ts) | Jeder relative Markdown-Link löst auf — 443 Stück in 148 Dateien, 0 kaputt. Fence und Inline-Code sind keine Links (sonst würde das Gate das Dokumentieren der eigenen Syntax verbieten). Biss: ein Tempfile mit `[gone](./nowhere.md)` fällt. |
| [`tests/architecture/guardrails.test.ts`](../../tests/architecture/guardrails.test.ts) | Dass jedes Quality-Tor im Workflow noch einen Träger hat. Seit 2026-09-24 eine Selbstbeschreibung: die Tore laufen im Quality-Job, der Test beweist nur, dass sie dort stehen. |
| [`tests/architecture/reference-crate.test.ts`](../../tests/architecture/reference-crate.test.ts) | Der Rust-Crate bleibt außerhalb jedes Tors und macht keine ungemessene Performance-Claim. (Gleicher Zug, anderer Befund — siehe [E25](../architecture/backlog.md).) |
| `tests/architecture/hygiene.test.ts` | Unverändert: die Dateigrößen budgets gelten für Quelltext, nicht für Prosa — aber die Datei, die sie liest, ist jetzt kleiner. |

**Messung nach dem Schnitt:** `AGENTS.md` **248.497 → 47.526 Bytes**
(1.461 → 1.298 Zeilen), längste Zeile **7.653 → 925**. Der Anteil der Norm an
der Datei ist von 17 % auf 100 % gewachsen.

## AI implementation notes

- Du liest **`AGENTS.md`** für Regeln. Wenn du einen *Verlauf* oder einen
  *Stand* brauchst, liest du `docs/changelog/agents-contract.md` bzw.
  `docs/architecture/status.md` — und sag im Ergebnis, welches Datum die Zahl
  trägt.
- Ein Verweis `AGENTS 0.E E10` meint [`docs/architecture/backlog.md`](../architecture/backlog.md),
  Eintrag E10. Ein Verweis `AGENTS 0.A` meint
  [`docs/architecture/status.md`](../architecture/status.md). Beide Dateien
  tragen ihre Nummer im Kopf.
- Änderst du eine Regel, änderst du `AGENTS.md` — nicht den Changelog. Der
  Changelog bekommt einen Bullet, der auf die Regel verweist.
- Ziehst du einen Stand nach, ziehst du `docs/architecture/status.md` nach —
  nicht `AGENTS.md`. `README.md` und `CONTRIBUTING.md` ziehen im selben PR mit
  (Regel 34.24).
- Die vier gehärteten Workflows aus ADR 0016 §3 **liegen im Repository** (seit
  2026-09-24, vom Inhaber gepusht): `ci.yml` mit Quality-Job vor der Test-Matrix,
  dazu `codeql.yml`, `dependency-review.yml` und `hardware.yml`. Die GitHub-App-
  *Integration* kann sie weiterhin nicht schreiben (gemessen per `git push` und per
  API) — ein Commit über die App braucht also weiterhin das Recht oder den
  Inhaber. Der Zweitträger, den ADR 0029 dafür gebaut hatte, ist damit
  gegenstandslos und wurde auf eine Selbstbeschreibung zurückgebaut; Details in
  [E20](../architecture/backlog.md) und im Kopf von
  [`guardrails.test.ts`](../../tests/architecture/guardrails.test.ts).
