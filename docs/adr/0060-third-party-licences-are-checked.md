# ADR 60 — Fremdcode wird auf Lizenz geprüft: die Richtlinie im Manifest, das Gate über dem Lockfile

- Status: akzeptiert (2026-09-23)
- Kontext: ADR 0002 (keine Laufzeit-Abhängigkeiten), ADR 0010 (Toolchain-Modernisierung),
  ADR 0029 (Guardrails, die beißen), ADR 0031/0042 (eine Quelle, Werkzeug statt
  Regel-Kopie), ADR 0053 (Abhängigkeiten als Teil von Industriestandard),
  AGENTS 24/34.20/35, `docs/architecture/open-core-dual-licensing.md` (§3.3)
- Betrifft: `architecture/architecture.yaml` (neuer Abschnitt `licenses`),
  `tools/architecture/check-licenses.mjs` (neu),
  `tools/architecture/check-dependencies.mjs` (validiert den Abschnitt),
  `package.json` (`check:licenses`, `ci`), `tests/architecture/licenses.test.ts` (neu),
  `CONTRIBUTING.md`, `AGENTS.md`, `docs/standards/conformance.md`, `docs/standards/csms.md`

## Problem

Zwei Sätze standen seit ADR 0002 bzw. AGENTS 34.20 im Raum, und beide waren **erzählt,
nicht gemessen**:

1. „`dependencies` bleiben leer, also gibt es keinen Supply-Chain-Vektor."
2. „Neue Abhängigkeiten nur nach Lizenz-Check (MIT/Apache-2.0/BSD)."

Der erste Satz war richtig und wurde nie nachgeprüft — er hängt daran, dass niemand eine
Laufzeit-Abhängigkeit hinzufügt, und dafür gab es kein Tor. Der zweite Satz war eine
Absichtserklärung ohne Prüfer: `npm audit` prüft *Schwachstellen*, nicht Lizenzen, und
niemand wusste, welche 108 Pakete im Lockfile überhaupt unter welcher Lizenz stehen.

Die Messung dieses ADR hat den Befund gleich geliefert: **12 Einträge stehen unter
MPL-2.0** (`lightningcss` und seine Plattform-Binaries unter der Vite/Vitest-Toolchain),
und das ist kein Fehler, sondern eine Entscheidung, die bisher niemand bewusst getroffen
hatte. Genau dafür gibt es das Gate.

## Entscheidung

1. **Die Richtlinie steht in `architecture.yaml` unter `licenses`**, in zwei Geltungs-
   bereichen — `production` (die Schließung, die ausgeliefert werden könnte) und
   `development` (Bau- und Testzeit) —, je mit `allowed`, `forbidden` und `why`.
   Geltung ohne Begründung gibt es nicht; beide `why`-Felder sind Pflicht.
