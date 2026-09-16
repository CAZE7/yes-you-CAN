# ADR 43 — Die AI-Kontextschicht: eine Doku-Ebene über einer maschinenlesbaren Architektur

- Status: akzeptiert (2026-09-16)
- Kontext: ADR 0031 (Architekturregel als Werkzeug mit einer Quelle), ADR 0042
  (Manifest ⇔ Importgraph), ADR 0002 (keine Laufzeit-Abhängigkeiten),
  AGENTS 34 (Regeln für Coding Agents), Master-Backlog P0 #2
- Betrifft: `architecture/architecture.yaml` (neu, ersetzt
  `tools/architecture/dependency-rules.json`), `tools/architecture/check-dependencies.mjs`,
  `tools/architecture/ai-context.mjs` (neu), `ARCHITECTURE.md` (neu),
  `docs/code-map.md`, `docs/glossary.md`, `docs/api/*`, `docs/flows/*` (neu),
  `.ai/` (neu), `tests/architecture/*`, alle Package-`README.md` (neu),
  `tests/examples/*` (neu), `vitest.config.ts` (Projekt `integration`),
  `package.json` (`ai:context`), `.gitignore`, `AGENTS.md` (Abschnitt 0.0)

## Problem

Das System ist strukturell gut genug, damit sich Doku lohnt — aber ein
Mensch oder ein Coding-Agent muss noch viel über Imports, Dateien und
Implementierungsdetails **rekonstruieren**: die Abhängigkeitsregeln liegen
in einer JSON-Datei neben dem Checker, das Wissen „wo ändere ich was“ und
„welche Verträge darf ich nicht brechen“ steckt in ADRs, Changelogs und
Kopfkommentaren, und es gibt keinen Einstiegspunkt, von dem aus das gesamte
System in einer Lesesitzung verständlich ist. Für Coding-Agenten ist das der
engpass: wer den Baum durchsuchen *muss*, trifft Architekturentscheidungen
auf halber Information.

## Entscheidung

1. **`architecture/architecture.yaml` ist die eine Quelle** für
   Abhängigkeitsregeln *und* AI-Kontext: die Regel bleibt eine Datei
   (ADR 0031), sie bekommt (a) die **Layer-Zuordnung** jedes Pakets und
   (b) die **AI-Context-Topics** (Pakete + ADRs + Doku + Flows + Beispiele
   pro Thema). Der Dependency-Checker liest dieselbe Datei — eine Quelle,
   ein Werkzeug, ein Gate, eine Doku-Basis (ADR 0031/0042, fortgeführt).
2. **Die Datei ist JSON-Syntax in einem `.yaml`-Namen.** YAML 1.2 umfasst
   JSON; Node liest sie mit `JSON.parse` ohne Laufzeit-Abhängigkeit
   (ADR 0002), und jeder YAML-Reader liest sie ebenfalls. Ein YAML-Parser
   wäre eine Abhängigkeit für einen Kommentar-Notstand, den niemand
   braucht.
3. **`ARCHITECTURE.md`** ist der menschliche Einstiegspunkt am
   Repository-Root: Schichten mit Purpose/Allowed/Forbidden/Entry
   points/Contracts/Tests, die harten (maschinellen) Verträge, und
   Verweise auf alles Weitere. Sie **restatet keine Kanten** — die stehen
   nur im YAML.
4. **Jedes Workspace-Paket trägt eine `README.md`** mit fixem Aufbau:
   Purpose / Responsibilities / **Does NOT do** / Public API / Dependencies /
   Data Flow / Important invariants / Tests / Examples. „Does NOT do“ ist
   die für Agenten wertvollste Sektion: sie sagt, wohin eine Änderung
   *nicht* gehört, bevor der Agent sie dorthin schiebt.
5. **`AGENTS.md` wird zur AI Engineering Contract** (neuer Abschnitt 0.0):
   ein verbindliches Vor-Checkliste-Protokoll und eine Forbidden-Liste
   (WritePort-Bypass, UI→Transport, private Implementation-Casts,
   neue Abhängigkeit ohne Begründung, doppelte Protokoll-Logik).
6. **ADRs tragen „Implementation Impact“**: ab ADR 0043 sind die
   Abschnitte *Affected packages*, *Forbidden implementations*, *Migration*,
   *Tests* und *AI implementation notes* Pflicht (siehe
   `docs/adr/README.md`). Ältere ADRs bleiben, wie sie sind — sie sind
   Aufzeichnungen, keine Vorlagen.
