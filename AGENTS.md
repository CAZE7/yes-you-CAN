# AGENTS.md — Vehicle Diagnostics Platform

> **Version:** 1.43 · **Letzte Änderung:** 2026-09-20
> **Changelog:** vollständige Historie in [`CHANGELOG.md`](CHANGELOG.md).
> - 1.43: **Zehn Verbesserungen ohne erfundenes OEM-Wissen.** Extra-Definitionen als Dateien (`data/definitions/*.json`), Hardware-/DoIP-TLS-Ehrlichkeit, Changelog ausgelagert, `npm run audit` in `npm run ci`, Backend-/Frontend-Split (`chaos-session.ts`/`write-ops.ts`, `chaos.js`/`writes.js`), Write-Token (`VDP_WRITE_TOKEN` / `X-VDP-Write-Token`, Loopback tokenlos bis gesetzt), Formal-Honesty-Test (`haskell NOT RUN`), Coverage-Boden 76/72 eingefroren. Crate `safety.rs::execute` unangetastet (kein cargo). Kein lizenziertes OEM-JSON erfunden.
> - 1.42: **Doku-Ehrlichkeit, kein Produktionscode.** Changelog-Duplikate entfernt; Rust-Crate-Köpfe nennen Classic-CAN / not in CI. `safety.rs::execute` unverändert.
>
> **Geltungsordnung:** Diese Datei ist normativ für das *Produkt*. ADRs in `docs/adr/` sind normativ für *Architektur- und Toolchain-Entscheidungen*. Bei Widerspruch zwischen Dokumentation und Repository gilt das Repository — und die Differenz wird im selben PR dokumentiert (Regel 34.24).

---

# Teil 0 — Für Coding Agents: zuerst lesen

Dieser Teil steht bewusst vor der Spezifikation. Er sagt dir, *was schon existiert*, *wie du arbeitest* und *wo die harten Grenzen sind*. Die Abschnitte 0–36 dahinter bleiben die normative Produktspezifikation.

## 0.0 AI Engineering Contract (verbindlich, ADR 0043)

Dieses Repository ist ein **AI-natives Repository** gebaut: die Architektur
steht einmal, maschinenlesbar, in [`architecture/architecture.yaml`](architecture/architecture.yaml)
(Layer, `mayImport`-Kanten, AI-Context-Topics), und die Doku-Ebene
([`ARCHITECTURE.md`](ARCHITECTURE.md), Package-READMEs, `docs/code-map.md`,
`docs/glossary.md`, `docs/api/*`, `docs/flows/*`, [`.ai/`](.ai/README.md))
verweist darauf — keine zweite Regel-Kopie existiert, eine zweite Kopie ist
ein Defekt (ADR 0031/0042/0043).

**Vor jeder Codeänderung — in dieser Reihenfolge:**

1. Lies `architecture/architecture.yaml` → Layer + `mayImport` deines Pakets.
2. Lies die Package-`README.md` des Ziel-Pakets (v. a. „Does NOT do“).
3. Identifiziere die architektonische Grenze, die du berührst (siehe
   [`ARCHITECTURE.md` → „Die harten Verträge“](ARCHITECTURE.md)).
4. Finde die **bestehende** Abstraktion (Code-Map-Zeile, dann `docs/api/*`).
5. Erstelle **keine** doppelte Abstraktion — eine zweite Kopie einer
   Vokabel/Regel/Logik ist ein Review-Defekt.
6. Führe die relevanten Tests aus (`npm run test:unit` als Mindestschleife,
   dazu die Projekt-Suite der betroffenen Ebene).
7. Führe `npm run check:deps` **und** `npm run check:manifests` aus — beides
   ist Teil von `npm run ci` und fällt bei einer Regelverletzung.
8. Bei Architektur-/Toolchain-Änderung: ADR im neuen Template (ADR 0043,
   inkl. *Affected packages* / *Forbidden implementations* / *AI
   implementation notes*) — und im selben PR: YAML + ARCHITECTURE.md +
   betroffene READMEs (Regel 34.24).

**Verboten (jeder Punkt bricht ein Review):**

- WritePort umgehen: ein Write nur als `WriteOperation` hinter
  `WritePort`/`SafetyManager` (ADR 0032, AGENTS 26).
- Direkter Transport-/Bus-Zugriff aus der UI (Regel 34.4) — die UI spricht
  über Runtime + Command Bus.
- Private Implementation-Casts: z. B. in interne `UdsServer`-Maps
  (ADR 0041), in `DiagnosticEngine`-Innereien aus dem Runtime heraus
  (ADR 0014), in Simulator-Felder aus Tests (ADR 0040).
- Neue Dependency ohne Begründung und ADR-Notiz (ADR 0002/0010, Regel
  34.20) — gilt auch für Dev-Dependencies und Parser-Bibliotheken.
- Duplicierte Protokoll-Logik: eine UDS-/DTC-Status-/Dekodierungs-Stelle
  (Glossar „Verbotene Doppelnamen“; `decodeDtcStatus` ist *die* Stelle).
- Evidenz neu bauen außerhalb `collectEvidence`/`EvidenceService`
  (ADR 0038) — UI/Report/AI *zitieren* Item-Ids, sie sammeln nicht.
- `mayImport` erweitern, um „eine kleine Abhängigkeit“ zu erlauben: das ist
  eine Architekturentscheidung — ADR + YAML, nicht nur YAML (Regel 34.15).

**Für Themen statt Baumsuchen:** `npm run ai:context uds|transport|
diagnostic-ir|dtc|simulator|ai` erzeugt das passende Kontext-Bundle
(Architektur-Regeln, Pakete, Public APIs, ADRs, Flows, Beispiele) — oder
lies das kuratierte Paket unter [`.ai/`](.ai/README.md).

## 0.A Umsetzungsstand (verifiziert gegen `arena/01a09708` 2026-09-12, Basis `9f0e70a`)

