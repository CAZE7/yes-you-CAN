# Beitragende und Rechte — das Register

> **Zweck:** Diese Datei ist die eine Stelle, an der die Rechtekette *nachlesbar* ist:
> wer beigetragen hat, unter welcher Fassung der Vereinbarung, und wann. Sie ist
> absichtlich eine Datei im Repository und kein Dashboard eines Drittanbieters — eine
> Rechtekette, die man nicht besitzt, kann man nicht vorlegen (ADR
> [0062](../adr/0062-contributions-need-a-cla.md)).

**Vereinbarung:** [`docs/legal/cla.md`](cla.md), **Fassung 1.0** (in Kraft ab 2026-09-23)
· **Lizenz des Projekts:** Apache-2.0 ([`LICENSE`](../../LICENSE), ADR [0061](../adr/0061-license-apache-2-0.md))

## Rechteinhaber

| Wer | Rolle | Seit |
|---|---|---|
| `@CAZE7` | Inhaber des Repositories und Rechteinhaber der eigenen Beiträge — benötigt keine CLA-Zustimmung | 2026 |

## Zustimmungen zur Vereinbarung

| Handle / Name | Fassung | Datum | Beleg |
|---|---|---|---|
| *(noch keine)* | — | — | — |

**Ehrlicher Stand (gemessen 2026-09-23):** Es gibt **keine** Zustimmung, weil es **keinen**
Fremdbeitrag gibt. `git rev-list --count HEAD` = 1, ein Autor
(`arena-ai-coding-agent[bot]`), kein externer Pull Request. Die Tabelle füllt sich mit der
ersten angenommenen Fremdbeitragung; ab dann ist eine Zeile die Voraussetzung für den
Merge, und der Satz aus `cla.md` § „Wie du zustimmst“ ist ihr Beleg.

## Was ab der ersten Zustimmung gilt

1. **Jeder** externe Beitrag trägt eine Zeile mit Datum und Fassungsnummer.
2. Eine **neue Fassung** der Vereinbarung (andere Nummer in `cla.md`) verlangt eine erneute
   Zustimmung — die Fassungsnummer in dieser Tabelle ist deshalb eine Pflichtspalte und
   keine Bequemlichkeit.
3. Der **DCO-Hinweis** (`Signed-off-by:`) bleibt zusätzlich bestehen; er belegt die
   Herkunft je Commit, ersetzt die Vereinbarung aber nicht.

## Was diese Datei nicht ist

Kein Nachweis über Urheberschaft einzelner Zeilen — dafür ist die Git-Historie da, und sie
sagt über die Zeit **vor** dem 2026-09-23 nichts Belastbares (ein Commit, ein Bot-Autor).
Genau deshalb steht die Rechteklärung in
[`docs/architecture/open-core-phase-0-rights.md`](../architecture/open-core-phase-0-rights.md)
als Phase-0-Aufgabe, die vor der ersten Veröffentlichung erledigt sein muss.
