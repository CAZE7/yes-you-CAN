# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); version tags
follow SemVer and match the platform version (`package.json`, `PLATFORM_VERSION`).
The dense German milestone history of the engineering contract lives in `AGENTS.md`;
this file is the release changelog.

## [Unreleased]

### Added

- **Fahrzeug-Ernte: read-only auslesen, als Beobachtung behalten (ADR 0058).**
  Neues Werkzeug `tools/harvest` (`@vdp/harvest`, layer `tool`): `harvestVehicle()`
  fährt Discovery, sichere Dienstsonden, Identifikations-DIDs, einen DID-Sweep
  (`F180–F1FF`, `F400–F4FF`, Paket-DIDs) und den Fehlerspeicher in der Reihenfolge
  `0x19 0x01 → 0x03 → 0x02 → 0x04/0x06` — und schreibt aus **einer** Beobachtung
  drei Projektionen: `harvest.json` (Datensatz mit Plan, Zählern, Lücken, Notes),
  eine ODX-Beschreibung (`.odx-d` und `.pdx`, ISO 22901-1 / ASAM ODX 2.2) und einen
  Definitions-Kandidaten für `@vdp/definitions`. CLI mit Vertrag
  (`runCli(argv, io) → exit code`, 0/2/3/4/5/6), `--simulator` für den Lauf ohne
  Hardware, `--print-plan` vor dem Lauf, `--definitions` schließt den Kreis zum
  nächsten Lauf.
- **ODX-Gegenprüfung gegen eine zweite Implementierung.** `--verify-odx` übergibt das
  geschriebene Dokument `odxtools` (MIT, extern, keine Abhängigkeit — ADR 0002) und
  prüft Parse, Encode- und Decode-Rundlauf jeder beobachteten Konversation. Gemessen
  am Simulator-Fahrzeug: 3 Varianten, 29 Dienste, 7 DTCs, **29/29 Anfragen auf die
  gesendeten Bytes, 29/29 Antworten auf die empfangenen Bytes, 0 Abweichungen**.
  Ohne installierte Bibliothek meldet das Werkzeug `odxtools NOT RUN` mit Grund und
  bleibt grün — ein Prüfer, der nicht laufen kann, ist nicht durchgefallen.