| Bereich | Stand | Bemerkung |
|---|---|---|
| Schichtenarchitektur | ✅ umgesetzt | ADR 0001; `tsc -b` erzwingt die Abhängigkeitsrichtung |
| CAN-Layer + Adapter (ELM327, CANable/slcan, SocketCAN, generisch) | ✅ inkl. Node-Host-Bindings | Serial-Byte-Stream über tty (`stty`), SocketCAN-Bindings-Loader und side-effect-freier Probe-Katalog in `@vdp/adapters/host`; etablierte serialport-Library / Web Serial API (ADR 0010, Schritt 7) folgen |
| ISO-TP (ISO 15765-2) | ✅ inkl. Block-Size-Enforcement, Escape-Sequenz > 4095, N_Bs/N_Cr | Regressionskatalog belegt gefundene Fehler und Fixes |
| UDS (ISO 14229-1) Client + In-Prozess-Server | ✅ | inkl. NRC-0x78-Pending-Loop, Session-Timing, DTC-Codec |
| KWP2000 (ISO 14230) | ✅ Basis-Client | für Alt-ECUs |
| DoIP (ISO 13400) | 🚧 Codecs, Routing activation, UDP-Discovery; TLS-Port 3496 announced-not-implemented; Transport-Seam in der Engine (Roadmap 8a) | noch nicht in der Workbench verdrahtet; der MVP braucht es nicht (Abschnitt 29). Nachgetestet 2026-09-12 (ADR 0020): `transport.ts` 98,5/88,7, `discovery.ts` 100/78,9; ein fehlgeschlagener Routing-Aktivierung gibt den Socket jetzt frei, statt `connecting` zu bleiben |
| OEM-Hooks + Registry | ✅ | füllen nur Lücken — dokumentierte Daten gewinnen immer (ADR 0003) |
| Definition Packages | ✅ Schema v3 mit Fahrzeugen (Plattform, Motor, Getriebe, VIN-Matching) **und DTC-Wissen pro Variante** (`dtcKnowledge[]` mit Ausfallmustern, Messfenstern, Reparaturhinweisen), Validator, Pflicht-Provenance je Quelle mit Gates nach Quellentyp (ADR 0025), Migration v1→v2→v3, WMI-Referenz nach ISO 3780 | VAG-/Mercedes-Pakete sind `example-placeholder` mit erfundenen Werten, keine Fahrzeugwahrheit; `simulatorPackage` beschreibt das virtuelle Fahrzeug und ersetzt `genericPackage` nur in Simulator-/Replay-Betrieb (ADR 0023); sein Variantenwissen ist `own` und aus öffentlichen SAE-J1979-Semantiken begründet; ECU- und Signal-Satz sind die von `genericPackage`, also referenziert es nur deklarierte Messpunkte und erfindet keine Lambda-Sonden (ADR 0024) |
| Fahrzeugauflösung (AGENTS 11) | ✅ Resolver mit Belegen: Query `vehicle.resolve` → `DefinitionProvider.resolveVehicle` → Kandidaten mit `evidence`/`conflicts`, Score = Anteil bestätigter Gewichte | Attributionsregel: widersprechen kann nur ein Wert, dessen DID als Teilenummer/Software-/Hardwarestand dokumentiert ist (ADR 0023); durchgehend read-only, `unresolved` kommt immer mit Grund; Panel „Fahrzeugbestimmung" in der Workbench |
| Core (VIN, ECU-Discovery, DTC, Live-Engine, Recorder, Safety) | ✅ | DTC-System komplett: Freeze Frames, First/Last-Seen, Safety-gated Clear über den Write-Port (AGENTS 20/25/26, ADR 0032), Beobachtungen mit Beleg und **eine** Identitätsregel `dtcKey` (ADR 0037); Discovery ignoriert eigene tx-Echos (Regressionskatalog); Identifikationswerte tragen die DID, aus der sie gelesen wurden (§11/§12) |
| Evidence Engine (Belege, Hypothesen, nächste Messschritte) | ✅ | `@vdp/diagnostic-ir/src/evidence.ts` + `packages/core/src/evidence/` (ADR 0038): jedes Item ist eine Aussage der Sitzung mit eigenem Beleg und stabilem Schlüssel, Widersprüche bleiben stehen, `checks[]` werden gegen das dokumentierte Fenster bewertet (`summariseWindow`), `confidenceOf` ist eine offene Regel mit Deckel; geliefert über `runtime.evidence.snapshot()` |
| Graphen (AGENTS 16) | ✅ | DOM-freier Chart-Kern `@vdp/charts` (Viewport, Cursor, Decimierung, Statistik; 41 Unit-Tests, ADR 0011) + synchronisierte Zeitachsen in der Workbench; Rendering in `public/*.js` (s. Web-Workbench) |
| Storage (JSON + NDJSON, Migrationen, ZIP-Export) | ✅ | ADR 0007; Session-IDs werden vor Dateizugriff validiert |
| Reports (HTML/PDF) | ✅ | eigener PDF-Writer (ADR 0002); Ersatz durch pdf-lib in ADR 0010 vorgesehen; Sektion „Observations & gaps“ zeigt, was die Sitzung nicht belegen kann (ADR 0037) |
| KI-Schicht | ✅ Provider-Abstraktion, lokaler Heuristik-Provider, HTTP-Gateway mit VIN-Redaktion; **Input ist die Diagnostic IR** (Evidenzmenge + Hypothesen), jede Antwort nennt Versionen und zitiert Beleg-Ids (ADR 0038) | bewusst keine „große KI“ im MVP (Abschnitt 29) |
| Web-Workbench (`apps/web`) | ✅ Node HTTP + SSE, Vanilla ESM, 13 Views + Panels „Fahrzeugbestimmung“, „Vehicle model“, „Scenario runner“ (gezählt 2026-09-16: `grep -c 'data-view=' apps/web/public/index.html` = 13; die Zeile war seit zwei Reitern nicht nachgezogen — sie sagt jetzt, wie sie gemessen ist) | `public/*.js` via Biome formatiert, jede Abfrage über `api.js` gegen `views.js` typgeprüft (ADR 0030); die Projektion der Szenarioläufe steht auf der Server-Seite der Grenze (`scenario-view.ts`), das Markup rendert nur noch `row.cells`/`entry.label`; `apps/web/test/markup.spec.ts` hält die 94 strengen Selektoren gegen die 140 IDs in `index.html` — die erste Frontend-Kopplung, die keine Coverage-Zahl je gezeigt hätte; `/lib` liefert `@vdp/charts`; Security-Header + Body-Limit (ADR 0009) |
| Simulator + Replay | ✅ | VirtualVehicle, VirtualCanNetwork (mit `impair()`-Störungen auf dem Draht; `CanChaosBus` ist seit 2026-09-16 siebtes Subjekt des `CanBus`-Vertrags in `tests/protocol/contracts/`, und seit 1.38 sitzt es **im** Pfad der Workbench-Sitzung — in `start()` um den Bus der Runtime gewickelt, nicht daneben: ein Schalter, der nichts erreicht, ist ein Widget (0.E E24, gemessen daran, dass `dropRate: 1` die Probensammlung einfriert); die Blende liest Ziel und Reichweite des Bursts aus `chaosStatus()`), ReplayTransport mit strikter Abweichungsmeldung; **`FaultyLink`** injiziert Fehlerklassen auf dem Draht zwischen `UdsClient` und echtem `UdsServer` (ADR 0039). **Seit 2026-09-15 fährt das High-Fidelity-Fahrzeug ein Verhaltensmodell**: `VehicleBehaviourModel` (Versorgung, Motor, Räder, Verdrahtung) mit Monitorregeln statt Statussetzern, `ModuleWiring` für Power/Bus, `SCENARIO_CATALOG` (6 Szenarien) als Daten — seit 1.41 (ADR 0048) sind die **Dateien unter `scenarios/`** der Katalog (7 Szenarien inkl. `alternator_failure`), geladen über `loadScenarioLibrary`, Seed inklusive — Fehler entstehen aus Ursachen, und `VehicleScenario`-Erwartungen werden über UDS nachgeprüft (ADR 0040). Die DIDs dafür laufen über die offizielle Server-API `registerDid()`/`registerWritableDid()`/`setDtc()` statt durch Casts in interne Maps (ADR 0041). Die Signal-Tabelle des Modells und die deklarierten Signale des Fahrzeugs sind in beide Richtungen geprüft (`vehicle-definition.spec.ts`), und der ABS-Modul meldet alle vier Räder auf `0xF40D` — eine Ursache, die niemand ablesen kann, ist kein Simulationsfund (ADR 0040 §9) |
| Tests | ✅ 2037 Tests auf 6 Ebenen (unit / protocol / regression / replay / integration / architecture), dazu 17 ausführbare Doku-Beispiele in `tests/examples/*.example.ts` (Projekt `integration`, ADR 0043) + 1 hardware smoke + 1 CI-only Träger für die Coverage-Gates (lokal skipped, ADR 0029 §6) | Vitest 5 mit Projektkonfiguration (ADR 0010, Schritt 1); Unit-Specs co-lokatiert (`src/*.spec.ts`), Property-Tests (fast-check), Coverage-Gates global 90/80/90/90 als Durchschnitt (Ist 95,16 Statements / 87,27 Zweige / 96,55 Funktionen / 96,44 Zeilen, gemessen 2026-09-16 am Stand dieses Commits (`npm run test:coverage`, 67 s); die Beine meldeten am Kopf 391f04f 94,77 / 86,71 / 96,05 (Node 22, Träger 28,7 s) und 94,71 / 86,63 / 96,03 (Node 24, 28,2 s); die letzten Stellen sind keine Konstanten: 86,66 im ruhigen Lokal-Lauf, 86,67 unter Last (ein einzelner `chaos-lab.ts`-Zweig), und Node 22 meldet in allen vier CI-Läufen 86,59/86,60 bei 94,68 Statements gegen 94,74 auf Node 24 — zwei Effekte, ADR 0029 §6), per-file laut `vitest.config.ts` für shared/core (88/80)/protocols/adapters (92/78)/transport (88/72)/storage/charts/reports (95/80)/ai (95/85)/diagnostic-ir (95/85)/definitions **und apps/web** (ADR 0017, angehoben durch ADR 0020, 0022, 0025, 0028 und `ai` 95/85 durch ADR 0027; `definitions` 85/80 seit ADR 0023; `apps/web/src` **76/72** als Bodenschwelle (2026-09-16 von 69/54 auf 75/66 und am selben Tag auf 76/72 gehoben, nachdem `server-paths.spec.ts`, die Adapter-Pins und `backend-paths.spec.ts` die dünnsten Dateien gehoben haben — ADR 0017: erst Tests, dann Gate; schwächste Werte gemessen: `server.ts` 79,67 Zeilen, `backend.ts` 73,89 Zweige von 249, ein Zweig sind 0,4 Punkte, deshalb 3,67 bzw. 1,89 Punkte Puffer; Biss gemessen zweimal: `branches: 78` benennt `backend.ts`/`server.ts`, `branches: 74` benennt `backend.ts` mit 73,89), der Puffer steht in Einheiten dessen, was sich ändern müsste. **Später am selben Tag nicht weiter gehoben, obwohl `backend.ts` auf 74,50 Zweige stieg:** derselbe Schnitt ließ `server.ts` auf 78,92 Zeilen fallen, und eine Hebung auf 78/74 hätte etwas über einen Zweig Puffer gelassen — eine Zahl, kein Spielraum (ADR 0017: Boden, kein Ziel) `diagnostic-ir` 95/85 seit ADR 0034). **Messbereich seit ADR 0027 die ganze Fläche:** `packages/**/src`, `apps/web/src/**`, `tools/**`. Struktur ist mitgetestet — Abhängigkeitsgraph, Hygiene-Regeln, die Manifest-Metadaten aller 27 Pakete (license/engines/repository.directory) **und dass jedes Manifest zu den tatsächlichen Importen passt** (`tests/architecture/manifests.test.ts`, ADR 0042) — grün; dazu die End-to-End-Kette der Szenarien (Ursache → Modell → `0x19`-Lesung → IR → Evidence, `tests/integration/scenario-chain.test.ts`); `npm test` 67 s, `npm run test:coverage` 73 s (gemessen 2026-09-16, Stand dieser Runde; 141 geprüfte Dateien + 1 übersprungener CI-Träger) — die Discovery fährt in Tests ein explizites Zeitbudget und es wird auf Bedingungen statt auf feste Sleeps gewartet (ADR 0019); `hardware` (`tests/hardware/vcan.test.ts`) läuft manual (`npm run test:hardware`), der nächtliche Job ist Teil von E10. Zähl-Falle beim Vergleichen von Zahlen: ein bloßes `npx vitest run` ohne `--project` nimmt `hardware` mit und meldet 143 / 2039 statt 142 / 2038 (nachgemessen am Stand dieser Runde: `npx vitest run` 142 passed | 1 skipped (143) bei 2038 passed | 1 skipped (2039), `npm test` 141 | 1 (142) bei 2037 | 1 (2038) — ohne `vcan0`). Seit 2026-09-16 zählt **auch `npm test` schon einen Skip mehr**, weil der Coverage-Träger (Ci/CD-Zeile, ADR 0029 §6) lokal als *skipped* mitläuft — verglichen wird deshalb gegen `passed`/`skipped`, nicht gegen die Klammerzahl. |
| CI/CD | 🚧 GitHub Actions: `ci.yml` mit `npm ci` → `build` → `npm test` auf Node 22 + 24 (`checkout@v4`/`setup-node@v4`, Concurrency, `contents: read`) + Dependabot (gruppiert) | **Ist-Zustand nach Regel 34.24:** Quality-Job (`biome check`·`typecheck`·`npm audit`), Coverage-Upload, `codeql.yml`, `dependency-review.yml` und `hardware.yml` sind nach ADR 0016 §3 fertig entwickelt, liegen aber nur in der Arbeitskopie — GitHub lehnt den Push von Workflow-Dateien ohne `workflows`-Berechtigung der App ab (gemessen 2026-09-12). Verbindliches Tor ist deshalb `npm run ci` (seit 2026-09-14 inklusive `npm run check:deps`, ADR 0031; seit 2026-09-15 inklusive `npm run check:manifests`, ADR 0042); Freischaltung und Folge-PR siehe 0.E E10. **Seit 2026-09-14 (ADR 0029) führt der `architecture`-Projektlauf `biome check .` und beide `--noEmit`-Pässe selbst aus** — die CI erzwingt die Quality-Gates damit ohne Workflow-Recht; die Gleichwertigkeit hängt an `tests/architecture/guardrails.test.ts` (0.E E20). **Seit 2026-09-16 trägt derselbe Mechanismus auch die Coverage-Gates**: `tests/architecture/coverage-gate.test.ts` läuft *nur unter `CI`*, ruft wörtlich `npm run test:coverage` und schlägt mit dessen Threshold-Meldung fehl (gemessen: lokal 5,5 s mit skippedem Test, in der CI 28–38 s pro Bein (vierzehn Messungen über sechs Köpfe, Rohwerte in ADR 0029 §6); Biss: `lines` auf 99 gehoben → dieser Test fällt als einziger). Der Träger meldet seinen Zweig als `::notice`, weil die Job-Logs von hier aus nicht lesbar sind — und hat damit schon einmal eine Vermutung widerlegt: 40 s pro Bein klangen nach „Kind nie gestartet", die Annotation zeigte „measured 27,6 s" (ADR 0029 §6). Am Kopf `c419100` (1.37) war dieser Kanal selbst nicht erreichbar — Logabruf abgelehnt (`failed to get run log`), Annotationen leer —, gemessen sind dort nur die Step-Zeiten des Test-Schritts: 41 s auf beiden Beinen (Job 57 s bzw. 56 s), und sie stehen in ADR 0029 §6 ausdrücklich *nicht* in der 14er-Liste, weil Schritt und Selbstbericht zwei Größen sind. `ci.yml` bleibt unverändert, weil die App Workflow-Dateien nicht schreiben darf — Push erneut abgelehnt, gemessen 2026-09-16 |

| HTTP-Security-Baseline | ✅ | localhost-Default, Security-Header, Body-Limit (ADR 0009) |
| Coding Framework (Abschnitt 25) | ❌ bewusst nicht begonnen | erst nach stabilem Read-only-System |
| DoIP-Engine-Integration, weitere Hersteller, Mobile/Desktop | ❌ | Phase 3+ |

Diese Tabelle ist ein *Stand*, keine Wahrheit auf ewig: Verifiziere sie bei jeder größeren Aufgabe gegen `git log` und die Paketliste (Regel 34.1) und pflege sie im selben PR nach, der den Stand ändert.

## 0.B Betrieb — Befehle, die funktionieren

Voraussetzung: Node.js ≥ 22 (siehe `engines` im Root-`package.json`, `.nvmrc`).

```bash
npm ci                # installiert exakt das Lockfile — kein npm install im CI-Kontext
npm run build         # tsc -b über alle Projekt-Referenzen (TypeScript 7 / tsgo)
npm run typecheck     # Build + strikter noEmit-Pass über Tests, Konfiguration, Specs und Frontend-JS
npx biome check .     # Lint + Format (Biome 1.9)
npm run check:deps   # Architektur-/Layer-Regel (tools/architecture/check-dependencies.mjs)
npm run check:manifests # `package.json` ⇔ tatsächliche Imports (ADR 0042)
npm run audit         # Lockfile-Gate (`--audit-level=moderate`); Teil von `npm run ci`
npm test              # komplette Suite auf 6 Ebenen (unit / protocol / regression / replay / integration / architecture)
                      # das Projekt `architecture` führt dabei biome check + beide --noEmit-Pässe
                      # selbst aus (ADR 0029) — deshalb sind die Gates auch in der CI scharf
npm run test:unit     # nur Unit-Specs — die schnelle Feedback-Schleife
npm run test:coverage # Suite + V8-Coverage — global 90/80/90/90 als Projekt-Durchschnitt,
                      # per-file-Gates für core/protocols/adapters/transport/storage/
                      # charts/reports/ai (maßgeblich ist vitest.config.ts,
                      # ADR 0017/0020/0022) — grün
npm run demo          # Workbench mit Simulator auf http://localhost:8080
npm run formal:conform # Konformanz-Vektoren gegen TS (und Haskell, wenn Toolchain da — sonst NOT RUN) (ADR 0045)
npm run architecture:impact -- <datei|paket>  # Betroffene Pakete/ADRs/Tests aus der manifest-Kantengraph (ADR 0046)
npm run ai:context:changed  # .ai/generated/changed-context.md — Topic-Bundles der geänderten Pakete (ADR 0046)
```

Einzelnes Paket bauen bzw. einzelne Test-Datei ausführen:

```bash
npx tsc -b packages/transport/iso-tp
npx vitest run packages/storage/src/storage.spec.ts
```

Getestet wird **direkt der TypeScript-Quelltext**: Die Root-`vitest.config.ts`
aliasst die Workspace-Exporte von `./dist/...` auf `./src/...` (ADR 0010,
Schritt 1) — für Unit-, Protokoll-, Replay- und Regressions-Tests ist kein
Build nötig, kein stales `dist` möglich. **Ausnahme:** die Workbench-
Integrationstests (`apps/web/test/server.spec.ts`) beziehen den Chart-Kern
über `/lib` aus dem *kompilierten* `dist` von `@vdp/charts`; ohne Build
antwortet `/lib/index.js` mit 404 (gemessen 2026-09-11). Deshalb führen
`npm test` und `npm run test:coverage` den Build seit dem 2026-09-11 selbst
aus (Regel 34.26); `tsc -b` prüft zusätzlich Declaration-Maps und die
Abhängigkeitsrichtung. Das Frontend (`apps/web/public/*.js`) wird über das
eigene Projekt `tsconfig.frontend.json` mit `checkJs` typgeprüft und läuft
im Typecheck-Pass mit.

## 0.C Workflow (verbindlich)

