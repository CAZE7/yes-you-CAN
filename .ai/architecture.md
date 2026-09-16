# Lese-Paket: Architektur

**Zweck:** Das gesamte System in einer Lesesitzung verstehen — Schichten,
Abhängigkeitsrichtung, die harten Verträge.

## Lese-Liste (in dieser Reihenfolge)

1. [`../ARCHITECTURE.md`](../ARCHITECTURE.md) — der Einstiegspunkt:
   Schichten mit Purpose / Allowed / Forbidden / Entry points / Contracts /
   Tests + die Tabelle der maschinellen Verträge.
2. [`../architecture/architecture.yaml`](../architecture/architecture.yaml) —
   die **eine Quelle**: `layers` (Layer-Vokabel), `packages` (je Paket
   `layer` + `mayImport` + `why`), `rules` (Node-Builtins, UI, Layer-
   Regeln, Portabilität), `topics` (AI-Kontexte).
3. [`../docs/adr/README.md`](../docs/adr/README.md) — die 43 ADRs; die
   wichtigsten für das Systemverständnis: 0001 (Schichtung), 0014
   (domain/application/runtime), 0031/0042/0043 (eine Regel, eine Quelle),
   0034/0037 (Diagnostic IR), 0038 (Evidence/AI), 0032 (WritePort).

## Die fünf Sätze der Architektur

1. Lesen und Schreiben sind getrennte Universen: alles, was liest, bekommt
   Observations mit Beleg aus dem Diagnostic IR; alles, was schreibt,
   läuft gestuft über `WritePort` + `SafetyManager`.
2. Die Abhängigkeitsrichtung ist eine **maschinelle Regel**
   (`npm run check:deps`) — „mayImport“ ist Allowlist, alles andere ist
   verboten.
3. Die Schichten `contract` (domain/diagnostic-ir/definitions) sind
   portabel: kein I/O, kein Protokoll, kein Transport — deshalb die
   stabile Mitte.
4. `@vdp/ai` darf **genau** `shared` + `diagnostic-ir` importieren —
   „eine Analyse berührt nie das Fahrzeug“ ist damit ein Test, kein
   Wunsch.
5. Die UI ist die Spitze: niemand importiert `@vdp/web`; die UI importiert
   das Fahrzeug nur über den Runtime.

## Weiter

- Aufgabe→Stelle: [`.ai/code-map.md`](code-map.md)
- Was nicht brechen: [`.ai/invariants.md`](invariants.md)
- Kontext-Bundle: `npm run ai:context <topic>`
