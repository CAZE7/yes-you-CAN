# Master-Backlog: von der Plattform zur nutzbaren Diagnosepraxis

Stand: 2026-09-14 · Bezug: ADR 0029, `docs/architecture/migration-roadmap.md`,
AGENTS 0.A (Stand), 0.E (offene Verbesserungen)

## Leitsatz

Das Repository hat genug Infrastruktur. Der Fehler wäre jetzt, weitere
Infrastruktur um ihrer selbst willen zu bauen. Die Richtung ist:

```
bestehende Architektur
      ↓
härtere automatische Guardrails      ← ADR 0029 (dieser Schritt, 2026-09-14)
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

## Zwei Korrekturen (entschieden, ADR 0029)

| Vorschlag | Entscheidung | Begründung |
|---|---|---|
| ESLint zusätzlich installieren | **nein** | Biome ist der Linter; das Problem war nicht die Menge der Regeln, sondern dass vier tragende Regeln auf `warn` standen und `biome check` in der CI nie lief. Ein zweiter Linter gäbe jeder Regel zwei Heimatorte (ADR 0029 §1) |
| Turborepo/Nx einführen | **nein, vorerst** | `tsc -b` über 25 Projekte, Biome in 0,8 s, Suite ~22 s — kein gemessener Flaschenhals. Ein Caching-Layer mit eigener Invalidierungslogik löst ein Problem, das noch nicht existiert; der Architekturtest meldet sich, sobald einer auftaucht (ADR 0029 §5) |

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
| 1 | `DiagnosticEngine` endgültig zerlegen | ✅ erledigt 2026-09-14: `engine.ts` 709 → **275 Zeilen** (davon 159 Code-Zeilen ohne Kommentar/Blank, 26 delegierende Methoden); Kollaborateure in `packages/core/src/diagnostics/`: `ecu-registry.ts` (94), `ecu-links.ts` (130, Transport-Naht CAN/ISO-TP/DoIP), `ecu-attacher.ts` (196), `session-opener.ts` (136), `dtc-access.ts` (212), `measurement-access.ts` (138), `engine-context.ts` (105 Aufbau/Verdrahtung), `engine-options.ts` (42). **Kein bestehender Test geändert** — 19 neue Tests in `engine-collaborators.spec.ts` (echte `UdsServer` hinter In-Memory-Link, Stub-Bus nur für Discovery) | — Nachbarpunkte #3/#7 sind mit ADR 0032 nachgezogen: `clearDtcs` ist keine Engine-Methode mehr; die Fassade schrumpfte durch das Entfernen der Schreibmethoden von 260 auf 275 Zeilen **inklusive** der neuen Doku, ohne dass ein Test weichen musste |
| 2 | Eine einzige verbindliche Architektur-/Dependency-Regel | ✅ erledigt 2026-09-14 (ADR 0031): die Regel ist **eine Datei** (`tools/architecture/dependency-rules.json` — Platzierung jedes Pakets mit `mayImport` **und** `why`, Node-Builtin-Ausnahmen, UI-Regel, Layer- und Portabilitätsregeln) und **ein Werkzeug** (`tools/architecture/check-dependencies.mjs`, `npm run check:deps`, Teil von `npm run ci`; Exit 0/1/2). Der Test wiederholt die Kanten nicht mehr, sondern bewacht das Werkzeug (Verdrahtung, Fixture-Negativfälle, blinde Präfixe, kaputte Regeldatei). **Dabei gefunden und behoben:** die Regel „protocols never import adapters“ prüfte `@vdp/adapters` — kein Paket heißt so (alle heißen `@vdp/adapter-*`), d. h. sie konnte nie feuern; ebenso in der Portabilitätsliste für domain/application. Ein Präfix ohne Treffer ist jetzt selbst ein Verstoß (`blind-prefix`) | — |
| 3 | Read- und Write-Pfad hart trennen | ✅ erledigt 2026-09-14 (ADR 0032): `DiagnosticEngine` und `DtcAccess` haben **keine Schreibmethode** mehr (`clearDtcs`, `evaluateDtcClear`, `DtcAccess.clear/evaluate` entfernt); Schreiben läuft ausschließlich über `WritePort` (`packages/core/src/writes/port.ts` — `register`/`run`/`precheck`/`kinds`/`history`). `packages/core/src/dtc/clear.ts` ist jetzt reiner Vertrag (`ClearableEcu`, `ClearDtcResult` inkl. `stages`/`transactionId`); `DtcClearService` ist weg. Verdrahtung an einer Stelle: `createWritePort()` (`writes/standard-operations.ts`). Der Test pinnt die Trennung: „die Leseseite kann nicht schreiben: ein Handle wechselt über den Write-Port“ (`engine-collaborators.spec.ts`, echtes `UdsServer`-ECU) | — |
| 4 | Write-Operationen als transaktionalen Ablauf modellieren | ✅ erledigt 2026-09-14 (ADR 0032): `WriteOperation<Input, Prepared, Value>` deklariert `prepare → confirm → execute → verify` (+ `rollback`, `rollbackUnavailable`, `onAbort`, `outcomeOf`); `DiagnosticTransaction.stage()` macht **jede** Stufe zu einem `StageReport {stage, state, reasons, warnings, at, detail?}` und fängt jeden Wurf — `run()` wirft nur noch bei unbekanntem `kind`. Scheitert `prepare`, wird die Transaktion abgebrochen **ohne** `confirm` (kein Permit, kein irreführender Audit-Eintrag); fehlendes `rollback` wird als übersprungene Stufe mit Begründung protokolliert (ISO 14229-1 kennt keine Rücknahme eines Clear). 19 Tests in `writes/writes.spec.ts` (u. a. Stufenreihenfolge, suspend/resume, rolled-back vs. aborted, Audit-Ausgang) | — |
| 5 | Safety „fail closed“ | ✅ erledigt 2026-09-14 (ADR 0033): fehlende Evidenz ist ein **Fehlschlag**, kein „kein Treffer“. `SafetyCheckResult` kennt drei Ausgänge — proven / violated / **unproven** —, `unproven ⊆ failed` blockiert also mit (Batteriespannung unbekannt, Ignition unbekannt, Parkbremse unbekannt, ECU-Typ nie gelesen, Softwarevariante nie gelesen, Sitzung unbekannt, DoIP-TLS/Routing unbekannt). Die Unterscheidung wird durchgereicht: `WritePort.precheck/run` → `DtcClearPrecheckInfo.unproven` → Wire-Contract `DtcClearPrecheck` → UI („?“ = messen statt „✘“ = reparieren); `requestPermit` zählt im Audit, wie viele der Gründe fehlende Nachweise waren. Zusätzlich aus dem Write-Port: Abbruch nach jeder gescheiterten Stufe, Permit-Ausgang immer journaliert (`write-failed` auch nach erteiltem Permit), `outcomeOf` markiert „ausgeführt, aber nicht bestätigt“ | — |
| 6 | Diagnostic IR einführen | 🟡 erste Etappe erledigt 2026-09-14 (ADR 0034): neues Paket `@vdp/diagnostic-ir` — `Provenance`/`Evidence` (proven/unproven), `SignalReading`**oder**`SignalGap`, `DtcObservation`/`DtcEnrichment` (+ `compareDtcObservations`), `EcuObservation`/`SessionObservation`, `MeasurementWindow` (mit Lücken und `conclusive`); 19 Tests, eigenes Coverage-Gate. **Verdrahtet:** der Signalmesspfad (`SignalDecoder.observe()` → IR, `decode()` als Projektion, `LiveDataEngine` sammelt `gaps` + `stats.gaps`, `MeasurementAccess` nutzt `observe()`), d. h. „raw → IR → Projektion“ ist für Messwerte Realität statt Absicht. **Offen:** DTC- und Session-Observations als Datenfluss (`DtcAccess`/`DtcTracker`, Session-Snapshots) und die Sicht „Lücken“ in Reports/UI | DTC-Pfad auf Beobachtungen umstellen (Scanner → `DtcObservation` → Projektion `EnrichedDtc`), Session-Snapshots als `SessionObservation`; zusammen mit #10 |
| 7 | `DiagnosticTransaction` als zentrale Abstraktion | ✅ erledigt 2026-09-14 (ADR 0032): `packages/core/src/writes/transaction.ts` — Zustände `open → prepared → confirmed → executed → verified \| suspended \| aborted \| rolled-back`, erlaubte Übergänge (`ALLOWED_FROM`), Journal und `snapshot` (Stufen, Journal, Permit, Vorbedingungen, Abbruchgrund), `suspend`/`resume` als Zustände statt `try/catch`. Der Typ lebt bewusst in `core`/`writes` und nicht in `domain`: Er gehört zum Schreibpfad; die IR-Variante (#6) darf ihn später ablösen. Test: `writes/writes.spec.ts` (4 Transaktionstests) | — (Persistenz über Prozessgrenzen bleibt offen, bis #6/#10 eine Session-Identität liefern) |
| 8 | Contract Tests für alle Transport-/Adapterimplementierungen | ✅ erledigt 2026-09-14: `tests/protocol/contracts/` — eine Suite je Port, gefahren gegen **jede** Implementierung. `can-bus.contract.test.ts`: virtueller Bus, Replay, Generic CAN, ELM327, CANable/slcan, SocketCAN (Lebenszyklus, typisierter Fehler auf geschlossenem Bus, unveränderte Nutzlast, Zustellung + Filter + Unsubscribe, ehrliche `capabilities` inkl. CAN-FD-Verhalten). `uds-link.contract.test.ts`: `IsoTpConnection` + `RequestResponseLink` (Antwortbytes, Schweigen als typisierter Fehler, `sendOnly` ohne Warten, Serialisierung paralleler Requests, `receive()`-Timeout als `null`). `byte-stream.contract.test.ts`: `MemoryByteStream` + Host-`SerialByteStream` (geordnete Writes, geordnete Zustellung, Unsubscribe, idempotentes `close()`, typisierter Fehler beim Schreiben in einen geschlossenen Strom). Drei Abweichungen gefunden und behoben: generische `Error` im Replay-/virtuellen Bus, FD-Frames auf einem Bus mit `canFd: false`, generischer `Error` im `MemoryByteStream`. | — (Adapter, die später dazukommen, tragen sich in die Tabelle ein und müssen die Regeln bestehen) |
| 9 | UDS-State-Machine + Conformance Suite | ✅ erledigt 2026-09-14 (ADR 0035): die Sitzung ist ein Datenrecord, die Maschine ein Modul. `packages/protocols/uds/src/session-state.ts` — `SessionDefinition` (`type`, `name`, `from`, `services`, `p2Ms`/`p2StarMs`/`s3Ms`), `SessionStateMachine` (`request`, `reset`, `activity`, `tick`, `serviceRefusal`, `isServiceAllowed`, `describeRefusal`, S3 aus ISO 14229-2 §7), Standard-Sätze `defaultSessionDefinition`/`extendedSessionDefinition`/`programmingSessionDefinition`/`standardSessions`/`simulatorSessions`. **Die vier Antworten sind verschieden:** unbekannter Sitzungstyp → 0x12, definierter Typ ohne erlaubten Übergang → 0x22 (Sitzung bleibt), Dienst implementiert, in dieser Sitzung gesperrt → 0x7F, Dienst nicht implementiert → 0x11 in jeder Sitzung. Lesen (`0x10`/`0x11`/`0x19`/`0x22`/`0x3E`) in jeder Sitzung, Schreiben (`0x14`/`0x27`/`0x2E`/`0x31`) erst außerhalb der Default-Sitzung; `0x27` bleibt ohne `securityAccess`-Option ein nicht implementierter Dienst. Der Server fragt die Maschine pro Request (`serviceRefusal`), S3 setzt abgelaufene Sitzungen auf Default, ein ECU-Reset ebenfalls. **Conformance-Suite:** `tests/protocol/uds-conformance.test.ts` fährt eine Regeltabelle gegen **zwei** Backends — `UdsServer` direkt und `VirtualVehicle` über virtuelles CAN + ISO-TP — 48 Tests (10 Dienst-×-Sitzungsfälle, 9 Übergänge, S3 mit injizierter Uhr, `0x78`-Paar, ECU-Reset, Definition-Guard-Rails); `session-state.spec.ts` pinnt die Maschine selbst (19 Tests). **Der Simulator teilt die Definitionen** (`simulatorSessions()`), kann also nicht großzügiger sein als das ECU. **Dabei gefunden:** ein Test war grün aus dem falschen Grund (prüfte Byte 2 des Seeds statt der NRC „nicht implementiert“) — Harness-Defaults maskieren „Dienst fehlt“. Messung: `npm test` 99 Dateien / 1487 Tests, `session-state.ts` 98,7/93,1/100/98,57 | — |
| 10 | Golden Vehicle Sessions + reproduzierbare reale Diagnosefälle | ✅ **Aufzeichnung, Replay und Erwartung erledigt am 2026-09-14 (ADR 0036):** `tools/golden-sessions` schreibt `vdp.golden` v1 aus Rezept + Simulator (`npm run golden:record --verify`), vier eingecheckte Fixtures in `tests/fixtures/golden-sessions/` (leerer Fehlerspeicher, gespeicherte Codes mit Freeze Frames, NRC 0x78 vor der echten Antwort, bewegte Signale mit Seed; 184–219 Frames je Sitzung), `tests/replay/golden-sessions.test.ts` fährt jedes Fixture durch die ganze Pipeline (Replay-Transport, ISO-TP, UDS-Client, Definitionen) und vergleicht ECUs, Fehlerspeicher und Signalwerte; VIN-Redaktion arbeitet auf ISO-TP-Nachrichten (byteweise, nicht als Textersetzung), Erwartungen tragen stabile ECU-Ids. Zwei echte Replay-Fehler hat erst der goldene Lauf gezeigt (Flow-Control-Frame als Anfrage gezählt, Antworten ohne Zeitlichkeit zugestellt) — beide behoben | **Offen bleibt der zweite Halbsatz:** die Fixtures stammen vom Simulator (`provenance.source: "simulator"`). Echte Fahrzeugaufzeichnungen laufen durch dieselbe Pipeline, sobald Adapteraufzeichnungen vorliegen (#11 Pakete als Artefakte, #25 Gitleaks vor dem ersten echten Datensatz, #29 Performance-Gates mit echten Datenmengen) |

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
| 22 | dependency-cruiser | ✅ erledigt 2026-09-14 durch P0 #2 — **bewusst ohne dependency-cruiser** (ADR 0031): genau eine Quelle (`dependency-rules.json`) + eigenes Werkzeug mit Fixture-Beleg; dependency-cruiser brächte eine zweite Regel-DSL und würde die Allowlist erneut ausdrücken („kein zweites Vokabular für dieselbe Frage“, vgl. ADR 0029/ESLint) | Neu bewerten, sobald Regeln nötig werden, die Datei-Ebenen, Laufzeit-Zyklen oder Type-only-Kanten brauchen |
| 23 | API Extractor | ⏳ | Nach #1/#6: dann existiert eine öffentliche Fläche, die man einfrieren kann |
| 24 | Semgrep mit eigenen Automotive-Regeln | ⏳ | Eigene Regeln nur für echte Hausregeln (kein UDS in der UI, kein Write ohne Safety, keine OEM-Logik in CAN) — sonst eine dritte Regelwelt |
| 25 | Gitleaks | ⏳ | Vor dem ersten echten Fahrzeugdatensatz (#10) verpflichtend, nicht danach |
| 26 | OSV Scanner | ⏳ | `npm audit` existiert als Skript, läuft aber nicht in der CI (E10/E20); OSV wäre der belastbarere Ersatz |
| 27 | strengere TypeScript-/Biome-Regeln | ✅ **erledigt am 2026-09-14.** Biome: 5 Regeln `warn`→`error`, 3 Regeln `off`→`error`, jede weitere `off`-Entscheidung mit Messung auf dem Rekord (ADR 0029). TypeScript: `exactOptionalPropertyTypes` global an (E18, 88 Fehler migriert) und Frontend-`noImplicitAny` an (E19, 221 Fehler migriert, ADR 0030) — `RELAXED_FLAGS` ist leer, und der Guardrail-Test fordert beide Flags positiv, statt nur Abschaltungen zu verbieten | fertig; neue Abschwächungen brauchen wieder einen Eintrag mit Messung |
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
- Gemessen: 1308 Tests in 91 Dateien grün in 22,9 s; Coverage global
  96,48 / 89,65 / 97,52 / 97,86; Zusatzkosten der Gates ≈ 2 s (das
  Frontend-Projekt prüft seit ADR 0030 acht Dateien mit `noImplicitAny`).
