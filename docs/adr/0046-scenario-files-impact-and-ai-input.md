# ADR 46 — Szenariodateien, Next-Test in der Analyse und Impact aus einer Quelle

- Status: akzeptiert (2026-09-18)
- Kontext: ADR 0038 (Evidence Engine — die Analyse liest nur Belege), ADR 0040
  (Fahrzeugmodell + Szenario-Engine), ADR 0043 (AI-Kontextschicht, Topics +
  `ai:context`), AGENTS 22/27 (nichts erfinden, VIN raus), Master-Prompt §14/§22/§23
- Betrifft: `tools/simulators/src/scenario-file.ts` (neu) + `index.ts`,
  `scenarios/alternator_failure.json` (neu geschrieben), `tools/simulators/scenario.schema.json`,
  `scenarios/README.md`, `packages/ai/src/{types,heuristic,http,prompt,provenance}.ts`,
  `apps/web/src/{analysis-input,backend}.ts`, `apps/web/test/analysis-input.spec.ts`,
  `tools/architecture/impact.mjs` (neu), `tools/architecture/ai-context.mjs`
  (`--changed`), `package.json` (`architecture:impact`, `ai:context:changed`),
  `tests/integration/scenario-file.test.ts` (neu), `tests/architecture/impact.test.ts` (neu)

## Problem

Drei offene Enden, dieselbe Wurzel — *Input, das keine Provenance trägt*:

1. Die Szenarien unter `scenarios/` waren Daten ohne Lader: jede Datei war eine
   Behauptung über die Simulator-API, nichts prüfte sie. Die Beispieldatei
   schrieb Erwartungen, die das gemessene Modell nie produzierte.
2. Die Analyse wusste nicht, *worauf* sie antwortete: kein Verweis auf die
   Aufnahme, aus der die Belege stammten, kein Verweis auf ein Lauf-Szenario —
   und sie schlug keinen nächsten Test vor, obwohl die Hypothesen ihn schon
   trugen (`Hypothesis.nextTest`).
3. Impact-Fragen („wenn ich das ändere, was muss dann nochmal laufen?“)
   beantwortete der Baum nicht: die Kanten stehen nur im Manifest (ADR 0031/0043),
   und `architecture:impact` / `ai:context:changed` waren als Skripte versprochen.

## Entscheidung

1. **Szenariodatei ist eine strenge, eigene Form.** `parseScenarioFile`
   (`tools/simulators/src/scenario-file.ts`) übersetzt declaratives JSON in
   `VehicleScenario` + `ScenarioStep[]`: `determinism` ist Pflicht, Schritte
   werden zu kausalen Modellschritten, `battery_voltage`-Bedingungen als
   Vergleichsobjekt, DTCs flach *und* verschachtelt, `offline: true` als
   ECU-Zucker. **Kein Parser-Raten:** ein unbekanntes Feld, ein fehlender
   Seed-Widerspruch, ein `engine`-Setter (den es nicht gibt) — Absage mit
   Grund. Der Loader kennt keine Engine-Setzer, weil das Modell keine hat.
2. **Das Beispiel ist nachgemessen, nicht erfunden.**
   `scenarios/alternator_failure.json` trägt den gemessenen Ausgang (Seed
   4242; `B1001` aktiv am BCM ab ≈ 8 s; `battery_voltage < 12.0` nach
   `wait 9000` — gemessen 10.77 V bei 10 s). Schema und `scenarios/README.md`
   beschreiben exakt die Loader-Grammatik — Doku-Stand = Code-Stand (34.24).
3. **Die Analyse nennt Aufnahme, Szenario und den nächsten Test.**
   `AnalysisInput.recordingId` (die Session-Id der Aufnahme, nicht ein neuer
   Deckname) und `AnalysisInput.scenario` (id/title/seed, absent wenn kein
   Lauf-Szenario) sind Teil des Vertrags (ADR 0038-Konsequenz: *was* die
   Antwort trägt, ist zitierfähig); `AnalysisResult.nextTest?:
   DiscriminatingTest` liefert den ersten nicht-widerlegten Vorschlag der
   Hypothesen — Heuristik direkt, HTTP-Provider über den Zitat-validierenden
   Parser; `provenance.recordingId` schreibt die Herkunft in die Antwort.
   Prompt-Fassung: `2026-09-16.1`.
