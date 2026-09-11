# 0012 — Statische Auslieferung nach Pfadsegmenten, nicht nach Zeichenkette

Status: accepted · Datum: 2026-09-11 · Bezug: ADR 0006, 0009, 0011; AGENTS 27, 31, 35

## Kontext

Die Workbench liefert zwei statische Wurzeln aus: das Frontend aus `public/`
(ADR 0006) und den kompilierten Chart-Kern unter `/lib/` (ADR 0011). Beide
Wege betonen „gleiche Regeln: same-origin, GET-only, kein Path-Traversal".
Die Absicherung bestand aus zwei Prüfungen: einem sichtbaren `..` im Request
(403) und einem Präfixvergleich des aufgelösten Zielpfads gegen das Wurzel-
Verzeichnis.

Der Präfixvergleich ist die Schwäche. `String.prototype.startsWith` vergleicht
Zeichen, keine Ordner:

```
root      = /srv/app/public
resolved  = /srv/app/public-internal/keys.json   ← beginnt mit "/srv/app/public"
```

Ein einziger Sprung `..` genügt, und jeder Nachbarordner, dessen Name mit dem
Namen der Wurzel *beginnt*, liegt innerhalb der erlaubten Zone — `.env`,
`~/.netrc`, das Git-Verzeichnis des Deployments. Da der Server standardmäßig
ohne Authentifizierung läuft (AGENTS 27) und oft an einer Arbeitskopie startet,
ist diese Enthaltung die einzige Wand.

## Entscheidung

Containment ist ein eigener, reiner Baustein: **`apps/web/src/paths.ts`**.

- **`isInsideDirectory(root, candidate)`** — beide Seiten mit `path.resolve()`
  normalisieren und dann *Segment für Segment* vergleichen: enthalten ist, was
  exakt die Wurzel ist oder mit `Wurzel + sep` beginnt. Ein Präfix ohne Trennzeichen
  ist damit kein Treffer mehr.
- **`resolveContained(rootDir, relative)`** — die Route reicht nur den
  URL-Pfad weiter. Abgelehnt wird, bevor die Dateisystem-Funktion überhaupt
  aufgerufen wird: leere Anfrage, NUL-Byte (die Syscalls schneiden dort ab),
  absolute Pfade (`resolve` würde das Wurzelargument schlicht ignorieren) und
  alles, was nach dem Falten der `..`-Segmente außerhalb landet. Antwort: der
  Zielpfad oder `null`.
- **Beide statischen Routen benutzen denselben Baustein.** Die bestehende
  `..`-Prüfung bleibt zusätzlich bestehen: sie gibt die sauberere Antwort
  (403 statt 404) und ist nicht mehr die Sicherheitsprüfung.
- **Symlinks werden bewusst nicht aufgelöst.** Kein `realpath`: der Build
  tauscht Verzeichnisse aus, und eine Prüfung, die bei jedem Umbau still
  andere Wege erlaubt, ist schlechter als eine, die den Auslieferungsordner
  als Vertrag nimmt. Verzeichniswahl bleibt Aufgabe des Deployments — nur
  Build-Output dient aus, kein beschreibbarer Arbeitsordner.

## Konsequenzen

- Jede neue statische Route ruft `resolveContained` auf; ein eigener
  `startsWith`-Vergleich an einer anderen Stelle ist ab jetzt ein Befund und
  keine Stilfrage.
- Der Nachbarordner-Fall ist in `apps/web/test/paths.spec.ts` festgehalten
  (21 Tests, Vitest-Projekt `integration`). Die Tests sind reine
  Zeichenketten-Tests: Sie laufen ohne gebautes Frontend und ohne Dateisystem,
  sind also in CI immer gültig (AGENTS 31).
- Eine Anfrage auf die Wurzel selbst (`/lib/.`) ist enthalten und wird ans
  Dateisystem übergeben; ein Leseversuch auf ein Verzeichnis endet dort als 404
  — ein Irrtum, keine Flucht.
- Der doppelte Schutz (403 bei sichtbarem `..`, 404/403 bei Containment) kostet
  nichts und macht das Verhalten in beiden Fällen ansagbar.