1. Kleiner, thematisch reiner Branch von `main` — ein PR behandelt genau ein Thema.
2. PR-Template ausfüllen; es kodiert die Definition of Done (Abschnitt 35) und die Leitplanken.
3. Die CI muss auf **Node 22 und 24 grün** sein. Kein Merge auf Rot, kein „lokal läuft es“.
4. Commit-Messages im Stil des Verlaufs: `<scope>: <was>` als Betreff, im Body die *Begründung* und — bei Verhaltensbehauptungen — die *Messung* (Testlauf, Build-Output, Zahlen).
5. Architektur- oder Toolchain-Entscheidungen werden als ADR in `docs/adr/` festgehalten (Regel 34.15); ein überholter ADR wird durch einen neuen als `superseded` markiert, nie gelöscht.
6. Behauptungen über Verhalten werden durch Messung belegt, nicht geschätzt (Regel 34.21).

## 0.D Leitplanken in Kurzform

Die Vollversion steht in Abschnitt 34 — diese Punkte brechen ein Review garantiert:

- **Niemals:** CAN-/UDS-Logik in der UI · OEM-Logik in der CAN-Schicht · monolithische Diagnoseklasse · Secrets im Code · ungeklärte Fremddaten aus Wettbewerbsprodukten · Umgehung von SFD/Security Access · Merge auf roter CI · Absenken der Security-Baseline aus ADR 0009.
- **Immer:** Roh und dekodiert strikt getrennt (ADR 0004) · Read-only vor Write · jede Schreiboperation über den SafetyManager (Abschnitt 26) · jeder gefundene Fehler wird ein Regressionstest *mit Symptombeschreibung* · Provenance-Metadaten bei Daten (Abschnitt 24) · ISO-Nummer im Kommentar bei Norm-Details (Regel 34.18).
- **Dependencies:** `transport/*`, `protocols/*`, `definitions` und `shared` bleiben dependency-frei (ADR 0002). Infrastruktur-Dependencies nur nach ADR 0010: Maintenance-Nachweis, Lizenz-Check (MIT/Apache-2.0/BSD), lokal regeneriertes Lockfile im selben PR.

## 0.E Offene Verbesserungen — Backlog (Stand 2026-09-20)

Dieser Backlog ist bewusst **auf Bestehendes beschränkt: keine neuen
Funktionen**, jede Maßnahme verbessert Vorhandenes. Prioritäten: **P1** =
Qualität/CI-kritisch, **P2** = Korrektheit/Konsistenz, **P3** =
Hygiene/Refactoring. Jeder Eintrag nennt den Befund mit Messung (Regel
34.21) und die konkrete Verbesserung. Ein abgearbeiteter Eintrag wird durch
den PR entfernt, der ihn behebt — zusammen mit dem Nachziehen von
0.A/README/CONTRIBUTING (Regel 34.24).

**Am 2026-09-20 abgearbeitet (v1.43):** Extra-Definitionen als Dateien
(`data/definitions/*.json`, `definition-source.ts`); Hardware-README und
DoIP-TLS-Ehrlichkeit (Port 3496 announced-not-implemented); Changelog in
`CHANGELOG.md`; `npm run audit` in `npm run ci`; Backend-/Frontend-Split
(`chaos-session.ts`/`write-ops.ts`, `chaos.js`/`writes.js` — Hygiene-Ausnahmen
nachgemessen: `backend.ts` 1336, `app.js` 1382); Write-Token
(`VDP_WRITE_TOKEN` / `X-VDP-Write-Token`); Honesty-Test für `haskell NOT RUN`;
Coverage-Boden 76/72 eingefroren. **Nicht angefasst:** `safety.rs::execute`
(E25.3, kein cargo); kein lizenziertes OEM-JSON erfunden.

**Am 2026-09-11 abgearbeitet (v1.5):** E1 (CI-Härtung real), E2 (`npm test`
baut selbst), E3 (Coverage-Wahrheit + ADR 0017), E5 (6 Ebenen, echter
Frontend-Typecheck), E6 (leeres `catch {}` weg), E7 (Script-Duplikate weg)
und der Storage-Teil von E4 (Gates 70/45 → 90/55 nach Tests).

**Am 2026-09-12 abgearbeitet (v1.6):** E8 (Engine-Zerlegung, Roadmap-Schritte
8/9) — `apps/web` ist engine-frei, vollständiges Command-/Query-Vokabular,
doppelter Live-Start und Doppel-Recording messbar behoben (0 Duplikate),
`dispose()` schließt den Bus auch nach fehlgeschlagenem Connect; Details im
Ergebnisabschnitt der Migrations-Roadmap.

**Am 2026-09-12 abgearbeitet (v1.8):** **E4** (DoIP-Coverage):
`transport/doip/src/transport.ts` 78,6/68,3 → **98,5/88,7**,
`discovery.ts` 91,3/52,9 → **100/78,9**, `charts/group.ts` 77,0/77,6 →
**99,1/91,3**; Gates angehoben (global 90/80, transport 85/70, charts 90/75 —
ADR 0020). Dabei gefunden und behoben: ein fehlgeschlagener Routing-Aktivierung
ließ den DoIP-Transport in `connecting` mit offenem Socket zurück, und
`ChartGroup.notify()` schluckte Subscriber-Fehler. **Nachzug zu E6:** die drei
verbliebenen leeren `catch {}` (`charts/group.ts`, `adapters/canable/adapter.ts`,
`adapters/host/serial.ts`) sind beseitigt — Regel 34.25 ist damit im gesamten
Baum erfüllt (nachgemessen am 2026-09-12: Skript über 211 `*.ts`/`*.js`-Dateien
ohne `node_modules`/`dist`, Kommentare entfernt → **0 leere `catch`-Blöcke**).
**Neu (ADR 0019):** das Discovery-Zeitbudget ist explizit (`probeDelayMs`) und
injizierbar; feste Sleeps in Tests sind durch Bedingungs-Waits ersetzt.
**Messung:** Gesamtlauf 71,69 s → 23,83 s, Suite 971 → 991 Tests grün.

**Am 2026-09-12 abgearbeitet (v1.9):** **E13** vollständig — `storage/zip.ts`
58,1 → **83,9 %** Zweige, `migrations.ts` 61,5 → **92,3**, 22 statt 15 Tests,
Gate 90/55 → **95/80**; die Anhebung war in E13 beabsichtigt, aber nie
committet, und ist jetzt mit ADR 0022 nachgeholt. **E12** ist gegenstandslos:
`adapters/host/catalog.ts` misst seit der SocketCAN-Naht **100 Zeilen / 95,2 %
Zweige** (der Befund nannte 68,0/48,6), das `adapters`-Gate steht auf 85/75.
Dazu zwei Arbeiten ohne Backlog-Nummer, beide mit ADR: der **Latin-1-Fix im
Export-Pfad** (ADR 0021, `pdf.ts` 93,9/71,4 → 100/88,9) und das **Nachtesten
von Analyse und Bericht** samt `messageOf`/`asError` als einem Vertrag in
`@vdp/shared` (ADR 0022, `ai/http.ts` 80,6/78,9 bei 63,6 % Funktionen →
100/87,7 bei 100 %, `ai/service.ts` → 100/100, `errors.spec.ts` neu mit 10
Tests, 40 von 45 Kopien der catch-Zeile ersetzt). **Messung:** Suite 991 →
**1066 Tests** in ~23 s grün (78 Dateien), Zweige global 86,0 → **87,8**, neue per-file-Gates
`shared` 100/95, `reports` 95/75 und `ai` 90/75; dass Gates beißen, ist mit einem absichtlich
unmöglichen Wert geprüft (`EXIT=1`, `pdf.ts` 88,88 % im Fehlertext).

**Am 2026-09-14 abgearbeitet (v1.19):** der Guardrail-Schritt (ADR 0029) —
fünf Regeln `warn`/`off` → `error` ohne Produktionsänderung, drei weitere Regeln
`error` mit fünf behobenen Fundstellen, jede verbleibende `off`-Entscheidung mit
Umfang und Messung im Rekord, und die Quality-Gates laufen jetzt im
`architecture`-Testlauf, weil `ci.yml` sie sonst nie ausführt (E17 bleibt als
Restkopplung dokumentiert). Der 57-Punkte-Backlog des Auftraggebers liegt als
`docs/architecture/master-backlog.md` gegen den gemessenen Stand abgeglichen vor;
die zwei dort korrigierten Vorschläge (kein ESLint, kein Turborepo/Nx auf Vorrat)
sind als Entscheidung in ADR 0029 §1/§5 festgeschrieben und vom Test erzwungen.

Offen bleiben:

| Nr. | P | Befund (gemessen am 2026-09-12) | Verbesserung (Bestehendes verbessern, kein Feature) |
|---|---|---|---|
| E10 | P1 | Die vier gehärteten CI-Workflow-Dateien (`ci.yml` mit Quality-Job + Coverage-Upload, `codeql.yml`, `dependency-review.yml`, `hardware.yml`) sind fertig entwickelt, aber nicht pushbar. Gemessen 2026-09-12 mit `git push origin <branch>`: `remote rejected … refusing to allow a GitHub App to create or update workflow .github/workflows/ci.yml without 'workflows' permission`. Im Repo liegt deshalb nur `ci.yml` mit `npm ci` → `build` → `npm test`; `gh api repos/CAZE7/yes-you-CAN/actions/workflows` liefert genau zwei Einträge (CI, Dependabot). README und 0.A behaupteten den gehärteten Stand — nach Regel 34.24 auf den Ist-Zustand korrigiert, das CodeQL-Badge ist entfernt. Seit ADR 0027 ist der Folgeschaden gemessen: `tools/test-reporters/flaky-reporter.ts` misst **0 %** (Zeilen 29-101) — kein Test führt ihn aus, weil kein Job ihn aufrufen kann. | Freischaltung: GitHub → Settings → Applications → Arena (GitHub App) → Repository Permissions → **Workflows: Read & write**, anschließend die vier Dateien in einem eigenen PR pushen (sie liegen in der Arbeitskopie) und README-Badge + 0.A-Zeile zurück auf ✅ stellen. Bis dahin ist `npm run ci` das verbindliche Tor (AGENTS 35). |
| E9 | P3 | `vitest.config.ts` erlaubt in der CI weiterhin `retry: 2`. Der Messbeleg für die ursprüngliche Sorge ist seit v1.8 stärker: die Suite brauchte 71,69 s und vier Workbench-Tests warteten mit festen `setTimeout`-Werten (300–400 ms) auf Samples, die der 60-ms-Poll-Loop nach ~70 ms liefert — Rennen unter Last. Feste Sleeps sind jetzt durch Bedingungs-Waits ersetzt, Discovery fährt ein explizites Zeitbudget (ADR 0019), der Lauf dauert 23,83 s. Ein Flaky-Report aus der CI liegt weiterhin nicht vor, weil die Workflows nicht pushbar sind (E10). | `retry` schrittweise Richtung 0 senken, sobald ein CI-Lauf der gehärteten Workflows den Flaky-Reporter ausgeworfen hat (`tools/test-reporters/flaky-reporter.ts`). Ohne diesen Nachweis bleibt der Wert unangetastet (Regel 34.21); lokal ist `retry` bereits 0. |
| E14 | P3 | **`isolate: false` halbiert die Suite-Laufzeit — gemessen, bewusst noch nicht übernommen.** Vier Läufe am 2026-09-12 (Node 22, jedes Mal 75 Dateien / 991 Tests grün): mit Isolation 26,77 s und 23,79 s, mit `--no-isolate` 13,18 s und 13,51 s — ≈45 % schneller; im Coverage-Modus 32,78 s → 16,35 s. Der Runner meldet denselben Befund selbst (75 Worker, ~104 ms Start je Datei, „at least ~7.72s faster with `isolate: false`“), die eigene Messung liegt deutlich darüber. Eine Abweichung ist dokumentiert: Branches gesamt 84,21 → **84,19** (0,02 Prozentpunkte), weil wiederverwendete Worker Modul-Initialisierung nur einmal zählen; alle Gates bleiben grün. | Die Entscheidung gehört in einen eigenen PR mit ADR, nicht stillschweigend in `vitest.config.ts`: `isolate: false` macht Modulzustand über Dateien hinweg sichtbar (Logger-Sinks, feste Uhren, Singletons). Vor der Übernahme dreimal grün in Folge plus gezielter Nachweis, dass kein Test auf frischem Modulzustand beruht; Determinismus schlägt Laufzeit (AGENTS 31). Bleibt der Nachweis aus, bleibt die Isolation — dann ist der Laufzeitgewinn verworfen, nicht aufgeschoben. |