- **Provenance-Quelle `observed`** für Daten, die von einem realen Fahrzeug gelesen
  wurden, plus ein eigenes optionales `provenance`-Feld an `SignalDefinition`,
  `DtcDefinition` und `EcuDefinition` (das Paket deckt das Paket, die Zeile braucht
  ihre eigene Quelle). Regeln: `observed` ohne `retrievedAt` warnt („eine Messung
  ohne Datum ist von einer Vermutung nicht zu unterscheiden"), mit `license` warnt
  („gemessen, nicht lizenziert"); `provenanceTrust("observed") = 0.9`.
- **`0x19` vollständig (ISO 14229-1 §11.3.4):** `readDtcCountByStatusMask()` (0x01),
  `readDtcSnapshotIdentification()` (0x03, neu auch im Server),
  `readDtcReportByStatusMask()`/`readSupportedDtcReport()` mit
  `DtcReport { availabilityMask, records }`; `supportedStatusBits()`,
  `unsupportedStatusBits()` und `dtcSeverity(bits, availabilityMask)`;
  `dtcFormatIdentifier` als Server-Option.
- **Ausführbares Doku-Beispiel** `tests/examples/harvest.example.ts` (Plan →
  Beobachtung → beide Hälften → Maske → VIN-Maskierung → ODX → Kandidat).

### Changed

- **Die DTC-Verfügbarkeitsmaske reist mit.** `DtcReport { availabilityMask, records }`
  statt einer nackten Liste, dazu `DtcRecord.availabilityMask`,
  `DtcObservation.availabilityMask` (IR, optional — nie auf `0xff` defaultet, das würde
  die Behauptung erfinden) und `EcuSession.dtcAvailabilityMask`;
  `dtcSeverity(bits, availabilityMask = 0xff)` bewertet nur Bits, die das Steuergerät
  setzt. `readDtcByStatusMask()`/`readSupportedDtc()` bleiben Projektionen — kein
  Aufrufer musste ändern.

### Fixed

- **`parseDtcList()` warf die Verfügbarkeitsmaske weg (ISO 14229-1 §11.3.4.2).** Der
  Parser begann *hinter* dem Byte, das sagt, welche der acht Statusbits ein
  Steuergerät überhaupt implementiert, und `dtcSeverity()` las alle acht: ein ECU ohne
  `confirmedDtc` wurde über ein Bit eingestuft, das es nie gesetzt hat.
- **Der Simulator antwortete auf `0x19 0x01` mit einem Layout, das kein reales
  Steuergerät nutzt:** `reportNumberOfDTCByStatusMask` ist sechs Bytes inklusive
  DTC-Formatkennung, nicht fünf — die Anzahl stand an der falschen Stelle, und ein
  gegen die Norm geschriebener Client hätte reale Fahrzeuge falsch gelesen. Der
  bestehende Test pinnt jetzt die Norm-Offsets, `dtcFormatIdentifier` ist
  konfigurierbar.

### Security

- **Read-only als Eigenschaft, nicht als Absicht:** `FORBIDDEN_HARVEST_SERVICES`
  nennt jeden Schreibdienst mit Grund, `0x2E` wird nur mit `--probe-writes` sondiert
  (ohne das Flag gilt wörtlich „kein Schreibdienst wird gesendet"), und ein Test
  scannt die Quellen der Ernte nach Schreibaufrufen.
- **VIN maskiert by default** (`redactVin`, WMI + letzte vier Stellen bleiben,
  `identity.vinRedacted` sagt es im Datensatz); `--keep-vin` ist der einzige Weg zum
  Klartext (AGENTS 30: Fahrzeugdaten sind personenbezogen).
- **Keine erfundene Bedeutung:** keine Skalierung, keine Einheiten, keine Namen oder
  DTC-Texte aus dem Nichts; eine Bytelänge ohne dokumentierte Kodierung wird kein
  Signal, sondern ein `skipped`-Eintrag mit Grund.

### Verification

- `npm run ci`: **EXIT 0** — 2505 Tests bestanden, 8 sichtbare lokale Skips (5 davon
  die `odxtools`-Gegenprüfung der Ernte, die ohne installierte Bibliothek ehrlich
  überspringt), 175 Testdateien bestanden von 177 (2 CI-Träger überspringen lokal,
  ADR 0029 §6); `biome check .` 523 Dateien; `check:deps` „29 packages placed,
  92 edges, 6 rules" ohne Verletzung; `check:manifests` agree — gemessen 2026-09-23
  in 85 s.
- `npm run test:coverage`: **EXIT 0** — global **93,64 / 85,44 / 95,53 / 94,95**
  (Statements / Branches / Functions / Lines), alle Böden unverändert;
  `tools/harvest/src` **85,60 / 75,69**, niedrigste Datei `odx/verify.ts`
  **72,34 / 58,97** — der `odxtools`-Pfad, der ohne `VDP_ODX_PYTHON` nicht läuft
  (0.E E27).
- Ernte gegen eine zweite Implementierung: `node tools/harvest/dist/src/cli.js
  --simulator --out … --verify-odx --odx-python …` **EXIT 0**, vier Artefakte,
  `odxtools` 3 Varianten, 29 Dienste, 7 DTCs — **29/29 Anfragen auf die gesendeten
  Bytes codiert, 29/29 Antworten auf die empfangenen Bytes decodiert, 0
  Abweichungen**; das geschriebene `.pdx` lädt in `odxtools.load_file()` und zeigt
  dieselben drei Varianten.

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
- GitHub CI [35769698573](https://github.com/CAZE7/yes-you-CAN/actions/runs/35769698573):
  **grün auf Node 22 und 24**; echte TypeScript ⇄ Haskell-Differentiale
  **ISO-TP 28/28** und **Write-Safety 44/44** sauber (16,9 s auf Node 22).

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
  `-outputdir` und genau ein Haskell-Träger im äußeren CI-Lauf; der saubere
  Wiederholungslauf ist unter „Verification" belegt, erst danach wurde der
  GitHub-Release veröffentlicht.

[0.1.0]: https://github.com/CAZE7/yes-you-CAN/releases/tag/v0.1.0
