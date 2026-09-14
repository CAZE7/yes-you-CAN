# Architecture Decision Records

Kurze, dauerhafte Aufzeichnungen darüber, *warum* die Plattform so gebaut ist, wie
sie gebaut ist (AGENTS 34.17). Ein ADR wird nicht gelöscht, wenn er überholt ist —
er wird durch einen neuen ersetzt, der den alten als `superseded` markiert.

| Nr. | Titel | Status |
|---|---|---|
| [0001](0001-layered-architecture.md) | Geschichtete Architektur mit fester Abhängigkeitsrichtung | accepted |
| [0002](0002-no-runtime-dependencies.md) | Keine Laufzeit-Abhängigkeiten | accepted |
| [0003](0003-definition-packages.md) | OEM-Wissen in Definition-Paketen mit Pflicht-Provenance | accepted |
| [0004](0004-raw-vs-decoded.md) | Rohdaten und Dekodierung strikt getrennt | accepted |
| [0005](0005-simulator-and-replay.md) | Simulator und Replay statt Real-Fahrzeug | accepted |
| [0006](0006-web-stack.md) | Node HTTP + SSE + Vanilla ESM für die Oberfläche | accepted |
| [0007](0007-session-storage.md) | JSON + NDJSON mit versionierten Migrationen | accepted |
| [0008](0008-testing-without-framework.md) | node:test auf kompiliertem Output | superseded (durch 0010, Schritt 1) |
| [0009](0009-ci-and-http-hardening.md) | CI/CD-Baseline und HTTP-Härtung | accepted |
| [0010](0010-toolchain-modernization.md) | Schrittweise Toolchain-Modernisierung | accepted (Schritt 1 gemergt) |
| [0011](0011-chart-core-without-dom.md) | Chart-Kern als DOM-freies, getestetes Paket | accepted |
| [0012](0012-static-asset-containment.md) | Statische Auslieferung nach Pfadsegmenten, nicht nach Zeichenkette | accepted |
| [0013](0013-transport-transaction-scope.md) | Transaktionssperre pro Verbindung, nicht pro Anfrage | accepted |
| [0014](0014-domain-application-runtime.md) | Domain-, Application- und Runtime-Schicht: schrittweise Ablösung des Gott-Controllers | accepted |
| [0015](0015-architecture-tests.md) | Architekturtests: der Abhängigkeitsgraph ist ein Test | accepted |
| [0016](0016-industrial-hardening.md) | Industriestandard-Härtung: Lint, Coverage-Gates, CI-Matrix und Security-Scans | accepted (§2 korrigiert durch 0017) |
| [0017](0017-coverage-gates-recalibrated.md) | Coverage-Gates neu kalibriert: Ist-Zustand statt Aspirationswerte | accepted |
| [0018](0018-write-rejections-as-data.md) | Abgelehnte Write-Operationen sind Antworten mit Gründen, keine HTTP-Fehler | accepted |
| [0019](0019-explicit-discovery-timing.md) | Das Zeitbudget der ECU-Discovery ist explizit und injizierbar | accepted |
| [0020](0020-coverage-gates-raised.md) | Coverage-Gates nach DoIP- und Chart-Nachtest angehoben | accepted |
| [0021](0021-pdf-strings-are-latin1.md) | PDF-Strings sind Latin-1: ein Encoder für Text, Länge und Offsets | accepted |
| [0022](0022-coverage-gates-output-and-analysis.md) | Coverage-Gates für Export-Pfad und Analyse, storage nachgezogen | accepted |
| [0023](0023-vehicle-resolution.md) | Fahrzeugauflösung: Schema v2, Resolver mit Belegen, Attributionsregel | accepted |
| [0024](0024-dtc-knowledge-per-variant.md) | DTC-Wissen pro Variante: Schema v3, Auflösung nach Spezifität, Ehrlichkeit als Datenmodell | accepted |
| [0025](0025-knowledge-quality-gates.md) | Was Wissen tragen muss: Provenance-Gates je Quellentyp, Checks ohne Stellvertreter-Signal, bewusste Lücken | accepted |
| [0026](0026-vehicle-determination-as-session-data.md) | Die Fahrzeugbestimmung ist Sitzungsdatum: Typ, Senke, Leser | accepted |
| [0027](0027-coverage-scope-web-and-tools.md) | Was gemessen wird: Workbench und Tools in der Coverage | accepted |
| [0028](0028-gates-after-backtest.md) | Gates nach dem Nachtesten, nicht nach dem Gefühl | accepted |
| [0029](0029-guardrails-that-bite.md) | Guardrails, die beißen: Fehler statt Warnungen, Entscheidungen auf dem Rekord, Gates im Testlauf | accepted |
| [0030](0030-frontend-typed-against-the-wire-contract.md) | Das Browser-Frontend wird gegen den Wire-Contract typgeprüft | accepted |
| [0031](0031-architecture-rule-as-a-tool-with-one-source.md) | Die Architekturregel ist ein Werkzeug mit einer Quelle | accepted |
| [0032](0032-write-path-as-its-own-port.md) | Der Schreibpfad ist ein eigener Port, keine Methode am Lesepfad | accepted |
| [0033](0033-missing-evidence-is-a-failure.md) | Fehlende Evidenz ist ein Fehlschlag, keine Warnung | accepted |
| [0034](0034-diagnostic-ir.md) | Diagnostische Zwischenstufe: Beobachtungen mit Beleg | accepted |
| [0035](0035-session-definitions-are-data.md) | Sitzungsdefinitionen sind Daten, die Zustandsmaschine ist ein Modul | accepted |
| [0036](0036-golden-sessions.md) | Eine goldene Sitzung ist Aufzeichnung, Erwartung und Lauf | accepted |