4. **Impact liest die eine Quelle.** `tools/architecture/impact.mjs` beantwortet
   `datei|paket → seeds, affected (transitive Umkehrung der `mayImport`-Kanten),
   relevante ADRs (Namens-Scan in `docs/adr/` + Topic-Zuweisung), zu laufende
   Tests (ko-lokierte Specs + `tests/**`-Importe) und Topic-Bundles — als
   Markdown oder `--json`; `--changed [base]` sammelt die Git-Diff-Dateien.
   `npm run ai:context:changed` schreibt `.ai/generated/changed-context.md` —
   die Union der betroffenen Topic-Bundles, generiert wie alle Bundles (ADR
   0043), mit demselben Dateibaum aus `impact.mjs` als gemeinsamem Kern statt
   zweiter Mechanik.
5. **Kein Schatten-Graph.** Beide Werkzeuge lesen `architecture/architecture.yaml`
   und nichts anderes; Dateien außerhalb von Workspace-Paketen (Docs, das
   Manifest selbst) werden als *unmapped* ausgewiesen, statt sie einem
   erfundenen Paket zuzuordnen.

## Why

- **Input mit Provenance statt Rekonstruktion:** Aufnahme-Id + Szenario im
  Analyse-Input machen die Antwort nachvollziehbar („was wurde wann, womit,
  mit welchem Script beobachtet“) — die Kette, die ADR 0038 für Belege
  verlangt, endet nicht beim Provider.
- **Der nächste Test ist schon da:** `DiscriminatingTest` existiert in den
  Hypothesen; die Analyse muss nur den führenden, nicht-widerlegten nennen —
  erfinden darf sie nichts, und zitiert werden muss auch der Vorschlag
  (`http.ts` validiert die Citation, sonst `undefined`).
- **Wiederverwendung statt Parallelwerkzeug:** `impact.mjs` exportiert die
  Helpers (`packageDirs`, `gitChangedFiles`, `filesToPackages`,
  `analyzeImpact`), `ai-context.mjs --changed` importiert sie — eine Mechanik,
  zwei Befehle (ADR 0031).

## Alternatives

- **Szenariodateien per `JSON.parse` direkt als `VehicleScenario`
  durchreichen:** abgelehnt — die API-Form und die Datei-Form sind
  unterschiedliche Abstraktionen (Bedingungen, Offline-Zucker, Determinismus-Pflicht);
  ein Direktpass macht die Dateiform zur API und verhindert spätere Grammatik ohne
  Bruch.
- **LLM soll den nächsten Test frei vorschlagen:** abgelehnt — Vorschläge ohne
  Anker an dokumentierte Checks sind das Gegenteil von ADR 0033; die
  Hypothesen-Kette hat ihn schon.
- **Impact als eigener YAML-Export („depends on“-Matrizen):** abgelehnt —
  zweite Quelle (ADR 0031); die Kanten sind im Manifest, der Rest ist
  Ableitung.

## Affected packages

- `tools/simulators`: `src/scenario-file.ts` (neu, exportiert über `index.ts`) —
  Schicht `tool` unverändert; `scenario.schema.json` + `scenarios/README.md`
  (Daten/Doku).
- `packages/ai`: `types.ts` (`AnalysisScenario`, `recordingId`/`scenario` auf
  `AnalysisInput`, `nextTest` auf `AnalysisResult`,
  `AnalysisProvenance.recordingId`), `heuristic.ts`, `http.ts`,
  `provenance.ts`, `prompt.ts` (Fassung). Schicht `ai`, keine neue Importkante.
- `apps/web`: `analysis-input.ts` (`sources.scenario`, `recordingId` aus
  `session.id`), `backend.ts` (`lastScenario` aus dem Szenario-Lauf).
- `tools/architecture`: `impact.mjs` (neu), `ai-context.mjs` (`--changed`).
- Root: `package.json` (`architecture:impact`, `ai:context:changed`);
  `tests/integration/scenario-file.test.ts`, `tests/architecture/impact.test.ts`
  (neu), `apps/web/test/analysis-input.spec.ts` (erweitert).

## Forbidden implementations

- **Kein zweiter Szenario-Lader.** `parseScenarioFile` ist der einzige Weg von
  Datei zu Modell; Web-UI und Tests verwenden ihn über `@vdp/simulators`.
- **Kein Engine-Setter in Loader oder Schema.** Das Modell hat keinen; eine
  Loader-Funktion „nur für Dateien“ wäre die zweite Wahrheit.
- **Kein `nextTest` ohne Zitat:** der HTTP-Pfad nimmt Vorschläge ausschließlich
  über den citation-validierenden Parser entgegen; Prosa ohne `basedOn`-Anker
  ist kein Ergebnis.
- **Kein erfundenes `recordingId`:** es ist die Session-Id der vorhandenen
  Aufnahme; ohne Session bleibt das Feld absent (AGENTS 22).
- **Kein zweiter Abhängigkeitsgraph in `impact.mjs`:** die Datei importiert
  `architecture.yaml` und die Workspace-Manifeste — keine `depends-on`-Felder,
  keine Kopien von `mayImport`.

## Migration

1. Bestehende `scenarios/*.json` gegen `parseScenarioFile` validieren (der
   Integrationstest tut das für das Beispiel); alte Dateien, die nicht mehr
   passen, werden nachgezogen — das Schema folgt dem Loader, nie umgekehrt.
2. `npm run ai:context:changed` ersetzt bei Änderungen die Frage „welches
   Topic brauche ich?“; das generierte Bundle bleibt uncommittet (wie alle
   Bundles, ADR 0043).
3. Bestehende Analyse-Aufrufe (Workbench, HTTP-Provider) funktionieren
   unverändert: alle neuen Felder sind optional.

## Tests

- `tools/simulators/src/scenario-file.spec.ts` (12 Tests): Grammatik,
  Abweisungsgründe (unbekanntes Feld, `engine`-Setter, fehlender
  Determinismus, Bedingungsformen), Schritt-Mapping, Schritt-für-Schritt.
- `tests/integration/scenario-file.test.ts` (3 Tests): Datei → Modell → UDS
  0x19 → IR → Evidence die ganze Kette; zweimaliger Lauf identisch
  (Determinismus-Pflicht als Messung, nicht als Behauptung).
- `packages/ai/src/ai.spec.ts`: 6 neue Tests — `nextTestOf` (Heuristik),
  Citation-validierender HTTP-Pfad (gültig/ungültig), Prompt-Fassung,
  recordingId-Weiterreichung in Provenance.
- `apps/web/test/analysis-input.spec.ts`: recordingId aus `session.id`,
  scenario-Durchreichung, Absentheit ohne Session/Szenario.
- `tests/architecture/impact.test.ts`: die Skripte existieren, unbekannte
  Targets scheitern mit Exit 2, dieclosure-/ADR-/Test-Ableitung stimmt mit dem
  Manifest überein (positiv *und* negativ: Nicht-Importeure fehlen),
  `ai:context:changed` generiert gegen denselben Kern.

## AI implementation notes

- Szenario-Datei ändern? Erst `parseScenarioFile` lesen (die Grammatik lebt
  dort), dann `scenario.schema.json` und `scenarios/README.md` im selben PR
  (34.24).
- `buildAnalysisInput` ist die *einzige* Stelle, die Aufnahme/Szenario in den
  Provider-Input hebt — neue Kontextfelder gehören dort hin, nicht in
  `backend.ts`.
- Impact-Ausgabe ist eine Ableitung: was dort fehlt, fehlt, weil das Manifest
  die Kante nicht hergibt — nicht, weil der Impactor sie übersehen dürfte.
- Prompt-Fassung bei Satzänderungen bumpen (`prompt.ts`), Antwort-Parsing nur
  über die validierenden Parser in `http.ts`.
