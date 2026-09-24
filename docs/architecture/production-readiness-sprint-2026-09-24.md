# Production-Readiness-Sprint 2026-09-24 — Abschluss-Audit

Bezug: Master-Prompt „Production-Readiness Sprint: Die 10 wichtigsten Aufgaben".
Basis-Commit `05ed4e4` (Merge PR #51), Branch `arena/01a0d4a9-yes-you-CAN`.
Alle Zahlen in diesem Dokument sind **gemessen**, nicht geschätzt; jede Zeile
nennt die Datei oder den Befehl, mit dem sie nachprüfbar ist.

## 0. Was dieser Sprint getan hat — und was nicht

Der Auftrag nennt zehn Prioritäten und verlangt ausdrücklich: *„Baue keine
Zukunftsfeatures nur für die Architektur"*, *„keine Dummy-Implementierungen als
fertig markieren"*, *„keine Tests abschwächen"*. Die Analyse am Code hat ergeben,
dass die Prioritäten 1 und 2 echte, gemessene Lücken hatten (fehlender
Verbindungszustand in der gesamten Adapter-Schicht; DoIP als Codec ohne
Produktpfad), während die Prioritäten 3–10 teilweise vorhandene, teilweise
fehlende Bausteine sind, deren halbe Umsetzung genau die Strukturen erzeugt
hätte, die der Auftrag verbietet (halbfertige Faktenmodelle, Capability-Kataloge
ohne Leser, ein Request-Journal ohne Konsument).

**Entschieden und begründet:** Prioritäten 1 und 2 wurden vollständig umgesetzt
(Code + Tests + Architektur-Gates + Dokumentation, ADR 0060/0061); Prioritäten
3–10 wurden **nicht** begonnen und stehen als konkrete, mit Ausgangspunkt
versehene Aufgaben in [NEXT 10](#6-next-10). Alles, was hier als erledigt
steht, hat einen Test, der es beweist; alles, was offen ist, steht offen.

## 1. IMPLEMENTED

### 1.1 Priorität 1 — Adapter-Validierung: der Adapter hat einen Zustand (ADR 0060)

| Änderung | Ort |
|---|---|
| `AdapterConnectionState` (`disconnected`, `connecting`, `connected`, `degraded`, `recovering`, `error`), `USABLE_CONNECTION_STATES`, `ConnectionTracker` (Zustand, Grund, Zeitpunkt, begrenzte Historie, Listener, Zähler) | `packages/transport/can/src/connection.ts` |
| `CanBus.getStatus(): ConnectionStatus` ist **Pflicht** im Port; `ConnectionState` ist jetzt überall dieselbe Obermenge; `ConnectionStatus` trägt `stateReason` und `since` | `packages/transport/can/src/{bus,transport}.ts` |
| ELM327: `connecting → connected` nach der Init-Sequenz, **`error` statt „offen“ nach einem gescheiterten `open()`** (vorher blieb `opened = true` stehen), verweigerter Frame → `degraded`, nächste Antwort → `connected`, Stream-Tod → `error` mit Ursache, Zähler aus dem Tracker | `packages/adapters/elm327/src/adapter.ts` |
| CANable/slcan: gescheiterter Handshake → `error` mit Grund, BEL → `degraded`, Frame-Empfang heilt, Stream-Tod → `error` | `packages/adapters/canable/src/adapter.ts` |
| SocketCAN: Interface/Bitrate-Fehler → `error`, vom Kernel abgelehnter Send → `degraded` mit Grund, Frame heilt | `packages/adapters/socketcan/src/adapter.ts` |
| Passthroughs melden ehrlich: generic-can und Chaos-Proxy delegieren, Replay und virtuelle Leitung melden ihren Lebenszyklus | `packages/adapters/generic-can/src/index.ts`, `tools/simulators/src/{chaos-lab,virtual-can}.ts`, `packages/transport/can/src/{replay,time-travel}.ts` |
| Reconnect-Supervisor: `recovering` solange Budget, `error` wenn aufgebraucht, sonst Durchreichen des echten Adapterzustands | `packages/adapters/host/src/reconnect.ts` |
| Sichtbar im Arbeitsplatz: `AppState.connection`, Panel-Zeile „Link“ | `apps/web/src/{views,backend}.ts`, `apps/web/public/app.js` |

### 1.2 Priorität 2 — DoIP Ende-zu-Ende (ADR 0061)

| Änderung | Ort |
|---|---|
| Reale Socket-Bindings: TCP mit `onClose`/`onError`, begrenztem Connect-Timeout, `isSecure() = false` für Klartext; UDP für Discovery (Broadcast + Empfangsfenster) | `packages/adapters/host/src/doip-socket.ts` |
| Verbindungsverlust ist ein Zustand: `DoipSocket.onClose?/onError?`, `error` mit Grund, wartende `receive()` scheitern **mit der Ursache**, `send()`/`receive()` nennen sie; NACK bleibt Daten; `degraded` existiert auch hier | `packages/transport/doip/src/transport.ts` |
| `SupervisedDoipLink`: Lebenszyklus über `ConnectionTracker`, begrenzte Wiederbelebung pro Vorfall (Socket **und** Routing Activation), in-flight-Anfrage scheitert mit dem Grund, nächste findet den lebenden Link; `states()`/`summariseLinkStates` für die Sitzung | `packages/runtime/src/transport.ts` |
| Eine Regel, zwei Aufrufstellen: `ReconnectPolicy`, Grenzen und `reconnectPolicyOf` ziehen nach `@vdp/shared`; `@vdp/adapter-host` re-exportiert unverändert | `packages/shared/src/reconnect.ts` |
| `EcuLinkFactory.describe()` + `DiagnosticEngine.attach()` öffnet den Sitzungsdatensatz, wenn die Fabrik ihren Transport beschreiben kann (DoIP); sonst bleibt es beim alten Verhalten ohne erfundenen Datensatz | `packages/core/src/diagnostics/{ecu-links,engine}.ts` |
| Virtuelle DoIP-Entity auf echtem UDP/TCP mit gezielten Fehlern (Aktivierung verweigern/schweigen, Zieladresse nicht routen, NACK, verzögern, Verbindung killen) | `tools/simulators/src/doip-entity.ts` |
| Zwei begründete Architekturkanten: host → transport-doip, simulators → transport-doip (plus Node-Builtin-Ausnahme für den Netz-Simulator) | `architecture/architecture.yaml` |
| Dokumentation: ADR 0060 ([`docs/adr/0060-adapter-connection-state.md`](../adr/0060-adapter-connection-state.md)), ADR 0061 ([`docs/adr/0061-doip-end-to-end.md`](../adr/0061-doip-end-to-end.md)), CHANGELOG, Status-Snapshot, Code-Map, Backlog E35/E36/E37 | `docs/`, `CHANGELOG.md` |

### 1.3 Prioritäten 3–10 — bewusst nicht implementiert

Siehe Abschnitt 6 (NEXT 10). Jede dort genannte Aufgabe nennt den gemessenen
Ausgangspunkt, damit der nächste Lauf nicht neu suchen muss.

## 2. VERIFIED — was Tests beweisen

| Eigenschaft | Beweis |
|---|---|
| Alle sechs Verbindungszustände sind erreichbar; `degraded` ist nutzbar, `recovering`/`error` nicht; Fehler wird beim Verbinden gelöscht; Wiederholung ist kein Übergang; Listener-Fehler werden gezählt statt geschluckt; Historie begrenzt | `packages/transport/can/src/connection.spec.ts` (12 Tests) |
| Jedes `CanBus`-Subjekt (virtuell, Chaos-Proxy, generic, Replay, ELM327, slcan, SocketCAN) meldet frisch `disconnected`, offen `connected`, geschlossen `disconnected`, nie einen Wert außerhalb des Vokabulars, und `getStatus()` widerspricht `isOpen()` nicht | `tests/protocol/contracts/can-bus.contract.test.ts` |
| Verweigerter Frame → `degraded` → geheilt; unvollständige Frame-Zeile wird verworfen, der Zähler zählt Frames statt Zeilen | `packages/adapters/elm327/src/elm327.spec.ts` |
| `recovering` während der Wiederbelebung, `error` mit Grund nach aufgebrauchtem Budget | `packages/adapters/host/src/reconnect.spec.ts` |
| Auf echten PTYs (`socat`): stilles Gerät → `error` mit Ursache statt „offen“; slcan verweigert die Bitrate-Folge (BEL) → `error` mit Befehlsnamen; verlorene Leitung → `recovering` → `connected` → Budget aufgebraucht → `error` | `tests/integration/adapter-rehearsal.spec.ts` (9 Szenarien) |
| DoIP-Pipeline über echte Loopback-Sockets: Discovery → logische Adresse → Routing Activation → Diagnosemeldung → UDS → Engine → `sessionObservationOf` (IR) → `collectEvidence`; verweigerte Aktivierung (Antwortcode in der Meldung); schweigende Aktivierung (Timeout); nicht routbares Ziel (Negative Ack im `lastError`); getötete Verbindung → `error` **und** Wiederbelebung, danach dieselbe Link-Instanz wieder `connected` (mit erneuter Routing Activation); Budget 0 → `error` mit „no reconnect attempt left“; TLS-Pflicht gegen Klartext abgelehnt; toter Endpunkt nennt die Adresse | `tests/integration/doip-pipeline.test.ts` (9 Tests) |
| Ein DTC ohne dokumentierte Bedeutung erzeugt **keine** Behauptung: das Evidence-Item ist `unproven` mit Grund und zusätzlich ein `gap`-Item | ebd., Abschnitt „the whole pipeline“ |
| Der DoIP-Seam-Test mit Fake-Socket bleibt gültig (keine Netzabhängigkeit) | `tests/integration/doip-engine.test.ts` |
| Abhängigkeitsregel und Manifest-Gleichheit halten mit den neuen Kanten | `npm run check:deps` (29 Pakete, 94 Kanten, keine Verstöße), `npm run check:manifests` (29 Pakete, Importe = `package.json`) |
| Lint/Format und strikte Typen über alles | `npx biome check .` (549 Dateien), `npm run build`, `tsc --noEmit -p tsconfig{,.typecheck,.frontend}.json` |
| Keine Fixes am Testbestand, um grün zu werden: die einzigen Anpassungen an bestehenden Tests sind (a) `getStatus()` in Test-Doubles (neue Pflichtmethode des Ports), (b) die nachgemessene Zeilenzahl in der Größen-Ausnahme (`backend.ts` 1590 → 1591), (c) neue Assertions. Kein Test wurde entfernt, abgeschwächt oder übersprungen. | `git diff` über `tests/`, `packages/**/*.spec.ts` |

## 3. NOT VERIFIED — was nicht bewiesen ist

| Nicht bewiesen | Warum, und was es braucht |
|---|---|
| **Adapter-Verhalten am echten Fahrzeug** (ELM327 per Bluetooth/USB, slcan, SocketCAN am Auto) | Es gibt keine Hardware im Sprint. Die PTY-Rehearsals beweisen die Strecke, nicht das Gerät. Tag-X-Messung mit `docs/adapter-checkliste.md` und `npm run adapter:doctor`. |
| **DoIP an einem echten Gateway** | Die virtuelle Entity ist ein Modell; ein Gateways mit echten Zeiten, Mehrfachverbindungen und Alive-Check-Dauerlauf fehlt. |
| **DoIP über TLS (Port 3496)** | Es gibt keine `tls.connect`-Bindung; nur die Vorbedingung `requireTls` ist erzwungen (fail closed). |
| **WRITE-Pfad überhaupt** (Coding, Adaptation, Routinen, Security Access) | Lesen bleibt der sichere Default, und die Plattform hat bewusst nur `clear-dtc`/`write-did` über den Write-Port; jede Schreibfunktion gegen ein echtes Fahrzeug ist ein eigenes Vorhaben mit OEM-Sicherheitsmechanismen. |
| **OEM-Daten** | Keine echten OEM-Daten im Baum. `generic` ist Standard-/eigenes Wissen, `simulator` beschreibt das virtuelle Fahrzeug, `vag`/`mercedes` sind `example-placeholder` mit erfundenen Werten. Es gibt **keinen** Beleg, dass eine DID-, DTC- oder Routine-Beschreibung eines realen Herstellers stimmt. |
| **Fahrzeugbestimmung gegen ein reales Auto** | Der Resolver ist getestet, aber nie mit echten Identifikationswerten aus einem Fahrzeug konfrontiert worden. |
| **Golden Sessions gegen echte Aufzeichnungen** | Der Mechanismus (ADR 0036/0048/0057) ist getestet; es existiert keine einzige echte Fahrzeugaufzeichnung im Baum. |
| **Langzeit-/Dauerlauf, Speicherverhalten, Reconnect über Stunden** | Kein Messaufbau dafür; `dispose()`-Pfade sind getestet, ein Langlauf-Gate fehlt. |
| **Windows-Verhalten der seriellen Pfade** | Läuft auf Linux; die Windows-Zweige (COM-Ports, `net.Socket`-Pfad) sind ungetestet. |

## 4. REMAINING RISKS

| Risiko | Wirkung | Milderung heute |
|---|---|---|
| Ein Adapter, der `getStatus()` falsch implementiert (z. B. immer `connected`) | Die Sichtbarkeit wäre eine Lüge, nicht ein fehlender Wert | Vertrags-Suite prüft alle sieben Subjekte; neue Adapter fallen im Typecheck auf (Pflichtmethode) |
| `degraded` als Sammelzustand | Zwei verschiedene Ursachen können denselben Zustand tragen | `stateReason` nennt die Ursache immer; ein Test pinnt „degraded ist nutzbar“ |
| DoIP-Reconnect ohne Timeout-Semantik über der ECU | Eine ECU, die nur langsam antwortet, wird nicht wiederbelebt (richtig), aber auch nicht beschleunigt | bewusst: die Trennung Link-Tod vs. ECU-Stille ist der ADR-0061-Kern; eine zweite Retry-Ebene wäre ein verstecktes Retry |
| `EcuLinkFactory.describe()` optional | Ein neuer Nicht-CAN-Transport, der es nicht implementiert, erzeugt wieder Handles ohne Sitzung | Die Engine loggt diesen Fall benannt (`attach without a session record`) und die ADR nennt ihn; ein Gate dafür fehlt noch |
| Zwei Test-Läufe teilen sich Loopback-Ports | Portkollision bei paralleler Ausführung | Die Entity bindet Port 0 (OS wählt); Discovery nutzt `port: 0` |
| Coverage-Gates und neue Werkzeug-Dateien | Neue Simulator-/Host-Dateien können die Gates unter Druck setzen | Gates sind pro Pfad konfiguriert; `tools/simulators` ist ein Werkzeug, kein Layer — die Zahlen stehen im Scorecard |

## 5. ARCHITECTURE SCORECARD (objektiv, gemessen am 2026-09-24)

Keine Gesamtnote, nur Zahlen. Quelle jeweils in Klammern.

### Umfang

| Kennzahl | Wert | Quelle |
|---|---|---|
| Tests (grün / gesamt) | **2699 / 2707** (8 skipped, 0 failed) | `node scripts/test-runner.mjs` |
| Testdateien | **191** (189 passed, 2 skipped) | ebd. |
| TypeScript-Dateien (ohne `dist`) | **447** | `find packages tools apps tests -name '*.ts' \| grep -v dist` |
| Test-Ebenen | 6 Vitest-Projekte (unit, protocol, regression, replay, integration, architecture) + hardware + 19 ausführbare Doku-Beispiele | `vitest.config.ts`, `tests/examples/` |
| Neue Tests in diesem Sprint | +40 Tests gegenüber der Basis (2659 → **2699**): 12 Tracker-Zustandstests, 6 Host-DoIP-Socket-Tests, 2 ELM327-Zustandstests, 1 Supervisor-Zustandstest, 9 DoIP-Pipeline-Tests über echte Sockets, 1 Vertragstest auf 7 `CanBus`-Subjekten, 3 neue PTY-Rehearsal-Szenarien, plus Assertions in bestehenden Suiten | `git diff --stat`, `node scripts/test-runner.mjs` |
| Coverage (global, Statements/Branches/Functions/Lines) | **93,78 / 85,56 / 94,97 / 95,28** — alle Gates grün (global 90/80/90/90; je Pfad strenger, u. a. adapters 92/78, transport 88/72) | `npm run test:coverage`, `vitest.config.ts` |

### Architektur

| Kennzahl | Wert | Quelle |
|---|---|---|
| Architektur-Gates | 4 (Abhängigkeiten, Manifeste, Hygiene/Größe/Sleeps/leere Catches, Link-Check) + Vertrags-Suiten (CanBus, Byte-Stream, ISO-TP-Transport, UDS-Link) + Konformanz-Runner | `npm run ci`, `tests/architecture/`, `tests/protocol/contracts/` |
| Dependency-Verstöße | **0** (29 Pakete, 94 Kanten, 6 Regeln; 2 neue Kanten in diesem Sprint, beide begründet) | `npm run check:deps` |
| Layer-Verletzungen | **0** | ebd. |
| Port-Implementierungen, die ihre Pflichtmethode getestet liefern | 7 `CanBus`-Subjekte im Vertragstest; 5 `VehicleTransport`-Varianten (CAN/ISO-TP, DoIP zu, DoIP mit TLS-Vorbedingung, Replay, virtuelle Leitung) | `tests/protocol/contracts/`, `tests/integration/` |

### Hygiene

| Kennzahl | Wert | Quelle |
|---|---|---|
| `TODO`/`FIXME`/`HACK` im Produktionscode | **0** | `grep -rn "TODO\|FIXME\|HACK" packages tools apps --include=*.ts \| grep -v dist \| grep -v spec` |
| Dateien über dem 800-Zeilen-Budget | 2, beide mit gemessener Begründung (`apps/web/src/backend.ts` 1591, `packages/transport/iso-tp/src/connection.ts` 888) | `tests/architecture/hygiene.test.ts` |
| Bekannte Einschränkungen (in ADRs dokumentiert) | ADR 0060 §offen (4 Punkte), ADR 0061 §offen (5 Punkte), Status-Snapshot (DoIP-TLS, Workbench-DoIP) | `docs/adr/0060*`, `docs/adr/0061*` |

### Protokolle & Simulation

| Kennzahl | Wert |
|---|---|
| Protokoll-Implementierungen | **6**: CAN (ISO 11898-1), CAN-FD (inkl. DLC-Tabellen, `fd`/`brs` durch SocketCAN und can-utils), ISO-TP (ISO 15765-2, inkl. N_Bs/N_Cr, Block Size, Overflow-FC), UDS (ISO 14229-1) inkl. In-Prozess-Server, KWP2000 (ISO 14230) Basis-Client, DoIP (ISO 13400-2) inkl. Discovery und Routing Activation |
| Simulator-Szenarien | **7** Szenariodateien (`scenarios/*.json`, ADR 0048) + High-Fidelity-Verhaltensmodell + **virtuelle DoIP-Entity** mit 7 gezielten Fehlerstellschrauben |
| Golden Sessions | Mechanismus + Tools vorhanden (`tools/golden-sessions`, `npm run golden:record`), deterministische Rezepte getestet; **0** echte Fahrzeugaufzeichnungen |
| Reale Hardware-Validierungen | **0** Messungen an echter Hardware; 2 Hardware-Suiten (`tests/hardware/*`) existieren und skippen lokal mit Grund |
| OEM-Daten-Abdeckung | 1 Standard-/Eigenpaket (`generic` + `simulator`), 2 Platzhalterpakete (`vag`, `mercedes` — `example-placeholder`, erfundene Werte, im Validator als solche erzwungen); **0** lizenzierte OEM-Daten |

## 6. NEXT 10

Priorisiert nach Risiko × Nutzen. Jede Aufgabe nennt den gemessenen
Ausgangspunkt (was existiert) und den Beweis, der sie abschließen würde.

| # | Aufgabe (Priorität im Master-Prompt) | Ausgangspunkt (gemessen) | Fertig, wenn |
|---|---|---|---|
| 1 | **Fahrzeugbestimmung als Fakten mit Verifikationsstatus** (P3). Volle Kette VIN → Identität → Hersteller → Modell → Plattform → Modelljahr → Motor → Getriebe → ECU-Topologie → Variante; je Fakt `source`, `confidence`, `timestamp`, `provenance`, `verification` ∈ {`CONFIRMED`,`INFERRED`,`UNKNOWN`,`CONFLICTING`,`UNVERIFIED`} | `VehicleMatch`/`VehicleDetermination` tragen `evidence`/`conflicts`/`score`/`trust`; die Attributionsregel steht (ADR 0023), eine Widerspruchsregel für *zwei Quellen über denselben Fakt* fehlt; Konflikte werden heute im Score nicht überschrieben, aber ein Fakt-Modell mit Status gibt es nicht | Ein Test: zwei Quellen widersprechen sich → beide Fakten bleiben `CONFLICTING`, kein Automatik-Sieg; Report und Evidence zeigen dieselben Statuswörter |
| 2 | **DoIP im Arbeitsplatz + TLS** (P2-Rest, Backlog E36) | Link-Fabrik, Sitzung, Zustände und Pipeline existieren; die Workbench hat keinen Transport-Schalter für DoIP, TLS ist nur erzwungen (ADR 0061 §offen) | `tls.connect`-Bindung mit Test gegen einen TLS-Server-Double; Panel-Feld „Endpunkt/logische Adresse“, Session-Start über die Link-Fabrik; ein HTTP-Test, der eine DoIP-Sitzung startet |
| 3 | **Request-Journal der Runtime** (P6). Jeder Request mit `request`, `timestamp`, `transport`, `ECU`, `response`, `duration`, `result`, `error`, `retryCount` | `UdsClient` ist der Choke-Point (jeder Request läuft durch), ISO-TP zählt `stats.retries`, der Client wiederholt transiente NRCs einmal — aber nichts davon ist nach außen sichtbar; es gibt kein Journal | Ein Journal-Hook am Client, ein Runtime-Query mit Ringpuffer, Tests für „Retry ist sichtbar“ und „Timeout ≠ Fehler“; Bericht/IR zitieren die Zahlen |
| 4 | **Capability-Level und Operations-Katalog** (P4 + P10). `READ_ONLY`,`DIAGNOSTIC_SESSION`,`ACTUATION`,`CODING`,`ADAPTATION`,`SECURITY_REQUIRED`,`PROGRAMMING`; je Operation `requiredCapability`, `requiredSession`, `securityRequirement`, `vehicleScope`, `riskLevel`, `confirmationRequired` | `domain/risk.ts` kennt `WriteOperationKind` mit `risk`/`requiresConfirmation`/`requiresBackup`/`requiresVerification` — aber keine Capability-Stufen; `definitions/schema.ts` (v3) hat ECUs, Signale, Fahrzeuge, DTC-Wissen, jedoch keine Modelle für Service, Session, Routine, Coding-Parameter, Adaptation, Security- und Transport-Anforderung | Schema v4 mit Provenance je Datensatz und Validierungs-Gates (ADR 0025-Muster: `reverse-engineered`/`simulated` nie als OEM darstellbar); Domain-Stufen mit Test; Write-Port verlangt die Stufe und lehnt Unbekanntes ab |
| 5 | **Diagnostic-IR-Leak-Audit + neue Gates** (P5) | Architekturkanten sind geprüft (`check:deps`), die IR-Schicht ist sauber positioniert; ein *datei*-genauer Gate „UI/Feature importiert keine Transport-/Adapter-Symbole“ existiert nicht | Ein Gate-Scan über `apps/web` und Feature-Module mit Fixture-Negativfall; Findings behoben (oder begründet) |
| 6 | **Zustandsautomat der Diagnose-Sitzung** (P6). Start/Ende, Session-Wechsel, TesterPresent, Timeout, Negative Response, Retry, Transportfehler, ECU-Reset, Verbindungsverlust, Abbruch, gleichzeitige Anfragen | `EcuDiagnosticSession` deckt Session-Wechsel/TesterPresent/Timeout; Abbruch und Nebenläufigkeit sind nicht modelliert und nicht getestet | Ein expliziter Automat mit maschinenlesbaren Übergängen inkl. `cancelled`; Tests für Abbruch mitten in Multi-Frame und zwei gleichzeitige Anfragen |
| 7 | **Golden-Session-Szenarien erweitern** (P8) | 7 Szenariodateien; fehlen: falsche VIN, falsche DID-Antwort, negative UDS-Antwort, Timeout, ungültiges Frame, mehrere gleichzeitige DTCs | Neue Szenariodateien + deterministische Aufnahme (`npm run golden:record`) + Diff-Gate, das eine unbeabsichtigte Änderung fallen lässt |
| 8 | **Bericht professionalisieren** (P9) | Reports existieren (HTML/PDF, Sektion „Observations & gaps“, ADR 0037); es fehlen Timeline, ECU-Übersicht, Evidence-Summary, Mehrseiten-Tabellen, Header/Footer, Metadaten | Bericht mit Fahrzeug-/Diagnose-/Evidence-Teil und Charts; Test, dass keine Aussage ohne Beleg erscheint und Tabellen über Seitenumbrüche tragen |
| 9 | **Hardware- und Feldmessung** (Querschnitt) | 0 echte Messungen; Checkliste, Doctor, Rehearsals vorhanden | Ein protokollierter Tag X mit `docs/adapter-checkliste.md`: ELM327 (BT + USB), slcan, SocketCAN am Fahrzeug, DoIP-Gateway; Ergebnisse als „REAL HARDWARE VALIDATION“ mit Datum und Fahrzeug |
| 10 | **ODX/PDX-Import und Definition-Pflege** (Backlog #58, P4) | Der Schreiber existiert (`tools/harvest/src/odx/`), ein Leser nicht; Lizenz-/Provenance-Entscheidung offen | ODX-D-Parser mit Lizenzfeld, Import-Gates je Quellentyp, ein Paket aus dokumentierter Quelle statt Platzhalter |

Ergänzend aus dem lokalen Backlog, nicht in den Top-10, aber benannt:
Coverage-Gates nach der DoIP-Runde nachmessen, den Flaky-Reporter in der CI
aufrufen (E9), `npm audit` in die CI holen (E20).

## 7. Wie man das hier nachprüft

```bash
npm ci
npm run build
npm test                       # 6 Projekte, Architektur-Gates inklusive
npm run check:deps             # Architekturkanten (inkl. der zwei neuen)
npm run check:manifests        # Importe vs. package.json
npx biome check .              # Lint/Format
npm run test:integration -- tests/integration/doip-pipeline.test.ts
npm run test:integration -- tests/integration/adapter-rehearsal.spec.ts   # braucht socat
```

Was dieser Sprint **nicht** liefert, steht in Abschnitt 3 (NOT VERIFIED) und
Abschnitt 4 (REMAINING RISKS) — und beides ist der Ausgangspunkt für die
NEXT-10-Liste, nicht ihr Ersatz.
