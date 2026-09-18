# Glossar — ein Begriff = eine Bedeutung

Wenn dieselbe Sache an verschiedenen Stellen verschiedene Namen trägt
(`DiagnosticData` / `DiagnosticResult` / `Measurement` / `SignalValue` /
`Reading`), muss ein KI-Agent erst herausfinden, ob das sechs Dinge oder
Synonyme sind. Diese Datei ist die Antwort *vor* der Suche: die
verbindliche Vokabel des Repositories, verankert in den Typen, die sie
definieren. Neue Namen für bestehende Dinge sind ein Defekt; ein neues Ding
bekommt hier zuerst eine Zeile.

## Der diagnostische Pfad (von unten nach oben)

| Begriff | Bedeutung | Definiert in |
|---|---|---|
| **Frame** (`CanFrame`) | Ein CAN-Rahmen auf der Bus-Ebene: Id, Daten, DLC, Zeitstempel. Die kleinste Einheit, die ein Transport transportiert. | `packages/transport/can/src/frame.ts` |
| **Bus** (`CanBus`) | Der Bus-Vertrag: `open/close/send/subscribe`. Ein Adapter *ist* eine Bus-Implementierung; der Simulator liefert einen virtuellen. | `packages/transport/can/src/bus.ts` |
| **Adapter** | Konkrete Hardware-/Schnittstellen-Implementierung des Bus-Vertrags (ELM327, SocketCAN, …) plus Probing-Katalog. | `packages/adapters/*/` |
| **Link** (`UdsLink`) | Die Seam zwischen Protokoll und Transport: `send(payload) → response`. Ein Protokoll spricht *nur* durch Links, nie durch Busse (ADR 0031). | `packages/protocols/uds/src/link.ts` |
| **UDS-Message** | Protokoll-Payload (`0x22 <DID>` etc.) auf dem Link. Noch kein Wert, keine Dekodierung. | `packages/protocols/uds/src/services.ts` |
| **Raw** | Bytes *wie empfangen*, immer neben dem Dekodierten aufbewahrt (ADR 0004). `raw: Uint8Array` + `rawHex` in jedem Reading; `RawTraceEntry` im Trace. | `packages/core/src/session/types.ts` |
| **Decoded** | Das Ergebnis, ein `Raw` über die Definition gelesen: physikalischer Wert mit Einheit. | `packages/core/src/measurements/decoder.ts` |

## Diagnostic IR (die stabile Mitte, ADR 0034/0037)

| Begriff | Bedeutung | Definiert in |
|---|---|---|
| **Observation** | Eine *normalisierte* Beobachtung über das Fahrzeug in IR-Form — was das Fahrzeug gesagt hat, ohne dass jemand gedeutet hat. Varianten: `DtcObservation`, `SignalObservation`/`SignalReading`, `EcuObservation`, `SessionObservation`. Immer mit `evidence`. | `packages/diagnostic-ir/src/{dtc,signal,session}.ts` |
| **Provenance** | Wer, was, wann, womit: `origin` (z. B. `ecu-response`), `at`, `ecuId`, `serviceId`, `raw`, Definition-Version. | `packages/diagnostic-ir/src/provenance.ts` |
| **Evidence** | Der Beleg einer Beobachtung: `proven` (mit Provenance) oder `unproven` (mit Grund). **Fehlende Evidenz ist ein Fehlschlag, keine Warnung** (ADR 0033). | `packages/diagnostic-ir/src/provenance.ts` |
| **Enrichment** | Was *unser Wissen* über eine Beobachtung sagt (Beschreibung, Severity, zugehörige Signale) — mit eigener Evidence. Gekoppelt mit der Observation in `DtcState`. Nicht verwechseln mit Observation: ein Report muss „der ECU meldete P0420, unsere Basis kennt ihn nicht“ sagen können. | `packages/diagnostic-ir/src/dtc.ts` |
| **DtcState** | Observation + Enrichment + Historie (`firstSeen`/`lastSeen`). Was Reports und Views mit einem Code arbeiten. | `packages/diagnostic-ir/src/dtc.ts` |
| **SignalReading** | Eine Signalmessung in IR-Form: Raw + `rawValue` (vor Scale/Offset) + `value` (nach) + Einheit + Evidenz. **Das** ist ein „Reading“; `MeasurementReading` (domain) ist die *Projektion* davon für die Domain-Views. | `packages/diagnostic-ir/src/signal.ts`, `packages/domain/src/model.ts` |
| **MeasurementWindow** | Ein Zeitfenster gemessener Punkte (`WindowPoint[]`), auf dem Hypothesen-Checks urteilen. | `packages/diagnostic-ir/src/window.ts` |
| **Session** (Fahrzeug-Session) | Der komplette diagnostische Interaktions-Kontext: `VehicleSessionData` (Id, ECUs, Scans, Messungen, Marker, Roh-Trace). **Achtung:** nicht verwechseln mit der *UDS-Diagnosesession* (default/programming/extended, 0x10-Service) — die heißt hier „Diagnostic Session“ und ist ein Protokollzustand. | `packages/core/src/session/session.ts` |
| **Marker** | Ein Zeitstempel mit Label, den ein Mensch in der Sitzung setzt (z. B. „Batterie abgeklemmt“). Sitzungsdaten, kein Messwert. | `packages/core/src/session/session.ts` |

