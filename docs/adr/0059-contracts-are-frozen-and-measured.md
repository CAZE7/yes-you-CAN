# ADR 59 — Verträge sind eingefroren und gemessen: der öffentliche API-Record und die Verteilungsgrenze

- Status: akzeptiert (2026-09-23)
- Kontext: ADR 0002 (keine Laufzeit-Abhängigkeiten), ADR 0031/0042/0043 (eine Quelle,
  Werkzeug statt Regel-Kopie), ADR 0038 (die Analyse liest Belege), ADR 0047/0057
  (Integrität und Signatur), AGENTS 24/26/34.12/34.24/35,
  `docs/architecture/open-core-dual-licensing.md` (Kapitel 1 und 4, Phase 1/2)
- Betrifft: `architecture/architecture.yaml` (neuer Abschnitt `contracts`),
  `architecture/public-api.json` (neu), `tools/architecture/check-api.mjs` (neu),
  `tools/architecture/check-package-manifests.mjs` (neue Regel),
  `tools/architecture/impact.mjs` (`loadManifest`/`packageDirs` nehmen ein optionales
  `root`), `package.json` (`check:api`, `ci`), `tests/architecture/api.test.ts` (neu),
  `tests/architecture/manifests.test.ts` (zwei Fixture-Tests), `ARCHITECTURE.md`,
  `CONTRIBUTING.md`, `AGENTS.md`

## Problem

Das Repository ist ein offener Kern, und die Voraussetzung dafür, dass neben ihm ein
**geschlossener** Teil entstehen kann, ist eine Grenze, die sich *messen* lässt. Der
Importgraph ist bereits ein Gesetz (ADR 0015/0031/0042): 29 Pakete, 92 Kanten, 6 Regeln,
0 Verstöße. Zwei Fragen beantwortet er nicht:

1. **Welche Fläche ist überhaupt Vertrag?** Alle Pakete sind heute gleich „öffentlich",
   und nichts unterscheidet `@vdp/diagnostic-ir` (das ein fremdes Modul liest und
   erzeugt) von `@vdp/reports` (das ein Kunde nie einbindet). Ohne diese Unterscheidung
   gibt es keine Grenze, nur eine Gewohnheit.
2. **Hat sich diese Fläche geändert?** Eine Signaturänderung in `@vdp/domain` bricht ein
   Modul, das gegen die *veröffentlichte* Version kompiliert wurde — und zwar erst dort,
   nicht hier. Kein Gate des Repos sah das: `check:deps` liest Quellen, `check:manifests`
   liest Manifeste, `hygiene.test.ts` liest Dateigrößen. Die *Kompilierfläche* las
   niemand.

Dazu kam die zweite Hälfte derselben Grenze: `check:manifests` prüfte, dass ein Paket
nichts Unerklärtes importiert — nicht, ob ein **veröffentlichbares** Paket von einem
**privaten** abhängt. Genau diese Kante entsteht beim Open/Closed-Split als erste, und
sie scheitert beim Kunden statt bei uns.

## Entscheidung

1. **`architecture.yaml` bekommt einen Abschnitt `contracts`.** Er benennt die Flächen,
   gegen die ein *anderes* Repository bauen darf — mit `why`, und mit optionalem `entry`,
   wenn der Vertrag ein **Modul** ist und nicht das Paket
   (`@vdp/core` → `dist/src/logging/integrity.d.ts`, `@vdp/protocols-uds` →
   `dist/src/security.d.ts`).
