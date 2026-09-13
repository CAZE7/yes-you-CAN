# Master-Backlog: von der Plattform zur nutzbaren Diagnosepraxis

Stand: 2026-09-14 · Bezug: ADR 0026, `docs/architecture/migration-roadmap.md`,
AGENTS 0.A (Stand), 0.E (offene Verbesserungen)

## Leitsatz

Das Repository hat genug Infrastruktur. Der Fehler wäre jetzt, weitere
Infrastruktur um ihrer selbst willen zu bauen. Die Richtung ist:

```
bestehende Architektur
      ↓
härtere automatische Guardrails      ← ADR 0026 (dieser Schritt, 2026-09-14)
      ↓
reale Fahrzeugdaten
      ↓
reproduzierbare Diagnosefälle
      ↓
Coding / Adaptation / Routines
      ↓
Evidence Engine
      ↓
AI
```

Damit verschiebt sich das Projekt von „technisch beeindruckender Plattform“ zu
„wirklich nutzbarer professioneller Diagnoseplattform“.

## Zwei Korrekturen (entschieden, ADR 0026)

| Vorschlag | Entscheidung | Begründung |
|---|---|---|
| ESLint zusätzlich installieren | **nein** | Biome ist der Linter; das Problem war nicht die Menge der Regeln, sondern dass vier tragende Regeln auf `warn` standen und `biome check` in der CI nie lief. Ein zweiter Linter gäbe jeder Regel zwei Heimatorte (ADR 0026 §1) |
| Turborepo/Nx einführen | **nein, vorerst** | `tsc -b` über 25 Projekte, Biome in 0,8 s, Suite ~22 s — kein gemessener Flaschenhals. Ein Caching-Layer mit eigener Invalidierungslogik löst ein Problem, das noch nicht existiert; der Architekturtest meldet sich, sobald einer auftaucht (ADR 0026 §5) |

## Was bereits vorhanden ist — nicht noch einmal bauen

Nachgeprüft am 2026-09-14 (Datei genannt, wo der Beleg liegt):

Biome (`biome.json`) · TypeScript `strict` + `noUncheckedIndexedAccess` +
`noImplicitOverride` (`tsconfig.base.json`) · Architekturtests
(`tests/architecture/dependencies.test.ts`, `hygiene.test.ts`,
`manifests.test.ts`, neu `guardrails.test.ts`) · GitHub-CI
(`.github/workflows/ci.yml`, Node 22 + 24) · CODEOWNERS · Dependabot · Vitest 5
mit sechs Projekten (`vitest.config.ts`) · fast-check · Replay und Simulator
(`tools/simulators`, `tests/replay`) · strukturierte Fehler und Logs
(`packages/shared/src/errors.ts`, `logger.ts`) · Runtime-/Application-/Domain-
Aufteilung (`packages/runtime`, `packages/application`, `packages/domain`,
ADR 0014) · DTC/UDS/DoIP-Grundlagen (`packages/protocols/uds`, `transport/doip`)
· Definitionssystem mit Schema v3, SemVer und Provenance
(`packages/definitions/src/schema.ts`, `migrate.ts`, `validate.ts`) ·
Safety-Grundlagen (`packages/core/src/safety/safety-manager.ts`,
`packages/domain/src/risk.ts`) · AI-Schicht mit Provider-Abstraktion und
VIN-Redaktion (`packages/ai`).

**Lesehilfe für die Tabellen:** ✅ = vorhanden und belegt · 🟡 = teilweise, mit
benannter Lücke · ⏳ = nicht begonnen. Ein „—“ im Stand heißt: in einer gezielten
Suche fand sich **kein** Beleg im Baum — dieselbe Beweislast wie überall sonst
(Regel 34.21). Diese Tabellen sind ein Stand, keine Wahrheit auf ewig.

## P0 — zuerst

