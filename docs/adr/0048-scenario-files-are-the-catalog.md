# ADR 48 — Szenario-Dateien sind der Katalog, und der Seed läuft bis zum Lauf durch

- Status: akzeptiert (2026-09-19)
- Kontext: ADR 0046 (Szenariodateien als strenge Form), ADR 0040 (Verhaltensmodell +
  Szenario-Engine), AGENTS 31 (Determinismus schlägt Laufzeit), 0.E-Regel „zweite
  Kopie ist ein Defekt" (ADR 0031)
- Betrifft: `scenarios/*.json` (6 neue Dateien), `tools/simulators/src/scenario-library.ts`
  (neu), `scenario-catalog.ts` (gelöscht), `tools/simulators/src/index.ts`,
  `scenario-file.ts` (Grammatik erweitert), `tools/simulators/src/vehicle-model.ts`
  (`reseed`), `high-fidelity-vehicle.ts` (`runScenario`-Option `seed`),
  `apps/web/src/scenario-source.ts` (neu), `apps/web/src/backend.ts`,
  `tests/helpers/scenario-files.ts` (neu), `tests/integration/scenario-chain.test.ts`,
  `tests/examples/simulator-scenario.example.ts`, `apps/web/test/{scenario-view,adapters}.spec.ts`,
  `tools/simulators/scenario.schema.json`, `scenarios/README.md`

## Problem

ADR 0046 machte die Szenariodatei zur tragfähigen Form — und ließ zwei Fäden offen:

1. **Zwei Wahrheiten.** Neben `scenarios/alternator_failure.json` existierte weiter
   `SCENARIO_CATALOG` in `tools/simulators` — sechs handgeschriebene
   `VehicleScenario`-Objekte. Der Loader und der Katalog teilten sich den Runner,
   aber nicht die Daten: ein Szenario lebte entweder als Datei oder als Code, und
   der Workbench-Katalog kam aus dem Code. Ein neuer Szenario-Autor musste zwei
   Orte kennen, und kein Gate verbot, dass sie auseinanderliefen.
2. **Der Seed wurde beim Lader fallen gelassen.** `determinism.seed` war Pflichtfeld
   jeder Datei — und wurde danach nirgends mehr gelesen. Der Workbench lief mit dem
   Modell-Default (20260915), die Suites mit ihrem eigenen `createRandom(4242)`;
   die Datei *behauptete* Reproduzierbarkeit, der Lauf wurde von ihr nicht bestimmt.
   Dieselbe Lücke in der Kette: `AnalysisScenario.seed` existierte im AI-Vertrag,
   das Backend füllte sie nie.

## Entscheidung

1. **Das Verzeichnis ist der Katalog.** `SCENARIO_CATALOG` ist gelöscht; alle sechs
   Szenarien liegen als `scenarios/*.json` und sind nachgemessen inhaltsgleich mit
   den früheren Katalogobjekten (Schritte, Erwartungen, Bedingungen, `durationMs` —
   strukturell verglichen, nicht abgetippt). Geladen wird über
   `loadScenarioLibrary` (`scenario-library.ts`, rein, ohne Filesystem): Sie parst
   jede Datei mit `parseScenarioFile` — es gibt exakt einen Weg von Datei zu
   Szenario — und scheitert als Ganzes, wenn eine Datei defekt ist oder eine ID
   doppelt auftritt. Ein still fehlendes Szenario ist der eine Fehlerfall, den ein
   Katalog nicht haben darf.
2. **Filesystem gehört an die Ränder.** `@vdp/simulators` bleibt frei von
   `node:*` (Regel `rules.nodeBuiltins`): Der Web-Server liest in
   `scenario-source.ts` (läuft vom Modulpfad zum Repo-Stamm hinauf, wirft bei
   Problemen mit Dateinamen bereits beim Start), die Suites in
   `tests/helpers/scenario-files.ts`. Beide sind dünne Umgebungsbindungen *eines*
   reinen Laders — kein zweiter Loader.
3. **Der Seed wird konsumiert.** `VehicleBehaviourModel.reseed(seed)` ersetzt den
   Zufallsstrom dort, wo er allein gezogen wird; `HighFidelityVehicle.runScenario`
   nimmt `seed` als Option und setzt ihn vor dem Lauf. Der Workbench übergibt
   `entry.determinism.seed` und schreibt den Seed in `lastScenario` — damit steht
   er im `AnalysisInput` (Vertrag von ADR 0046) und eine Antwort ist allein aus
   sich heraus reproduzierbar. Die Suites bauen das Fahrzeug weiterhin frei, geben
   aber den Seed der Datei in den Lauf: Die Datei bestimmt, nicht der Test.
4. **Die Grammatik wächst mit dem Katalog.** Damit die sechs Szenarien als Dateien
   ausdrückbar sind, ohne sie zu verbiegen, kann eine Datei jetzt sagen:
   - `{ "driver": { speedKph?, throttlePct?, gear?, brake? } }` — der Mensch am
     Lenkrad als Ursache (mindestens ein Feld; ein Fahrer, der nichts tut, ist
     keine Ursache);
   - `ecu`-Ursachen mit `flapMs`/`pattern` (wackelnder Stecker mit Periode und
     Reproduzierbarkeitsform, beides nur *mit* `mode`);
   - Bedingungen über den Zahlen hinaus: Booleans (`engine_running.equals`) und
     Aufzählungen (`ignition.equals`), jede optional mit `atMs` (Prüfzeitpunkt) und
     `because` (Begründung) — die Katalogbedingungen benutzten beides, die alte
     Vergleichstabelle kannte nur Zahlen.
   Schema und `scenarios/README.md` folgen dem Loader im selben Zug (34.24).

## Why