7. **`docs/code-map.md`** ist die Aufgabe→Stelle-Karte; **`docs/glossary.md`**
   der Vokabel-Vertrag (ein Begriff = eine Bedeutung); **`docs/api/*`** der
   Public-API-Index; **`docs/flows/*`** die Pipeline-Karten.
8. **`.ai/`** ist die vorbereitete AI-Kontextschicht: kurze, kuratierte
   Lesepakete (Architektur, Code-Map, Invarianten, Workflows, Verträge pro
   Domäne, Tasks für häufige Änderungen). `.ai/` ist **Navigation, keine
   Quelle** — es verweist, es kopiert keine Regeln.
9. **`npm run ai:context <topic>`** generiert aus demselben YAML ein
   Kontext-Bundle nach `.ai/generated/<topic>-context.md` (Architektur-
   Regeln, relevante Pakete, Public APIs, ADRs, Flows, Beispiele,
   Invarianten). Generierte Artefakte werden nicht committet
   (`.gitignore`).
10. **Tests als ausführbare Dokumentation:** `tests/examples/*.example.ts`
    zeigt die vier typischen Pfade (Read, DTC-Analyse, Evidence-Flow,
    Simulator-Szenario) als lauffähige Tests — „so wird diese API benutzt“.

## Why

- **Eine Quelle statt vieler:** die Regel, die Layer, die Topics und die
  generierten Kontexte hängen an derselben Datei — eine Regeländerung
  ändert alle, und der Checker fällt, wenn die Doku von der Regel
  abweicht.
- **Kleiner, relevanter Agent-Kontext:** `ai:context uds` liefert die
  UDS-Welt in einer Datei statt des halben Repositories — genau das, was
  ein Coding-Agent für eine UDS-Änderung lesen soll.
- **Keine Code-Kommentar-Flut:** Kontext gehört in die richtige
  Doku-Ebene (README/ADR/Flow), nicht in jede Funktion — der Code bleibt
  lesbar, die Doku versioniert.

## Alternatives

- **YAML-Parser als Dev-Dependency** (z. B. `yaml`): abgelehnt — ADR 0002
  verbietet Laufzeit-Abhängigkeiten ohne Maintenance-Nachweis; die
  JSON-Syntax liefert dieselbe Datei für beide Reader ohne Parser.
- **Jede Datei mit Architekturkommentaren versorgen**: abgelehnt —
  macht den Code schlechter, erzeugt zweite Regel-Kopien in Kommentaren
  und ist der genaue Fall, den ADR 0031/0042 beseitigt haben.
- **`.ai/` als generierter Spiegel von ARCHITECTURE.md**: abgelehnt —
  ein Spiegel ist eine zweite Quelle. `.ai/` verweist; es ist Navigation.
- **Alles in `AGENTS.md` konzentrieren**: abgelehnt — die Datei ist das
  normative Regelwerk; Doku, die dort *über* das Regelwerk erklärt,
  konkurriert mit ihm um die Autorität.

## Affected packages

| Paket | Auswirkung |
|---|---|
| (keine `packages/*`-Quellen) | Dieses ADR ändert **keinen** Produktions-Code — nur Doku, Tools, Tests und die Regeldatei |
| `tools/architecture/` | Checker liest `architecture/architecture.yaml`; neuer `ai-context.mjs` |
| `tests/architecture/` | Pfade auf das Manifest aktualisiert; neuer `ai-context.test.ts` |
| `tests/examples/` (neu) | Ausführbare Doku, läuft im Projekt `integration` |
| `vitest.config.ts` | Projekt `integration` pickt `tests/examples/**/*.example.ts` auf |
| `package.json` | Skript `ai:context`; `check:deps` unverändert (liest jetzt das YAML) |
| `docs/adr/README.md` | Neues Pflicht-Template ab ADR 0043 |

## Forbidden implementations

- **Keine zweite Regel-Kopie:** `ARCHITECTURE.md`, `.ai/*`, `docs/*` und
  package-READMEs dürfen die `mayImport`-Kanten nicht neu auflisten —
  nur verweisen (Test: `dependencies.test.ts` „the rule lives in exactly
  one file“; der Manifest-Gate prüft die Kanten).