2. **`tools/architecture/check-api.mjs`** hüllt die emittierten Deklarationen ein:
   Ausgehend von **jedem Typ-Einstiegspunkt** — dem `types`-Feld *und* jedem
   `types`-Eintrag der Subpfad-`exports` (ein explizites `entry` in der YAML ersetzt die
   Menge und meint: „nur dieses Modul") — folgt es den `from "…"`-Spezifizierern
   **transitiv**, entfernt Kommentare, normalisiert Whitespace und hasht. Das Ergebnis
   steht in **`architecture/public-api.json`** (Format `vdp.public-api`, Version 2:
   eine Fläche ist eine *Menge* von Einstiegspunkten) — eine Datei, die committet wird,
   weil sie das Versprechen *ist*.
3. **`check:api` fällt bei Drift** (EXIT 1) und nennt die geänderte Datei
   (`~ dist/src/config.d.ts`, `+ dist/src/deep.d.ts`). `--update` schreibt den Record neu
   und **sagt, was es geändert hat**; eine stille Aktualisierung wäre genau der
   Unfall, den das Gate verhindern soll.
4. **Ein Kommentar ist nicht die Fläche, und Prosa ist kein Import.** Kommentare und
   Whitespace werden vor dem Hashen entfernt (eine Wortunstellung darf nicht „cry wolf"
   rufen), und die Spezifizierer werden aus dem *normalisierten* Text gelesen — der erste
   Lauf des Werkzeugs erfand sonst eine Abhängigkeit auf ein Paket namens
   `we never reached it`, weil ein Doc-Kommentar genau so aussah.
5. **`check-package-manifests.mjs` bekommt `private-dependency-leak`:** Ein Paket ohne
   `private: true` (also veröffentlichbar) darf in `dependencies`,
   `optionalDependencies` oder `peerDependencies` keine private Workspace-Abhängigkeit
   nennen. `devDependencies` sind ausgenommen — npm installiert sie für eine Dependency
   nicht, und die Begründung steht als Kommentar an der Regel.
6. **`--update` schreibt nichts über einen kaputten Zustand.** Ein Tippfehler in
   `contracts` ist keine Drift, sondern ein Defekt: `--update` bricht dann mit EXIT 1 ab
   und lässt die Datei unangetastet.

## Why

- **Ein Vertrag, den niemand messen kann, ist eine Absicht.** Der Record macht die
  Änderung *sichtbar*: sie erscheint als Diff in `architecture/public-api.json` in genau
  dem PR, der sie verursacht — und der Reviewer entscheidet über Version und
  Migrationshinweis, statt sie zu übersehen.
- **Ein Subpfad ist Teil des Versprechens.** Wer
  `import type { VagPackage } from "@vdp/definitions/vag"` schreibt, kompiliert gegen
  *diese* Datei. Gemessen wird deshalb die Vereinigung über alle Typ-Einstiegspunkte
  (`@vdp/definitions` deklariert fünf: `.`, `./generic`, `./vag`, `./mercedes`,
  `./simulator`). Dass der transitive Lauf sie heute ohnehin erreicht, weil `index.d.ts`
  alles re-exportiert, ist Zufall — und ein Gate darf sich nicht auf Zufall stützen.
- **Der transitive Lauf ist der Punkt, nicht ein Detail.** Eine geänderte Type, die der
  Vertrag *referenziert*, bricht einen gepinnten Konsumenten genauso wie eine geänderte
  Signatur. Wer nur die Exporte des Einstiegspunkts hasht, hat ein Gate mit Loch:
  `dist/src/logging/integrity.d.ts` zieht `session-logger`, `recorder`, `decoder` und
  `types` mit — fünf Dateien, und alle fünf gehören zu dem, was ein Speicher-Backend
  einhält.
- **Der Emissions-Record statt der Quellen.** Das Versprechen wird gegenüber einem
  *Konsumenten des gebauten Pakets* gemacht; `dist` + `.d.ts` ist genau das, was ein
  veröffentlichtes Paket enthielte. Quelldateien wären eine zweite Wahrheit über
  dieselbe Fläche.
- **Die Verteilungsregel gehört ins Manifest-Werkzeug.** „Wer darf was importieren" und
  „wer darf was veröffentlichen" sind zwei Fragen; die zweite ist eine Eigenschaft des
  Manifests (`private`) — und `check-package-manifests.mjs` ist der Ort, an dem
  Manifest-Aussagen gegen die Wirklichkeit gehalten werden (ADR 0042).

## Alternatives

1. **Ein neuer Layer `contract` für die Vertragspakete.** Verworfen: den Layer gibt es
   bereits (`contract`: domain, diagnostic-ir, definitions), und er beantwortet die
   falsche Frage — er sagt, dass ein Paket nichts importiert, nicht, dass seine Fläche
   fremden Code trägt. `@vdp/ai`, `@vdp/protocols-oem` und `@vdp/protocols-uds` sitzen in
   anderen Layern und sind trotzdem Verträge.
2. **Ein `contract: true`-Flag an jedem Paket-Eintrag.** Verworfen: Die Fläche ist eine
   *Beziehung* („ein anderes Repository baut dagegen"), kein Rang. Ein Flag an einem
   Paket hätte außerdem keinen Ort für `entry` — und genau das braucht die
   Seed&Key-Naht, die in einem großen Paket liegt.
3. **`api-extractor`, `tsd`, `dts-critic` als Dev-Dependency.** Verworfen nach ADR
   0002/0010: Die Frage „hat sich die Fläche geändert" ist ein Hash über einen
   transitiven Lauf — rund 120 Zeilen ohne Abhängigkeit, in derselben Bauart wie die
   drei vorhandenen Prüfer, und ohne Lockfile-Bewegung.
4. **Den Record generiert lassen (nicht committen).** Verworfen: Ein Record, der im
   Build entsteht, hat nichts, wogegen er geprüft werden könnte. Dann wäre er eine
   Momentaufnahme und keine Zusage.
5. **Die Verteilungsregel in `check-dependencies.mjs`.** Verworfen: Dort geht es um
   Kanten zwischen *Paketen*, nicht um `private`-Felder. Zwei Fragen, zwei Werkzeuge —
   aber ein Gate (`npm run ci`).

## Affected packages

| Paket | Auswirkung |
|---|---|
| `@vdp/diagnostic-ir`, `@vdp/domain`, `@vdp/definitions`, `@vdp/protocols-oem`, `@vdp/ai`, `@vdp/core`, `@vdp/protocols-uds` | als **Verträge** deklariert; ihre emittierte Fläche (49 Dateien) ist ab jetzt ein Record. Keine Code-Änderung. |
| alle übrigen 22 Pakete | keine Änderung; `private: true` bleibt die Regel des ganzen Baums (`manifests.test.ts`) |
| `tools/architecture/` | neues Prüfwerkzeug, erweiterte Manifest-Regel, `impact.mjs` nimmt ein `root` (Fixture-Baum) |
| `tests/architecture/` | `api.test.ts` (neu), zwei Fixture-Tests in `manifests.test.ts` |
| `package.json` | `check:api`; `ci` um `check:api` und `check:licenses` erweitert |

## Forbidden implementations

- **Den Record in der Hand pflegen.** Er kommt aus `--update`, sonst driftet er gegen
  den Build — und ein Record, der nicht der Build ist, ist schlimmer als keiner.
- **Einen Vertrag ändern, um ein Closed-Modul passend zu machen.** Der Vertrag wird
  versioniert; das Modul zieht nach (`open-core-dual-licensing.md` §1.3).
- **`--update` als Antwort auf eine Drift-Meldung, ohne Version zu entscheiden.** Der
  Diff ist der Review-Prompt; der ADR sagt, was danach kommt.
- **Ein veröffentlichbares Paket, das eine private Abhängigkeit deklariert.** Der
  Komfort einer gemeinsamen `dependencies`-Zeile ist die Ursache, nicht die Ausnahme.
- **Den `entry` auf eine Quelldatei zeigen lassen.** Gemessen wird die emittierte
  Fläche; alles andere wäre eine zweite Wahrheit über sie.
- **Die Messung auf `types` verkürzen oder einen Subpfad-`types` entfernen, um einen
  Drift loszuwerden.** Die Fläche wird nicht kleiner, indem man aufhört, sie anzusehen.

## Migration

1. `contracts` in `architecture.yaml` setzen (7 Flächen, jede mit `why`).
2. `npm run build && npm run check:api -- --update` → `architecture/public-api.json`
   (Format 2) erzeugen und committen. Der Record ist versioniert: ein Record aus einer
   älteren Werkzeugfassung beschreibt eine andere Messung, deshalb verweigert der Check
   ihn mit Grund statt Drift zu erfinden — `--update` ist die Antwort.
3. `check:api` in `npm run ci` aufnehmen (nach dem Build).
4. Biss-Test (`tests/architecture/api.test.ts`) und Verteilungsregel-Fixtures
   (`manifests.test.ts`) sind Teil dieses ADR.
5. Beim ersten Paket des geschlossenen Teils (`@vdp/enterprise-*`, Phase 2/3 des
   Konzepts) kommt die YAML-Kantenregel **in denselben PR**: `layerRules`-Präfixe
   müssen ein Paket treffen (`blind-prefix`), deshalb darf die Regel nicht vor den
   Paketen entstehen.

## Tests

Gemessen am Stand dieses ADR (`npm run ci`, Node v22.22.3):

- `node tools/architecture/check-api.mjs` → `public API rule: 7 contracts, 49 surface
  files, 5 external type source(s) — the record is the build.` (EXIT 0)
- Biss-Probe von Hand: eine Zeile an `packages/domain/dist/src/capabilities.d.ts`
  angehängt → `✗ [contract-drift] @vdp/domain … ~ dist/src/capabilities.d.ts` (EXIT 1);
  zurückgesetzt → EXIT 0.
- `tests/architecture/api.test.ts` — 13 Tests: Verdrahtung im `ci`-Pfad und **nach** dem
  Build, Record ⇔ Manifest-Gleichheit, Version gegen `package.json`, Fixtures für Drift
  (Datei benannt), Kommentar-Änderung (kein Drift), transitive neue Datei (`+ …`),
  **Subpfad-Export ohne Re-Export aus `index.d.ts`** (beide Einträge im Record, Änderung
  dahinter = `~ dist/src/deep.d.ts`), Prosa-Regression (`external` bleibt leer),
  `version-drift`, `stale-api-entry`, fehlender Build (EXIT 2 mit Grund), leere
  `contracts` (EXIT 2), Tippfehler wird von `--update` nicht gesegnet (EXIT 1, keine Datei
  geschrieben).
- `tests/architecture/manifests.test.ts` — zwei neue Tests: `private-dependency-leak`
  beißen lassen, und die beiden Formen, die **nicht** beißen (beide Seiten privat;
  nur `devDependencies`).
- `node tools/architecture/check-dependencies.mjs` → `29 packages placed, 92 edges,
  6 rules` / `no violations.` (EXIT 0) — die Schema-Erweiterung validiert `contracts`
  mit (unbekannte Schlüssel, fehlendes `why`, `entry`-Typ, nicht platziertes Paket).

## AI implementation notes

- Vor einer Änderung an einem Vertragspaket: `npm run check:api` **nach** `npm run
  build`. Rot heißt „der Record ist älter als die Fläche", nicht „der Code ist falsch".
- Eine bewusste Vertragsänderung: Version entscheiden, `--update`, und beide Dateien
  (`public-api.json` **und** die geänderte Deklaration) in denselben PR.
- Niemals `--update` benutzen, um eine Drift-Meldung „wegzumachen", ohne im PR-Text zu
  sagen, was sich für einen Konsumenten ändert (Regel 34.21: Messung vor Behauptung).
- Ein neues Vertragspaket ist ein Eintrag in `contracts` mit `why` — und für Module ein
  `entry`, keine Umbenennung des Pakets.