- **Eine Quelle ist ein Gate, das man nicht schreiben muss:** Existiert der
  Katalog nur als Dateien, kann nichts doppelt sein — die Loader-Fehler *sind*
  die Konsistenzprüfung.
- **Determinismus ist eine Kette, keine Eigenschaft einer Datei:** Seed →
  Modell → Lauf → Aufnahme → Analyse. Ein Feld, das in der Kette nicht ankommt,
  ist nicht implementiert, sondern nur deklariert; der Backend-Durchreichung
  (`lastScenario.seed`) sieht der Analytik-Vertrag das Feld längst an.
- **Rein/unrein an der vorhandenen Grenze:** Der Lader ist rein testbar
  (`scenario-library.spec.ts`), das Filesystem an denselben Stellen, die es auch
  für Exporte gibt (Web-Server, Test-Helfer) — dieselbe Teilung wie
  `golden-sessions` (ADR 0036).

## Alternatives

- **`SCENARIO_CATALOG` als Fassade behalten, aus den Dateien generiert:** abgelehnt —
  ein generierter Export wäre eine zweite Form derselben Daten und ein zweiter Lader
  (zur Compile-Zeit); jeder Konsument kann denselben reinen Lader direkt verwenden.
- **Seed als Konstruktor-Option des Fahrzeugs statt `reseed`:** abgelehnt — das
  Fahrzeug lebt über viele Läufe; ein Neubau pro Szenario würde die Workbench-
  Verbindung (und ihre Aufnahme) zerstören, um eine Zahl zu ändern.
- **`durationMs` als Pflichtfeld in die Datei:** abgelehnt — Laufzeit ist Zeit, und
  Zeit drückt die Datei durch `wait` aus; die Beobachtungsphase ist ein letzter
  `wait`, kein zweites Zeitkonzept. (Der Loader leitet `durationMs` ab wie bisher.)

## Affected packages

- `tools/simulators`: `scenario-library.ts` neu (exportiert), `scenario-catalog.ts`
  gelöscht, `scenario-file.ts` (+ `driver`, `flapMs`/`pattern`, Boolean-/Aufzähl-
  Bedingungen, `atMs`/`because`), `vehicle-model.ts` (`reseed`),
  `high-fidelity-vehicle.ts` (`seed`-Option). Schicht `tool` unverändert, keine
  neue Importkante, kein `node:*`.
- `apps/web`: `scenario-source.ts` neu (Filesystem-Leser), `backend.ts` (Katalog aus
  Dateien, Seed in Lauf und `lastScenario`).
- Root: `scenarios/*.json` (+ `README.md`), `tests/helpers/scenario-files.ts`,
  Suite-Anpassungen, Schema, ADR.

## Forbidden implementations

- **Kein zweiter Katalog.** Eine getippte Liste von Szenarien irgendwo im Baum ist
  der alte Defekt mit neuem Datum; Szenarien kommen aus `scenarios/` über
  `loadScenarioLibrary`.
- **Kein `node:*` im Lader.** Umgebungsbindungen lesen Texte; die Grammatik bleibt
  portabel.
- **Kein Lauf, der am Datei-Seed vorbeigeht:** Wer `runScenario` mit einer
  Datei-außerhalb-Suite fährt, übergibt `seed` — ein Lauf, der still den
  Konstruktor-Default nutzt, ist ADR 0046 verworfen.
- **Kein `engine`-Setter, kein Ergebnis-Setter:** die neuen Felder sind Ursachen
  (`driver`) und Prüfungen (`equals`, `atMs`, `because`) — nichts davon schreibt
  Modellzustand direkt.

## Tests

- `scenario-library.spec.ts` (5): Ordnung = Aufrufer-Reihenfolge, defekte Datei
  mit Pfad, doppelte ID nennt beide Dateien, mehrere Brüche werden alle gemeldet,
  `scenariosOf` verweigert die kaputte Bibliothek.
- `scenario-file.spec.ts` (+7): `driver` (Abweisung der leeren Form),
  `flapMs`/`pattern` (und deren Pflicht, eine `mode` zu haben), Boolean- und
  Aufzählungs-Bedingungen mit `atMs`/`because`, String- und Objekt-Vergleichsformen,
  Einheitenprüfung, unbekanntes Feld nennt alle bekannten.
- `vehicle-model.spec.ts` (+1): `reseed` installiert exakt den Strom desselben
  Seeds (Zustandsgleichheit über die Wackel-Spur bei 9,2 V ohne Lichtmaschine),
  Zwillingslauf gleich, anderer Seed darf anders wackeln.
- `scenarios.spec.ts`: Katalog-Tests laufen gegen die geladenen Dateien — IDs,
  hochgeladene Erwartungen, positive Läufe mit Datei-Seed, Negativkontrolle,
  Zweierlauf-Gleichheit.
- `scenario-chain.test.ts`: alle Dateien über den Draht, Seed aus der Datei.
- `apps/web/test/adapters.spec.ts` / `scenario-view.spec.ts`: Panel und
  Katalog-Antwort kommen aus dem Dateiverzeichnis (Reihenfolge = Verzeichnis).

## AI implementation notes

- Neues Szenario? Datei unter `scenarios/` anlegen, mit `parseScenarioFile` im
  Kopf gegen die Grammatik prüfen — der Lauf im Integrationstest ist die Messung,
  kein Nachtrag. `scenario.schema.json` und `scenarios/README.md` im selben Zug.
- Der Katalog-Test in `scenarios.spec.ts` zählt die Dateien; eine neue Datei ohne
  Erwartung fällt dort wie im Panel auf.
- Seed-Änderungen sind Verhaltensänderungen: Der Kommentar in der Datei (oder der
  ADR) sagt, warum die Zahl sich drehen darf.