2. **`tools/architecture/check-licenses.mjs`** liest `package-lock.json`, wertet jede
   SPDX-Angabe **als Ausdruck** aus und fällt bei einem Verstoß mit EXIT 1.
   Geltungsbereich: Einträge unter `node_modules/` ohne `link: true` — also
   Fremdpakete. Der Root-Eintrag und die Workspace-Verzeichnisse sind unser eigener
   Code; deren Lizenz-Frage besitzt `manifests.test.ts` („every package declares the
   license the root declares") und bekommt hier **keine zweite Regel**.
3. **Der Ausdruck wird geparst, nicht verglichen:** `(MIT OR CC0-1.0)` ist zulässig
   (der Konsument darf wählen), `MIT AND GPL-3.0-only` ist es nicht (beide Pflichten
   gelten), `GPL-2.0-only WITH Classpath-exception-2.0` behält sein Copyleft — eine
   Ausnahmeklausel weicht die Richtlinie nicht auf.
4. **Unbekannt ist ein Verstoß, kein Durchlauf.** Eine Lizenz, für die niemand
   entschieden hat, ist ein Befund (`unknown-license`) — der Zweck des Gates ist, dass
   das *nächste* Paket eine Entscheidung wird, nicht dass der aktuelle Baum ruhig ist.
5. **Ausnahmen sind datiert und sterben mit ihrem Befund:** `{ package, why, until }`.
   Eine abgelaufene Ausnahme ist ein Verstoß, eine nicht mehr benötigte (`unused-
   exception`) und eine auf ein verschwundenes Paket (`stale-exception`) ebenfalls. Eine
   undatierte Ausnahme **entschuldigt nichts** (fail closed) — auch dann nicht, wenn das
   Werkzeug gegen ein Fixture läuft, das `check-dependencies.mjs` nie validiert hat.
6. **Der Schema-Eigentümer validiert mit:** `check-dependencies.mjs` prüft die Form von
   `licenses` (beide Geltungsbereiche vorhanden, `allowed` nicht leer, `why` gesetzt,
   Ausnahmen mit `package`/`why`/`until`-Datum) **und** dass keine Lizenz gleichzeitig
   erlaubt und verboten ist. Ein Widerspruch in der Richtlinie würde sonst still
   zugunsten von `forbidden` entschieden, und der `allowed`-Eintrag wäre Dekoration.
7. **Beide Geltungsbereiche sind `npm run ci`-Pflicht** (`check:licenses`), und der
   Biss-Test liegt in `tests/architecture/licenses.test.ts`.

## Why

- **„Es ist ja nur eine Dev-Dependency" ist eine Aussage, die jemand treffen muss.** Die
  Trennung der beiden Geltungsbereiche macht sie zu einer Entscheidung mit Ort und
  Begründung. MPL-2.0 bei `lightningcss` ist Datei-Copyleft, das nicht in unsere Quellen
  wandert — zulässig in `development`, **nicht** in `production`. Dieselbe Lizenz, zwei
  Antworten, und beide sind im Manifest nachlesbar.
- **Der `production`-Bereich ist der Wächter von ADR 0002.** Er ist heute leer
  (gemessen: `0 production, 108 development`). Diese Null ist ab jetzt kein Satz in
  einem ADR mehr, sondern eine Zahl, die ein Werkzeug in jedem CI-Lauf ausgibt — und die
  sich meldet, sobald jemand die erste Laufzeit-Abhängigkeit hinzufügt, unter welcher
  Lizenz auch immer.
- **SPDX-Semantik statt Zeichenkettensuche.** Ein Prüfer, der `MIT AND GPL-3.0-only` für
  zulässig hält, weil „MIT" darin vorkommt, ist gefährlicher als kein Prüfer: er erzeugt
  Vertrauen ohne Deckung.
- **Ausnahmen mit Ablaufdatum, weil eine Ausnahme sonst eine Richtlinie wird.** Dasselbe
  Muster wie die Größenbudget-Ausnahmen in `hygiene.test.ts` („eine Ausnahme, die nicht
  mehr nötig ist, fällt") und die Blind-Präfix-Regel in `check-dependencies.mjs`.

## Alternatives

1. **`license-checker` / `licensee` / `oss-attribution-generator` als Dev-Dependency.**
   Verworfen: Die Frage ist „welche SPDX-Ausdrücke stehen im Lockfile und was erlaubt
   unsere Richtlinie" — rund 250 Zeilen ohne Abhängigkeit, in der Bauart der drei
   vorhandenen Prüfer. Eine neue Dev-Dependency für eine Lizenzprüfung ist außerdem ein
   schlechter Scherz (ADR 0002/0010).
2. **`npm audit` als Lizenzprüfung lesen.** Verworfen: `npm audit` prüft
   Schwachstellen. Der Irrtum wäre teuer, weil die Ausgabe wie eine Freigabe aussieht.
3. **Nur eine erlaubte Liste, ohne `forbidden`.** Verworfen: „nicht auf der Erlaubnisliste"
   und „ausdrücklich verboten" sind zwei verschiedene Aussagen — die zweite ist die, die
   ein Review braucht, wenn ein Board-Mitglied fragt.
4. **MPL-2.0 stillschweigend akzeptieren (ohne Eintrag).** Verworfen — genau das war der
   Zustand vor diesem ADR: 12 Pakete unter Datei-Copyleft, und niemand hatte es
   entschieden. Jetzt steht es im Manifest mit Grund.
5. **Eine Ausnahme (`licenses.exceptions`) für `lightningcss` statt eines
   Geltungsbereichs-Eintrags.** Verworfen: Es ist kein Einzelfall, sondern eine
   Kategorie (Bauzeit-Werkzeug, Datei-Copyleft, keine Auslieferung). Eine Ausnahme würde
   die Kategorie verstecken; der `development`-Bereich sagt sie.

## Affected packages

| Paket | Auswirkung |
|---|---|
| kein Produktionscode | Dieses ADR ändert **keine** Quelldatei in `packages/`, `apps/` oder `tools/*`-Laufzeit |
| `tools/architecture/` | neuer Prüfer; `check-dependencies.mjs` validiert den neuen Abschnitt mit |
| `tests/architecture/` | `licenses.test.ts` (12 Tests) |
| `package.json` | `check:licenses`; `ci` ruft es zusammen mit `check:api` |
| `architecture/architecture.yaml` | Abschnitt `licenses` mit zwei Geltungsbereichen und leerer Ausnahmeliste |

## Forbidden implementations

- **Eine Lizenz ohne Eintrag dulden.** Unbekannt = Verstoß.
- **Eine Ausnahme ohne Datum.** Sie entschuldigt nichts (fail closed).
- **Eine erlaubte Lizenz gleichzeitig als verboten führen.** Der Schema-Check macht das
  zum Fehler; `forbidden` gewinnt in der Auswertung.
- **Die Lizenz der Workspace-Pakete hier prüfen.** Das ist eine Manifest-Aussage und
  gehört `manifests.test.ts` (eine Regel, ein Ort).
- **`forbidden` dazu benutzen, eine unbequeme Kategorie zu verbieten, ohne `why`.** Der
  Schema-Check verlangt die Begründung an beiden Geltungsbereichen.

## Migration

1. Abschnitt `licenses` in `architecture.yaml` (mit dem gemessenen Befund zum
   MPL-2.0-Anteil).
2. `node tools/architecture/check-licenses.mjs` → EXIT 0 auf dem aktuellen Lockfile.
3. `check:licenses` in `npm run ci`.
4. Biss-Test und Fixtures in `tests/architecture/licenses.test.ts`.
5. Register nachziehen: `docs/standards/conformance.md` (Supply Chain) und
   `docs/standards/csms.md` (Schwachstellen-/Lieferkettenprozess) — im selben PR
   (Regel 34.24).

## Tests

Gemessen am Stand dieses ADR (Node v22.22.3, Lockfile v3):

- `node tools/architecture/check-licenses.mjs` →
  `license rule: 108 third-party packages (0 production, 108 development), every licence
  inside the policy.` (EXIT 0)
- `tests/architecture/licenses.test.ts` — 12 Tests: Verdrahtung, „nicht leer" (≥ 50
  gescannte Pakete), `0 production` als gemessene Aussage, Begründungen in beiden
  Geltungsbereichen, Fixtures für: GPL im Entwicklungswerkzeug, `AND`- gegen
  `OR`-Semantik, Ausnahmeklausel behält Copyleft, unbekannte Lizenz, fehlende Lizenz,
  MPL-2.0 im Entwicklungsbereich (grün) gegen MPL-2.0 im Produktionsbereich (rot),
  datierte/abgelaufene/undatierte Ausnahme, unbenutzte und veraltete Ausnahme, eigener
  Code wird nicht gescannt, halbe Richtlinie (EXIT 2).
- `node tools/architecture/check-dependencies.mjs` → EXIT 0 (`29 packages placed, 92
  edges, 6 rules`), inklusive der neuen Schema-Prüfungen für `licenses`.

## AI implementation notes

- Eine neue Abhängigkeit heißt: erst die Lizenz **lesen**, dann entscheiden. Steht sie
  nicht in `allowed`, ist der Ort der Entscheidung `architecture.yaml` — nicht ein
  `npm install` und ein grüner Lauf danach.
- Ein Fixture-Test darf die Lizenzprüfung **nicht** umgehen, indem er die Richtlinie
  kopiert: `licenses.test.ts` reicht die echte Richtlinie aus `architecture.yaml` durch.
- Eine Ausnahme im Manifest braucht ein Datum in der Zukunft und einen Grund, den ein
  Reviewer nachvollziehen kann; sie ist ein Befund mit Ablauf, nicht ein Freibrief.
- Der Produktionsbereich ist heute leer. Wer ihn füllt, ändert damit die Aussage dieses
  ADR und muss im selben PR begründen, was ausgeliefert wird.
