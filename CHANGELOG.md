# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); version tags
follow SemVer and match the platform version (`package.json`, `PLATFORM_VERSION`).
The dense German milestone history of the engineering contract lives in
[`docs/changelog/agents-contract.md`](docs/changelog/agents-contract.md) — it was moved out
of `AGENTS.md` on 2026-09-24 (ADR 0059), because it was 65 % of the bytes of the file and
none of it was the norm. This file is the release changelog.

## [Unreleased]

### Changed

- **`AGENTS.md` ist wieder lesbar (ADR 0059).** Gemessen am 2026-09-24: 248.497 Bytes
  auf 1.461 Zeilen, längste Zeile **7.653 Zeichen**, durchschnittlich 172 Zeichen — und
  davon 65,3 % Chronik (162.192 B in 61 Versions-Bullets), 14.336 B Abschnitt 0.A
  „Umsetzungsstand" und 26.684 B 0.E „Offene Verbesserungen". Die eigentliche Norm war
  42 KB, also **17 %**. Drei Textarten mit drei Halbwertszeiten in einer Datei: die Norm
  ändert sich bei jeder Entscheidung, Stand und Chronik bei jedem PR. **Ausgelagert,
  ohne eine Referenz zu brechen:** Chronik →
  [`docs/changelog/agents-contract.md`](docs/changelog/agents-contract.md), 0.A →
  [`docs/architecture/status.md`](docs/architecture/status.md), 0.E →
  [`docs/architecture/backlog.md`](docs/architecture/backlog.md). Die Abschnittsnummern
  0.A/0.E **bleiben**, damit jedes „AGENTS 0.E E10" in Code-Kommentaren, ADRs und Tests
  weiter auflösbar ist; 24 Dateien mit solchen Verweisen wurden nachgezogen.
  **Nach dem Schnitt: 248.497 → 47.526 Bytes (1.461 → 1.298 Zeilen), längste Zeile
  7.653 → 925.** Kein Satz der Norm wurde umformuliert; die Abschnitte 0–36 stehen
  unverändert und in derselben Reihenfolge.
- **Der Rust-Referenz-Crate sagt, was er ist (ADR 0059, [Backlog E25](docs/architecture/backlog.md)).**
  Nachgemessen am 2026-09-24: drei der fünf in E25 geführten Befunde waren im Code
  bereits geschlossen (der CAN-FD/32-bit-DL-Kopf von `isotp.rs`, und
  `safety.rs::execute`, das das Permit-Ablaufdatum vom Aufrufer entgegennahm). Der
  dritte — „zero-copy"/„zero-allocation" — ist in dieser Runde korrigiert, weil
  `signal.rs` alloziert (`values.to_vec()`, zweimal `vec![0.0; n]`); `Cargo.toml`,
  `lib.rs` und der `signal.rs`-Kopf sagen das jetzt, statt es zu behaupten. Neu:
  `crates/yes_you_can_core/README.md` als Statuslabel (**nicht gebaut, nicht getestet,
  nicht importiert**) und `tests/architecture/reference-crate.test.ts` als Tor — es
  hält alle drei Tatsachen fest, scannt `.rs`/`.toml` nach ungemessenen
  Performance-Claims (eine sich selbst negierende Zeile ist eine Korrektur, kein Claim)
  und beißt nachweislich (ein wieder eingesetztes „High-Performance" im `lib.rs`-Kopf
  lässt genau diesen Test fallen). Zwei Lesen-Befunde ohne Toolchain **nicht**
  behoben, sondern an Datei und Zeile dokumentiert: `isotp.rs:57` panikt bei einer
  Single Frame mit `SF_DL = 0` (`&data[1..=0]`), und `compute_fft` prüft nicht, dass
  `timestamps` dieselbe Länge hat wie `values`.

- **Zwei Zahlen in den Akten standen falsch, beide durch Nachmessen gefunden.**
  (1) **Coverage:** global ist **94,04 / 85,88 / 95,83 / 95,39** (Statements /
  Branches / Functions / Lines), nicht 93,64 / 85,44 / 95,53 / 94,95 — die alten
  Zahlen stammen vom 2026-09-23. Der Sprung kommt vom Rebase auf `main`
  (`flaky-reporter.spec.ts`, 5 Tests) plus den geborgenen Suites aus #36/#37; die
  letzten beiden Hundertstel darunter sind der neue ELM327-Code, dessen
  Windows-Zweige auf Linux nicht laufen. (2) **`flaky-reporter.ts` steht nicht bei 0 %.** ADR
  0027 hatte die 0 % als Beweis dafür genommen, dass nichts die Datei ausführt; mit
  dem Rebase auf `main` kam `tools/test-reporters/src/flaky-reporter.spec.ts` herein
  (5 Tests, grün), und die Datei misst **100 % Statements / 86,66 % Zweige**. Der
  Befund selbst steht unverändert — **keiner der vier CI-Jobs ruft den Reporter auf**
  (`grep -rn flaky .github/workflows/` trifft nichts), also gibt es keinen einzigen
  Flaky-Report aus der CI und `retry: isCi ? 2 : 0` bleibt unbewiesen ([Backlog
  E9](docs/architecture/backlog.md)). Getestet ist sie, aufgerufen wird sie nicht.

