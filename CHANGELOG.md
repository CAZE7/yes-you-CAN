# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); version tags
follow SemVer and match the platform version (`package.json`, `PLATFORM_VERSION`).
The dense German milestone history of the engineering contract lives in `AGENTS.md`;
this file is the release changelog.

## [0.1.0] - 2026-09-22

Erstes Release der Vehicle Diagnostics Platform. Inhalt: die Grundlage aus ADR
0047/0048 (Integrity-Port, Szenario-Dateien als der eine Katalog, Seed bis in den
Lauf) und die vier Meilensteine dieses Stands — Haskell-Konformanz als Release-Gate,
zentraler Szenario-Katalog, produktionsreifer Diagnose-Loop sowie Provenance + Replay
(Entscheidung ADR 0057, Migration 1–4 von 6 umgesetzt; siehe unten).

### Added

- **Haskell-Konformanz ist ein Release-Gate (ADR 0055).**
  `tests/architecture/haskell-conformance-gate.test.ts` prüft in jedem CI-Lauf das
  TypeScript ⇄ Haskell-Differential über 28 ISO-15765-2- und 44 Write-Safety-Vektoren
  (`npm run formal:conform -- --compare`). Grün nur, wenn beide Sätze die Zeile
  `TS ⇄ Haskell differential clean (N vectors)` tragen; eine Abweichung (Exit 1)
  fällt mit dem Bericht des CLI, und ein CI-Runner ohne Toolchain (Exit 2) ist ein
  harter Fehlschlag — „a release without the differential is not a release".
  Lokal ohne Haskell-Toolchain: sichtbarer Skip, nie ein unsichtbares Grün.
- **Der Diagnose-Loop ist eine Zustandsmaschine mit maschinenlesbarem Diff
  (ADR 0056).** Jede Hypothese trägt ihre Evidenz mit Seite
  (`Hypothesis.supporting`/`against`, zitiert und existenzgeprüft); der empfohlene
  Test maximiert die Unsicherheitsreduktion über alle ungetesteten Checks
  (`DiscriminatingTest.uncertaintyReduction`); `DiagnosisStep {before, after, changes}`
  diffed eine Messung gegen die Welt davor; `EvidenceService.advanceDiagnosis`/
  `resetGuidedDiagnosis` tragen den Loop in der Runtime, `diagnosis` reist in AI-Eingabe
  und -Antwort (nur gegen die Aufnahme prüfbare Zustände), `GuidedDiagnosisView`
  beantwortet je Hypothese: welche Evidenz spricht dafür, was spricht dagegen.
- **Provenance + Replay (ADR 0057, Migration 1–4 von 6).** Vier additive optionale
  Session-Felder, kein Schema-Bump: `platformVersion` (von `PLATFORM_VERSION` über
  Runtime → Engine → Session-Opener), `scenario {id, title, seed}`, `ai {provider,
  promptVersion, runtimeVersion}` und eine **content-adressierte** `traceId`
  (`t-` + die ersten 16 hex des Manifest-Digests). Das Raw-Trace-Manifest ist
  **v2** mit optionalem ed25519-`signature`-Block
  (`{keyId, algorithm, value}`) über die kanonische Zeichenkette
  `format|version|algorithm|entries|sha256` und dem `publicKey` neben der Signatur.
  Neu in Core: `ManifestSigner`/`ManifestVerifier`-Ports neben `IntegrityPort`;
  in `@vdp/storage`: `createNodeManifestSigner` (ein Prozess-Signer mit ephemeren
  ed25519-Schlüsselpaar, `keyId = ed25519:` + 16 hex Fingerabdruck) und
  `createNodeManifestVerifier`.
- **Ein Scan nennt auch die Steuergeräte, die er nicht lesen konnte (ADR 0049).**
  DTC-Scans liefern `DtcScanReport {scanned, unread}` statt ein leeres Ergebnis mit
  verschwundenen Timeouts; Query, Domain-Event, Workbench-Zustand und Server-Log
  tragen dieselbe Lücke.
- **Standards-Konformanz ist ein Register mit Belegen (ADR 0050/0053/0054).**
  Die ISO-21434-/ISO-26262-Dokumentation, Traceability, HARA-Vorlage und CSMS-Gerüst
  nennen erfüllt, teilweise und offen getrennt statt „Industriestandard" als Pauschale.