| E16 | P3 | **Die Gates sind nachgezogen, die dünnsten Puffer sind benannt (Stand 2026-09-14).** Aus dem alten Fünf-Dateien-Befund sind alle fünf abgearbeitet: `elm327/protocol.ts` 96,3/76,0 → **100/100**, `elm327/stream.ts` 88,2/100 → **100/100**, `transport/can/bus.ts` 87,5/100 → **100/100** (eigene Spec mit fünf Registry-Fällen), `reports/report.ts` 100/79,5 → 100/**83,3**, `ai/heuristic.ts` 94,9/79,5 → **100/89,4**. Gates angehoben (ADR 0028): `core` 85/65 → **88/80**, `adapters` 85/75 → **92/78**, `transport` 85/70 → **88/72**, `reports` 95/75 → 95/**80**, `ai` 90/75 → **95/85**; dass sie beißen, ist mit je einer absichtlich unmöglichen Schwelle gemessen (`ERROR: … does not meet "packages/reports/**/src/**" threshold (99%) for …/pdf.ts`, `… for …/report.ts`). Der Ratchet erzeugt neue dünste Stellen, die hier stehen statt versteckt zu werden: `diagnostics/engine.ts` 82,10 Zweige (Puffer 2,1), `dtc/clear.ts` 90,24 Zeilen (2,2), `host/selection.ts` 95,40 Zeilen / 83,78 Zweige (3,4/5,8), `iso-tp/connection.ts` 92,85/75,62 (4,9/3,6), `ai/http.ts` 87,71 Zweige (2,7), `apps/web/src/adapters.ts` und `server.ts` (siehe E17). | Wie bisher: dünste Stelle nachtesten, dann in Schritten anheben (ADR 0017: erst Tests, dann Gate). Die Liste oben ist die Reihenfolge nach Puffer, beginnend mit `engine.ts`/`clear.ts` (core) und `http.ts` (ai); `connection.ts` braucht einen Timeout-/Overflow-Test doubles, nicht mehr Sleeps. Keine Ausnahme, kein `?? 0`-Arm, der als "nicht testbar" ausgenommen wird. |
| E17 | P2→✅ | **Die beiden dünnen Dateien sind nachgemessen und nachgetestet (2026-09-16).** Was die Zeile benannte: `server.ts` 69,63/65,53 und `adapters.ts` 73,68/**54,54** Zweige, je knapp über der Schwelle. Danach: `server.ts` **76,99 / 77,28**, `adapters.ts` **100 / 100**, `backend.ts` 92,81/67,87 (vorher 89,61/73,22 — die Szenario- und Panel-Pfade zählen jetzt mit). Getan: `apps/web/test/server-paths.spec.ts` (Freeze-Frame-Lesung bis aufs Rohbyte, jede Absage, Body-Limit, Marker), Adapter-Pins für die drei `create()`-Verweigerungen und die Katalog-Schalter, und `summarizeAvailability` ist gestrichen (Export ohne Aufrufer; die zwei Zweige, die die Datei drückten, waren ungenutzter Code). Schwelle auf 75/66, Biss gemessen. **Was bleibt, ist benannt statt gemeutert:** der CLI-Block am Fuß von `server.ts` (703-793: `--demo`, `--list-adapters`, Exit-Codes) bleibt in der Zahl ungeprüft, weil ein Kindprozess nicht in die v8-Deckung des Vaters zählt — ihn zu spawnen bringt Verhalten, keine Coverage, und die Zahl bleibt ehrlich niedrig; `backend.ts` steht bei 67,87 Zweigen, weil Export- und Session-Zweige (u. a. 1177, 1326-1332) denselben Nachlauf verdienen. | CLI-Block: ein Spawn-Test auf Verhalten (Exit 2 bei kaputtem `--adapter`, `--list-adapters` nennt Verfügbarkeit), mit dem Satz in 0.A, dass er die Zahl nicht hebt; **Nachtrag am selben Tag, zweiter Schnitt:** `apps/web/test/backend-paths.spec.ts` (8 Tests, Integration) geht die Zweige durch, die kein Happy Path berührt — die drei Replay-Quellen (gespeicherte Session, Inline-JSON, Pfad, den es nicht gibt), die Absage einer Session ohne Roh-Trace, die Managed-Absage eines Katalogeintrags unter fremder Id, der werfende Event-Listener samt Abbestellverschluss, das Marker vor jeder Verbindung, die Statistik-/Spektrum-Arme der Signalanalyse und die drei Chaos-Schalter mit Reset. `backend.ts` damit 92,81/67,87 → **95,56 / 73,89**, `server.ts` 76,99/77,28 → **77,12 / 77,42** (der `statusFor`-Zweig aus E23 zählt dort mit), Bodenschwelle `apps/web/src/**` 75/66 → **76/72** (ADR 0017: erst Tests, dann Gate). Biss gemessen: mit `branches: 74` fällt der Lauf mit `ERROR: Coverage for branches (73.89%) does not meet "apps/web/src/**" threshold (74%) for apps/web/src/backend.ts`. Dasselbe Nachlesen fand den zweiten toten Export und strich ihn: `get canBus()` — Dokstring „exposed for tests and embedding“, Aufrufer im ganzen Baum: keiner, die Replay-Specs spritzen ihren Bus über `BackendOptions.bus` ein; `backend.ts` 1427 → **1419** Zeilen, Größen-Ausnahme in `hygiene.test.ts` auf den neuen Wert nachgezogen (der Gate schlägt bei einer veralteten Zahl absichtlich). **Was übrig bleibt, ist benannt statt weggemessen:** die drei Aufräum-Fänge in `stop()` (595/599/603) brauchen ein Objekt, das beim Abmelden wirft; die Geführte-Diagnose-Zuordnung (771/776) einen laufenden Guide; die Anomalie-Zuordnung (1022) eine Stichprobe mit Ausreißer; die Actions-Zeile des Exports (1318) eine Sitzung mit Schreibaktion; 1169 den abgelehnten Marker; 427 ein Domänen-Ereignis, das nur bei echtem Timeout läuft — und der CLI-Block 707-797 bleibt, weil ein Kindprozess nicht in die v8-Deckung des Vaters zählt. | CLI-Block: ein Spawn-Test auf Verhalten (Exit 2 bei kaputtem `--adapter`, `--list-adapters` nennt Verfügbarkeit), mit dem Satz in 0.A, dass er die Zahl nicht hebt; die Restarme brauchen Injektion (Abbau, Guide, Anomalie), nicht noch einen Sleep. |
| E15 | P3 | **Der erste Schnitt ist gesetzt (2026-09-14), der zweite folgte beim Merge:** die Präsentation verlässt `backend.ts` — `apps/web/src/ecu-view.ts` (95 Zeilen: `EcuView`, `FreezeFrameView`, `toEcuView`, `toFreezeFrameView`), `apps/web/src/dtc-view.ts` (86: `DtcView`, `toDtcView(info, ecus)` statt `this.toDtcView`), `apps/web/src/trace-view.ts` (105: Sample/Marker/Trace plus die zwei Formatierer `formatValue`/`formatCanId`, jetzt ein Ort statt zwei — die Extraktion hatte eine Kopie von `formatCanId` erzeugt, die ein Test nicht fand). `backend.ts` 1338 → **1107** Zeilen, `analysis-input.ts` (114) kam in Runde 1.14 dazu; die `*View`-Typen bleiben über Re-Export aus `backend.js` erreichbar, `server.ts` und die Tests importieren unverändert (ADR 0014: outward API gleich). Dass das Messen dabei zwingt, ist gemessen: direkt nach dem Schnitt fiel `ecu-view.ts` mit **57,14/25** durch die neue Bodenschwelle (der Freeze-Frame-Mapper hatte keinen eigenen Test) — ein Test dazu (14 Tests in `apps/web/test/views.spec.ts`), und die drei Module stehen auf 100/100; `apps/web/src` als Ganzes 80,63/74,41 → 81,06/76,04. **Zweiter Schnitt (2026-09-14, beim Zusammenführen mit der Strictness-Linie):** `packages/runtime/src/services.ts` überschritt durch beide Linien zusammen das 800-Zeilen-Budget (809) — ausgelagert wurde `packages/runtime/src/sample-stream.ts` (96 Zeilen: `SampleRound`/`SampleListener` und die Abo-Logik `bind`/`unbind`/`subscribe`), `services.ts` 809 → **785** Zeilen, 5 neue Tests, das Modul steht auf 100/100/100/100. | Offen bleibt der Rest der Zeile: Präsentationszustand (`ecus`/`dtcs`/`resolution` als Backend-Felder) und die Frage, ob die HTTP-Schicht ihren Zustand an einen Kollaborateur übergibt; Adapter-/Bus-Auswahl liegt bereits in `adapters.ts` (138 Zeilen, 72/54,54 — siehe E17). Kein weiterer Schnitt, der Logik nach `public/app.js` verlagert (0.E-Regel: verschieben statt messen). |
| E22 | P3 | **Die Radkreis-Diagnose kann nur einen Kreis benennen.** Das Modell fährt vier Räder, verbiegt vier (`breakSensor()` an jeder Ecke) und seit 2026-09-16 melden sie auch alle vier über `0xF40D` — dokumentiert ist im Simulator-Paket aber genau ein Radkreis-Code (`C0035`, vorn links; `vehicle-monitors.ts` hat einen Monitor, `high-fidelity-package.ts` einen Code in `abs.dtcs`). Defekt an einem Hinterrad: kein Code, weil vorn links gegen die anderen drei plausibel bleibt (gemessen, in `high-fidelity-vehicle.spec.ts` festgehalten). Defekt an beiden Hinterrädern: `C0035`, also ein **Vorderrad**-Kreis, weil Regel 3 kein Erfinden undokumentierter Codes zulässt. Die Messung stimmt, der Name ist grob. | Die drei übrigen Kreise brauchen ihre J2012-Zuordnung **als Quelle**, nicht drei erfundene Nummern (AGENTS 13/23: ein Code ohne Beleg ist ein Gerücht mit Build). Mit Beleg: vier Monitor-Ids je Ecke (derselbe Rationalitätsvergleich, Bezug = die anderen drei), vier `dtcs`-Einträge im Paket, und der Attributionstest zieht mit. |
| E23 | ~~P3~~ | **geschlossen 2026-09-16.** Der eine Tipp zählt nicht mehr als Serverfehler: `@vdp/shared` meldet die Klasse (`UnknownEcuError`, `ErrorCode`-Mitglied `"E_ECU_UNKNOWN"`), `statusFor()` im HTTP-Layer ordnet zu — **409**, weil eine falsche Adresse Sache des Operators ist und nicht Defekt der Plattform (ADR 0018: eine Ablehnung ist eine Antwort mit Grund) — und kein Layer vergleicht Sätze. Der Satz selbst ist unverändert, weil er die Frage beantwortet („connect first or check the id“). Gepinnt zweimal: `packages/runtime/src/runtime.spec.ts` (Klasse, Code, `ecuId`) und `apps/web/test/server-paths.spec.ts` (Status 409 statt 500). Gemessen: `npx tsc --noEmit -p tsconfig.typecheck.json` ohne Befund, `npm run test:unit --project unit packages/runtime/src/runtime.spec.ts` 24 Tests, `npx vitest run --project integration apps/web/test` 156 Tests / 10 Dateien. | Die vier anderen Aufrufstellen von `unknownEcu()` teilen die Zuordnung, weil sie dieselbe Klasse werfen; nachgeprüft ist sie an einer Route, nicht an fünf — eine zweite Route dreht mit, wenn jemand die Klasse ändert, und das ist der Punkt der Klasse. |
| E24 | ~~P2~~ | **geschlossen 2026-09-16 — das Chaos sitzt jetzt im Pfad, und die Blende sagt, wohin ein Burst zielt.** Der Befund war doppelt: `injectChaos()` legte den `CanChaosBus` *neben* den Bus der Runtime (`backend.ts:1039-1041`, `openBus()` wickelte nie), und der Burst hing an einer hart codierten `0x7e0`. Gebaut: `start()` wickelt das Ergebnis von `openBus()` ein (eine Instanz, die Runtime, Roh-Trace und Schalter gemeinsam sehen — ADR 0014 §Konsequenzen), `injectChaos` ohne offene Verbindung ist eine Absage (`TransportClosedError` → **409**, keine ERROR-Zeile), `ChaosLab.injectBurstFrameDrop` nimmt jetzt `canId: undefined` als bus-weite Form (die `drop-count`-Regel zählt dann über alle Rahmen, `chaos-lab.spec.ts` pinnt das), und `chaosStatus()` meldet `dropBurstTarget` (formatiert) plus `dropBurstScope` (`none` / `bus-wide` / `targeted`) — das Panel hat dafür ein optionales Adressfeld (`#chaos-burst-can-id`) neben dem Feld, das die Korruptur schon hatte, und zwei stille Defaults (`?? 5`, `?? 0x7e8`) sind weg: die Felder prüfen jetzt die Grammatik der Route (`apps/web/src/route-input.ts`: `parseCanId`, `parseBurstCount`, `parseDropRate`). **Gemessen am laufenden Server auf dem verwalteten Fahrzeug** (`node apps/web/dist/src/server.js --port=8099`, built, Auswahl `simulator-5ecu`): bus-weiter Burst von 20 → `droppedFrames: 20`, verbleibend 0; auf `0x7f0` gezielt → nach 1,5 s noch 6 verbleibend *und* `dropBurstTarget: "0x7F0"` in der Antwort — die Stille ist ein Satz geworden; `dropRate: 1` friert die Probensammlung ein (135 → 135) und nach `reset` 281, vorher: 566 Rahmen gezählt, während die Session ungestört weiterlief. Im Test nachgeprüft wird die Wirkung an der Sitzung, nicht am Zähler: Probe-Einfrieren und Wiederaufnahme (`backend-paths.spec.ts`), und eine korrumpierte **Antwort**-Id nimmt 3 von 8 Codes aus dem Auslesebild (5 statt 8), nach Reset wieder 8. **Was bewusst nicht gebaut wurde:** `delayedFrames` hat weiterhin keinen Schalter (die Regel existiert im Labor, die Blende legt sie nicht), die Korruptur wirkt aufrahmengenau (Sequenznummern — Einzelrahmen sind davon nicht betroffen, gemessen: auf `0x7e0` gerichtet bleibt die Acht-Code-Lesung vollständig), und Chaos überlebt keine Reconnect, weil `stop()` die Regeln löscht. | Wer die Blende erweitert, prüft die Wirkung an einer Sitzung (ein Timeout, ein fehlender Code, eingefrorene Statistik) und nicht an einem Zähler: `assert.rejects` auf eine Zahl ist die alte Krankheit in neuem Test. |

| E21 | ~~P2~~ | **geschlossen 2026-09-16.** Der Runner ist ein Reiter, wie ADR 0040 §8 ihn will: eine Frage („Was passiert, wenn…?“), kein Meter. Katalog, Lauf, Ergebnis (Urteil, Checks, dekodierter Fehlerspeicher, Endzustand, Zeitlinie) hängen an `SimulatorControl.runScenario`, und die 70 Zeilen, die die 0.E-Regel nicht in `public/app.js` dulden wollte, sind zwei eigene Dateien geworden: `apps/web/public/scenario.js` (194 Zeilen) und die Projektion `apps/web/src/scenario-view.ts` (407 Zeilen, 100/93,18/100/100 Coverage, gemessen im Lauf von 1.35). `app.js` wuchs um Mount und Refresh auf 1648 Zeilen (Ausnahmegrund in `hygiene.test.ts` nachgezogen, ebenso `backend.ts` 1427). Der zweite Halbsatz der alten Zeile — „eine View, die niemand abdecken kann“ — ist nicht behauptet, sondern zugebaut: `apps/web/test/markup.spec.ts` pinnt die Selektoren *und* dass Panel-Hosts existieren, und die Projektion liegt im `integration`-Projekt. | Nur noch Feinheiten, die das Panel reicher machen, ohne neue Schichten zu erfinden: `run.timeline` trägt keine Live-Marken (die Zeitlinie ist deshalb Modellzeit), und `scenario.js` bleibt ohne eigene Rendering-Tests, solange es nur Zeilen des Payloads kopiert. |

| E20 | P3 | **Die Gleichwertigkeit der Gates hängt an Tests, nicht am Workflow — und das ist jetzt vollständig.** Was offen war: `npm run ci` führte Biome, beide `--noEmit`-Pässe, `check:deps` und `check:manifests` (die beiden letzteren ohnehin als Architekturtests), **kein** Träger führte die Coverage-Gates in der CI aus; `ci.yml` ist mit dieser App nicht schreibbar (dritter Messlauf 2026-09-16: `refusing to allow a GitHub App to create or update workflow '.github/workflows/ci.yml' without 'workflows' permission`, wortgleich zu E10). Ein Schwellwert ohne Träger ist beides nicht: weder ein Absturz der Coverage noch eine Absenkung des Bodens fällt auf. Seit heute trägt `tests/architecture/coverage-gate.test.ts` das Tor in der CI (nur `CI`, Kind = `npm run test:coverage`, Rekursionssperre, `retry: 0`; gemessen +65 s pro Bein, Biss über `lines: 99` verifiziert). Damit ist die CI-Seite deckungsgleich mit den Toren außer einem: der Workflow *selbst* bleibt drei Schritte, und `npm audit`, CodeQL, Dependency-Review und Coverage-Upload (ADR 0016 §3) existieren nur als lokale Dateien. | Nach der Freischaltung (E10) zwei Schritte in `ci.yml` — `npm run ci` und `npm run test:coverage` — und der Carrier-Test darf auf die reine Selbstbeschreibung zurückgebaut werden (er ist dann Doppelung, nicht Träger); der Diff dafür liegt fertig im PR-Body von #22, er braucht nur die Berechtigung. Bis dahin pinnt `guardrails.test.ts`, dass `ci.yml` `npm ci`, `npm test` und die Matrix `[22, 24]` behält, und `hygiene.test.ts` die Größen. |

| E25 | P2 | **Der Rust-Kern (`crates/yes_you_can_core`) bleibt ein Prototype neben dem Hauptsystem, ohne `cargo` in CI.** Stand 2026-09-20, gemessen am Quelltext (kein `rustc` in dieser Umgebung): (1)/(2) **Modulkopf-Claims korrigiert** — `isotp.rs` nennt Classic-CAN, SF ≤ 7, FF 12-bit DL ≤ 4095, Encode in `[u8; 8]`; `signal.rs` nennt Allokation (`to_vec`, FFT-Puffer) und behauptet keinen Hampel-Filter mehr; `crates/README.md` + `Cargo.toml` sagen experimental / not in CI. (3) **unverändert:** `safety.rs::execute(current_time_ms, permit_expiry_ms)` nimmt das Ablaufdatum weiter vom Aufrufer, nicht aus `permit.expires_at_epoch_ms` — ohne Toolchain nicht angefasst (Regel 34.21). (4) **unverändert:** `signal.rs` / `safety.rs` ohne Tests, `isotp.rs` zwei Roundtrips. (5) **unverändert:** kein `cargo`-Schritt in CI/`package.json`, keine Vektor-Kopplung an `tools/formal-conformance/vectors/`. | Weiterhin: **Integration nur bei messbarem Hotspot**, sonst Reference/Experimental. Offen: Permit-Fix (3) gegen die TS-Semantik, Tests zu (4), Rust-Runner derselben 72 Vektoren (ADR 0045) — jeder Schritt braucht eine Toolchain. |

---

# Produktspezifikation (Abschnitte 0–36, normativ)

## 0. Glossar

| Begriff | Bedeutung |
|---|---|
| ECU | Electronic Control Unit — Steuergerät im Fahrzeug |
| DID | Data Identifier — adressierbarer Datenpunkt in einem Steuergerät (z. B. Kühlmitteltemperatur) |
| DTC | Diagnostic Trouble Code — gespeicherter Fehlercode |
| UDS | Unified Diagnostic Services, ISO 14229 — Anwendungsschicht-Protokoll für Diagnose |
| ISO-TP / DoCAN | ISO 15765-2 — Transportprotokoll, das UDS-Nachrichten über 8-Byte-CAN-Frames segmentiert |
| DoIP | Diagnostic communication over Internet Protocol, ISO 13400 — Diagnose über Ethernet/IP statt CAN |
| VIN | Vehicle Identification Number, ISO 3779 — eindeutige 17-stellige Fahrzeugkennung |
| SFD / SFD2 | Security Fault Detection — herstellerseitiger Schutzmechanismus gegen unautorisierte Codierung/Freischaltung |
| P2 / P2\* | UDS-Timing-Parameter: max. Antwortzeit einer ECU (P2) bzw. nach „Response Pending“ (P2\*) |

## 1. Ziel

Dieses Repository soll langfristig eine moderne, modulare, herstellerübergreifende Kfz-Diagnoseplattform werden — funktional ungefähr in der Klasse von Carly/OBDeleven, aber mit eigener, sauberer Architektur und späterer KI-gestützter Diagnose.

Der **erste Release muss mit einem normalen CAN-Adapter funktionieren**. Die Architektur darf dadurch aber niemals auf CAN-only festgelegt werden.

Langfristig vorbereiten auf:
- CAN / CAN-FD
- DoIP
- mehrere Adapter
- mehrere Hersteller
- UDS / weitere Diagnoseprotokolle
- ECU Explorer
- Live-Messwerte
- synchronisierte Graphen
- Logging / Replay / Exporte
- DTC-Diagnose
- Reports
- ausgewählte Komfortcodierungen
- KI-Diagnose
- optional Cloud/Mobile/Desktop

## 2. Architekturprinzip

Nicht „CAN-Logger plus spätere Erweiterungen“ bauen, sondern eine Plattform:

```text
UI
 ↓
Application Layer
 ↓
Diagnostic Engine
 ↓
Transport Layer
 ↓
Adapter Layer
 ↓
Vehicle
```

Die Schichten müssen entkoppelt sein. UI darf niemals CAN-Frames direkt interpretieren. Herstellerlogik gehört nicht in die CAN-Schicht.

**Begründung der Trennung Transport ↔ Diagnostic Engine:** ISO 14229-2 definiert UDS-Sessiondienste explizit *transportunabhängig* — dieselbe UDS-Logik muss über CAN (via ISO 15765-2) oder DoIP (via ISO 13400) laufen können, ohne dass der Diagnosekern etwas vom Transport weiß. Das ist keine Design-Präferenz, sondern folgt direkt aus dem Normstandard.

## 3. Empfohlene Repository-Struktur

```text
apps/
  web/
  desktop/
packages/
  core/
    vehicle/
    session/
    diagnostics/
    measurements/
    dtc/
    logging/
  transport/
    can/
    iso-tp/
    doip/
  adapters/
    generic-can/
    socketcan/
    elm327/
    canable/
  protocols/
    uds/
    kwp2000/
    oem/
  definitions/
    schema/
    generic/
    vag/
    mercedes/
  storage/
  reports/
  ai/
  shared/
tools/
  definition-importer/
  trace-analyzer/
  simulators/
tests/
docs/
AGENTS.md
```

Die konkrete Technologie darf dem bestehenden Repository angepasst werden. Die Verantwortlichkeiten müssen erhalten bleiben.

> **Stand 2026-09-11:** Der tatsächliche Baum entspricht dieser Struktur. `apps/desktop` existiert noch nicht (Phase 3); die Definition-Pakete `schema/generic/vag/mercedes` sind im Paket `@vdp/definitions` gebündelt statt als Unterordner. `packages/adapters/host` (Node-Host-Bindings, s. 0.A) und `packages/diagnostic-ir` (Beobachtungen mit Beleg, ADR 0031) existieren zusätzlich.

## 4. Adapter-Abstraktion

Diagnosecode darf nie von einem bestimmten Adapter abhängen.

```ts
interface VehicleTransport {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(data: Uint8Array): Promise<void>;
  receive(timeoutMs?: number): Promise<Uint8Array | null>;
  getStatus(): ConnectionStatus;
}
```

Später müssen mindestens möglich sein:
- Generic CAN
- SocketCAN
- CANable
- PCAN
- Vector
- ELM327/OBDLink
- DoIP
- eigener Adapter

Capability-Modell vorsehen:

```ts
interface AdapterCapabilities {
  can: boolean;
  canFd: boolean;
  doip: boolean;
  isoTpOffload: boolean;
  channels: number;
}
```

## 5. Kommunikationsschichten

Strikt trennen, mit Normreferenz pro Schicht:

```text
CAN Frame          (physikalisch, kein Standard nötig)
 ↓
ISO-TP             ISO 15765-2 — Segmentierung/Reassembly für 8-Byte-CAN-Payloads
 ↓
UDS Session Layer  ISO 14229-2 — transportunabhängige Session-/Timing-Dienste
 ↓
UDS Application    ISO 14229-1 — Diagnostic Services (0x10, 0x22, 0x19, ...)
 ↓
OEM/ECU Definition — herstellerspezifische Interpretation der DIDs/DTCs
 ↓
Decoded Diagnostic Data
```

DoIP muss später als alternativer Transport unterhalb der UDS-Schicht eingefügt werden können:

```text
                 Diagnostic Engine
                        │
                 Transport Interface
                  ┌─────┴─────┐
                 CAN         DoIP
              (ISO 15765-2) (ISO 13400)
```

Die UDS-Engine darf nicht wissen, ob sie CAN oder DoIP verwendet — das ist durch ISO 14229-2 explizit vorgesehen.

## 6. CAN-Layer

CAN bleibt reine Transport-/Frame-Schicht.

```ts
interface CanFrame {
  timestamp: number;
  id: number;
  extended: boolean;
  fd: boolean;
  dlc: number;
  payload: Uint8Array;
  channel: string;
}
```

Keine UDS- oder Herstellerlogik in dieser Schicht.

## 7. ISO-TP (ISO 15765-2)

Eigenständige Implementierung bzw. gekapselte Library für:
- Single Frame
- First Frame
- Consecutive Frame
- Flow Control
- Timeouts
- Retries
- Fehlerzustände

## 8. DoIP-Layer (ISO 13400)

Muss als eigenständiger Transport unterhalb der UDS-Schicht implementiert werden, mit folgendem Ablauf:

```text
1. UDP Vehicle Identification / Announcement
   → Discovery im lokalen Netz, Fahrzeug meldet VIN + Logical Address
2. TCP-Verbindungsaufbau
   → Standard-Port 13400, TLS-Variante Port 3496
3. Routing Activation Request/Response
   → Tester authentisiert sich, ECU-Routing wird freigeschaltet
4. UDS-Payload über TCP (UDSonIP, ISO 14229-5)
```

**Sicherheitshinweis:** DoIP läuft über Ethernet/IP und hat damit eine grundsätzlich andere Angriffsfläche als CAN. Netzwerksegmentierung, keine offene Diagnoseschnittstelle ins allgemeine Fahrzeugnetz und TLS-Nutzung sind vorzusehen, sobald DoIP implementiert wird (siehe auch Abschnitt 25 Safety Layer und Abschnitt 26 Datenschutz).

## 9. Diagnosekern

Abstraktionen vorsehen für:
- DiagnosticSession
- DiagnosticService
- DiagnosticRequest
- DiagnosticResponse
- DiagnosticResult
- DiagnosticError

Initial relevante UDS-Services (ISO 14229-1):
- 0x10 Diagnostic Session Control
- 0x11 ECU Reset
- 0x19 Read DTC Information
- 0x22 Read Data By Identifier
- 0x27 Security Access (zunächst nur abstrahieren)
- 0x2E Write Data By Identifier (später)
- 0x31 Routine Control (später)
- 0x3E Tester Present
- 0x14 Clear Diagnostic Information
- 0x2F Input Output Control (später)

**Timing-Parameter (ISO 14229-2) verbindlich abbilden:**
- `P2Client`: maximale Wartezeit auf die erste ECU-Antwort.
- `P2*Client`: maximale Wartezeit nach einer „Response Pending“ (NRC 0x78)-Antwort.
- Diese Werte müssen konfigurierbar pro ECU/Definition Package sein, nicht global hartkodiert, da Steuergeräte unterschiedliche Timeouts melden können.

Read-only zuerst.

## 10. Vehicle Session

Jede Fahrzeugverbindung ist eine Session.

```ts
interface VehicleSession {
  id: string;
  startedAt: Date;
  vehicle?: VehicleIdentity;
  adapter: AdapterInfo;
  transport: TransportInfo;
  selectedEcus: EcuSession[];
}
```

Sessions müssen speicherbar und später wieder öffnbar sein.

Session umfasst später:
- VIN/Fahrzeugidentität
- Fahrzeugbestimmung aus Belegen (§11.1, ADR 0026): welche Variante mit welchem score,
  welchen Belegen und welchen Widersprüchen sie dran war
- ECU-Liste
- DTC-Snapshot
- Messwertaufzeichnungen
- Raw Trace
- Diagnoseaktionen
- User Notes
- Reports

## 11. Fahrzeugidentität

Nicht nur Modellname speichern.

```text
VIN            (ISO 3779, 17-stellig, inkl. Prüfziffer)
Hersteller
Marke
Modell
Baujahr/Model Year
Plattform
Motor
Getriebe
ECUs
```

VIN automatisch erkennen, wenn verfügbar. Prüfziffer-Validierung (ISO 3779 Position 9) einbauen, um Lesefehler von Übertragungsfehlern zu unterscheiden.

### 11.1 Bestimmung aus Belegen (verbindlich, ADR 0023)

Fahrzeugidentität wird bestimmt, nicht geraten:

1. **Eingabe** ist, was bekannt ist: VIN, Identifikationswerte je Steuergerät
   (mit `ecu`, `oem`, `did`, `value`), die Adressen, die geantwortet haben, und
   was der Bediener oder eine frühere Session angibt (`declared`).
2. **Ausgabe** ist eine Rangliste von Kandidaten mit `score` (Anteil der
   bestätigten Gewichte an allen geprüften) sowie `evidence[]` und `conflicts[]`
   — je Kriterium `observed`, `expected`, `weight`, `reason` — dazu `unresolved`,
   `notes` und `unexplained`.
3. **Kein Kandidat ohne Beleg.** `score <= 0` erscheint nicht. Ein leeres
   Ergebnis ist eine gültige Antwort und trägt einen Grund („kein Paket deklariert
   Fahrzeugdefinitionen"), nie eine leere Maske.
4. **Widersprüche bleiben sichtbar.** Sie werden nicht verrechnet, nicht
   versteckt und nicht zu einer „Konfidenz" zusammengeschmolzen.
5. **Attributionsregel.** Ein Identifikationswert kann nur widersprechen, wenn
   seine DID im Paket als Teilenummer, Software- oder Hardwarestand dokumentiert
   ist. Werte ohne dokumentierte Art (Seriennummern, Werkstattcodes) stützen bei
   Treffer und sind sonst neutral.
6. **Namensraum.** Identifikationsfakten tragen `oem` und das nackte ECU-Id;
   Belege aus einem fremden Paket zählen nicht.
7. **Angaben wiegen weniger als der Bus.** `declared` ist ein Kriterium mit
   eigenem Gewicht, kein Filter: widerspricht die Busspur, gewinnt die Busspur,
   und der Widerspruch steht im Ergebnis.
8. **Provenance bricht nur Gleichstände** (ADR 0003): `own`/`standard`/`licensed`
   1,0 · `community` 0,8 · `reverse-engineered` 0,6 · `example-placeholder` 0,3.
   Ein Treffer auf Platzhalterdaten muss als solcher gekennzeichnet sein.
9. **Read-only.** Auflösung schreibt nichts auf den Bus und ändert keine Session
   (§25/§26 bleiben unberührt). Sie ist eine Query, kein Command.

## 12. ECU Explorer

Nach dem Verbinden möglichst systematisch erreichbare ECUs erkennen und darstellen.

```text
ECU
├── Name
├── Adresse
├── Protokoll
├── Identification
├── Part Number
├── Software Version
├── Hardware Version
├── VIN
├── Supported Services
├── DTCs
└── Available Measurements
```

Discovery nicht auf einen Hersteller hardcoden.

Das Zeitbudget der Discovery ist explizit und gehört zum Command-Vokabular:
`windowMs` begrenzt die beiden Hörphasen, `probeDelayMs` die Pause zwischen zwei
Einzelprobes — insgesamt `windowMs + Kandidaten × probeDelayMs` (ADR 0019).
Realverkehr fährt den Default (1200 ms / 15 ms), Simulator und Tests ein kleines
Budget, weil `VirtualCanNetwork` ohne `latencyMs` verzögerungsfrei antwortet.

## 13. OEM-/Diagnosedefinitionen

Hersteller-/ECU-spezifische Informationen dürfen nicht in UI und Diagnosecode verstreut werden.

Normalisiertes Modell vorsehen:

```text
Definition Package
 ↓
Parser/Importer
 ↓
Normalized Diagnostic Model
 ↓
Diagnostic Engine
```

Das Modell soll u. a. aufnehmen können:
- OEM
- ECU
- DID
- Service
- Request
- Response
- Byte-/Bit-Offset
- Length
- Endianness
- signed/unsigned
- Scaling
- Offset
- Unit
- Min/Max
- Enum Mapping
- Beschreibung
- Version
- Source/Provenance

Definition Packages selbst müssen semantisch versioniert werden (z. B. SemVer), damit Sessions, die mit einer älteren Definition aufgezeichnet wurden, nachvollziehbar bleiben, auch wenn sich die Definition später ändert.

### 13.1 Fahrzeuge im Paket (Schema v2, ADR 0023)

Zusätzlich zu ECUs, DIDs und Signalen trägt ein Paket `vehicles[]`: Marke,
Modell, Plattform, Generation, Karosserieformen, Modelljahre, `vinMatch`
(WMI-Liste, VDS-Muster, Modelljahr- und Werkzeichen), Motoren und Getriebe mit
Kennungen (`codes`) sowie je Fahrzeug die zugehörigen ECUs mit Teilenummern,
Softwareständen und optional `engine`/`gearbox`/`optional`.

Verbindlich:

- **Schema-Version und Migration.** `schemaVersion` ist Pflicht; ältere Pakete
  werden über einen expliziten Schritt gehoben (`migrate.ts`), nie über
  stillschweigende Annahmen. Eine unterstützte Version ohne Migrationsschritt ist
  ein Fehler.
- **Semantische Prüfung.** Unbekannte ECU-/Motor-/Getriebereferenzen, doppelte IDs
  und VIN-Matching mit in VINs verbotenen Zeichen (I, O, Q) sind Fehler, keine
  Warnungen; fehlende Einheiten und leere Enum-Mappings sind Warnungen.
- **Referenzdaten getrennt.** Standardwissen (WMI nach ISO 3780) liegt mit eigener
  Provenance neben den OEM-Paketen, nicht in der Engine.
- **Provenance je Fahrzeug.** Ein Paket darf dokumentierte und beispielhafte
  Fahrzeuge mischen; die Herkunft wird je Fahrzeug angegeben und erreicht die UI
  (§24).

### 13.2 DTC-Wissen pro Variante (Schema v3, ADR 0024)

Ein Fahrzeug trägt `dtcKnowledge[]`: je `code` mit optional `ecu`/`engine`/`gearbox`
(Scope) Texte, `patterns[]` (Ursache, Erklärung, `likelihood`, `repair`) und darin
`checks[]` (`signal`, `expect`, `min`/`max`, `windowMs`).

Verbindlich:

- **Auflösung nach Spezifität.** `findDtcKnowledge(packages, query)` gewichtet
  Motor 16 · Getriebe 8 · ECU 4 · angenommen 2/1. Ein Eintrag für einen anderen
  Motor ist kein schwacher Treffer, sondern keiner. Muster werden über alle
  zutreffenden Einträge gesammelt (spezifischster zuerst), Texte kommen aus dem
  spezifischsten Eintrag, sonst aus der Definition des lesenden Steuergeräts.
- **Nur deklarierte Signale.** Eine Prüfung referenziert ein Signal aus dem Paket.
  Fehlt das Signal, fehlt die Prüfung — eine erfundene Signal-ID erzeugt einen
  Prüfschritt, der nie laufen kann.
- **Kein Stellvertreter-Signal.** Ein Check muss den Fehler beobachten können, zu
  dem er gehört. Kann das Paket ihn nicht beobachten, sagt das Muster das in
  `explanation` und prüft nur die Bedingung, unter der der Fehler auftritt
  (ADR 0025).
- **Fenster sind Messbedingungen.** `min`/`max` nennen die Bedingung im
  `expect`-Text (Testgeschwindigkeit, Temperatur), nicht eine Toleranz aus einer
  Kalibrierung. Ein numerisches Fenster für ein Enum-Signal ist nur zulässig, wenn
  es die `enumMapping` desselben Pakets liest.
- **Eine Lücke ist eine Entscheidung.** Ein Code ohne Varianteneintrag bleibt
  paketweit, wenn die Variante nichts beitragen kann (ein Kommunikationscode
  bedeutet für jeden Motor dasselbe). Beschriebene und dokumentierte Codes werden
  gegeneinander gezählt, damit die Differenz benannt bleibt (ADR 0025).
- **Annahme nur bei Eindeutigkeit.** Ohne Eingrenzung des Antriebsstrangs gilt ein
  motor-/getriebegescoper Eintrag nur, wenn genau ein Motor (bzw. Getriebe)
  deklariert ist; dann steht er unter allem Bestätigten und mit Note.
- **Pattern-IDs sind je Fahrzeug eindeutig.** Damit sind Muster global adressierbar
  (Verbraucher: Schritt 16, Geführte Diagnose).
- **Provenance je Eintrag.** Wissen ohne Herkunft ist ein Fehler; ein
  Reparaturhinweis ohne Provenance ist eine Warnung (§24, Rechtefrage).
- **Migration erfindet nichts.** v2→v3 hebt die Version; Wissen darf fehlen, dann
  bleibt die paketweite Beschreibung stehen (§20.1).

## 14. Messwert-Engine

Raw Response darf nie direkt in der UI interpretiert werden.

```text
Raw Response
 ↓
Decoder
 ↓
Signal
 ↓
Value + Unit
 ↓
UI / Logger / Analysis
```

Beispiel:

```json
{
  "id": "engine.coolant_temperature",
  "ecu": "engine",
  "did": "0x1234",
  "offset": 0,
  "length": 2,
  "encoding": "uint16",
  "scale": 0.1,
  "offsetValue": -40,
  "unit": "°C"
}
```

## 15. Parallel-Livewerte

Mehrere Signale müssen gleichzeitig aufgezeichnet werden können.

Jeder Datenpunkt braucht einen präzisen Timestamp:

```json
{
  "timestamp": "2026-09-10T11:20:31.481Z",
  "signal": "engine.rpm",
  "value": 2384,
  "unit": "rpm"
}
```

Raw value und decoded value getrennt speichern.

**Nebenläufigkeit:** Da mehrere DIDs quasi-parallel abgefragt werden (Polling oder ECU-seitiges Multi-Response), muss die Implementierung klar festlegen, ob Requests sequenziell pro ECU-Session serialisiert werden (UDS erlaubt i. d. R. keine parallelen Requests auf derselben Session) oder ob mehrere ECU-Sessions parallel über getrennte Transport-Channels laufen.

## 16. Graph-System — zentrale Funktion

Das Produkt soll eine deutlich bessere Messwertanalyse ermöglichen als einfache Diagnose-Apps.

Pflicht:
- beliebig viele Signale
- gemeinsame Zeitachse
- Zoom
- Pan
- Cursor
- Marker
- Zeitraum auswählen
- automatische Skalierung
- individuelle Y-Achsen
- Ein-/Ausblenden
- Min/Max/Durchschnitt
- Delta
- Event-Marker

Später:
- DTC-Marker auf Zeitachse
- Diagnoseaktionen als Marker
- Session-Vergleich
- synchronisierte Cursor über mehrere Charts

Beispiel:

```text
Zeit ─────────────────────────────────────>

RPM       /───────\________
Boost     /───────\________
Lambda    ────────\____/───
                    │
                    ▼
                 DTC event
```

## 17. Logging

Von Anfang an sauber entwerfen.

Speichern:
- Session Metadata
- Fahrzeugidentität
- ECU
- Signal
- Timestamp
- Raw Data
- Decoded Value
- Unit
- DTC Events
- Requests/Responses
- Adapter Metadata

Exporte:
- CSV
- JSON
- ZIP Session Package
- PDF Report

Später ggf. Parquet/API/Cloud.

## 18. Raw CAN Trace

Zusätzlich zum dekodierten Messwert-Logging muss optional ein kompletter Raw-Trace möglich sein:

```text
timestamp
can_id
direction
dlc
payload
channel
```

Damit müssen Diagnoseprobleme später reproduzierbar analysierbar sein.

## 19. Trace Replay

Gespeicherte CAN/UDS-Traces müssen später wieder abgespielt werden können:

```text
Recorded Trace
 ↓
Replay Engine
 ↓
Diagnostic Engine
```

Das ist wichtig für Entwicklung und Regressionstests ohne Fahrzeug.

## 20. DTC-System

DTC-Datenmodell:

```text
Code
Raw Code
ECU
Status
Description
Severity
Freeze Frame / Environment Data
First Seen
Last Seen
Related Signals
```

Über das Fahrzeug gebundenes Variantenwissen (§13.2, ADR 0024) erweitert den
Datensatz:

```text
Scope (vehicle-engine / vehicle-gearbox / vehicle / package)
Fahrzeug (id, name, Provenance der angezeigten Aussage)
Bedingungen (wann der Code setzt)
Ausfallmuster (id, name, Erklärung, likelihood, Reparatur, Checks)
Notes (kein Variantenwissen / nur Text / kein Zahlenfenster / angenommen)
Checks (Signal, Erwartung, min/max, windowMs, measurable)
```

Funktionen:
- Scan all ECUs
- Read DTCs
- Details
- Snapshot
- Before/After Compare
- Clear DTCs mit expliziter Bestätigung

### 20.1 Variantenwissen und Ehrlichkeit (ADR 0024)

- **Schichtung statt Ersetzen.** `EcuDefinition.dtcs[]` bleibt die Basis (sie trägt
  Enable-Bedingungen und Snapshot-Referenzen); Variantenwissen überschreibt
  Description/Severity/Hint und merged `relatedSignals`.
- **Bindung.** `DtcScanner.setVehicle(context)` schaltet es ein, `connect()` bindet
  das aufgelöste Fahrzeug sofort, `resolve(hints)` bindet neu, `disconnect()` löst.
  Ein Scanner, der ein Fahrzeug trägt, darf beim Verbinden kein paketweites Wissen
  zeigen.
- **Ohne gebundenes Fahrzeug entsteht kein `knowledge`.** Die paketweite
  Beschreibung steht bereits am Record; sie als Variantenwissen auszugeben wäre
  genau die Verwechslung, gegen die die Fahrzeugachse existiert.
- **Die Aussage verrät ihre Quelle.** `scope`, `notes[]`, `checks[].measurable` und
  `knowledgeProvenance` (Entry → sonst Fahrzeug, aber nur wenn ein Entry gewann →
  sonst Paket) machen sichtbar, woraus ein Satz besteht und welche Messung er
  nicht trägt.

## 21. Diagnosebericht

Automatische Reports vorsehen:
- Fahrzeug
- Vehicle determination (§11.1, ADR 0026): Beleglage, trust, Abdeckung, weitere Kandidaten
- VIN
- Datum
- Laufleistung
- ECU Overview
- DTC Summary
- Variant knowledge (§20.1, §23): Scope, Ursache-Reihenfolge, Messfenster, Quelle,
  offene Punkte — und der Unterschied zwischen „nichts dokumentiert" und „nie gefragt"
- Messwert-Anomalien
- Sessions
- Notes
- Empfehlungen

PDF exportieren.

## 22. KI-Schicht

KI als austauschbaren Service abstrahieren.

```ts
interface DiagnosticAnalysisProvider {
  analyze(input: DiagnosticAnalysisInput): Promise<DiagnosticAnalysisResult>;
}
```

Architektur:

```text
Diagnostic Data
 ↓
Analysis Service
 ↓
AI Provider
 ├── Cloud Model
 └── Local Model
```

KI soll später:
- DTCs erklären
- Symptome zusammenfassen
- relevante Messwerte auswählen
- nächste Diagnoseschritte vorschlagen
- Logs/CSV/JSON analysieren
- Graphen analysieren
- zeitliche Korrelationen erkennen
- Berichte erstellen

Antworten müssen klar unterscheiden zwischen:
- Fact
- Observation
- Hypothesis
- Recommendation

Keine Scheinsicherheit bei Diagnosen.

Verbindlich für den Input (ADR 0026, since 1.14): die Analyse weiß, **wovon** sie
spricht. `vehicle` trägt das bestimmte Fahrzeug samt Beleglage (score, trust,
provenance) oder den Grund, warum nichts bestimmt ist — nie den VIN (HTTP-Provider
verlassen die Box, AGENTS 27). Pro Code trägt der Input `hint`, `scope`, `conditions`
und `measure` mit `measurable`; die Antwort zitiert diese Felder, statt sie zu
übersetzen: ein dokumentiertes Messfenster wird zur Messanweisung, ein Check ohne Zahl
bleibt eine Beurteilung durch einen Menschen, und ein Code ohne Scan-Record sagt genau
das. Konfidenz ist eine Obergrenze: fehlende Belege senken sie, vorhandene Belege heben
sie nicht.

## 23. Knowledge Base

Später eigene strukturierte Wissensbasis:

```text
DTC Definitions            ✅ EcuDefinition.dtcs[] (paketweit)
DID Definitions            ✅ EcuDefinition.dids[] mit Signalpfad
ECU Information            ✅ EcuDefinition (Adresse, Protokoll, Enable-Bedingungen)
Vehicle Variants           ✅ vehicles[] (§13.1, ADR 0023)
Known Failure Patterns     ✅ vehicles[].dtcKnowledge[].patterns[] (§13.2, ADR 0024)
Measurement Relationships  ✅ patterns[].checks[] mit min/max/windowMs
Repair Information         ✅ patterns[].repair, gelabelt als Hinweis (§24)
Legal/Licensed Documentation ✅ Präsenz aller Lizenzpflichten auf beiden Wegen (Paket,
                                      Fahrzeug, Wissenseintrag) — welche Lizenz weitergegeben
                                      werden darf, prüft kein Code (§24, Menschenentscheid)
Community Knowledge        ⏳ Datenweg ist die Datei (`sourceType: "community"` warnt auf
                                      beiden Wegen), ein Erfassungspfad in der Workbench
                                      existiert nicht und wird nicht vorgetäuscht
```

Jede Quelle braucht Provenance.

```json
{
  "sourceType": "licensed",
  "source": "OEM documentation",
  "license": "...",
  "version": "...",
  "retrievedAt": "..."
}
```

Verbindlich für die Wissensbasis:

- Wissen liegt **im Paket bei den Fahrzeugen**, nicht in einer Engine
  (ADR 0024): es versioniert mit dem Paket, bleibt in Sessions und Reports
  nachvollziehbar und braucht keinen zweiten Ablageort.
- Provenance je **Eintrag**, nicht je Paket: dokumentiertes und beispielhaftes
  Wissen dürfen nebeneinander stehen.
- **Gates nach Quellentyp** (ADR 0025): `licensed` braucht `license` (Fehler) und
  soll `version` plus `retrievedAt` tragen (Warnung) — ohne Stand und Datum ist ein
  Widerruf nicht bemerkbar. `standard` ohne Ausgabe (`version` oder `notes`) warnt,
  `community` warnt immer über ungeklärte Rechte. Ein `retrievedAt`, das kein
  ISO-8601-Datum ist, ist ein Fehler.
- **Beide Wege, dieselben Regeln — und dasselbe Werkzeug.** Der JSON-Parser ruft
  denselben Validator und verwirft kein Provenance-Feld still: ein Feld, das vorhanden,
  aber kein String ist, schlägt strukturell fehl (Regressionseintrag: `notes` ging auf
  dem Dateipfad verloren). Seit 2026-09-14 gilt das auch für `tools/definition-importer`:
  sein `importJson` las nur `ecus`/`signals` und gab ein Dokument mit `vehicles[]`
  als `valid: true`, `errors: []` und **ohne** die Fahrzeugachse zurück — die zweite,
  schwächere Koerzion war genau der Klasse, die 34.2 verbietet; der Weg geht jetzt durch
  `parseDefinitionPackage`. Abweichung mit Begründung: ein abgelehntes Dokument wird dort
  geworfen statt als `valid: false` zurückgegeben — ein Ergebnis, das ein Skript
  überlesen kann, ist für „ich verstehe diese Datei nicht" die falsche Form.
- Ein Reparaturhinweis ohne Provenance ist eine Warnung — an dieser Kategorie
  können Rechte Dritter hängen (§24).
- Fehlendes Wissen ist ein Zustand (`notes: []` bzw. `scope: "package"`), kein
  Raten: keine erfundenen Ursachen, keine erfundenen Messpunkte.

## 24. Datenherkunft / Commercial Readiness

Von Anfang an Source-/License-Metadaten vorsehen.

Keine ungeklärten Daten aus kommerziellen Wettbewerbsprodukten übernehmen. Insbesondere keine direkte Kopie von Datenbanken oder proprietären Definitionen aus Carly, OBDeleven, VCDS, XENTRY, ODIS, VCP etc., sofern keine entsprechenden Rechte vorliegen.

Eigenes Datenmodell, eigene Softwarelogik und sauber dokumentierte/lizenzierte Quellen bevorzugen.

## 25. Coding Framework

Erst nach stabilem Read-only-System.

Architektur:

```text
Coding Definition
 ↓
Validation
 ↓
Preview
 ↓
Explicit User Confirmation
 ↓
Backup
 ↓
Write
 ↓
Verification
 ↓
Audit Log
```

Jede Änderung speichern:
- aktuelle Werte
- neue Werte
- ECU
- Definition/Version
- Risiko
- Backup
- Zeitpunkt
- Ergebnis

Zuerst nur niedrig-riskante Komfortfunktionen.

Dieser Ablauf ist seit ADR 0032 **ausführbarer Code** und nicht mehr nur ein
Diagramm: Validation/Preview → `describe()` der Operation, Confirmation +
Preconditions → `confirm`-Stufe mit `SafetyManager.requestPermit()`, Backup →
`prepare()`, Write → `execute()`, Verification → `verify()` (Re-Read, nicht
Glauben), Audit → `WritePort.history` plus `SafetyManager.audit`. Eine neue
Operation ist ein `WriteOperation`-Objekt und eine Zeile in
`createWritePort()` (`packages/core/src/writes/standard-operations.ts`) — die
Stufen und das Permit lassen sich dabei nicht umgehen.

Keine frühen Implementierungen zum Umgehen von SFD/SFD2 oder anderer Sicherheits-/Authentifizierungsmechanismen.

## 26. Safety Layer

Jede Schreiboperation muss über einen SafetyManager laufen. Seit ADR 0032 ist
das **strukturell** durchgesetzt und nicht nur eine Konvention: Der Lesepfad
(`DiagnosticEngine`, `DtcAccess`) hat keine Schreibmethode, und `WritePort`
erteilt kein Permit ohne `SafetyManager.evaluate()` — eine Operation, die eine
Vorbedingung hinzufügen möchte (Warnungen), kann keine entfernen
(fail-closed, AGENTS 26).

Seit ADR 0033 gilt dabei: **unbekannt ist nicht erfüllt.** Jede Vorbedingung
endet als *proven*, *violated* oder *unproven*; `unproven` blockiert wie eine
Verletzung und wird getrennt ausgewiesen (`SafetyCheckResult.unproven`,
`DtcClearPrecheckInfo.unproven`). Wer eine Vorbedingung nicht belegen kann, misst
sie — er überspringt sie nicht.

```text
SafetyManager
├── preconditions
├── voltage check
├── vehicle state
├── ECU/session validation
├── backup
├── confirmation
├── rollback availability
└── verification
```

Beispiele:
- Fahrzeug steht
- Batteriespannung ausreichend
- korrekter ECU-Typ
- korrekte Softwarevariante
- korrekte Definition
- sichere Session

Sobald DoIP produktiv genutzt wird, zusätzlich: Netzwerk-Preconditions prüfen (keine unautorisierten Geräte im selben Diagnose-Segment, TLS aktiv, Routing Activation erfolgreich).

## 27. Datenschutz

Fahrzeugdaten können personenbezogen sein. Daher von Anfang an vorsehen:
- lokale Speicherung als Standard
- Cloud optional
- explizite Zustimmung
- Datenlöschung
- Export
- Verschlüsselung sensibler Daten
- VIN/Session-Handling sauber dokumentieren
- bei DoIP zusätzlich: Netzwerkverkehr nicht unverschlüsselt über gemeinsam genutzte Netze senden

## 28. UI-Struktur

```text
Dashboard
├── Fahrzeug
│   ├── Fahrzeugdaten
│   ├── ECU Explorer
│   └── Scan
├── Diagnose
│   ├── Fehler
│   ├── Messwerte
│   ├── Live Data
│   └── Sessions
├── Analyse
│   ├── Graphs
│   ├── Compare
│   └── AI Analysis
├── Coding
├── Reports
└── Settings
```

UI soll später Web/Desktop/Mobile unterstützen können. Business Logic nicht in UI-Komponenten verankern.

## 29. MVP

### Muss funktionieren
- CAN-Adapter verbinden
- Adapterstatus
- Fahrzeugverbindung
- CAN Communication
- ISO-TP
- UDS
- ECU Identification
- VIN
- DTC lesen
- Live-DIDs lesen
- mehrere DIDs gleichzeitig
- Live Dashboard
- synchronisierte Graphen
- Recording
- CSV Export
- JSON Export
- Raw CAN Trace
- Session speichern

### Noch nicht nötig
- komplexes Coding
- SFD/SFD2-Umgehung
- Security-Access-Umgehung
- DoIP-Implementierung
- Cloud
- Mobile App
- Marketplace
- Community
- große KI-Schicht

## 30. Phasen

> **Stand 2026-09-12:** Phase 1 ist implementiert und durch 1066 Tests auf sechs Ebenen abgesichert. Die Engine-Zerlegung (Roadmap-Schritte 8/9) ist vollzogen: `apps/web` spricht ausschließlich über das Command-/Query-Vokabular der Runtime mit dem Fahrzeug, ist `@vdp/core`-frei, und kein Code außerhalb von `@vdp/runtime` erreicht die Engine mehr (Backlog E8 erledigt; Rest: Auflösung der Engine-Klasse selbst, ADR 0014 Phase 4). Phase 2 läuft: OEM-Definition-Pakete existieren als gekennzeichnete Platzhalter, Reports und Session-Persistenz sind gebaut, das DTC-System (Freeze Frames, First/Last-Seen, Safety-gated Clear) ist fertig, die Graphen sind nach AGENTS 16 umgesetzt, die erste KI-Analyse ist ein lokaler Heuristik-Provider hinter der Provider-Abstraktion. Industriestandard-Härtung (ADR 0016) ist gemergt: Biome, Coverage-Gates grün, CI-Matrix mit Quality + Security, `LICENSE`/`CONTRIBUTING`/`CODEOWNERS`.

### Phase 1
```text
CAN Adapter
 → ISO-TP
 → UDS
 → ECU Explorer
 → Live Data
 → Graphs
 → Logging
 → Export
```

### Phase 2
```text
Multi-ECU
 → OEM Definition Packages
 → DTC/Freeze Frames
 → Reports
 → Session Compare
 → erste KI-Analyse
```

### Phase 3
```text
DoIP
 → weitere Adapter
 → mehrere Hersteller
 → Coding Framework
 → Service Functions
 → Mobile/Desktop Ausbau
```

### Phase 4
```text
Carly-like Feature Set
 → Guided Diagnostics
 → AI Knowledge Base
 → Workshop Mode
 → Community/Fleet Features
 → Commercial Definition Packages
```

## 31. Testing

Mindestens:
- Unit Tests
- Integration Tests
- Protocol Tests
- Simulator Tests
- Replay Tests
- Regression Tests

Jeder gefundene Protokoll-/Decoderfehler soll möglichst als reproduzierbarer Testfall festgehalten werden.

## 32. Simulator

Vor echter Fahrzeughardware ein virtueller ECU-Simulator. Er beantwortet nicht nur
Diagnosefragen — er **verhält sich wie ein Fahrzeug**, damit eine Diagnose etwas hat, das
sie finden kann (ADR 0040).

```text
Virtual ECU
├── Identification
├── VIN
├── DIDs            ← registerDid()/registerWritableDid(), keine Casts in interne Maps
├── DTCs            ← setDtc()/removeDtc(): der Fehlerspeicher ist API
├── UDS sessions
├── timing
└── responses

Virtual Vehicle (HighFidelityVehicle)
├── VehicleBehaviourModel      ← Versorgung, Motor, Räder, Integration in Modellzeit
│   ├── monitors[]             ← Bedingung + Debounce + Hysterese, dokumentierte Codes nur
│   ├── ModuleWiring           ← power-cut / supply-resistance / connector-loose / bus-open
│   └── vehicle-signals        ← eine Abbildung Modellzustand → Signal-Id (DID, Freeze Frame, Live)
├── VirtualCanNetwork.impair() ← Störungen auf dem Draht, beide Richtungen, zählbar
└── HEARTBEAT_IDS + gateway-ear ← „lost communication" ist eine Messung eines Nachbarn
```

```text
Application
 ↓
Simulator  (Ursache → Modell → Reaktion des Moduls)
 ↓
UDS
 ↓
ISO-TP
 ↓
Virtual CAN
```

**Regeln für den Simulator:**

1. Ein Fehler wird nicht gesetzt, er entsteht: eine Ursache (Spannung, Widerstand,
   Sensorabweichung, Leitungsstörung) ändert einen physikalischen Zustand, und eine
   Monitorregel lacht den Code, wenn der Zustand länger als der Debounce anhält.
2. Ein Modul dokumentiert nur, was sein Definitions-Paket kennt. Ein undokumentierter Code
   wird nicht aufgezeichnet — sonst meldet ein Scan eine Zahl ohne Erklärung (AGENTS 20.1).
3. Modellzeit ist eigen: `advance(ms)` in festen Schritten; dieselbe Anzahl Schritte liefert
   dasselbe Ergebnis, unabhängig davon, wie der Aufrufer schneidet. Wer die Szenarien im
   Demo-Takt laufen lässt, pausiert den Realtime-Loop für die Dauer des Laufs.
4. Ein Szenario ist Daten (`VehicleScenario`): Ursachen mit Modellzeit, Bedingungen am
   Zustand, Erwartungen an den Fehlerspeicher — mit `because`. Dasselbe Objekt treibt Test,
   Simulation und Workbench; `closedWorld` macht jeden nicht vorhergesagten Latch zu einem
   Fehlschlag.
5. Was der Simulator über UDS antwortet, ist die einzige Wahrheit für einen Test:
   erst die Kette `Ursache → 0x19 → IR → Evidence` beweist, dass ein Fehler gefunden werden
   kann und nicht nur gesetzt wurde (AGENTS 31, 34.9).

## 33. Observability

Strukturierte Logs für:
- Connection
- CAN
- ISO-TP
- UDS
- ECU
- Decoder
- UI
- AI

Level:
`ERROR`, `WARN`, `INFO`, `DEBUG`, `TRACE`

Raw protocol logging optional.

## 34. Regeln für Coding Agents

Der Coding Agent MUSS:

1. Das bestehende Repository zuerst analysieren.
2. Bestehende Architektur wiederverwenden, statt parallel ein zweites System zu bauen.
3. Keine monolithische Diagnoseklasse erstellen.
4. Keine CAN-/UDS-Logik direkt in UI-Komponenten schreiben.
5. Herstellerdaten in Definition Packages kapseln.
6. Interfaces für austauschbare Adapter/Transporte/AI-Provider verwenden.
7. Raw und decoded data getrennt halten.
8. Neue Funktionen testbar implementieren.
9. Für Tests Simulator/Replay statt echtes Fahrzeug verwenden.
10. Jede Diagnoseoperation sauber loggen.
11. Read-only vor Write-Funktionen priorisieren.
12. Sicherheitsmechanismen nicht umgehen.
13. Datenbankmigrationen versionieren.
14. Alte gespeicherte Sessions möglichst kompatibel halten.
15. Architekturentscheidungen dokumentieren.
16. Keine Secrets/API-Keys in den Quellcode schreiben.
17. Keine proprietären Konkurrenzdaten ungeklärt übernehmen.
18. Bei Unklarheit über Norm-Details (UDS-Service-Byte, DTC-Format, DoIP-Header) die relevante ISO-Nummer im Code-Kommentar referenzieren, statt Annahmen zu treffen.
19. Die CI ist Teil der Fertigstellung: Ein Change ist erst fertig, wenn der Workflow auf Node 22 und 24 grün ist (ADR 0009). Kein Merge auf Rot, kein Umgehen der Checks.
20. Dependency-Disziplin nach ADR 0010: `transport/*`, `protocols/*`, `definitions` und `shared` bleiben dependency-frei. Infrastruktur-Dependencies nur mit Maintenance-Nachweis, Lizenz-Check (MIT/Apache-2.0/BSD) und lokal regeneriertem Lockfile im selben PR.
21. Messung vor Behauptung: Aussagen über Verhalten („der Compiler fängt das“, „alle Tests grün“) nur mit Beleg aus einem tatsächlichen Lauf — Testausgabe, Build-Log oder gezielte Gegenprobe im Commit oder PR.
22. Die Security-Baseline aus ADR 0009 nicht absenken: localhost-Default, Security-Header, Body-Limit, GET-only-Stream. Neue Endpunkte übernehmen die Baseline; Abweichungen brauchen einen eigenen ADR.
23. Kleine, thematisch reine PRs mit ausgefülltem Template; die Commit-History bleibt lesbar und begründet.
24. Bei Widerspruch zwischen dieser Datei (oder einem ADR) und dem Repository gilt das Repository — und die Differenz wird im selben PR dokumentiert, der den Stand ändert. Dokumentation, die vom Stand abweicht, ist ein Defekt.
25. Kein stilles Fehler-Schlucken: leere `catch {}`-Blöcke sind unzulässig. Ein Fehler wird entweder behandelt oder mindestens strukturiert (Level `debug`) mit Grund geloggt (AGENTS 33). Bestehende Verstöße listet 0.E; wer eine solche Stelle berührt, beseitigt sie im selben PR.
26. `npm test` und `npm run test:coverage` führen den Build selbst aus, weil die Workbench-Integrationstests den kompilierten Chart-Kern über `/lib` aus `dist` beziehen. Diesen Build-Anteil nicht umgehen oder als „überflüssig“ entfernen — ohne ihn antwortet `/lib/index.js` mit 404 (gemessen 2026-09-11). Ein Lauf gegen fehlendes `dist` ist nicht „grün“ und darf nicht als Beleg gemeldet werden (Regel 34.21).

## 35. Definition of Done

Eine Funktion gilt erst als fertig, wenn mindestens vorhanden sind:

```text
Implementation
+ Error Handling
+ Unit/Integration Tests
+ Logging
+ UI Integration
+ Documentation
```

Zusätzlich seit v1.2:

```text
+ CI grün auf Node 22 und 24 (ADR 0009)
+ Verifikationsbeleg im PR (Testlauf, Build-Output oder Messung — Regel 34.21)
+ bei neuer Dependency: ADR-0010-Nachweise (Maintenance, Lizenz, Lockfile)
+ bei Norm-Details: ISO-Referenz im Code-Kommentar (Regel 34.18)
+ bei geändertem Verhalten: AGENTS.md-Tabelle 0.A und betroffene Doku im selben PR nachgezogen (Regel 34.24)
```

Nicht nur „läuft bei mir“.

## 36. Oberstes Architekturziel

Das MVP darf klein sein. Die Architektur darf nicht klein gedacht sein.

Ziel:

```text
             Web / Desktop / Mobile
                      │
                Application Core
                      │
                Diagnostic Engine
                      │
             Transport Abstraction
                ┌─────┴─────┐
               CAN         DoIP
            (ISO 15765-2) (ISO 13400)
                │            │
             Adapter      Ethernet
                └─────┬──────┘
                      │
                    Vehicle
```

**Das Projekt ist keine CAN-Logger-App. Es ist eine erweiterbare Fahrzeugdiagnoseplattform, deren erste Ausbaustufe lediglich über einen normalen CAN-Adapter arbeitet.**