- **Ein transienter Bus-Fehler beendete die ganze Anfrage, statt einen Retry zu kaufen
  ([Backlog E30](docs/architecture/backlog.md)).** Nachdem `send()` ELM-Fehler wirft
  (E29 Punkt 3), erkannte `isRetryable()` nur noch `IsoTpError` mit `timeout: N_Bs`
  oder `N_Cr`. `BUS BUSY` und `CAN ERROR` gingen als nicht-retrybar durch — auf
  Bluetooth SPP mit 50–150 ms Funkverzögerung und Jitter routine, nicht Ausnahme.
  `SLOW_LINK_TIMING.maxRetries: 2` war für genau diese Fehlerklasse nie wirksam.
  Behoben in drei Teilen, weil der Fehler an einer Naht lag: `protocol.ts` führt
  `ELM_TRANSIENT_ERRORS`/`isTransientElmError()` (transient: `NO DATA`, `BUFFER FULL`,
  `BUS BUSY`, `BUS ERROR`, `CAN ERROR`, `UNABLE TO CONNECT`, `FB ERROR`, `STOPPED`;
  permanent: `DATA ERROR`, `<DATA ERROR`, `ERR`, `?`); `adapter.ts` gibt
  `retryable: isTransientElmError(error)` in die `TransportError`-Details; und
  `isRetryable()` akzeptiert eine `TransportError` mit `details.retryable === true`,
  wobei `transmit()` die Details des gefangenen Fehlers **verbreitet**, statt sie mit
  `cause: messageOf(error)` in einen String zu platten — ohne diesen dritten Teil
  starb das Flag auf dem Weg nach draußen und die ersten beiden Teile waren
  wirkungslos. Die Aufteilung bleibt Absicht: der Adapter *klassifiziert*, ISO-TP
  *entscheidet*. Drei Biss-Nachweise: `transmit()`-Verbreitung entfernt → rot,
  `isRetryable` auf `return false` gezwungen → rot, `"BUS BUSY"` aus der Menge
  genommen → rot. Zwei neue Tests, 78 grün in `iso-tp` + `elm327`, die Suite
  insgesamt bei **2569 passed / 8 skipped**.

- **Der ELM327-Pfad lief gegen einen Bluetooth-Adapter, auf vier Ebenen gleichzeitig
  ([Backlog E29](docs/architecture/backlog.md)).** (1) Die Init-Sequenz schickte
  `ATS0` — Leerzeichen aus — während `parseFrameLine` auf Leerzeichen splittet und
  ein Ein-Token-Dokument verwirft: mit `ATS0` wird **jeder** empfangene Frame
  verworfen. Jetzt `ATS1`. (2) `ATCAF0` fehlte, obwohl der Katalog den Adapter als
  „raw CAN mode (ATH1/ATCAF0)" beschreibt: mit `CAF1` baut die Adapter-Firmware
  eigene Flow-Control-Frames und beantwortet die des TypeScript-Stacks. Jetzt
  dabei. (3) `send()` schluckte `CAN ERROR`/`BUFFER FULL`/`STOPPED` — ISO-TP hielt
  den Frame für gesendet und wartete auf eine Antwort, die nie angefordert wurde.
  Jetzt wirft `send()` mit Befehl und Frame-ID. (4) `ATSP6` war eine Konstante,
  obwohl `formatIdentifier` 29-Bit schon kann: jetzt über `canProtocol`,
  `--protocol=<6..9>` und ein Feld im Adapter-Panel, durchgereicht bis
  `selectionFromPayload` (als Zahl, nie als Wort). Dazu: Zeilen enden an `\r\n`,
  `\n` **und** bare `\r`; `ByteStream.onError?` ist optionaler Vertragsteil, den der
  Adapter abonniert, damit ein Gerät, das weg ist, nicht weiter `connected: true`
  meldet; und `SLOW_LINK_TIMING` (N_Bs/N_Cr 2000 ms, sendTimeout 3000 ms, 2 Retries)
  als benanntes Profil für Bluetooth SPP — `DEFAULT_TIMING` bleibt 1000/0, denn ein
  Default, der lockerer wird, lässt jedes Timeout-Gate leichter bestehen.