- **Kein YAML-Parser:** `architecture.yaml` bleibt JSON-parsbar;
  Kommentare im YAML-Flow-Stil sind keine Option (ADR 0002).
- **Kein generiertes `commit`:** `.ai/generated/` ist kein Teil des
  Commits (`.gitignore`), sonst entsteht eine zweite, veraltete Quelle.
- **Kein `.ai/`-Inhalt als Autorität:** bei Widerspruch zwischen `.ai/*`
  und `architecture.yaml`/package-README/ADR gilt die tiefere Ebene
  (AGENTS 34.24).
- **Keine Beispieldatei außerhalb von `tests/examples/`** als „ausführbare
  Doku“ — der Ort ist einer, der im Projekt `integration` läuft.

## Migration

1. `tools/architecture/dependency-rules.json` → `architecture/architecture.yaml`
   (Inhalt erhalten, `layer` + `topics` ergänzt, `schemaVersion` 1 → 2);
   die alte Datei ist gelöscht — ein zweiter Stand wäre eine zweite Regel.
2. `check-dependencies.mjs`: `DEFAULT_RULES` auf das YAML, `checkSchema`
   validiert die neuen Schlüssel (`layers`, `layer` je Paket, `topics`-
   Struktur, ADR-Nummern) — ein Tippfehler sieht nicht wie eine
   bestehende Regel aus.
3. `dependencies.test.ts`/`guardrails.test.ts`: Pfade + Assertions auf das
   Manifest (darunter: jedes Paket hat einen Layer).
4. Doku-Ebene neu (dieses ADR): `ARCHITECTURE.md`, 28 Package-READMEs,
   `docs/{code-map,glossary}.md`, `docs/api/*`, `docs/flows/*`, `.ai/*`,
   `tests/examples/*`.
5. Für künftige ADRs gilt das neue Template rückwirkend ab ADR 0044.

## Tests

- `npm run check:deps` — liest das YAML, 27 Pakete platziert, 0 Verletzungen
  (Schema inkl. Layer/Topics validiert; Exit 2 bei Malformation).
- `tests/architecture/dependencies.test.ts` — Regel lebt genau in einer
  Datei, jedes Paket platziert **und gelayert**, Werkzeug in der CI.
- `tests/architecture/ai-context.test.ts` (neu) — für jedes Topic:
  Generator läuft, Bundle existiert, enthält alle Pakete/ADRs; unbekannte
  Topics fallen mit Exit 2; alle Doku-/Flow-/Beispiel-Referenzen des
  Manifests zeigen auf echte Dateien.
- `tests/examples/*.example.ts` (neu) — die vier Pfade als lauffähige
  Integrationstests (Projekt `integration`).
- `npm run ci` — alles zusammen als ein Tor.

## AI implementation notes

Wenn du als Coding-Agent diese ADR umsetzt oder darauf aufbaust:

1. **Starte bei einer Änderung immer bei `architecture/architecture.yaml`**
   (Layer + Kanten + Topics) — nicht bei einem README.
2. **Neues Paket:** Eintrag unter `packages` (Layer + `mayImport` + `why`)
   *vor* dem ersten Import; `check:deps` fällt sonst mit `unplaced-package`.
   Die Layer-Vokabel kommt aus `layers` — ein neuer Layer-Name braucht
   zuerst einen Eintrag dort.
3. **Neue AI-Context-Topics** (z. B. `doip`): Eintrag unter `topics` mit
   `title`, `summary`, `packages` (nur deklarierte Pakete), `adrs`
   (4-stellig), `docs`/`flows`/`examples` (relative Pfade, müssen existieren
   — der Test prüft das).
4. **README-Änderung:** die Sektionsreihenfolge bleibt; „Does NOT do“ wird
   bei jeder neuen Verantwortung *negativ* ergänzt (was jetzt nicht mehr
  darfst).
5. **Doku-Drift ist ein Defekt** (AGENTS 34.24): ändert sich eine Regel,
   werden YAML + ARCHITECTURE.md + betroffene READMEs + ADR in *einem* PR
   aktualisiert.
6. **Keine Kommentare-Flut im Code:** Architekturwissen wandert in README/
   ADR/Flow, nicht in die Funktion — die Datei-Kopfkommentare tragen die
   Verweise, nicht die Regel.
