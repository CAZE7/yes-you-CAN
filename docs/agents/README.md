# docs/agents/ — die Volltexte hinter `AGENTS.md`

> **Entstanden 2026-09-22 (AGENTS 2.0).** Die Wurzel-[`AGENTS.md`](../../AGENTS.md)
> war auf 239 KB angewachsen — 1.44 Changelog-Einträge, Umsetzungsstand, Backlog
> und die normative Produktspezifikation in einer Datei. Seit 2.0 ist sie der
> Einstieg (≤ 10 KB: Architekturprinzipien, Naming, Testpflicht, Seed&Key-Regel,
> PR-Prozess) und verweist hierher. **Verschoben, nicht gelöscht:** jede Zeile
> des Stands 1.44 steht wortgleich in einer der Dateien unten (nachgemessen mit
> einem Zeilenvergleich über das Original, Protokoll im PR zu AGENTS 2.0).
> Nummern bleiben gültig — `AGENTS 34.12` ist §34.12 in
> [`rules.md`](rules.md), `AGENTS 0.E E15` ist E15 in [`backlog.md`](backlog.md),
> `AGENTS 11.1` ist §11.1 in [`specification-diagnosis.md`](specification-diagnosis.md).

## Die beiden Überschriften des Originals (wortgleich)

> # Teil 0 — Für Coding Agents: zuerst lesen
>
> Dieser Teil steht bewusst vor der Spezifikation. Er sagt dir, *was schon existiert*, *wie du arbeitest* und *wo die harten Grenzen sind*. Die Abschnitte 0–36 dahinter bleiben die normative Produktspezifikation.

> # Produktspezifikation (Abschnitte 0–36, normativ)

## Index

| Datei | Inhalt (Abschnitte des Originals) | Größe |
|---|---|---|
| [`changelog.md`](changelog.md) | Kopfzeile mit Version, die Changelog-Einträge 1.44 → 1.0, Geltungsordnung | 153 KB |
| [`ai-engineering-contract.md`](ai-engineering-contract.md) | Teil 0 · **0.0** AI Engineering Contract (ADR 0043): Lesereihenfolge, `.ai/`-Kontextpakete, Doku-Pflicht | 2,9 KB |
| [`implementation-status.md`](implementation-status.md) | Teil 0 · **0.A** Umsetzungsstand — was existiert wirklich (Tabelle, bei Verhaltenänderung nachziehen, Regel 34.24) | 13,5 KB |
| [`operations.md`](operations.md) | Teil 0 · **0.B** Betrieb — die Befehle, die funktionieren (gemessen) | 2,7 KB |
| [`workflow.md`](workflow.md) | Teil 0 · **0.C** Workflow (verbindlich) und **0.D** Leitplanken in Kurzform | 1,7 KB |
| [`backlog.md`](backlog.md) | Teil 0 · **0.E** Offene Verbesserungen — die E-Nummern, auf die Code und ADRs verweisen | 23,7 KB |
| [`specification-platform.md`](specification-platform.md) | Spezifikation **§0–§8**: Glossar, Ziel, Architekturprinzip, Repository-Struktur, Adapter-Abstraktion, Kommunikationsschichten, CAN, ISO-TP, DoIP | 6,2 KB |
| [`specification-diagnosis.md`](specification-diagnosis.md) | Spezifikation **§9–§21**: Diagnosekern, Vehicle Session, Fahrzeugidentität (11.1), ECU Explorer, OEM-Definitionen (13.1/13.2), Messwert-Engine, Parallel-Livewerte, Graphen, Logging, Raw Trace, Replay, DTC-System (20.1), Bericht | 13,6 KB |
| [`specification-analysis.md`](specification-analysis.md) | Spezifikation **§22–§24**: KI-Schicht, Knowledge Base, Datenherkunft / Commercial Readiness | 4,9 KB |
| [`specification-engineering.md`](specification-engineering.md) | Spezifikation **§25–§33**: Coding Framework, Safety Layer, Datenschutz, UI-Struktur, MVP, Phasen, Testing, Simulator, Observability | 7,9 KB |
| [`rules.md`](rules.md) | Spezifikation **§34–§36**: die 26 Regeln für Coding Agents (34.1–34.26), Definition of Done, oberstes Architekturziel | 4,4 KB |

## Wohin gehört neuer Text?

- Eine **Regel**, an der ein Change scheitert → [`rules.md`](rules.md) (§34, neue Nummer hinten anhängen; Nummern werden nie wiederverwendet).
- Ein **Produktverhalten** (was das System können muss) → die passende Spezifikationsdatei oben.
- Ein **gemessener Stand** oder eine **offene Verbesserung** → [`implementation-status.md`](implementation-status.md) bzw. [`backlog.md`](backlog.md) (E-Nummer).
- Eine **Entscheidung** mit Alternativen und Begründung → ein ADR in [`docs/adr/`](../adr/README.md), nicht hierher.
- Die Wurzel-`AGENTS.md` wächst nur, wenn eine der fünf Einstiegsthemen-Regeln selbst sich ändert — sie bleibt ≤ 10 KB.