## Evidence & Hypothesen (der analytische Teil, ADR 0038)

| Begriff | Bedeutung | Definiert in |
|---|---|---|
| **EvidenceItem** | Eine Aussage mit eigener Evidence, adressierbar durch stabile Id (`dtc:P0420@engine`). Die *Zitierform*: Befunde zitieren Item-Ids, keine Sätze. | `packages/diagnostic-ir/src/evidence.ts` |
| **EvidenceSet** | Alles, was eine Session zu einem Moment sagen kann (`collectedAt`), inkl. **Conflicts** (zwei Items, ein Gegenstand, keine Einigung). Read-only by construction. | `packages/diagnostic-ir/src/evidence.ts` |
| **EvidenceConflict** | Zwei Items über einen Gegenstand, die nicht zusammenpassen. Nennen statt Gewinner-Picken. | `packages/diagnostic-ir/src/evidence.ts` |
| **Hypothesis** | Ein dokumentiertes Fehlermuster, *geurteilt* gegen die Messungen: `outcome` (`confirmed`/`refuted`/`untested`), `checks[]` (jeder Check mit eigenem Urteil), `evidence[]` (Item-Ids), `reason`, `nextTest`. Keine Modell-Konfidenz — `confidence` ist die veröffentlichte Heuristik aus `@vdp/core`. | `packages/diagnostic-ir/src/evidence.ts`, `packages/core/src/evidence/hypotheses.ts` |
| **HypothesisTest** | Ein dokumentierter Check in der Form, die das Definition-Paket schrieb (`signal`, `expect`, `min/max`, `windowMs`) — `measurable: false`, wenn nur Prosa. | `packages/diagnostic-ir/src/evidence.ts` |
| **DiscriminatingTest** | Ein vorgeschlagener Test, der zwischen konkurrierenden Hypothesen entscheidet (`discriminatesAgainst`). | `packages/diagnostic-ir/src/evidence.ts` |
| **GuidedDiagnosisState** | Zustand einer geführten Diagnose: führende Hypothese, nächster Test, Status. | `packages/diagnostic-ir/src/evidence.ts` |
| **AnalysisInput / AnalysisResult** | Der komplette faktische Input für einen Analyse-Provider (Evidenzmenge, Hypothesen, Versionen) und dessen Antwort (Befunde mit `basedOn`-Zitaten, `provenance`). | `packages/ai/src/types.ts` |

## Schreiben (getrenntes Universum, ADR 0018/0032)

| Begriff | Bedeutung | Definiert in |
|---|---|---|
| **WriteOperation** | Eine beschriebene Schreibart: `kind`, Preconditionen, `prepare` (nur lesendes Backup), `execute`, `describe`. Existiert nur hinter dem Port. | `packages/core/src/writes/port.ts` |
| **WritePort** | Die einzige Tür zu Schreiboperationen: `precheck` (nichts schreiben), `run` (gestuft: prepare → permit → execute → audit). | `packages/core/src/writes/port.ts` |
| **WriteBinding** | Wo ein Write läuft: ECU, Session, Definition-Version, Vehicle-State. | `packages/core/src/writes/port.ts` |
| **SafetyManager** | Bewertet Write-Kontexte gegen die Risk-Policy (AGENTS 26); erteilt Permits. Ein abgelehnter Write ist eine **Antwort mit Gründen** (`WriteOperationResult`), kein Fehler. | `packages/core/src/safety/safety-manager.ts`, `packages/domain/src/risk.ts` |
| **NRC** | Negative Response Code (ISO 14229): Protokoll-Absage mit Grund. Daten, nicht Exception. | `packages/protocols/uds/src/nrc.ts` |

## Wissen & Tools