- **Windows-COM-Ports wurden mit dem falschen Hinweis beantwortet.**
  `fs.stat("COM3")` wirft unter Windows für jeden existierenden Port ENOENT — das
  ist dokumentiertes Win32-/`node:fs`-Verhalten, **nicht** in dieser Arbeitsumgebung
  gemessen (die ist Linux, AGENTS 34.21). Der Probe übersetzte das in „is the adapter plugged in?" — ein Operator sucht
  nach einem Kabel, das steckt. Neu: `isWindowsComPortName` /
  `isWindowsBareComPort` (Plattform injizierbar, damit der Zweig von Linux aus
  testbar ist) und eine Antwort, die den echten Weg nennt — `\\.\COM3`. Die
  Doku von `SerialStreamOptions.device` versprach vorher `COM3` als Beispiel; sie
  sagt jetzt die Wahrheit über `node:fs` und über `stty`, das Windows nicht mitbringt.

### Fixed

- **Zehn kaputte relative Markdown-Links** — sechs in `.ai/contracts/*.md`
  (`../docs/…` wo `../../docs/…` gemeint war) und vier in
  `docs/standards/conformance.md` (`0053-…`/`0054-…` ohne `../adr/`). Die `.ai/`-Schicht
  wird aus derselben Regel generiert wie `check:deps` (ADR 0043); eine Vertragsdatei,
  die ins Nichts zeigt, ist ein Agent, der einem toten Zeiger folgt. Neu verankert als
  Tor: [`tests/architecture/links.test.ts`](tests/architecture/links.test.ts) prüft alle
  **443 relativen Links in 148 Markdown-Dateien** und lässt Fences sowie Inline-Code
  aus — sonst würde das Gate das Dokumentieren der eigenen Syntax verbieten. Biss
  nachgewiesen an einem Tempfile mit `[gone](./nowhere.md)`.

- **Die Chronik der Spielregeln war zu einem Viertel doppelt.** Beim Auslagern
  (ADR 0059) fiel auf, dass die 61 Versions-Bullets von `AGENTS.md` nur **46
  verschiedene Versionen** trugen: 1.0–1.12 und 1.38 standen je zweimal darin. 13
  der 14 Doppelungen sind byte-identisch und entfernt; bei 1.38 stehen zwei
  *verschiedene* Einträge unter derselben Nummer — beides eigene Aussagen, beide
  bleiben stehen (die Kollision ist ein eigener Befund, siehe
  [Backlog E28](docs/architecture/backlog.md)). Kein Tor hat das bemerkt, weil die
  Datei 45 KB groß war und niemand sie rückwärts las. Eintrag 1.48 der Chronik.

### Infrastructure

- **Die gehärtete CI aus ADR 0016 §3 liegt im Repository (2026-09-24).** Alle vier
  Workflows sind auf `main`: `ci.yml` mit **Quality-Job** (`build` · `typecheck:all` ·
  `check` · `check:deps` · `check:manifests` · `npm audit`) vor der Test-Matrix auf
  Node 22 und 24 plus Coverage-Artefakt-Upload, dazu `codeql.yml`,
  `dependency-review.yml` und der nächtliche `hardware.yml`-Smoke auf `vcan0`.
- **Der Zweitträger fällt weg (ADR 0059).** Von 2026-09-14 bis 2026-09-24 lief `ci.yml`
  nur mit `npm ci` → `build` → `npm test`, weil die GitHub-App keine Workflow-Dateien
  schreiben durfte. In dieser Zeit führte der `architecture`-Projektlauf von `npm test`
  `biome check .` und beide `--noEmit`-Pässe selbst aus (≈2 s auf einen 22,6-s-Lauf).
  Da der Workflow das jetzt selbst tut, ist dieser Test auf eine reine
  Selbstbeschreibung zurückgebaut: er liest `ci.yml` und fällt, wenn ein Tor seinen
  Träger verliert — genau die Form, die [Backlog E20](docs/architecture/backlog.md) für den
  Moment der Freischaltung vorgesehen hatte. `runTool`/`execFileSync` sind entfallen.
- **Die Coverage-Gates behalten ihren Träger, und der Grund steht jetzt im Code.**
  `ci.yml` lädt `coverage/` mit `if: always()` hoch — ein Artefakt, das kommt, ob die
  Schwellen hielten oder nicht, ist ein Bericht, kein Tor. Getragen wird es von
  `tests/architecture/coverage-gate.test.ts` (Kindlauf `npm run test:coverage`, nur
  unter `CI`, Rekursionssperre, `retry: 0`). Der fehlende Workflow-Schritt ist
  einzeilig und in [`CONTRIBUTING.md`](CONTRIBUTING.md) aufgeschrieben; er braucht
  jemanden, der `.github/workflows/` schreiben darf — die GitHub-App-Integration kann
  es weiterhin nicht (gemessen 2026-09-24 per `git push` und per API).

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
