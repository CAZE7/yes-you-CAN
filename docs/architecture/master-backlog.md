# Master-Backlog: von der Plattform zur nutzbaren Diagnosepraxis

Stand: 2026-09-14 (zweite Etappe Diagnostic IR, ADR 0037) · Bezug: ADR 0029/0034/0037,
`docs/architecture/migration-roadmap.md`, [AGENTS 0.A](status.md) (Stand), 0.E (offene Verbesserungen)

## Leitsatz

Das Repository hat genug Infrastruktur. Der Fehler wäre jetzt, weitere
Infrastruktur um ihrer selbst willen zu bauen. Die Richtung ist:

```
bestehende Architektur
      ↓
härtere automatische Guardrails      ← ADR 0029 (erledigt)
      ↓
Diagnostic IR als eine Zwischenstufe ← ADR 0034 + ADR 0037 (dieser Schritt)
      ↓
reale Fahrzeugdaten
      ↓
reproduzierbare Diagnosefälle        ← ADR 0036 (Werkzeug da, echte Sessions fehlen)
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
| 2 | Eine einzige verbindliche Architektur-/Dependency-Regel | ✅ erledigt 2026-09-14 (ADR 0031): die Regel ist **eine Datei** (`tools/architecture/dependency-rules.json` — Platzierung jedes Pakets mit `mayImport` **und** `why`, Node-Builtin-Ausnahmen, UI-Regel, Layer- und Portabilitätsregeln) und **ein Werkzeug** (`tools/architecture/check-dependencies.mjs`, `npm run check:deps`, Teil von `npm run ci`; Exit 0/1/2). Der Test wiederholt die Kanten nicht mehr, sondern bewacht das Werkzeug (Verdrahtung, Fixture-Negativfälle, blinde Präfixe, kaputte Regeldatei). **Nachgezogen 2026-09-15 (ADR 0042):** die Sibling-Frage — passt `package.json` zu den tatsächlichen Importen? — hat ein eigenes Werkzeug mit derselben Form (`check-package-manifests.mjs`, `npm run check:manifests`, Teil von `npm run ci`); es fand und behob 12 Abweichungen in acht Paketen (4 fehlende Deklarationen, 6 tote, 1 `dependencies`→`devDependencies`, Versionen/Unbekanntes). Es liest die Schichtregeln nicht, sondern nur den Importgraphen — eine Regel, eine Heimat. **Dabei gefunden und behoben:** die Regel „protocols never import adapters“ prüfte `@vdp/adapters` — kein Paket heißt so (alle heißen `@vdp/adapter-*`), d. h. sie konnte nie feuern; ebenso in der Portabilitätsliste für domain/application. Ein Präfix ohne Treffer ist jetzt selbst ein Verstoß (`blind-prefix`). **Nachgezogen 2026-09-16 (ADR 0043):** `dependency-rules.json` ist zu `architecture/architecture.yaml` gezogen — dieselbe Regel, dasselbe Werkzeug, eine Quelle, jetzt mit `layers` (Layer-Zuordnung aller 27 Pakete) und `topics` (6 AI-Context-Topics); JSON-Syntax in einem YAML-Namen (ADR 0002), damit `JSON.parse` ohne Laufzeit-Abhängigkeit und jeder YAML-Reader dieselbe Datei lesen. Derselbe Manifest trägt die AI-Kontextschicht: `npm run ai:context <topic>` generiert daraus `.ai/generated/<topic>-context.md` (nie committet), und die Doku-Ebene darüber — `ARCHITECTURE.md`, Package-READMEs mit „Does NOT do“, AGENTS §0.0 (AI Engineering Contract), `docs/code-map.md`, `docs/glossary.md`, `docs/api/*`, `docs/flows/*`, `.ai/`, `tests/examples/*.example.ts` — ist in ADR 0043 verankert | — |
| 3 | Read- und Write-Pfad hart trennen | ✅ erledigt 2026-09-14 (ADR 0032): `DiagnosticEngine` und `DtcAccess` haben **keine Schreibmethode** mehr (`clearDtcs`, `evaluateDtcClear`, `DtcAccess.clear/evaluate` entfernt); Schreiben läuft ausschließlich über `WritePort` (`packages/core/src/writes/port.ts` — `register`/`run`/`precheck`/`kinds`/`history`). `packages/core/src/dtc/clear.ts` ist jetzt reiner Vertrag (`ClearableEcu`, `ClearDtcResult` inkl. `stages`/`transactionId`); `DtcClearService` ist weg. Verdrahtung an einer Stelle: `createWritePort()` (`writes/standard-operations.ts`). Der Test pinnt die Trennung: „die Leseseite kann nicht schreiben: ein Handle wechselt über den Write-Port“ (`engine-collaborators.spec.ts`, echtes `UdsServer`-ECU) | — |
| 4 | Write-Operationen als transaktionalen Ablauf modellieren | ✅ erledigt 2026-09-14 (ADR 0032): `WriteOperation<Input, Prepared, Value>` deklariert `prepare → confirm → execute → verify` (+ `rollback`, `rollbackUnavailable`, `onAbort`, `outcomeOf`); `DiagnosticTransaction.stage()` macht **jede** Stufe zu einem `StageReport {stage, state, reasons, warnings, at, detail?}` und fängt jeden Wurf — `run()` wirft nur noch bei unbekanntem `kind`. Scheitert `prepare`, wird die Transaktion abgebrochen **ohne** `confirm` (kein Permit, kein irreführender Audit-Eintrag); fehlendes `rollback` wird als übersprungene Stufe mit Begründung protokolliert (ISO 14229-1 kennt keine Rücknahme eines Clear). 19 Tests in `writes/writes.spec.ts` (u. a. Stufenreihenfolge, suspend/resume, rolled-back vs. aborted, Audit-Ausgang) | — |
| 5 | Safety „fail closed“ | ✅ erledigt 2026-09-14 (ADR 0033): fehlende Evidenz ist ein **Fehlschlag**, kein „kein Treffer“. `SafetyCheckResult` kennt drei Ausgänge — proven / violated / **unproven** —, `unproven ⊆ failed` blockiert also mit (Batteriespannung unbekannt, Ignition unbekannt, Parkbremse unbekannt, ECU-Typ nie gelesen, Softwarevariante nie gelesen, Sitzung unbekannt, DoIP-TLS/Routing unbekannt). Die Unterscheidung wird durchgereicht: `WritePort.precheck/run` → `DtcClearPrecheckInfo.unproven` → Wire-Contract `DtcClearPrecheck` → UI („?“ = messen statt „✘“ = reparieren); `requestPermit` zählt im Audit, wie viele der Gründe fehlende Nachweise waren. Zusätzlich aus dem Write-Port: Abbruch nach jeder gescheiterten Stufe, Permit-Ausgang immer journaliert (`write-failed` auch nach erteiltem Permit), `outcomeOf` markiert „ausgeführt, aber nicht bestätigt“ | — |
| 6 | Diagnostic IR einführen | ✅ **beide Etappen erledigt 2026-09-14** (ADR 0034, ADR 0037): `@vdp/diagnostic-ir` ist die eine Zwischenstufe zwischen Rohform und Projektion. **Erste Etappe (Messpfad):** `Provenance`/`Evidence` (proven/unproven), `SignalReading` **oder** `SignalGap`, `MeasurementWindow` mit Lücken und `conclusive`; `SignalDecoder.observe()` → IR, `decode()` als Projektion, `LiveDataEngine` sammelt `gaps`, `MeasurementAccess` nutzt `observe()`. **Zweite Etappe (Fehlerspeicher, Sitzung, Lücken):** `DtcScanner.observe()` liefert `DtcState` (`DtcObservation` + `DtcEnrichment` + Historie, je mit eigenem Beleg), `enrich()` ist die Projektion davon — ein Rechenweg, zwei Sichten, **kein Konsument musste ändern**. `dtcKey()` (IR) ist die **einzige** Identitätsregel: Historie, Vergleich und Replay rechnen dieselbe Paar-Eindeutigkeit (ECU + normalisierter Code); `DtcScanner.compare` delegiert an `compareDtcObservations` statt eine zweite Regel zu haben. `session/observation.ts` projiziert die gespeicherte Sitzung in die IR (`sessionObservationOf`, `dtcObservationsOf`, `sessionGapsOf`) — inklusive Reparatur des JSON-Byte-Problems (`storedBytes`). **Lücken sind sichtbar:** Bericht-Sektion „Observations & gaps“, DTC-Details in der Workbench zeigen `Belegt durch:` (das Feld `DtcView.provenance` existierte, wurde aber nie gesetzt — die IR füllt es), und `evidence` reist als optionales Feld im gespeicherten Record mit — additiv, ohne Schema-Bump. 27 Tests neu, 2 bestehende gepinnte Entscheidungen bewusst ersetzt (Groß-/Kleinschreibung, Wortlaut des unproven-Grunds) | — (die IR ist der Datenfluss, nicht das Ziel: die nächsten Verbraucher #39 (Evidence Engine) und #40 (Hypothesis Engine) sind am selben Tag gefolgt (ADR 0038); offen bleibt die interaktive Ablaufsteuerung aus Roadmap-Schritt 16) |
| 7 | `DiagnosticTransaction` als zentrale Abstraktion | ✅ erledigt 2026-09-14 (ADR 0032): `packages/core/src/writes/transaction.ts` — Zustände `open → prepared → confirmed → executed → verified \| suspended \| aborted \| rolled-back`, erlaubte Übergänge (`ALLOWED_FROM`), Journal und `snapshot` (Stufen, Journal, Permit, Vorbedingungen, Abbruchgrund), `suspend`/`resume` als Zustände statt `try/catch`. Der Typ lebt bewusst in `core`/`writes` und nicht in `domain`: Er gehört zum Schreibpfad; die IR-Variante (#6) darf ihn später ablösen. Test: `writes/writes.spec.ts` (4 Transaktionstests) | — (Persistenz über Prozessgrenzen bleibt offen, bis #6/#10 eine Session-Identität liefern) |
| 8 | Contract Tests für alle Transport-/Adapterimplementierungen | ✅ erledigt 2026-09-14: `tests/protocol/contracts/` — eine Suite je Port, gefahren gegen **jede** Implementierung. `can-bus.contract.test.ts`: virtueller Bus, Replay, Generic CAN, ELM327, CANable/slcan, SocketCAN (Lebenszyklus, typisierter Fehler auf geschlossenem Bus, unveränderte Nutzlast, Zustellung + Filter + Unsubscribe, ehrliche `capabilities` inkl. CAN-FD-Verhalten). `uds-link.contract.test.ts`: `IsoTpConnection` + `RequestResponseLink` (Antwortbytes, Schweigen als typisierter Fehler, `sendOnly` ohne Warten, Serialisierung paralleler Requests, `receive()`-Timeout als `null`). `byte-stream.contract.test.ts`: `MemoryByteStream` + Host-`SerialByteStream` (geordnete Writes, geordnete Zustellung, Unsubscribe, idempotentes `close()`, typisierter Fehler beim Schreiben in einen geschlossenen Strom). Drei Abweichungen gefunden und behoben: generische `Error` im Replay-/virtuellen Bus, FD-Frames auf einem Bus mit `canFd: false`, generischer `Error` im `MemoryByteStream`. | — (Adapter, die später dazukommen, tragen sich in die Tabelle ein und müssen die Regeln bestehen) |
| 9 | UDS-State-Machine + Conformance Suite | ✅ erledigt 2026-09-14 (ADR 0035): die Sitzung ist ein Datenrecord, die Maschine ein Modul. `packages/protocols/uds/src/session-state.ts` — `SessionDefinition` (`type`, `name`, `from`, `services`, `p2Ms`/`p2StarMs`/`s3Ms`), `SessionStateMachine` (`request`, `reset`, `activity`, `tick`, `serviceRefusal`, `isServiceAllowed`, `describeRefusal`, S3 aus ISO 14229-2 §7), Standard-Sätze `defaultSessionDefinition`/`extendedSessionDefinition`/`programmingSessionDefinition`/`standardSessions`/`simulatorSessions`. **Die vier Antworten sind verschieden:** unbekannter Sitzungstyp → 0x12, definierter Typ ohne erlaubten Übergang → 0x22 (Sitzung bleibt), Dienst implementiert, in dieser Sitzung gesperrt → 0x7F, Dienst nicht implementiert → 0x11 in jeder Sitzung. Lesen (`0x10`/`0x11`/`0x19`/`0x22`/`0x3E`) in jeder Sitzung, Schreiben (`0x14`/`0x27`/`0x2E`/`0x31`) erst außerhalb der Default-Sitzung; `0x27` bleibt ohne `securityAccess`-Option ein nicht implementierter Dienst. Der Server fragt die Maschine pro Request (`serviceRefusal`), S3 setzt abgelaufene Sitzungen auf Default, ein ECU-Reset ebenfalls. **Conformance-Suite:** `tests/protocol/uds-conformance.test.ts` fährt eine Regeltabelle gegen **zwei** Backends — `UdsServer` direkt und `VirtualVehicle` über virtuelles CAN + ISO-TP — 48 Tests (10 Dienst-×-Sitzungsfälle, 9 Übergänge, S3 mit injizierter Uhr, `0x78`-Paar, ECU-Reset, Definition-Guard-Rails); `session-state.spec.ts` pinnt die Maschine selbst (19 Tests). **Der Simulator teilt die Definitionen** (`simulatorSessions()`), kann also nicht großzügiger sein als das ECU. **Dabei gefunden:** ein Test war grün aus dem falschen Grund (prüfte Byte 2 des Seeds statt der NRC „nicht implementiert“) — Harness-Defaults maskieren „Dienst fehlt“. Messung: `npm test` 99 Dateien / 1487 Tests, `session-state.ts` 98,7/93,1/100/98,57 | — |
| 10 | Golden Vehicle Sessions + reproduzierbare reale Diagnosefälle | ✅ **Aufzeichnung, Replay und Erwartung erledigt am 2026-09-14 (ADR 0036):** `tools/golden-sessions` schreibt `vdp.golden` v1 aus Rezept + Simulator (`npm run golden:record --verify`), vier eingecheckte Fixtures in `tests/fixtures/golden-sessions/` (leerer Fehlerspeicher, gespeicherte Codes mit Freeze Frames, NRC 0x78 vor der echten Antwort, bewegte Signale mit Seed; 184–219 Frames je Sitzung), `tests/replay/golden-sessions.test.ts` fährt jedes Fixture durch die ganze Pipeline (Replay-Transport, ISO-TP, UDS-Client, Definitionen) und vergleicht ECUs, Fehlerspeicher und Signalwerte; VIN-Redaktion arbeitet auf ISO-TP-Nachrichten (byteweise, nicht als Textersetzung), Erwartungen tragen stabile ECU-Ids. Zwei echte Replay-Fehler hat erst der goldene Lauf gezeigt (Flow-Control-Frame als Anfrage gezählt, Antworten ohne Zeitlichkeit zugestellt) — beide behoben | **Offen bleibt der zweite Halbsatz — und hat seit 2026-09-23 ein Werkzeug (ADR 0058):** die Fixtures stammen vom Simulator (`provenance.source: "simulator"`). `tools/harvest` (`@vdp/harvest`) liest jetzt ein reales Fahrzeug **read-only** aus und schreibt eine Beobachtung (`harvest.json`), eine ODX-Beschreibung (`.odx-d`/`.pdx`, gegen `odxtools` gegengeprüft) und einen Definitions-Kandidaten mit `sourceType: "observed"` — derselbe Bus-Vertrag, den die goldenen Sitzungen benutzen, also läuft eine echte Ernte durch dieselbe Pipeline. Was weiterhin fehlt: **Ernte-Datensätze aus echten Fahrzeugen im Baum** (davor #25 Gitleaks, AGENTS 30: VIN ist maskiert, `--keep-vin` ist die Ausnahme) und #29 Performance-Gates mit echten Datenmengen |

## P1 — danach

| # | Thema | Stand | Nächster Schritt |
|---|---|---|---|
| 11 | Definition Packages als versionierte Artefakte | 🟡 Schema v3, SemVer, Provenance, `migrate.ts`, JSON-Parser; Sitzungen referenzieren die Version (`oem@version`) | Pakete als unveränderliche Artefakte ausliefern (Datei/Registry) statt als Import; Signatur ist #50 |
| 12 | Declarative Diagnostic DSL | ⏳ Nutzerdefinierte Prüfabläufe liegen heute als `patterns[]`/`checks[]` in den Paketen (ADR 0024/0025) | Syntax + Compiler auf die IR (#6); Ziel: ein Ablauf ist Daten, kein Code |
| 13 | Capability Discovery mit Evidence | 🟡 `packages/domain/src/capabilities.ts`, `packages/runtime/src/capability-map.ts` | Fähigkeiten nicht behaupten, sondern mit Beleg sammeln (`evidence[]` wie beim Fahrzeug-Resolver) |
| 14 | Immutable Raw Recordings | 🟡 Roh und dekodiert getrennt (ADR 0004), NDJSON-Aufzeichnung (`storage`), aber Unveränderlichkeit ist nicht erzwungen | Rohspur unveränderlich schreiben (Prüfsumme je Datei, nur anhängen) und gegen Manipulation prüfbar machen |
| 15 | Signal-Analysis-Engine | 🟡 `packages/charts` (Decimierung, Statistik, Viewport), `measurements/statistics.ts` | Analyse von der Darstellung trennen: Anomalie, Fenster, Beziehung zwischen Signalen (Roadmap-Schritt 16 braucht genau das) |
| 16–18 | Fault Injection · Chaos Testing · Differential Testing | ✅ **Fault-Injection am Transport-Seam erledigt 2026-09-14** (ADR 0039) · ✅ **Chaos über mehrere Module erledigt 2026-09-15** (ADR 0040): das Fahrzeugmodell lässt Fehler aus Ursachen entstehen, `VirtualCanNetwork.impair()` verliert Rahmen auf dem Draht (beide Richtungen, zählbar), und die Szenario-Engine (`SCENARIO_CATALOG`, 6 Szenarien) fährt dieselben Daten durch Modell-Test *und* End-to-End-Kette bis zur Evidence — 1907 Tests, davon 77 im Simulators-Paket und 13 in `tests/integration/scenario-chain.test.ts` | ⏳ Differential gegen einen zweiten Stack (#18): der Simulator kann jetzt Verhalten, nicht nur Zustände; eine Referenz-Implementierung (zweites UDS-Verhalten gegeneinander laufen lassen) existiert nicht |
| 19 | Fuzzing für Parser | 🟡 fast-check ist da und wird für Parser-Eigenschaften genutzt (`json.spec.ts`, `validate.spec.ts`) | Gezieltes Fuzzing der Parser aus #6/#11 (Struktur, nicht nur Werte); der Fault-Seam aus ADR 0039 ist die Anbindung für Frame-Eingaben |
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
| 31–32 | Coding · Adaptation | ❌ bewusst nicht begonnen ([AGENTS 0.A](status.md)). Die Risiko-Policy nennt beide Operationen bereits (`domain/risk.ts`) | Erst nach #3/#4/#5 — Schreiben ohne Transaktion ist der teuerste Fehler dieser Plattform |
| 33 | Security-Access-Framework operationalisieren | 🟡 UDS-Security-Grundlagen (`protocols/uds/src/security.ts`), SFD/Security-Access-Umgehung ist verboten (AGENTS 0.D) | Zugriffsstufen, Freigaben und Audit als Domänenbegriff; nie als Umgehung |
| 34 | Routine Framework | ⏳ Routinen sind als Operationstyp bekannt, nicht implementiert | Nach #7, weil Routinen Transaktionen sind |
| 35 | DoIP produktionsfest | 🟡 `transport/doip/src/transport.ts` 98,5 % Zeilen / 91,4 % Zweige, Discovery getestet; **TLS ist angekündigt, nicht implementiert** (Dateikopf) | TLS (ISO 13400-2, Port 3496) und Mehrfach-Verbindungen; heute ist der TLS-Zweig nur eine Vorbedingung im Safety-Check |
| 36–37 | Multi-Bus · Gateway Routing | ⏳ | Nach #8 (Contract-Suite), sonst vervielfacht man ungetestete Nahtstellen |
| 38 | größere OEM-Definitionsbasis | 🟡 `generic`, `vag`, `mercedes`, plus Simulator-Paket; die Tiefe ist bewusst gering. **Seit 2026-09-23 (ADR 0058) gibt es den Weg von einem Fahrzeug zu einem Paket:** `tools/harvest` schreibt einen Definitions-Kandidaten mit `observed`-Provenance, der durch dieselbe Validierung läuft; Beobachtungen ohne dokumentierte Kodierung landen in `skipped[]` mit Grund statt als erfundene Signale | Wächst mit #10: jede echte Ernte bringt Adressen, DIDs mit Bytelänge und Codes zurück — die *Bedeutung* braucht weiterhin eine Quelle (`standard`/`licensed`), sonst bleibt es ein Kandidat. Nächster Schritt: einen Kandidaten gegen eine dokumentierte Quelle anreichern und die Delta-Ansicht dazu (was ist beobachtet, was belegt?) |
| 39 | Evidence Engine | ✅ **Diagnose-Ebene erledigt 2026-09-14** (ADR 0038): die IR trägt `EvidenceItem`/`EvidenceSet`/`EvidenceConflict`/`Hypothesis`, `core/src/evidence/collect.ts` füllt sie aus der Sitzung (Scan mit `enrichmentEvidence`, Statistik, Anomalien, Bestimmung, `sessionGapsOf`) — jede Aussage adressierbar über `evidenceItemId`, offene Fragen als unprovene Items, ein Widerspruch zweier Items über demselben Code bleibt stehen statt eine Seite zu verlieren; `runtime.evidence.snapshot()` ist der eine Lieferant für Workbench, Bericht und Analyse | Belege **gegeneinander** prüfen (ADR 0033s Freispruch-Fall: ‚nach dem Clear gemessen, aber der Zähler lief weiter'), nicht nur gegen das Nichts |
| 40 | Hypothesis Engine | ✅ **Bewertung erledigt 2026-09-14** (ADR 0038): `core/src/evidence/hypotheses.ts` bewertet jeden dokumentierten `checks[]`-Eintrag gegen die Messwerte im dokumentierten Fenster (IR-`summariseWindow`, die eine Fensterrechnung) und leitet das Musterurteil daraus ab — `confirmed`/`refuted`/`untested`, `nextTest` = erster unentschiedener Check, `confidenceOf` als nachrechenbare Regel mit Deckel 0,9; die Workbench zeigt „next test for …“ als Empfehlung | Der **interaktive** Ablauf (Roadmap 16): Messung aus dem UI anstoßen, Fenster schließen, nächsten Schritt aus dem Urteil wählen — die Regel existiert, die Führung noch nicht |
| 41–42 | AI-Ausgaben nur über Schema/IR · AI-Diagnose reproduzierbar versionieren | ✅ 2026-09-14 (ADR 0038): `@vdp/ai` darf `shared` und `diagnostic-ir` importieren und sonst nichts; ein Guardrail-Test rechnet die Transitivhülle aus `dependency-rules.json` und fällt, sobald ein Lese-Layer Schreibfähigkeit erreicht (maschinelle Form von „die KI ruft nie `CAN.write()`/`UDS.send()`“). `AnalysisInput` trägt Evidenzmenge, Hypothesen und Versionen; `AnalysisResult.provenance` nennt `promptVersion` (steht im Prompttext selbst, `ai/src/prompt.ts`), `runtimeVersion` (`PLATFORM_VERSION`, manifest-geprüft), `definitionVersion`/`packageVersions`; Befunde zitieren `basedOn`-Item-Ids, und ein Gateway-Zitat auf ein nicht existierendes Item fällt weg. Versionen stammen aus der Anfrage, nie aus der Antwort | Knowledge-Version als eigene Zahl (heute die Paketversionen), Promptfassung auch ins Session-Audit schreiben |
| 43 | professionelle Diagnose-Workbench | ✅ 9 Views + Fahrzeugbestimmungspanel (`apps/web`) | Ausbau entlang #10/#40, nicht entlang von UI-Ideen |
| 44 | Time-Travel / Session Inspector | 🟡 `tools/trace-analyzer`, `packages/core/src/session/compare.ts` | Zeitreise braucht unveränderliche Rohspur (#14) als Grundlage |
| 45 | Storage für sehr große Zeitreihen | 🟡 JSON + NDJSON mit Migrationen (ADR 0007) | Erst messen (#10): NDJSON trägt überraschend viel, eine Datenbank vor dem Messwert wäre geraten |
| 46 | Event Store / ggf. Event Sourcing | 🟡 `packages/runtime/src/event-recorder.ts` (Audit-Trail über den geschlossenen Ereigniskatalog) | Vollständiges Event Sourcing nur, wenn #7 es verlangt — der Ereigniskatalog ist die Vorarbeit |
| 58 | ODX-/PDX-Pakete der Hersteller **importieren** | ⏳ Der Schreiber existiert (`tools/harvest/src/odx/`), ein Leser nicht | Rechtlich der Weg zu *dokumentiertem* Wissen (Art. 61/63 VO (EU) 2018/858, maschinenlesbar, gebührenpflichtig; EuGH C-319/22, OLG Köln 6 U 58/24, VO (EU) 2026/699). Braucht je Quelle eine Lizenz- und Provenance-Entscheidung (`licensed` mit `license`+`version`+`retrievedAt`, ADR 0025), einen ODX-D-Parser und die ODX-C-Entscheidung (Comparam-Subsets mitführen = Abhängigkeit, ADR 0002/0010) |
| 59 | Ernte in der Workbench | ⏳ CLI und Bibliothek stehen, die UI ruft sie nicht | Ein Panel „Fahrzeug auslesen" mit Plan-Ansicht vor dem Lauf, Fortschritt je Stufe, und der zweiten Hälfte (`unread`, `didRefusals`, `gaps`) sichtbar wie beim DTC-Scan (ADR 0049). Bedingung: `runCli` ist bereits als Funktion mit Exit-Code testbar, die Runtime braucht ein Kommando, das eine Ernte startet und ihren Datensatz als Sitzung ablegt |

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