| Begriff | Bedeutung | Definiert in |
|---|---|---|
| **Definition Package** | OEM-Wissen als validierte Daten: ECUs, DIDs, Signale, DTC-Wissen pro Variante (Schema v3) mit Pflicht-Provenance. Daten, keine Logik. | `packages/definitions/` (ADR 0003/0023/0024) |
| **Capability** | Was eine ECU anbieten kann (`read-dtc`, `read-did`, …) — getrieben die Actions der UI. | `packages/domain/src/capabilities.ts` |
| **Golden Session** | Aufzeichnung + Erwartung + Lauf: gegen den Simulator aufgenommen, über den echten Core replayed, im IR-Vokabular verglichen (ADR 0036). | `tools/golden-sessions/` |
| **Scenario** (`VehicleScenario`) | Eine Zeitlinie von Ursachen (`steps`) und Erwartungen (`expectations`) für die Simulator-Modellzeit; `runScenario` liefert `ScenarioRun` und *assertet nie*. | `tools/simulators/src/scenarios.ts` |
| **Fault Injection** | Beschädigung/Abschneiden von Antworten *an der Link-Seam* — die Plattform muss den Schaden sehen wie an einem echten Bus (ADR 0039). | `tools/simulators/src/faulty-link.ts` |
| **Trace** | Der Roh-CAN-Trace einer Session (NDJSON), Replay-fähig. | `packages/core/src/session/types.ts` |

## Formale Referenz und Konformanz (ADR 0045/0046)

| Begriff | Bedeutung | Definiert in |
|---|---|---|
| **Konformanz-Vektor** (test vector) | Ein vollständiger Fall in `tools/formal-conformance/vectors/*.json`: Eingangstranskript, Zeit, erwartetes Ausgangstranskript und Zustandsübergänge. TypeScript **und** Haskell werden gegen dieselbe Datei grading — die Datei ist der Vertrag, nicht der Test. | `tools/formal-conformance/src/vectors.ts` |
| **Differentialtest** | Dasselbe Vektor-Set über beide Implementierungen (TypeScript-Läufer ⇔ Haskell-Referenz) und ein strukturierter Diff (`diffPaths`), kein Seitentest mit eigener Erwartungsprosa. Findet der Läufer keine Haskell-Toolchain, meldet der Bericht `haskell NOT RUN` — ehrlich, statt still grün. | `tools/formal-conformance/src/{isotp,safety}-runner.ts`, `formal/ConformanceDriver.hs` |
| **Formale Referenz** | Die Haskell-Modelle in `formal/` — ausführbare Spezifikation des Produktionsvertrags (ISO-TP-Zustandsmaschine, Safety-Kette). **Nie** eine Laufzeitabhängigkeit; der Vergleich ist Werkzeug, kein Build-Tor. | `formal/README.md` |
| **Szenariodatei** | Deklaratives JSON unter `scenarios/` mit Pflicht-Determinismus, das `parseScenarioFile` (strenge Grammatik, kein Raten) in `VehicleScenario` + kausale Schritte übersetzt. Kein Engine-Setter, weil das Modell keinen hat. | `tools/simulators/src/scenario-file.ts` |
| **Next Test** (`AnalysisResult.nextTest`) | Der von der Analyse empfohlene entscheidende Test: **nur** ein `DiscriminatingTest` aus den Hypothesen (erster nicht-widerlegter Vorschlag), HTTP-seitig citation-validiert — nichts Erfundenes. | `packages/ai/src/{types,heuristic,http}.ts` |

## Verbotene Doppelnamen (bekannte Fallstricke)

| Verwende | Nicht | Warum |
|---|---|---|
| `DtcObservation` / `DtcState` | „DtcResult“, „DtcData“ | Zwei Formen (Beobachtung vs. +Wissen), keine drei. |
| `SignalReading` (IR) vs. `MeasurementReading` (domain) | „SignalValue“, „Measurement“ für beide | IR-Form vs. Domain-Projektion — je eine, mit Präfix zu unterscheiden. |
| `Session` (Fahrzeug-Session) vs. „Diagnostic Session“ (UDS 0x10) | „Session“ für beide | Unterschiedlicher Kontext: Interaktion vs. Protokollzustand. Im UDS-Kontext immer „Diagnostic Session“. |
| `collectEvidence` / `EvidenceService` | eigener Evidenz-Bau in UI/Reports/AI | Evidenz wird an *einer* Stelle gesammelt (ADR 0038). |
| `evidence` (IR-Field) vs. „Evidenz“ (Umgespräch) | `provenance` als Synonym | Provenance = wer/was/wann; Evidence = proven *oder* unproven. |
| `raw` / `decoded` | „value“ für die Rohebene | `value` ist immer der physikalische Wert; Rohebene heißt `raw` (ADR 0004). |

**Regel:** Ein neuer Typname, der auf ein Ding dieses Glossars zeigt, wird
nicht eingeführt. Ein neues Ding, das hier fehlt, wird im selben PR ergänzt,
der es einführt (Regel 34.24: Doku-Stand = Code-Stand).