| # | Thema | Stand | Nächster konkreter Schritt |
|---|---|---|---|
| 1 | `DiagnosticEngine` endgültig zerlegen | 🟡 `packages/core/src/diagnostics/engine.ts` ist 701 Zeilen; Orchestrierung liegt bereits in `packages/runtime/src/services.ts` (726 Zeilen), der Escape-Hatch `runtime.engine` ist entfernt (Roadmap-Schritt 8) | Engine-Klasse in Kollaborateure auflösen (ADR 0014 Phase 4): Verbindungsaufbau/ECU-Links, DTC-Zugriff, Messungszugriff, Session-/Kontextbindung. Kriterium: `engine.ts` verschwindet oder schrumpft unter ~200 Zeilen, ohne dass ein Test geändert wird |
| 2 | Eine einzige verbindliche Architektur-/Dependency-Regel | 🟡 `tests/architecture/dependencies.test.ts` hält den Graphen als explizite Allowlist (jedes neue Paket muss bewusst eingeordnet werden) + drei Negativregeln; ADR 0026 pinnt jetzt zusätzlich Linter, Strictness und Orchestrator-Freiheit | Die Regel auch als *Werkzeug* verfügbar machen (Backlog #22), damit Verstöße vor dem Test rot werden; bis dahin bleibt der Test die Regel — nicht eine von zwei |
| 3 | Read- und Write-Pfad hart trennen | 🟡 `dtc.clear-precheck` (Query) und `clearDtcs` (Command) werten nachweislich dieselbe Safety-Kette aus (ADR 0018); `DtcClearService` kapselt das Löschen | Write-Operationen aus der Engine herausziehen, sodass der Read-Pfad keine Schreibmethoden mehr kennt; Zielbild: `WriteOperation` als eigener Port mit eigenem Vokabular |
| 4 | Write-Operationen als transaktionalen Ablauf modellieren | 🟡 `packages/domain/src/risk.ts` definiert Risiko-Policy je Operation (`requiresConfirmation`, `requiresBackup`, `requiresVerification`) | Ablauf als Daten: `prepare → confirm → execute → verify → rollback` je Operation; jede Stufe ein Ergebnis mit Gründen, nie eine Ausnahme (AGENTS 26) |
| 5 | Safety „fail closed“ | ✅-nah: `SafetyManager.evaluate()` leitet `ok` ausschließlich aus `failed[]` ab — Zustand, Definition, Backup, Bestätigung, Session, TLS und Routing sind einzelne Vorbedingungen (AGENTS 25/26) | Fehlende *Evidenz* ebenfalls als Fehlschlag typisieren (heute: fehlender Wert ⇒ kein Treffer); zusammen mit #6/#7, weil „unbekannt“ ein IR-Fall ist |
| 6 | Diagnostic IR einführen | ⏳ heute liefert die Dekodierung `DecodedSignal`/`EnrichedDtc` direkt an Verbraucher | IR als eigenes Paket: Transport-/Rohform → IR → Projektion. Erst damit werden #7, #41 und #42 sauber; Kandidaten aus dem Bestand: Signal, Messfenster, DTC-Zustand, Session-Zustand, Beleg/Widerspruch |
| 7 | `DiagnosticTransaction` als zentrale Abstraktion | 🟡 Transaktionssperre pro Verbindung existiert (ADR 0013), aber als Transportdetail, nicht als Domänenbegriff | `DiagnosticTransaction` als Domänentyp über Verbindung + Session + Vorbedingungen + Audit; Abbrüche und Wiederaufnahme als Zustände, nicht als `try/catch` |
| 8 | Contract Tests für alle Transport-/Adapterimplementierungen | 🟡 Naht-Tests existieren (`tests/integration/transport-seam.test.ts`, `doip-engine.test.ts`, `host-serial.spec.ts`) | Eine gemeinsame Contract-Suite, die *jede* Implementierung desselben Ports bestehen muss (CAN, ISO-TP, DoIP, SocketCAN, ELM327, Generic-CAN, Host-Serial); heute ist sie implizit und je Datei unterschiedlich |
| 9 | UDS-State-Machine + Conformance Suite | 🟡 `packages/protocols/uds/src/server.ts` prüft Session-Gating, NRC 0x78 und Service-Rechte; `server.spec.ts`, `protocol-details.spec.ts` | Zustandsmaschine (Default/Programming/Extended + P2/P2\* `ISO 14229-2`) explizit modellieren und als Conformance-Suite gegen den Simulator fahren; „Zustandsübergang ohne Definition ⇒ Ablehnung“ |
| 10 | Golden Vehicle Sessions + reproduzierbare reale Diagnosefälle | 🟡 Simulator und Replay sind da (`tests/replay/replay.test.ts`, 287 Zeilen), aber **es gibt keine echten Fahrzeugaufzeichnungen** | Dies ist der Hebel mit der größten Wirkung (siehe Leitsatz): eine echte, datenschutzkonforme Session — VIN redigiert, Rohspur + Definition-Version + Erwartung — als Golden Fixture je Fahrzeugreihe; ab da kann jede Änderung gegen die Praxis gemessen werden |

## P1 — danach

| # | Thema | Stand | Nächster Schritt |
|---|---|---|---|
| 11 | Definition Packages als versionierte Artefakte | 🟡 Schema v3, SemVer, Provenance, `migrate.ts`, JSON-Parser; Sitzungen referenzieren die Version (`oem@version`) | Pakete als unveränderliche Artefakte ausliefern (Datei/Registry) statt als Import; Signatur ist #50 |
| 12 | Declarative Diagnostic DSL | ⏳ Nutzerdefinierte Prüfabläufe liegen heute als `patterns[]`/`checks[]` in den Paketen (ADR 0024/0025) | Syntax + Compiler auf die IR (#6); Ziel: ein Ablauf ist Daten, kein Code |
| 13 | Capability Discovery mit Evidence | 🟡 `packages/domain/src/capabilities.ts`, `packages/runtime/src/capability-map.ts` | Fähigkeiten nicht behaupten, sondern mit Beleg sammeln (`evidence[]` wie beim Fahrzeug-Resolver) |
| 14 | Immutable Raw Recordings | 🟡 Roh und dekodiert getrennt (ADR 0004), NDJSON-Aufzeichnung (`storage`), aber Unveränderlichkeit ist nicht erzwungen | Rohspur unveränderlich schreiben (Prüfsumme je Datei, nur anhängen) und gegen Manipulation prüfbar machen |
| 15 | Signal-Analysis-Engine | 🟡 `packages/charts` (Decimierung, Statistik, Viewport), `measurements/statistics.ts` | Analyse von der Darstellung trennen: Anomalie, Fenster, Beziehung zwischen Signalen (Roadmap-Schritt 16 braucht genau das) |
| 16–18 | Fault Injection · Chaos Testing · Differential Testing | ⏳ Simulator kann Zustände, aber keine Fehlerinjektion | Fehlerklassen im Virtual Vehicle (Timeout, NRC, Frame-Abbruch, Zündung aus), dann Chaos über Discovery/Session-Wechsel |
| 19 | Fuzzing für Parser | 🟡 fast-check ist da und wird für Parser-Eigenschaften genutzt (`json.spec.ts`, `validate.spec.ts`) | Gezieltes Fuzzing der Parser aus #6/#11 (Struktur, nicht nur Werte) |
| 20 | Mutation Testing | ⏳ | Erst einführen, wenn die Coverage-Gates gesättigt sind — sonst misst es Deckung, die schon gemessen ist |
| 21 | knip | ⏳ | Nach #1 sinnvoll (tote Exporte fallen beim Zerlegen an) |
| 22 | dependency-cruiser | ⏳ (die Regel selbst existiert als Test, #2) | Generator aus der Allowlist in `tests/architecture/dependencies.test.ts`, damit es genau eine Quelle gibt |
| 23 | API Extractor | ⏳ | Nach #1/#6: dann existiert eine öffentliche Fläche, die man einfrieren kann |
| 24 | Semgrep mit eigenen Automotive-Regeln | ⏳ | Eigene Regeln nur für echte Hausregeln (kein UDS in der UI, kein Write ohne Safety, keine OEM-Logik in CAN) — sonst eine dritte Regelwelt |
| 25 | Gitleaks | ⏳ | Vor dem ersten echten Fahrzeugdatensatz (#10) verpflichtend, nicht danach |
| 26 | OSV Scanner | ⏳ | `npm audit` existiert als Skript, läuft aber nicht in der CI (E10/E17); OSV wäre der belastbarere Ersatz |
| 27 | strengere TypeScript-/Biome-Regeln | 🟡 **Biome erledigt (ADR 0026)**: 5 Regeln `warn`→`error`, 3 Regeln `off`→`error`, jede weitere `off`-Entscheidung mit Messung auf dem Rekord. Offen und gemessen: `exactOptionalPropertyTypes` (88 Fehler, 0.E E18) und Frontend-`noImplicitAny` (110 Fehler, E19) | E18 zuerst: die Roh→dekodiert-Grenze ist die Stelle, an der „fehlt“ und „undefined“ verwechselt werden können — und genau dort entstehen stille Diagnosefehler |
| 28 | strukturierte TraceId / CommandId / SessionId | 🟡 `packages/shared/src/ids.ts`, Events tragen die Ids (Roadmap-Schritt 11 ⏳) | Ids durch Trace und Logs ziehen und im Bericht sichtbar machen |
| 29 | Performance Gates | — | Erst mit #10 (echte Datenmengen) sinnvoll; eine erfundene Schwelle ist eine Zahl, die niemanden schützt |
| 30 | Memory-/Lifecycle-Leak Tests | — | `dispose()`-Pfade sind vorhanden; ein Gate, das echte Langläufe beobachtet, fehlt |

## P2 — Produkt- und Plattformausbau

| # | Thema | Stand | Nächster Schritt |
|---|---|---|---|
| 31–32 | Coding · Adaptation | ❌ bewusst nicht begonnen (AGENTS 0.A). Die Risiko-Policy nennt beide Operationen bereits (`domain/risk.ts`) | Erst nach #3/#4/#5 — Schreiben ohne Transaktion ist der teuerste Fehler dieser Plattform |
| 33 | Security-Access-Framework operationalisieren | 🟡 UDS-Security-Grundlagen (`protocols/uds/src/security.ts`), SFD/Security-Access-Umgehung ist verboten (AGENTS 0.D) | Zugriffsstufen, Freigaben und Audit als Domänenbegriff; nie als Umgehung |
| 34 | Routine Framework | ⏳ Routinen sind als Operationstyp bekannt, nicht implementiert | Nach #7, weil Routinen Transaktionen sind |
| 35 | DoIP produktionsfest | 🟡 `transport/doip/src/transport.ts` 98,5 % Zeilen / 91,4 % Zweige, Discovery getestet; **TLS ist angekündigt, nicht implementiert** (Dateikopf) | TLS (ISO 13400-2, Port 3496) und Mehrfach-Verbindungen; heute ist der TLS-Zweig nur eine Vorbedingung im Safety-Check |
| 36–37 | Multi-Bus · Gateway Routing | ⏳ | Nach #8 (Contract-Suite), sonst vervielfacht man ungetestete Nahtstellen |
| 38 | größere OEM-Definitionsbasis | 🟡 `generic`, `vag`, `mercedes`, plus Simulator-Paket; die Tiefe ist bewusst gering | Wächst mit #10: jede echte Session bringt Wissen zurück, das validiert werden kann (ADR 0003/0025) |
| 39 | Evidence Engine | 🟡 `packages/definitions/src/evidence.ts` und der Fahrzeug-Resolver tragen `evidence[]`/`conflicts[]` (ADR 0023) | Auf Diagnose ausdehnen: jede Aussage trägt ihre Belege, jede Hypothese ihre Widerlegung |
| 40 | Hypothesis Engine | 🟡 `patterns[]` **sind** die Hypothesen (ADR 0024), Roadmap-Schritt 16 ⏳ | Ablaufsteuerung: messen → Fenster bewerten → Ergebnis je Muster |
| 41–42 | AI-Ausgaben nur über Schema/IR · AI-Diagnose reproduzierbar versionieren | 🟡 `packages/ai` validiert Ausgaben Feld für Feld und redigiert VINs; Provider-Abstraktion vorhanden | Erst nach #6: ohne IR gibt es kein Schema, gegen das eine AI-Aussage gehalten werden kann |
| 43 | professionelle Diagnose-Workbench | ✅ 9 Views + Fahrzeugbestimmungspanel (`apps/web`) | Ausbau entlang #10/#40, nicht entlang von UI-Ideen |
| 44 | Time-Travel / Session Inspector | 🟡 `tools/trace-analyzer`, `packages/core/src/session/compare.ts` | Zeitreise braucht unveränderliche Rohspur (#14) als Grundlage |
| 45 | Storage für sehr große Zeitreihen | 🟡 JSON + NDJSON mit Migrationen (ADR 0007) | Erst messen (#10): NDJSON trägt überraschend viel, eine Datenbank vor dem Messwert wäre geraten |
| 46 | Event Store / ggf. Event Sourcing | 🟡 `packages/runtime/src/event-recorder.ts` (Audit-Trail über den geschlossenen Ereigniskatalog) | Vollständiges Event Sourcing nur, wenn #7 es verlangt — der Ereigniskatalog ist die Vorarbeit |

## P3 — langfristig

| # | Thema | Stand | Bedingung |
|---|---|---|---|
| 47 | Rust für den Low-Level-Hot-Path | — | Nur mit gemessenem Bedarf (ISO-TP bei hoher Last); heute ist die Suite in 22 s grün |
| 48 | Haskell für Safety/State/Math | — | Nur für hochformalisierte Bereiche; die Safety-Regeln sind heute Daten + Tests, das ist der billigere Beweis |
| 49 | Reference Implementations + Differential Tests | — | Nach #8 |
| 50 | signierte Definition Packages | — | Setzt #11 voraus |
| 51–52 | SBOM · Supply-Chain-/Build-Provenance | — | Zusammen mit #25/#26; ohne CI-Recht (E10) nicht wirksam |
| 53 | OpenTelemetry | — | Nach #28 und nur, wenn Traces außerhalb des Prozesses gebraucht werden |
| 54 | reproduzierbare Builds / Devcontainer | — | Kein Devcontainer im Baum; sinnvoll, sobald Beiträge von außen kommen |
| 55 | Cloud-/Device-Sync | — | Nach #14/#46 und mit einer Datenschutzentscheidung (VIN ist personenbezogen) |
| 56 | OEM-Plugin-System | 🟡 Oem-Hooks existieren (`packages/protocols/oem`, `tests/integration/oem-hooks.test.ts`) | Erst nach #12, sonst ist ein Plugin Code statt Daten |
| 57 | gemeinsamer Engineering-Graph-Kernel mit dem Elektroplaner | — | Bewusst offen; erst wenn beide Seiten einen stabilen IR haben (#6) |

## Was dieser Schritt (2026-09-14) bereits geändert hat

- `biome.json`: 5 Regeln `warn`/`off` → `error` ohne Produktionsänderung;
  3 weitere Regeln `error` mit 5 behobenen Fundstellen; Produktionscode ohne
  Regel-Ausnahme; jede `off`-Entscheidung mit Umfang und Messung im Rekord
  (`tests/architecture/guardrails.test.ts`).
- `tests/architecture/guardrails.test.ts` (neu, 7 Tests): ein Linter, jede
  Regel entschieden, Overrides nur für Nicht-Produktion, geerbte Strictness,
  **die Gates laufen im Testlauf**, CI pinnt `npm test` + Matrix, kein
  Orchestrator.
- Damit erzwingt die CI Biome und beide `--noEmit`-Pässe, ohne dass ein
  Workflow geändert werden muss (E10 bleibt für die Workflow-Härtung offen).
- Gemessen: 1307 Tests in 91 Dateien grün in 22,6 s; Coverage global
  96,48 / 89,65 / 97,52 / 97,86; Zusatzkosten der Gates ≈ 2 s.