- `CHANGELOG.md` (diese Datei) und annotierte Versions-Tags.

### Changed

- **`scenarios/*.json` sind der einzige Szenario-Katalog (ADR 0048).** Simulator,
  Tests, Workbench, Replay und AI lesen dieselben Dateien; der Seed aus der Datei
  läuft bis in den Lauf (`HighFidelityVehicle.runScenario`), und eine doppelte ID
  oder kaputte Datei lässt die Bibliothek als Ganzes scheitern.
- Die Auswahl des nächsten Tests der Evidence-Engine kommt aus der
  Unsicherheitsreduktion über alle offenen Checks statt aus „erster offener Check
  der führenden Hypothese" — eine Messung, die drei Hypothesen entscheidet, schlägt
  eine, die eine entscheidet.
- Die Uhr des Signalmodells ist ein injizierbarer Parameter (ADR 0052), nicht die
  Geschwindigkeit der Maschine; Simulator- und Dateiläufe bleiben damit deterministisch.

### Fixed

- `LIKELIHOOD_PRIOR` kannte `plausible`, die Definitionsdomäne schreibt `possible` —
  jede dokumentierte `possible`-Hypothese fiel still auf den Unknown-Prior (0,4 statt
  0,45). Beide Schreibweisen gelten jetzt mit demselben Prior.
- `HighFidelityVehicle.runScenario` stellt die Baseline selbst her
  (`prepareScenarioRun`): Szenario-Läufe sind reproduzierbar, auch wenn der
  Verbindungszustand davor driftete (gemessen: Lauf 1 ≡ Lauf 2 mit 20 s Pause).

### Security

- Raw-Trace-Exporte können signiert werden (Manifest v2, ed25519): die Signatur deckt
  genau die Identitätsfelder des Manifests ab, der öffentliche Schlüssel liegt neben
  der Signatur, und die `keyId` ist der Fingerabdruck des Schlüssels, nicht sein Name.
  Das Schlüsselpaar wird pro Prozess erzeugt und verlässt den Prozess nicht.
- Der Digest über dem rohen Trace bleibt SHA-256 über den kanonischen Strom
  (Längenpräfix je Eintrag). Der goldene Vektor `8600983e…` ist der cross-language
  Anker und bleibt gepinnt; **V1-Manifeste verifizieren weiter**
  (`SUPPORTED_VERSIONS = [1, 2]`).
- Die Workbench-API kennt ihren Aufrufer (ADR 0051): Bearer-Token-Tor mit konstantem
  Vergleich, localhost als Default, Security-Header/HSTS; TLS-Konfiguration,
  Rate-Limit und CSMS-Gerüst schließen weitere ISO-21434-Lücken (ADR 0054).

### Verification

- `npm run ci`: **EXIT 0** — 2364 Tests bestanden, 3 sichtbare lokale Skips,
  163 Testdateien bestanden; `biome check` 489 Dateien; Dependency- und
  Manifest-Gates ohne Verletzung.
- `npm run test:coverage`: **EXIT 0** — global
  **94,10 / 86,40 / 95,94 / 95,48** (Statements / Branches / Functions / Lines),
  alle Böden unverändert.

### Known gaps (ehrlich, in diesem Release sichtbar)

- ADR-0057-Migration 5 (Backend-Verdrahtung `saveSession`/`exportJson`/`runScenario`/
  `analyze` + Report-Provenance-Sektion) und Migration 6
  (`tests/replay/scenario-replay.test.ts`) sind noch offen — die Kette
  „gleicher Input → gleicher Output" wird in einem der nächsten Releases mit dem
  Replay-Test geschlossen.
- Lokal ist keine Haskell-Toolchain verfügbar (`haskell NOT RUN`, ehrlich statt grün
  behauptet). Der erste GitHub-CI-Anlauf belegte `toolchain=present`, fand aber einen
  Workspace-Race zweier gleichzeitiger GHC-Prozesse (`Json.o.tmp` im gemeinsamen
  `/tmp`) statt einer Differentialabweichung. Behoben: per `mkdtemp` isoliertes
  `-outputdir` und genau ein Haskell-Träger im äußeren CI-Lauf; der GitHub-Release
  wird erst nach einem sauberen Wiederholungslauf veröffentlicht.

[0.1.0]: https://github.com/CAZE7/yes-you-CAN/releases/tag/v0.1.0
