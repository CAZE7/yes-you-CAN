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
| [0008](0008-testing-without-framework.md) | node:test auf kompiliertem Output | accepted |
| [0009](0009-ci-and-http-hardening.md) | CI/CD-Baseline und HTTP-Härtung | accepted |
| [0010](0010-toolchain-modernization.md) | Schrittweise Toolchain-Modernisierung | proposed |
| [0011](0011-chart-core-without-dom.md) | Chart-Kern als DOM-freies, getestetes Paket | accepted |
