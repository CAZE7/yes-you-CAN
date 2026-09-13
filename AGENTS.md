# AGENTS.md — Vehicle Diagnostics Platform

> **Version:** 1.17 · **Letzte Änderung:** 2026-09-14
> **Changelog:**
> - 1.17: **P0 #5 abgearbeitet: fehlende Evidenz ist ein Fehlschlag (ADR 0030).** Die Safety-Kette kannte zwei Zustände — erfüllt und verletzt — und behandelte den dritten, **nicht belegt**, wie „erfüllt”: `batteryVoltage === undefined` war eine Warnung vor dem Permit, `expectedEcuType && actualEcuType && …` verglich nur, wenn **beide** Seiten gelesen waren, und DoIP-Voraussetzungen wurden geprüft, wenn sie zufällig da waren. Damit war ein Schreibvorgang ohne Messung erlaubt, einer mit schlechter Messung nicht — belohnt wurde, nicht zu messen. Jetzt: `SafetyCheckResult` kennt **drei** Ausgänge pro Vorbedingung (proven / violated / **unproven**), `unproven ⊆ failed` und blockiert damit (Batteriespannung, Ignitionszustand, Parkbremse, nie gelesener ECU-Typ, nie gelesene Softwarevariante, unbekannte Sitzung, unbekannter DoIP-TLS-/Routing-Zustand); `warnings` bleibt echten Hinweisen vorbehalten. Die Begründungen benennen die fehlende Handlung („cannot prove the supply is stable”, “ECU type was never read…”), und die Unterscheidung reist mit: `WritePrecheckResult.unproven` → `DtcClearPrecheckInfo.unproven` → Wire-Contract `DtcClearPrecheck` → UI („?“ = messen, „✘“ = reparieren); der Audit-Eintrag einer Verweigerung nennt zusätzlich, wie viele der Gründe fehlende Nachweise waren. Aus dem Write-Port kam dabei eine zweite Härtung dazu: nach jeder gescheiterten Stufe wird abgebrochen, `outcomeOf` lässt die Operation „ausgeführt, aber nicht bestätigt“ als `write-failed` auditieren, und der Audit-Eintrag einer Verweigerung nennt zusätzlich, wie viele der Gründe fehlende Nachweise waren — ein Nachweis ohne geprüfte Spannung ist keiner. Messung: `npm test` grün, 93 Dateien / 1348 Tests.
> - 1.16: **P0 #3/#4/#7 abgearbeitet: der Schreibpfad ist ein eigener Port, und jede Stufe ist ein Ergebnis mit Gründen (ADR 0029).** Befund: Lesen und Schreiben waren zwei Zweige derselben Klasse — `DiagnosticEngine.scanDtcs()` **und** `clearDtcs()`, `DtcAccess.scanEcu()` **und** `clear()` —, und die Safety-Kette war eine Methode, die man *aufrufen musste* (`evaluateDtcClear()` für die Vorprüfung, dieselbe Auswertung noch einmal in `clear()`). Damit hatte jeder, der scannen konnte, auch das Recht zu löschen; Ablehnungen waren Ausnahmen statt Daten (der HTTP-Rand musste sie zurückübersetzen, ADR 0018); und ein abgebrochener Schreibvorgang hinterließ eine Ausnahme, kein Ergebnis — Backup, Audit und Wiederaufnahme hatten keinen Ort. Jetzt: (1) **Trennung** — `engine.clearDtcs`/`evaluateDtcClear` und `DtcAccess.clear/evaluate` existieren nicht mehr, `dtc/clear.ts` ist reiner Vertrag (`ClearableEcu`, `ClearDtcResult` inkl. `stages`/`transactionId`), und Schreiben geht ausschließlich über `WritePort` (`writes/port.ts`: `register`/`run`/`precheck`/`kinds`/`history`); welche Operationen die Plattform darf, steht an einer Stelle (`createWritePort()` in `writes/standard-operations.ts` — heute genau `clear-dtc`). (2) **Transaktional** — `WriteOperation<Input, Prepared, Value>` deklariert `prepare → confirm → execute → verify` (+ `rollback`, `rollbackUnavailable`, `onAbort`, `outcomeOf`); `DiagnosticTransaction.stage()` macht jede Stufe zu einem `StageReport {stage, state, reasons, warnings, at, detail?}` und fängt jeden Wurf — `run()` wirft nur noch bei unbekanntem `kind` (Programmierfehler). (3) **Fail-closed an der Stufengrenze** — scheitert `prepare` (kein Backup, verweigerter Sitzungswechsel), wird abgebrochen **ohne** `confirm`: kein Permit für einen Schreibvorgang, der nicht starten kann, und kein irreführender Audit-Eintrag; ohne Permit läuft `execute` nie. (4) **Ehrlicher Ausgang** — der Permit-Ausgang wird auch dann journaliert, wenn die Ausführung nach erteiltem Permit scheitert, und `outcomeOf(value)` lässt die Operation selbst beurteilen, ob ihr Ziel erreicht wurde: ein Clear, dessen Re-Read den Fehler weiterhin zeigt, ist *ausgeführt*, aber nicht bestätigt und steht als `write-failed` im Audit-Log. (5) **Keine erfundene Rücknahme** — ISO 14229-1 kennt keinen Dienst, der gelöschten Fehlerspeicher wiederherstellt; `clear-dtc` hat deshalb kein `rollback`, sondern `rollbackUnavailable` mit Begründung, und der Port protokolliert die übersprungene Stufe **mit dieser Begründung**. Die Transaktion führt `open → prepared → confirmed → executed → verified | suspended | aborted | rolled-back` mit erlaubten Übergängen und Journal; `suspend`/`resume` beschreiben eine unterbrochene Handlung als Zustand statt als Aufrufstapel. Die `definitionVersion`, gegen die validiert wird, kommt aus dem `WriteBinding` — eine Quelle, damit Permit und Transaktion nie verschiedene Versionen nennen. Tests: die Szenarien der alten `DtcClearService`-Suite leben als Datentests weiter (`ok: false` + Stufe + Grund statt `assert.rejects`), plus 7 Tests für die generische Port-Maschine (fehlende Verifikation, erfolgter/failed Rollback, Audit-Ausgang, History-Grenze, unbekannter `kind`) und ein Kollaborateur-Test, der pinnt, dass die Leseseite keine Schreibmethode besitzt. >
>   Messung: 93 Dateien / 1345 Tests grün, `npm run ci` grün; Coverage `core/src/writes` 95,4/84,1/96,6/96,9 (global 96,9/89,6/97,7/98,2).
> - 1.15: **P0 #1 abgearbeitet: die 709-Zeilen-Engine ist eine Fassade, ein Test musste nicht weichen.** ADR 0014 Phase 4 verlangte „Engine in Kollaborateure auflösen", das Kriterium war `engine.ts` unter ~200 Zeilen **ohne Teständerung** — beides ist gemessen: 709 → **260 Zeilen** (159 Code-Zeilen ohne Kommentar/Blank, 26 delegierende Methoden), 0 geänderte bestehende Tests, 19 neue in `engine-collaborators.spec.ts` (92 Dateien / **1327 Tests** grün, 23,9 s; `npm run ci` grün). Neue Module unter `packages/core/src/diagnostics/`: `ecu-registry.ts` (welcher Handle gehört zu welcher Adresse — die eine Sache, die alle brauchen und die kein I/O hat), `ecu-links.ts` (die Transport-Naht: Bus, ISO-TP, `EcuLinkFactory` für DoIP), `ecu-attacher.ts` (aus einer Adresse eine nutzbare ECU-Session, inkl. „ECU antwortet nicht" als sichtbarer Zustand statt als verschwundene ECU), `session-opener.ts` (Verbindungsaufbau und Fehlerpolitik), `dtc-access.ts` (Fehlerspeicher lesen/anreichern/markieren/löschen), `measurement-access.ts` (Plan, Snapshot, Live-Daten), `engine-context.ts` (Aufbau der Kollaborateure), `engine-options.ts` (Konfiguration). Die öffentliche API bleibt unverändert — `OpenedEcuLink`, `EcuLinkFactory`, `ConnectResult`, `ScannedEcu`, `EcuHandle` werden aus `engine.ts` re-exportiert, weil Runtime, DoIP-Tests und Replay-Tooling genau diesen Importpfad nutzen; eine Zerlegung, die Aufrufer zwingt, sich zu ändern, wäre ein Umbau und kein Refactoring. Zwei Dinge sind dabei zu *Verhalten* geworden statt zu Zufall: `attachFailed()` erzeugt den Session-Record einer nicht erreichbaren ECU bewusst über die ISO-TP-Naht (ein Scan muss zeigen, *dass* ein Steuergerät geantwortet hat und *warum* es unbenutzbar ist), und `startLiveData()` ist jetzt `async` — es warf vorher synchron, während `scanDtcs()`/`clearDtcs()` bei fehlender Session ein abgelehntes Promise liefern; eine Fassade mit zwei Fehlerkanälen ist ein Fallstrick. Messung: Coverage global 96,85/89,83/97,73/98,20, `diagnostics/` 94,91/85,18 (vorher 89,6/78,6), `ecu-registry.ts` 100/100, alle per-file-Gates grün. Der Spec fährt echte `UdsServer` hinter einem In-Memory-Link — gemockt wird nur der CAN-Bus, weil Discovery ein Busprotokoll ist. Learnings für die nächsten Punkte: `ecu-session.ts` (438 Zeilen) bleibt der nächste Kandidat, und `Delivery: engine.ts` **unter 200 Gesamtzeilen** ist nur mit Vererbung oder ohne Public-API-Doku zu haben; die Fassade hat 159 Code-Zeilen — die Differenz ist Dokumentation an der Schnittstelle, kein Code.
> - 1.15b: **P0 #2 abgearbeitet: die Architekturregel ist ein Werkzeug mit einer Quelle (ADR 0028).** Die Regel lag doppelt vor — als Literal in `tests/architecture/dependencies.test.ts` und als Prosa in AGENTS 28 — und konnte nur feuern, wenn jemand die Suite laufen ließ. Jetzt liegen die Kanten in `tools/architecture/dependency-rules.json` (jede Platzierung mit `mayImport` **und** `why`, dazu Node-Builtin-Ausnahmen, UI-Regel, Layer- und Portabilitätsregeln) und werden von `tools/architecture/check-dependencies.mjs` gegen den echten Importgraphen ausgewertet (`npm run check:deps`, Teil von `npm run ci`, Exit 0/1/2 — eine unbreadbare Regeldatei ist ein Fehler, kein Freibrief). Der Test wiederholt die Kanten nicht mehr, sondern bewacht das Werkzeug: Verdrahtung in `ci`, Fixture-Bäume für verbotene/erlaubte/blinde Regeln, Fehler bei kaputter Regeldatei. **Zwei echte Regelfehler fielen dabei auf:** (1) „protocols never import adapters" prüfte den Präfix `@vdp/adapters`, aber die Pakete heißen `@vdp/adapter-*` — die Regel konnte nie greifen, in der Portabilitätsliste für domain/application stand dasselbe tote Präfix; (2) eine Regel ohne Treffer ist jetzt ein eigener Verstoß (`blind-prefix`), ebenso ein Regelschlüssel mit Tippfehler und ein `why`, das fehlt. Kein dependency-cruiser: es brächte eine zweite Regel-DSL und eine Konfiguration, die die Allowlist erneut ausdrückt — dieselbe Duplizierung, die dieser Schritt auflöst (dieselbe Begründung wie „kein zweites Vokabular" bei ESLint, ADR 0026). Messung: Werkzeug 0,13 s über 25 Pakete / 67 Kanten / 6 Regeln, `npm run ci` grün, 92 Dateien / 1327 Tests grün.
> - 1.14: **Strictness ohne Lücke: „fehlt“ ist nicht „undefined“, und das Frontend ist typgeprüft (ADRs 0026 §4, 0027; E18/E19 geschlossen).** (1) **E18 — `exactOptionalPropertyTypes` ist an, für den ganzen Baum.** Gemessen vorher: 27 Fehler in 13 Produktionsdateien im Build plus 61 Fehler in 28 Dateien im Typecheck-Projekt = 88; danach 0 in beiden Pässen. Das Flag ist keine Konfigurationszeile, sondern eine Aussage an der Roh→dekodiert-Grenze (ADR 0004): ab hier ist „das Feld fehlt“ von „das Feld ist `undefined`“ unterscheidbar, und genau diese Verwechslung erzeugt Berichte, die eine Aussage weglassen, statt eine leere zu machen. Produktionsseitig: `definitions/json.ts` castet nicht mehr `undefined` in Felder, die es nicht tragen (vier `literalOf`-Prüfungen, ECU-Teilbäume als `NonNullable<…>`), `definitions/resolve.ts` baut `factsOf()` Feld für Feld mit Vorhandenheitsprüfung (ein fehlendes `modelYearChar` heißt weiter „Position 10 ist kein Modelljahr“ und wird **nicht** aus dem VIN gefüllt), `core/vehicle/identity.ts` führt ein unbekanntes Modelljahr als fehlendes Feld, `core/diagnostics/engine.ts` übergibt optionale Argumente per Spread, `runtime/handlers.ts`/`services.ts`/`definition-service.ts` unterscheiden fehlende ECU/Identität/Plattform von leeren, `adapters/elm327` löscht eine gelesene Version nicht mehr bei stillem `ATZ`, `ai/http.ts` übergibt kein `AbortSignal | undefined` mehr, `apps/web/backend.ts` führt acht Teardown-Felder als `T | undefined` (vorhanden und leer) statt als `?:`, `tools/trace-analyzer` trennt „nicht dekodierbar“ von „leer“. Testseitig: neu `tests/helpers/fixture.ts` mit `FixturePatch<T>`, `patched(defaults, patch)` (ein `undefined` im Patch **entfernt** den Schlüssel — genau die Eingabe, die Tests wie „optional fields are omitted when absent“ beschreiben) und `without(value, …keys)`; sieben lokale Kopien des Musters sind ersetzt, `validate.spec.ts`/`storage.spec.ts` nutzen `delete` statt `x = undefined`, vier Cast-Aliase benennen die abgeschnittene Union. Der Guardrail-Test führt das Flag seitdem in `REQUIRED_STRICT_FLAGS` — und hat den unvollständigen Umbau selbst gefangen (Biome meldete einen ungenutzten Import als rote Gate). **(2) E19 — das Browser-Frontend ist typgeprüft (ADR 0027).** Gemessen mit `noImplicitAny: true`: 110 Fehler in 4 Dateien (`public/*.js`) — der Wert war zu optimistisch: sobald `$` ehrlich `HTMLElement | null` liefert, werden aus impliziten Parametern Nullability-Fragen, der Zähler stieg auf **221** (TS18047/TS2531), und am Ende steht **0**. Dafür: der Wire-Contract liegt node-frei in `apps/web/src/views.ts` (View-Typen plus benannte `SignalInfoView`/`AnomalyView`/`ActionView`/`AdaptersView`/`AdapterSelectView`/`AnalysisView`; `backend.ts` re-exportiert, bestehende Importe bleiben), `public/api.js` bildet jede Route auf ihren Antworttyp ab (Rumpf `unknown`, pro Endpunkt eine sichtbare Aussage), `public/dom.js` trägt die einmaligen DOM-Helfer (`$` nullbar, `must`/`input`/`select`/`button`/`child` verlangen ein vorhandenes Element und nennen sonst den Selektor), `chart.js`/`graphs.js`/`vehicle.js`/`app.js` sind vollständig annotiert. Zwei Nebeneffekte: der typisierte Durchgang fand einen echten Fehler — `btn-live-start` reichte `renderConnection` ein Objekt ohne `adapter` (jeder Klick landete im Fehlerbanner), jetzt wird der Zustand beim Backend geholt —, und `backend.ts` sinkt von 1326 auf 1117 Zeilen. Neuer Guardrail-Test „the browser project checks the front end against the wire contract“: `checkJs` und `noImplicitAny` müssen an sein, jeder absolute Import braucht ein `paths`-Mapping (sonst tippt TypeScript ihn still als `any`), und `views.ts` bleibt node-frei. `RELAXED_FLAGS` ist damit **leer** — nicht gelöscht: der nächste Abschwächungsversuch braucht wieder Datei, Flag und Messung. Messung: 91 Dateien / 1308 Tests / 22,85 s, `npm run ci` grün, Biome 303 Dateien ohne Fund.
> - 1.13: **Guardrails, die beißen (ADR 0026).** (1) **Das Problem war nicht zu wenig Linter, sondern zu weiche Regeln — und ein Tor, das niemand ausführte.** `biome check` scheitert an `error`, nicht an `warn`; die vier tragenden Regeln (`noUnusedVariables`, `noUnusedImports`, `noExplicitAny`, `noNonNullAssertion`) standen auf `warn`, `noUnnecessaryContinue` ebenso. Gemessen am 2026-09-14: alle fünf als `error` = **0 Fundstellen** in 298 Dateien — die Härte war kostenlos, sie war nur nicht beschlossen. Dazu drei Regeln von `off` auf `error` mit echten Fundstellen: `noImplicitAnyLet` (1, `doip/transport.ts` `let header;` → `DoipHeader` annotiert), `noShadowRestrictedNames` (2, `reports/report.ts` `escape` → `escapeHtml` — der deprecated Global war kein Name für HTML-Escaping — und `apps/web/test/paths.spec.ts`), `noUnusedTemplateLiteral` (2 × `definitions/resolve.ts`, Template ohne Interpolation → String). Drei Regeln, die global `off` waren (`noDelete`, `noAssignInExpressions`, `useConst`), sind jetzt `error` und nur für Testquellen aus; `noConsoleLog` ist `error` außer für `scripts/**` und `packages/shared/src/logger.ts` (die Datei, die die Konsole *ist*). Damit hat Produktionscode **keinen Regel-Ausnahmepfad** mehr. (2) **Zweites Tor geschlossen, das offen war: die CI führte Biome und beide `--noEmit`-Pässe nie aus.** `ci.yml` fährt `npm ci` → `build` → `npm test`; `npm run ci` (build · typecheck · check · test) rief niemand auf, und `tsc -b` prüft weder Specs noch `apps/web/public/*.js` — ein Spec mit Typfehler konnte grün mergen. Workflow-Dateien sind mit der App-Installation nicht änderbar (erneut gemessen 2026-09-14: `refusing to allow a GitHub App to create or update workflow … without 'workflows' permission`, E10), deshalb laufen die Gates jetzt **im Testlauf**: der `architecture`-Projektlauf führt `biome check .`, `tsc --noEmit -p tsconfig.typecheck.json` und `-p tsconfig.frontend.json` selbst aus und schlägt mit deren Ausgabe fehl. Gemessen: 0,82 s + 0,83 s + 0,31 s ≈ **2 s** auf einen 22,6-s-Lauf; `npm run test:unit` bleibt unberührt. Ein Test pinnt zusätzlich, dass `ci.yml` weiterhin `npm ci`, `npm test` und die Matrix `[22, 24]` fährt — wer `npm test` entfernt, entfernt sonst still die Gates. (3) **Neuer Architekturtest `tests/architecture/guardrails.test.ts` (7 Tests, Projekt geht 24 → 31):** ein Linter (kein ESLint — ein zweites Vokabular für dieselbe Frage; steht als Entscheidung mit Grund in JUSTIFIED_RULES), jede nicht-`error`-Regel mit Umfang **und** Messung auf dem Rekord (tote Begründungen fallen durch), Overrides nur für Testquellen oder benannte Nicht-Produktionsdateien, geerbte Strictness (`strict`, `noUncheckedIndexedAccess`, `noImplicitOverride` …) ohne lokale Rücknahme, und **kein Build-Orchestrator** (Turbo/Nx als Abhängigkeit, Datei oder Skripteintrag = Test rot; „auf Vorrat Komplexität erhöhen“ ist eine Entscheidung, keine Verbesserung). (4) **Strictness-Lücken beziffert statt behauptet:** `exactOptionalPropertyTypes: false` kostet 27 Fehler in 13 Produktionsdateien (Build) + 61 im Typecheck-Projekt = **88**, konzentriert in den Parsern, die optionale Felder kopieren (`json.ts`, `mappers.ts`, Backlog E18); Frontend-`noImplicitAny: false` kostet **110** Fehler in 4 Dateien (104 × TS7006, E19). Beide sind damit eine Aufgabe mit Messung, keine Fußnote. (5) Der Guardrail-Test fand beim Schreiben sofort zwei eigene Verstöße (Formatierung und `noUnusedTemplateLiteral` in seinem eigenen File) — er beißt also nachweislich. (6) **Messung:** Suite **1307 Tests / 91 Dateien in 22,6 s** grün (ohne `--project` 1308 / 92 wegen `hardware`, unverändert als Zähl-Falle dokumentiert), `npm run ci` 25,6 s, Coverage global 96,48 Statements / 89,65 Zweige / 97,52 Funktionen / 97,86 Zeilen, per-file unverändert grün (`reports/src/report.ts` 100/78,2, `doip/transport.ts` 98,54/91,37, `definitions/resolve.ts` 100/92,78), Biome und Typecheck grün. Neu in 0.E: E17/E18/E19; neuer Master-Backlog `docs/architecture/master-backlog.md` (die 57 Punkte gegen den gemessenen Stand, inklusive der zwei Korrekturen zu ESLint und Orchestrierung).
> - 1.12: **Wissensqualität: Gates für Einträge und Quellen, zwei gemessene Datenfehler (ADR 0025).** (1) Provenance wird je Quellentyp geprüft: `licensed` ohne `license` bleibt Fehler, ohne `version`/`retrievedAt` warnt es jetzt — ein Stand ohne Datum und Ausgabe macht einen Widerruf unbemerkbar (AGENTS 13); `standard` ohne Ausgabe (`version` **oder** `notes`) warnt, weil „SAE J1979" ohne Jahr ein Verweis und kein Zitat ist; `community` war die einzige Kategorie in §23 **ohne** Regel und warnt jetzt über ungeklärte Rechte; ein `retrievedAt`, das kein ISO-8601-Datum ist, ist ein **Fehler** — ein Datum, das nichts parsen kann, sieht dokumentiert aus und ist mit nichts vergleichbar. Fehler nur, wo Daten rechtlich oder logisch unbrauchbar sind, sonst Warnung: ein Fehler erzeugt den Anreiz, ein Feld auszudenken, statt es zu ergänzen. (2) **Echter Datenverlust, als Regressionseintrag katalogisiert:** `coerceProvenance` kopierte `license`/`version`/`retrievedAt`, aber nicht `notes` — ein aus einer Datei geladenes lizenziertes Paket verlor damit den einzigen Satz, der die Lizenz in menschlicher Sprache einschränkt. Kein Typfehler (jedes Feld ist optional), keine Warnung (der Validator prüft nur, was ankam), kein Test. Jetzt kopiert eine Feld-Schleife alle vier, und ein vorhandenes Feld, das kein String ist, schlägt strukturell fehl statt still zu verschwinden; der JSON-Parser ruft denselben Validator, also gelten die Gates auf dem Weg, auf dem lizenziertes Wissen tatsächlich kommt. Biss belegt: ohne die Kopie `1 failed | 19 passed`. (3) **Zweiter Datenfehler, von der laufenden Demo gefunden:** das Muster „intermittierendes Signal" zu P0715 prüfte 30 s lang die Getriebeöltemperatur und nannte das einen Dropout-Wächter — das Paket definiert kein Eingangsdrehzahlsignal, also beobachtete der Check einen anderen Fehler als den, zu dem er gehörte, und konnte praktisch nicht fehlschlagen. Neu sagt das Muster im `explanation`, welche Messung dieses Paket nicht machen kann, und prüft nur die Bedingung, unter der der Fehler auftritt (Öl über 60 °C); der Schritt für einen Menschen (30 s Kabelbaum bewegen, Statusbits beobachten) steht als Text. Regel daraus: **kein Stellvertreter-Signal** — ein Check muss den Fehler beobachten können, zu dem er gehört; zwei Tests pinnen das (jeder Prüfschritt referenziert ein deklariertes Signal, jeder Check trägt Grenze oder Fenster). (4) Wissen 4 → **6 Codes**: P0700 (Getriebe; drei Muster, das dritte ohne Check, weil kein Signal dieses Pakets einen Selbsttest des Moduls entscheidet — das Gangfenster 3…4 liest die `enumMapping` desselben Pakets statt einer erfundenen Skala) und C0035 (Fahrzeug; drei auswertbare Fenster 45…55 km/h über 5 s — linke Ecke, rechte Ecke, OBD-Geschwindigkeit aus einem anderen Steuergerät — plus ein 30-s-Wächter ohne Grenze, also `measurable: false` und in der View „nur manuell beurteilbar"). `U0121` bleibt **bewusst** ohne Eintrag: ein Kommunikationscode bedeutet für jeden Motor, jedes Getriebe und jede Ausstattung dasselbe, seine Ursachen liegen in Versorgung, Masse und Busleitung — Variantenwissen dafür wäre Füllung, die sich als Wissen ausgibt. Ein Test zählt die vom Paket beschriebenen Codes gegen die dokumentierten, die Differenz ist damit benannt und wächst nicht unbeobachtet; die Antwort bleibt `scope: "package"` plus Note. (5) Fenster sind Messbedingungen, keine Toleranzen: `45…55 km/h` gilt für die im `expect`-Text genannte Geradeausfahrt bei rund 50 km/h, `≥ 60 °C` sagt, wann ein Monitor gelaufen sein kann — beides aus öffentlichen Semantiken begründet, kein Kalibrierwert (AGENTS 24). (6) Suite: **1300 Tests / 90 Dateien in ~25 s** grün, Coverage global 96,48 Statements / 89,67 Zweige / 97,52 Funktionen / 97,86 Zeilen, `packages/definitions` 97,91/94,15/100/99,08, `validate.ts` 94,22/92,06, `json.ts` 98,61/94,37, `knowledge.ts` unverändert 100 Zeilen / 96,98 Zweige; per-file-Gate `definitions` 85/80 gehalten. `validate.ts` 525 → 574, `json.ts` 536 → 545, `simulator-knowledge.ts` 326 → 506 Zeilen; kein eingebautes Paket warnt neu (`genericPackage` zitiert `standard` mit Ausgabe **und** Notes).
> - 1.11: **DTC-Wissen pro Fahrzeugvariante: Schema v3, Auflösung nach Spezifität, Ehrlichkeit als Datenmodell (ADR 0024).** (1) `vehicles[].dtcKnowledge[]` ist neu: `code` plus optional `ecu`/`engine`/`gearbox` als Scope, varianteneigene Texte (`description`, `severity`, `hint`, `conditions` = wann der Code setzt), `patterns[]` (`id`, `name`, `explanation`, `likelihood` ∈ common/possible/rare, `repair`, `checks[]`) und darin die Messbeziehungen (`signal`, `expect`, `min`/`max`, `windowMs`) — die drei in §23 genannten, bisher fehlenden Kategorien „Known Failure Patterns", „Measurement Relationships", „Repair Information" sind damit Daten. `CURRENT_SCHEMA_VERSION` 2→3, `SUPPORTED_SCHEMA_VERSIONS` [1,2,3], `upgradePackage` verkettet 1→2→3 (v2→v3 hebt nur die Version, denn Wissen **darf** fehlen und eine Migration erfindet nichts); eingebaute Pakete deklarieren die Konstante statt einer Zahl, damit ein Bump nicht an drei Stellen nachgezogen werden muss. (2) Validator und JSON-Parser prüfen strukturell und semantisch: Code-Format nach SAE J2012, unbekannte ECU-/Motor-/Getriebe-/Signalreferenzen, doppelte Scopes (`code|ecu|engine|gearbox`), doppelte Pattern-IDs **je Fahrzeug** (eine Pattern-ID ist damit global adressierbar — Schritt 16 braucht das als Schlüssel), `min > max`, nicht-ganzzahliges `windowMs`, leere Texte, Werte außerhalb der Union, Provenance je Eintrag; ein Reparaturhinweis ohne Provenance wird zur Warnung mit Regelverweis (§24), weil an dieser Kategorie Rechte hängen können. (3) `findDtcKnowledge(packages, query)` lebt in `packages/definitions` (damit das per-file-Gate 85/80 greift) und gewichtet: Motor bestätigt 16 · Getriebe bestätigt 8 · ECU 4 · Motor angenommen 2 · Getriebe angenommen 1 — ein Eintrag für einen anderen Motor ist **kein schwacher Treffer, sondern keiner**; Patterns werden über alle zutreffenden Einträge gesammelt (spezifischster zuerst, IDs eindeutig), denn eine motorspezifische und eine variantenweite Ursache ergänzen sich, und Texte kommen aus dem spezifischsten Eintrag, sonst aus der Definition des **lesenden** Steuergeräts, sonst aus der ersten im Paket. `dtcKnowledgeQuery(candidate, code, ecu)` bildet einen `VehicleCandidate` direkt ab, damit kein Aufrufer die Einengung selbst auspackt und dabei versehentlich verengt. (4) Eine bewusste Ausnahme von der Strenge: hat die Auflösung nichts zum Antriebsstrang eingeengt und deklariert die Variante **genau einen** Motor (bzw. Getriebe), gilt der darauf gescopete Eintrag — unter allem Bestätigten rangierend und mit Note, dass die Belege den Antriebsstrang nicht eingeengt haben und dieser Motor der einzige deklarierte ist; sind mehrere deklariert, wird abgelehnt, weil die Wahl ohne Beleg ein Münzwurf wäre. Praktisch: Nur-VIN zeigt das Wissen des einzigen dokumentierten Motors, nach dem Lesen der Identifikations-DIDs verschwindet die Annahme samt Note. (5) **Schichtung statt Ersetzen:** `DtcScanner` behält `EcuDefinition.dtcs[]` als Basis und legt Variantenwissen darüber (`setVehicle(context)`, Cache je Kontext+Code und bei Neubindung verworfen, `enrich(records, ecuName, ecuId, definition?)` überschreibt description/severity/hint und **merged** `relatedSignals` — Paket plus Variante, eindeutig, nur im Paket definierte IDs); `DtcVariantKnowledge` ist die bewusst flachere Record-Form (scope, vehicleId, conditions, patterns, `provenanceType`/`-Source`, notes), weil jeder gespeicherte DTC klein und selbstständig bleiben soll. `DiagnosticEngine.setVehicleContext` reicht die Bindung durch, `VehicleService.connect()` bindet **sofort** (VIN und Identifikation sind dann gelesen — der erste Scan trägt das Wissen ohne Zusatzschritt), `resolve(hints)` bindet mit den Angaben des Bedieners neu, `engine.disconnect()` löst, damit Wissen die Sitzung nicht überlebt. Ohne gebundenes Fahrzeug entsteht **kein** `knowledge`: die paketweite Beschreibung steht bereits am Record, und sie als Variantenwissen auszugeben wäre genau die Verwechslung, gegen die die Fahrzeugachse existiert. (6) Ehrlichkeit als Datenmodell: `scope` ∈ vehicle-engine/vehicle-gearbox/vehicle/package, `notes[]` (kein Variantenwissen dokumentiert · nur Text ohne Muster · kein Zahlenfenster, ein Mensch muss beurteilen · Antriebsstrang angenommen · Fahrzeug im Paket nicht deklariert), `checks[].measurable`, und `knowledgeProvenance` nennt die Quelle **der angezeigten Aussage** (Entry → sonst Fahrzeug, aber nur wenn ein Entry gewann → sonst Paket). Keine erfundenen Messpunkte: `genericPackage` definiert keine Lambda-Sonden (PID 0x14–0x1B), also prüft das Katalysator-Muster über Kraftstoffkorrektur und Kühlmitteltemperatur und sagt im Text, was das belegt und was nicht — eine erfundene Signal-ID hätte einen Prüfschritt erzeugt, der nie laufen kann. (7) Naht bis in die UI: `DtcInfo.knowledge` in `domain` (eigene Feldnamen `signalId`/`name` wie jede andere Messung), `toDtcKnowledge` in `runtime/mappers.ts`, `DtcView.knowledge` über `apps/web/src/dtc-knowledge-view.ts` (200 Zeilen; Scope- und Likelihood-Labels sind gegen die Union-Typen der Definitionsschicht typisiert, ein neuer Scope bricht also den Build statt als Key beim Bediener anzukommen, unbekannte Werte bleiben als sie selbst sichtbar, `checkWindow()` bildet `min`/`max`/`windowMs` auf „−5 … 5 · 2 s messen" ab), und `public/app.js` enthält damit kein Vokabular mehr: Muster als Karten, Messpunkte als Tabelle (Messpunkt · Erwartung · Fenster · Bewertung), Reparaturhinweise als solche gelabelt, Notes als Warnungen, in der Liste ein Pill nur bei Variantenwissen. (8) Echte Daten für das einzige überall verfügbare Fahrzeug: `simulator-knowledge.ts` (326 Zeilen, Provenance `own`, Begründung je Fenster im Dateikopf) zu P0420 (Motor-Scope, 2 Muster, 5 auswertbare Fenster, Enable-Bedingung „closed loop, > 80 °C, drei Fahrzyklen"), P0300 (variantenweit, 3 Muster inkl. 5-s-Fenster für Leerlauf-Unruhe), P0171 (Motor, 2 Muster) und P0715 (Getriebe-Scope, 2 Muster inkl. 30-s-Fenster, weil ein intermittierender Kabelbaumfehler im Snapshot gesund aussieht); das Simulator-Paket validiert damit **ohne** Wissens-Warnung. (9) Suite: **1290 Tests / 90 Dateien in ~25 s grün** (global 96,4 Statements / 89,6 Zweige / 97,5 Funktionen / 97,8 Zeilen; `packages/definitions` 97,8/94,1/100/99,0; `knowledge.ts` 100 Zeilen / 96,9 Zweige; `scanner.ts` 100/87,8), Biome und beide Typecheck-Projekte grün; `backend.ts` wuchs um 10 Zeilen (ein Feld plus Mapper-Aufruf, das View-Mapping liegt in `dtc-knowledge-view.ts`), `services.ts` um 9, `app.js` um 103 (nur Rendern) und `styles.css` um 55 — E15 ist damit am 2026-09-13 nachgemessen (1336 / 726 / 724); Ende-zu-Ende belegt durch `tests/integration/vehicle-resolution.test.ts` (Scan nach Connect: `scope: "vehicle-engine"`, zwei Muster, `notes: []`, Getriebe-Code über die Getriebe-Achse, C0035 als „nur paketweit") und `apps/web/test/server.spec.ts` über HTTP inkl. der deutschen Labels.
> - 1.10: **Fahrzeugschicht: Schema v2, Resolver mit Belegen, Attributionsregel (ADR 0023).** (1) `packages/definitions` trägt jetzt `vehicles[]` — Marke, Modell, Plattform, Generation, Karosserieformen, Modelljahre, `vinMatch` (WMI, VDS-Muster, Modelljahr- und Werkzeichen), Motoren und Getriebe mit `codes`, je Fahrzeug ECUs mit Teilenummern/Softwareständen/`optional` — samt Migration v1→v2, semantischer Prüfung (unbekannte ECU-/Motor-/Getriebereferenzen, doppelte IDs, die in VINs verbotenen Zeichen I/O/Q) und WMI-Referenz nach ISO 3780 mit eigener Provenance. (2) `VehicleResolver` bestimmt das Fahrzeug aus VIN, Identifikationswerten und beantworteten Adressen: 16 gewichtete Kriterien (Teilenummer 4 · WMI/Motor-Getriebekennung/ECU-Abdeckung 3 · VDS/Softwarestand/Modellangabe/unerwartetes Steuergerät 2 · Rest 1), `score` = Anteil bestätigter Gewichte, `ecu-coverage` anteilig, Kandidaten nur mit `score > 0`, jeder mit `evidence[]` **und** `conflicts[]` (`observed`/`expected`/`weight`/`reason`); Provenance-Trust bricht nur Gleichstände (ADR 0003). (3) **Attributionsregel** (neu §11.1): widersprechen kann nur ein Wert, dessen DID als Teilenummer, Software- oder Hardwarestand dokumentiert ist (`identificationKindForLabel`); Seriennummern und unbekannte DIDs stützen bei Treffer und sind sonst neutral — ohne die Regel bestrafte der Resolver das richtige Auto für Werte, die es nicht kennt. Identifikationsfakten tragen zusätzlich `oem`, weil die Engine `"<oem>:<id>"` speichert und zwei Pakete dasselbe ECU-Id tragen dürfen. (4) Naht durch alle Schichten: Port `DefinitionProvider.resolveVehicle` (inkl. Null/Static und `unresolvedVehicleResolution(reason)`), Query `vehicle.resolve` mit `ResolveVehicleHints`, `VehicleService.resolve` mit Faktensammlung in `runtime/src/vehicle-resolution.ts` (`services.ts` 780 → 717 Zeilen), `POST /api/vehicle/resolve`, SSE-Ereignis `vehicle`, Panel „Fahrzeugbestimmung" mit `apps/web/src/vehicle-view.ts` (235 Zeilen, gegen die Union-Typen der Definitionsschicht typisiert — ein neues Kriterium ohne Übersetzung bricht den Build). (5) **Zwei echte Fehler, beide als Regressionstests mit Symptom katalogisiert:** ASCII-Signale des Simulators antworteten ausnahmslos mit der VIN (Teilenummer unter 0xF187 = `1HGCM82633A00435`) — jetzt trägt nur DID 0xF190 die VIN, jedes andere ASCII-Signal antwortet `<ECU-ID>-<DID>`; und „Wert passt zu keinem deklarierten Token" galt als Widerspruch. Neu: `simulatorPackage` (genericPackage plus `virtual-vehicle`, Provenance `own`), das `genericPackage` **nur** in Simulator-/Replay-Betrieb ersetzt — gegen echte Hardware bleibt die OEM-neutrale Baseline aktiv —, mit Kopplungstest in `tools/simulators`, der die Antworten aus den Definitionen nachrechnet (er fand die Hex-Groß-/Kleinschreibung der DID-Werte). (6) Leitplanke neu: per-file-Gate `packages/definitions/**/src/**` 85/80; dass es beißt, ist belegt (`lines: 99` → `EXIT=1` mit `migrate.ts (87.5%)` und `validate.ts (96.07%)` im Fehlertext). Suite: **1223 Tests in ~25 s grün** (88 Dateien; global 96,3 Statements / 89,1 Zweige / 97,5 Funktionen / 97,7 Zeilen; `packages/definitions` 98,7 Zeilen / 92,9 Zweige), Biome und beide Typecheck-Projekte grün. Die Demo bestimmt das simulierte Fahrzeug mit `score 1,00` aus 11 Belegen und 0 Widersprüchen; derselbe Bus mit fremder VIN ergibt `score 0,39` mit vier benannten VIN-Widersprüchen.
> - 1.9: **Ausgabepfad und Analyse — ein echter Fehler, ein Vertrag statt 45 Kopien, Gates dafür.** (1) `reports/pdf.ts` schrieb UTF-8-Bytes in ein Dokument, dessen Schriften `/WinAnsiEncoding` deklarieren. Gemessen am 2026-09-12 an `Kühlmittel 90 °C`: `ü` als `c3 bc`, `°` als `c2 b0`, der Binärkommentar als acht statt vier Bytes — jeder exportierte Bericht mit Umlaut oder Gradzeichen war Mojibake, auf dem realen Pfad `apps/web/src/server.ts → renderPdf`. Strukturell war die Datei gültig, weil `/Length` und xref dieselben falschen Bytes zählten; nur ein Byte-Test findet das (ADR 0021). Neu: ein Latin-1-Encoder für Text, `/Length` und Offsets, drei Byte-/Struktur-Tests, der tote `case 0x00b0` entfernt; `pdf.ts` 93,9/71,4 → **100/88,9**. (2) Analyse-Pfad nachgetestet: der eingebaute `defaultHttpClient` war nie gelaufen (`ai/http.ts` **63,6 % Funktionen**), ebenso Timeout-Wache, `safeHost`-Fallback und der Fehlerpfad des Dienstes. `JSON.parse` wurde blind auf `Partial<AnalysisResult>` gecastet, und `clamp` machte aus `"confidence": "high"` ein `NaN`, aus dem `JSON.stringify` ein `null` schrieb — die Anzeige zeigte gar keine Konfidenz. Jetzt prüft `normalise` Feld für Feld und `clamp` nimmt `unknown`; `ai.spec.ts` 13 → **21 Tests**, `http.ts` → **100/87,7**, `service.ts` → **100/100**. (3) `error instanceof Error ? …message : String(…)` stand **45 mal in 25 Dateien** (sieben private `messageOf` plus 38 inline), keine Variante getestet — `shared/errors.ts` hatte keine Spec. Ein Vertrag `messageOf`/`asError` in `@vdp/shared/errors.ts` ersetzt 40 Stellen, Objekte werden mit Inhalt benannt statt `[object Object]`, `errors.spec.ts` neu mit 10 Tests; `charts/group.ts` bleibt bewusst lokal (Allowlist `"@vdp/charts": []`). (4) **Manifest-Metadaten**: alle 25 Workspace-Pakete deklarierten weder `license` noch `engines` noch `repository` — nur das Wurzel-Manifest tat es, obwohl Lizenz-Scanner, Renovate und `npm outdated` diese Felder pro Paket lesen. Jetzt MIT / `node >=22` / `repository.directory` je Paket, geprüft durch sechs neue Architektur-Tests (Einstiegspunkte müssen auf existierende Quellen zeigen); die Paket-Discovery liegt einmal in `tests/architecture/workspace.ts`. (5) **Fundament nachgetestet**: `shared/logger.ts` 91,8/76,6 → **100/100** (ConsoleSink-Level-Routing auf `console.error`/`warn`/`log`, MemorySink-Limit, `byScope`, `clear`, `safeStringify` für Bytes und BigInt, `addSink`-Idempotenz, Collect-Limit bei 10 000, Default-Level INFO) und `bytes.ts` 96,9/78,6 → **100/100** (`bytesEqual` mit ungleichen Längen und mit einem abweichenden Byte, Leser über das Pufferende mit definiertem Null-Padding) — `packages/shared` ist damit in allen fünf Dateien vollständig gedeckt. (6) Gates: `reports` und `ai` hatten **keines**, `storage` stand auf 90/55, obwohl E13 die Dateien weit darüber gehoben hatte — die beabsichtigte Anhebung war nie committet (`db5d525` enthält nur `migrations.ts` und die Spec). Neu `reports` 95/75, `ai` 90/75, `storage` 95/80 (ADR 0022); dass sie beißen, ist gemessen (absichtlich unmögliche 99 % → `EXIT=1` mit `pdf.ts` 88,88 % im Fehlertext). E12 und E13 sind aus 0.E entfernt. Suite: **1066 Tests in ~23 s grün** (78 Dateien; global 95,9 Statements / 87,8 Zweige / 97,3 Funktionen / 97,4 Zeilen), Biome und Typecheck grün.
> - 1.8: **Zeitbudget, Coverage und Doku-Wahrheit — alles gemessen.** (1) `windowMs` begrenzte die ECU-Discovery nicht: die Probepause war mit 15 ms hart verdrahtet, `connect({ windowMs: 30 })` dauerte 200 ms, ein Connect ohne Optionen ~1,37 s — in jedem Test und bei jedem Workbench-Start gegen den Simulator. Neu: `probeDelayMs` als Discovery-Option bis hinauf ins Kommando `connectVehicle`, `DEFAULT_PROBE_DELAY_MS`/`DEFAULT_DISCOVERY_WINDOW_MS` als benannte Konstanten, injizierbarer `sleep` in der DoIP-Discovery, kurze Fenster im Simulator-Modus des Backends, feste Sleeps in den Workbench-Tests ersetzt durch Bedingungs-Waits (ADR 0019). **Messung: Gesamtlauf 71,69 s → 23,83 s** (Replay 11,74 → 1,41 s, Integration 36,67 → 7,71 s, Regression 3,97 → 1,57 s). (2) E4 erledigt: DoIP nachgetestet (`transport.ts` 78,6/68,3 → **98,5/88,7**, `discovery.ts` 91,3/52,9 → **100/78,9**) und `charts/group.ts` 77,0/77,6 → **99,1/91,3**; Gates angehoben auf global 90/80, transport 85/70, charts 90/75 (ADR 0020). (3) Zwei echte Fehler, die das Nachtesten freigelegt hat: ein fehlgeschlagener Routing-Aktivierung ließ den DoIP-Transport in `connecting` mit offenem Socket und abonniertem Listener zurück (jetzt: Freigabe + `error` + `lastError`), und `ChartGroup.notify()` schluckte Subscriber-Fehler in einem leeren `catch {}` (jetzt: `onListenerError`). Damit sind **alle drei** verbliebenen leeren `catch {}` beseitigt (Regel 34.25) — auch `canable.close()` und der Serial-Error-Listener loggen strukturiert. (4) Nach Regel 34.24 korrigiert: README und 0.A behaupteten Quality-Job, CodeQL, Dependency-Review und nächtlichen vcan-Job — im Repo liegt nur `ci.yml` mit `build` + `npm test`, und das README zeigte ein CodeQL-Badge auf einen nicht existierenden Workflow. Die vier gehärteten Workflows sind fertig, aber weiterhin nicht pushbar (gemessen 2026-09-12: `refusing to allow a GitHub App to create or update workflow ... without 'workflows' permission`); E10 nennt jetzt den Freischaltweg. Suite: **991 Tests grün**, Coverage-Gates grün, Biome/Typecheck grün. Neu in 0.E: E11 (ecu-session am Gate), E12 (host/catalog), E13 (storage-Branches), E14 (`isolate: false`), E15 (`backend.ts`-Größe).
> - 1.7: **Nacharbeit zur Engine-Zerlegung — alle offenen Punkte geschlossen.** (1) Der Escape-Hatch `runtime.engine` ist aus der öffentlichen Runtime-Fläche entfernt; kein Code außerhalb von `@vdp/runtime` erreicht die Engine mehr (Restarbeit: Auflösung der Engine-Klasse in Kollaborateure, ADR 0014 Phase 4 — dort jetzt 🟡 geführt, Phase 5 auf ✅). (2) Live-Fehler sind wieder sichtbar: `LiveDataEngine.onError` meldet Loop-Crashes, der Measurement-Service publiziert `diagnostic-error`, das Backend leitet sie als SSE-`error` weiter (Regel 34.25; Unit-Test mit injizierter Uhr). (3) Sample-Streams dürfen vor dem Start abonnieren (Service puffert Listener bis zur nächsten Live-Engine) — der Stream-Integrationstest ist dadurch deterministisch. (4) Abgelehnte Fehlerspeicher-Löschungen tragen ihre Gründe bis in die HTTP-Antwort (`cleared:false` + `reasons`) und sind als Entscheidung in **ADR 0018** festgeschrieben (neuer Server-Test; Precheck und Write werten dieselbe Kette aus). (5) `apps/web` ist `@vdp/core`-frei: `SessionLogger`/Rohspur/Session-Daten laufen über die Storage-Naht, `AppState.statistics` bekam eine eigene View-Form. Suite: 971 Tests grün, Coverage-Gates grün, Biome/Typecheck grün. Verbleibend in 0.E: E4 (DoIP-Coverage), E9 (CI-Retries), E10 (Workflow-Dateien pushbar machen).
> - 1.6: **Engine-Zerlegung (Migrations-Roadmap Schritte 8/9, Backlog E8)** — die `DiagnosticEngine` ist hinter dem Runtime-Vokabular verschwunden: neue Commands `ecu.identify`, `dtc.freeze-frame`, `marker.add` und neue Queries `dtc.clear-precheck`, `signal.list`, `marker.list`, `measurement.statistics`, `measurement.anomalies`, `recording.get`, `measurement.status`; `DemoBackend` dispatcht ausschließlich Commands/Queries und hält nur noch Transport, Rohspur und Präsentation. Die Architektur-Allowlist erlaubt `apps/web` jetzt `@vdp/runtime`/`@vdp/application`/`@vdp/domain`. Messbar behoben (Regel 34.21): der Live-Start rief `LiveDataEngine.run()` doppelt auf (SSE-Fehler bei jedem Start) und recordete jedes Sample doppelt (vorher 322 Samples/276 eindeutig, nachher 0 Duplikate); `dispose()` schließt den Bus auch nach einem fehlgeschlagenen Connect. Bewusste Angleichung: eine abgelehnte Fehlerspeicher-Löschung ist jetzt Ergebnis (`ok:false` + Gründe) statt HTTP-Fehler (AGENTS 26). +11 Tests, Suite: 969 Tests grün, Coverage-Gates grün, Biome/Typecheck grün. Verbleibend in 0.E: E4 (DoIP-Coverage), E9 (CI-Retries).
> - 1.5: Backlog 0.E abgearbeitet (nur Verbesserungen, keine Features) und gemessen: CI-Härtung nach ADR 0016 real (`ci.yml` mit Quality-Job lint·build·typecheck·audit vor der Test-Matrix, Coverage-Upload auf Node 22, Timeouts; neu `codeql.yml`, `dependency-review.yml`, nächtlicher `hardware.yml`-vcan-Job). `npm test`/`test:coverage` bauen jetzt selbst vor (E2 behoben, Regel 34.26 angepasst). Neues Typecheck-Projekt `tsconfig.frontend.json` prüft `apps/web/public/*.js` mit `checkJs` + DOM-Lib; dafür 34 Typosoden im Frontend beseitigt (u. a. nullbarer Canvas-Kontext, `unknown`-Fehler, nie typisierte Arrays). `@vdp/charts`: `ensureSeries`/`Series.fillMissingMetadata` ergänzen verspätete Metadaten, statt sie zu verwerfen (+Regressionstest); das readonly-Mutations-Workaround im Frontend entfällt. Storage: 6 neue Tests für Crash-Toleranz, Migrations-Persistenz und Listen-Resilienz heben `repository.ts` von 70/46 auf 97/84 — storage-Gate auf 90/55 angehoben (ADR 0017). Leeres `catch {}` in der Engine durch Debug-Log ersetzt (Regel 34.25). Duplikat-Scripts `sim`/`web` entfernt. Suite: 958 Tests grün, Coverage-Gates grün, Biome/Typecheck grün. Verbleibend in 0.E: E4 (DoIP-Coverage), E8 (Engine-Zerlegung), E9 (CI-Retries).
> - 1.4: Repo-Audit vom 2026-09-11 (Messung vor Behauptung, Regel 34.21): neuer Abschnitt **0.E „Offene Verbesserungen“** — priorisierter Backlog ausschließlich für Verbesserungen am Bestehenden, ohne neue Funktionen. Zusätzlich nach Regel 34.24 korrigiert: 0.A/0.B zeigen den *Ist*-Zustand von CI und Coverage-Gates statt des ADR-0016-Solls (Quality-Gates, CodeQL, Dependency-Review und Coverage-Upload fehlen noch im Repo); dokumentiert, dass `npm test` einen vorherigen `npm run build` voraussetzt (Backlog E2). Neue Regeln 34.25 (kein stilles Fehler-Schlucken) und 34.26 (Build vor Test).
> - 1.3: Industriestandard-Härtung (ADR 0016): Biome Lint/Format, realistische Coverage-Gates (80/75 global, per-file für core/protocols), CI-Matrix mit Quality-Gates (lint·typecheck·audit) + Coverage-Upload, CodeQL + Dependency-Review, hardware-Platzhalter `tests/hardware/vcan.test.ts`, LICENSE/CONTRIBUTING/CODEOWNERS, `.nvmrc`/`.npmrc` (AGENTS 35 erweitert).
> - 1.2: Von der Bau-Spezifikation zum Fortführungs-Leitfaden: Umsetzungsstand, Betrieb und Workflow für Coding Agents (Teil 0), Dependency-Policy (ADR 0010), Security-Baseline (ADR 0009), neue Regeln 34.19–34.24, erweiterte Definition of Done (35). Die Abschnittsnummern 0–36 bleiben unverändert — alle `AGENTS x.y`-Verweise im Code bleiben gültig.
> - 1.1: Norm-Referenzen ergänzt (ISO 14229-2, ISO 15765-2, ISO 13400-1/2/3, ISO 3779), UDS-Timing-Parameter, DoIP-Discovery-Flow, Glossar, DoIP-Netzwerksicherheit.
> - 1.0: Erste Fassung.
>
> **Geltungsordnung:** Diese Datei ist normativ für das *Produkt*. ADRs in `docs/adr/` sind normativ für *Architektur- und Toolchain-Entscheidungen*. Bei Widerspruch zwischen Dokumentation und Repository gilt das Repository — und die Differenz wird im selben PR dokumentiert (Regel 34.24).

---

# Teil 0 — Für Coding Agents: zuerst lesen

Dieser Teil steht bewusst vor der Spezifikation. Er sagt dir, *was schon existiert*, *wie du arbeitest* und *wo die harten Grenzen sind*. Die Abschnitte 0–36 dahinter bleiben die normative Produktspezifikation.

## 0.A Umsetzungsstand (verifiziert gegen `arena/01a09708` 2026-09-12, Basis `9f0e70a`)

| Bereich | Stand | Bemerkung |
|---|---|---|
| Schichtenarchitektur | ✅ umgesetzt | ADR 0001; `tsc -b` erzwingt die Abhängigkeitsrichtung |
| CAN-Layer + Adapter (ELM327, CANable/slcan, SocketCAN, generisch) | ✅ inkl. Node-Host-Bindings | Serial-Byte-Stream über tty (`stty`), SocketCAN-Bindings-Loader und side-effect-freier Probe-Katalog in `@vdp/adapters/host`; etablierte serialport-Library / Web Serial API (ADR 0010, Schritt 7) folgen |
| ISO-TP (ISO 15765-2) | ✅ inkl. Block-Size-Enforcement, Escape-Sequenz > 4095, N_Bs/N_Cr | Regressionskatalog belegt gefundene Fehler und Fixes |
| UDS (ISO 14229-1) Client + In-Prozess-Server | ✅ | inkl. NRC-0x78-Pending-Loop, Session-Timing, DTC-Codec |
| KWP2000 (ISO 14230) | ✅ Basis-Client | für Alt-ECUs |
| DoIP (ISO 13400) | 🚧 Codecs, Routing activation, UDP-Discovery, TLS vorhanden; Transport-Seam in der Engine (Roadmap 8a) | noch nicht in der Workbench verdrahtet; der MVP braucht es nicht (Abschnitt 29). Nachgetestet 2026-09-12 (ADR 0020): `transport.ts` 98,5/88,7, `discovery.ts` 100/78,9; ein fehlgeschlagener Routing-Aktivierung gibt den Socket jetzt frei, statt `connecting` zu bleiben |
| OEM-Hooks + Registry | ✅ | füllen nur Lücken — dokumentierte Daten gewinnen immer (ADR 0003) |
| Definition Packages | ✅ Schema v3 mit Fahrzeugen (Plattform, Motor, Getriebe, VIN-Matching) **und DTC-Wissen pro Variante** (`dtcKnowledge[]` mit Ausfallmustern, Messfenstern, Reparaturhinweisen), Validator, Pflicht-Provenance je Quelle mit Gates nach Quellentyp (ADR 0025), Migration v1→v2→v3, WMI-Referenz nach ISO 3780 | VAG-/Mercedes-Pakete sind `example-placeholder` mit erfundenen Werten, keine Fahrzeugwahrheit; `simulatorPackage` beschreibt das virtuelle Fahrzeug und ersetzt `genericPackage` nur in Simulator-/Replay-Betrieb (ADR 0023); sein Variantenwissen ist `own` und aus öffentlichen SAE-J1979-Semantiken begründet; ECU- und Signal-Satz sind die von `genericPackage`, also referenziert es nur deklarierte Messpunkte und erfindet keine Lambda-Sonden (ADR 0024) |
| Fahrzeugauflösung (AGENTS 11) | ✅ Resolver mit Belegen: Query `vehicle.resolve` → `DefinitionProvider.resolveVehicle` → Kandidaten mit `evidence`/`conflicts`, Score = Anteil bestätigter Gewichte | Attributionsregel: widersprechen kann nur ein Wert, dessen DID als Teilenummer/Software-/Hardwarestand dokumentiert ist (ADR 0023); durchgehend read-only, `unresolved` kommt immer mit Grund; Panel „Fahrzeugbestimmung" in der Workbench |
| Core (VIN, ECU-Discovery, DTC, Live-Engine, Recorder, Safety) | ✅ | DTC-System komplett: Freeze Frames, First/Last-Seen, Safety-gated Clear über den Write-Port (AGENTS 20/25/26, ADR 0029); Discovery ignoriert eigene tx-Echos (Regressionskatalog); Identifikationswerte tragen die DID, aus der sie gelesen wurden (§11/§12) |
| Graphen (AGENTS 16) | ✅ | DOM-freier Chart-Kern `@vdp/charts` (Viewport, Cursor, Decimierung, Statistik; 41 Unit-Tests, ADR 0011) + synchronisierte Zeitachsen in der Workbench; Rendering in `public/*.js` (s. Web-Workbench) |
| Storage (JSON + NDJSON, Migrationen, ZIP-Export) | ✅ | ADR 0007; Session-IDs werden vor Dateizugriff validiert |
| Reports (HTML/PDF) | ✅ | eigener PDF-Writer (ADR 0002); Ersatz durch pdf-lib in ADR 0010 vorgesehen |
| KI-Schicht | 🚧 Provider-Abstraktion, lokaler Heuristik-Provider, HTTP-Gateway mit VIN-Redaktion | bewusst keine „große KI“ im MVP (Abschnitt 29) |
| Web-Workbench (`apps/web`) | ✅ Node HTTP + SSE, Vanilla ESM, 9 Views + Panel „Fahrzeugbestimmung" | `public/*.js` via Biome formatiert, `/lib` liefert `@vdp/charts`; Security-Header + Body-Limit (ADR 0009) |
| Simulator + Replay | ✅ | VirtualVehicle, VirtualCanNetwork, ReplayTransport mit strikter Abweichungsmelding |
| Tests | ✅ 1348 Tests auf 6 Ebenen (unit / protocol / regression / replay / integration / architecture) + 1 hardware smoke | Vitest 5 mit Projektkonfiguration (ADR 0010, Schritt 1); Unit-Specs co-lokatiert (`src/*.spec.ts`), Property-Tests (fast-check), Coverage-Gates global 90/80/90/90 als Durchschnitt (Ist 96,85 Statements / 89,83 Zweige / 97,73 Funktionen / 98,20 Zeilen), per-file laut `vitest.config.ts` für shared/core/protocols/adapters/transport/storage/charts/reports/ai/definitions (ADR 0017, angehoben durch ADR 0020 und 0022, `definitions` 85/80 neu durch ADR 0023); Struktur ist mitgetestet — Abhängigkeitsgraph, Hygiene-Regeln und die Manifest-Metadaten aller 25 Pakete (license/engines/repository.directory, `tests/architecture/manifests.test.ts`) — grün; Gesamtlauf 23,9 s (gemessen 2026-09-14; `npm run ci` 26,5 s), weil Discovery in Tests ein explizites Zeitbudget fährt und auf Bedingungen statt auf feste Sleeps gewartet wird (ADR 0019); `hardware` (`tests/hardware/vcan.test.ts`) läuft manual (`npm run test:hardware`), der nächtliche Job ist Teil von E10. Zähl-Falle beim Vergleichen von Zahlen: ein bloßes `npx vitest run` ohne `--project` nimmt `hardware` mit und meldet 94 Dateien / 1349 Tests statt 93 / 1348 — ohne `vcan0` besteht der Test per Selbst-Skip immer. |
| CI/CD | 🚧 GitHub Actions: `ci.yml` mit `npm ci` → `build` → `npm test` auf Node 22 + 24 (`checkout@v4`/`setup-node@v4`, Concurrency, `contents: read`) + Dependabot (gruppiert) | **Ist-Zustand nach Regel 34.24:** Quality-Job (`biome check`·`typecheck`·`npm audit`), Coverage-Upload, `codeql.yml`, `dependency-review.yml` und `hardware.yml` sind nach ADR 0016 §3 fertig entwickelt, liegen aber nur in der Arbeitskopie — GitHub lehnt den Push von Workflow-Dateien ohne `workflows`-Berechtigung der App ab (gemessen 2026-09-12). Verbindliches Tor ist deshalb `npm run ci` (seit 2026-09-14 inklusive `npm run check:deps`, ADR 0028); Freischaltung und Folge-PR siehe 0.E E10. **Seit 2026-09-14 (ADR 0026) führt der `architecture`-Projektlauf `biome check .` und beide `--noEmit`-Pässe selbst aus** — die CI erzwingt die Quality-Gates damit ohne Workflow-Recht; die Gleichwertigkeit hängt an `tests/architecture/guardrails.test.ts` (0.E E17) |
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
npm test              # komplette Suite auf 6 Ebenen (unit / protocol / regression / replay / integration / architecture)
                      # das Projekt `architecture` führt dabei biome check + beide --noEmit-Pässe
                      # selbst aus (ADR 0026) — deshalb sind die Gates auch in der CI scharf
npm run test:unit     # nur Unit-Specs — die schnelle Feedback-Schleife
npm run test:coverage # Suite + V8-Coverage — global 90/80/90/90 als Projekt-Durchschnitt,
                      # per-file-Gates für core/protocols/adapters/transport/storage/
                      # charts/reports/ai (maßgeblich ist vitest.config.ts,
                      # ADR 0017/0020/0022) — grün
npm run demo          # Workbench mit Simulator auf http://localhost:8080
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

## 0.E Offene Verbesserungen — Backlog (Stand 2026-09-12)

Dieser Backlog ist bewusst **auf Bestehendes beschränkt: keine neuen
Funktionen**, jede Maßnahme verbessert Vorhandenes. Prioritäten: **P1** =
Qualität/CI-kritisch, **P2** = Korrektheit/Konsistenz, **P3** =
Hygiene/Refactoring. Jeder Eintrag nennt den Befund mit Messung (Regel
34.21) und die konkrete Verbesserung. Ein abgearbeiteter Eintrag wird durch
den PR entfernt, der ihn behebt — zusammen mit dem Nachziehen von
0.A/README/CONTRIBUTING (Regel 34.24).

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

**Am 2026-09-14 abgearbeitet (v1.13):** der Guardrail-Schritt (ADR 0026) —
fünf Regeln `warn`/`off` → `error` ohne Produktionsänderung, drei weitere Regeln
`error` mit fünf behobenen Fundstellen, jede verbleibende `off`-Entscheidung mit
Umfang und Messung im Rekord, und die Quality-Gates laufen jetzt im
`architecture`-Testlauf, weil `ci.yml` sie sonst nie ausführt (E17 bleibt als
Restkopplung dokumentiert). Der 57-Punkte-Backlog des Auftraggebers liegt als
`docs/architecture/master-backlog.md` gegen den gemessenen Stand abgeglichen vor;
die zwei dort korrigierten Vorschläge (kein ESLint, kein Turborepo/Nx auf Vorrat)
sind als Entscheidung in ADR 0026 §1/§5 festgeschrieben und vom Test erzwungen.

Offen bleiben:

| Nr. | P | Befund (gemessen am 2026-09-12) | Verbesserung (Bestehendes verbessern, kein Feature) |
|---|---|---|---|
| E10 | P1 | Die vier gehärteten CI-Workflow-Dateien (`ci.yml` mit Quality-Job + Coverage-Upload, `codeql.yml`, `dependency-review.yml`, `hardware.yml`) sind fertig entwickelt, aber nicht pushbar. Gemessen 2026-09-12 mit `git push origin <branch>`: `remote rejected … refusing to allow a GitHub App to create or update workflow .github/workflows/ci.yml without 'workflows' permission`. Im Repo liegt deshalb nur `ci.yml` mit `npm ci` → `build` → `npm test`; `gh api repos/CAZE7/yes-you-CAN/actions/workflows` liefert genau zwei Einträge (CI, Dependabot). README und 0.A behaupteten den gehärteten Stand — nach Regel 34.24 auf den Ist-Zustand korrigiert, das CodeQL-Badge ist entfernt. | Freischaltung: GitHub → Settings → Applications → Arena (GitHub App) → Repository Permissions → **Workflows: Read & write**, anschließend die vier Dateien in einem eigenen PR pushen (sie liegen in der Arbeitskopie) und README-Badge + 0.A-Zeile zurück auf ✅ stellen. Bis dahin ist `npm run ci` das verbindliche Tor (AGENTS 35). |
| E9 | P3 | `vitest.config.ts` erlaubt in der CI weiterhin `retry: 2`. Der Messbeleg für die ursprüngliche Sorge ist seit v1.8 stärker: die Suite brauchte 71,69 s und vier Workbench-Tests warteten mit festen `setTimeout`-Werten (300–400 ms) auf Samples, die der 60-ms-Poll-Loop nach ~70 ms liefert — Rennen unter Last. Feste Sleeps sind jetzt durch Bedingungs-Waits ersetzt, Discovery fährt ein explizites Zeitbudget (ADR 0019), der Lauf dauert 23,83 s. Ein Flaky-Report aus der CI liegt weiterhin nicht vor, weil die Workflows nicht pushbar sind (E10). | `retry` schrittweise Richtung 0 senken, sobald ein CI-Lauf der gehärteten Workflows den Flaky-Reporter ausgeworfen hat (`tools/test-reporters/flaky-reporter.ts`). Ohne diesen Nachweis bleibt der Wert unangetastet (Regel 34.21); lokal ist `retry` bereits 0. |
| E11 | P2 | `packages/core/src/diagnostics/ecu-session.ts` liegt bei 85,6 % lines / 71,3 % branches (nachgemessen am 2026-09-12, vorher 65,3) und damit **0,6 Punkte** über seinem Gate (`core` 85/65, per file) — die knappste Datei im ganzen Baum. Keine Spec referenziert `EcuDiagnosticSession` direkt: die Deckung stammt ausschließlich aus Integrations-/Replay-Läufen, und es existiert kein UDS-Test-Double, das Fehlerfälle einspielen könnte. Jede größere Änderung kann die Datei rot machen, ohne dass ein echter Mangel vorliegt; unbeobachtet bleiben u. a. die Zweige um `probeSupportedServices`, NRC-Behandlung und Timing-Übernahme aus der Session-Antwort (ISO 14229-2). | Fehler-/NRC-Zweige und die Session-Timing-Übernahme gezielt nachtesten, danach das `core`-Gate anheben (ADR 0017/0020: erst Tests, dann Gate). Keine neue Logik. |
| E14 | P3 | **`isolate: false` halbiert die Suite-Laufzeit — gemessen, bewusst noch nicht übernommen.** Vier Läufe am 2026-09-12 (Node 22, jedes Mal 75 Dateien / 991 Tests grün): mit Isolation 26,77 s und 23,79 s, mit `--no-isolate` 13,18 s und 13,51 s — ≈45 % schneller; im Coverage-Modus 32,78 s → 16,35 s. Der Runner meldet denselben Befund selbst (75 Worker, ~104 ms Start je Datei, „at least ~7.72s faster with `isolate: false`“), die eigene Messung liegt deutlich darüber. Eine Abweichung ist dokumentiert: Branches gesamt 84,21 → **84,19** (0,02 Prozentpunkte), weil wiederverwendete Worker Modul-Initialisierung nur einmal zählen; alle Gates bleiben grün. | Die Entscheidung gehört in einen eigenen PR mit ADR, nicht stillschweigend in `vitest.config.ts`: `isolate: false` macht Modulzustand über Dateien hinweg sichtbar (Logger-Sinks, feste Uhren, Singletons). Vor der Übernahme dreimal grün in Folge plus gezielter Nachweis, dass kein Test auf frischem Modulzustand beruht; Determinismus schlägt Laufzeit (AGENTS 31). Bleibt der Nachweis aus, bleibt die Isolation — dann ist der Laufzeitgewinn verworfen, nicht aufgeschoben. |
| E16 | P2 | **Fünf Dateien liegen weniger als fünf Punkte über ihrem per-file-Gate** (gemessen am 2026-09-12 im Gesamtlauf, Puffer in Zeilen/Zweigen): `adapters/elm327/src/protocol.ts` 96,3/**76,0** (+11,3/+1,0 — Gate `adapters` 85/75), `transport/can/src/bus.ts` **87,5**/100 (+2,5), `adapters/elm327/src/stream.ts` **88,2**/100 (+3,2), `reports/src/report.ts` 100/**79,5** (+5,0/+4,5), `ai/src/heuristic.ts` **94,9**/**79,5** (+4,9/+4,5). Ein Gate, das nur durch Stillstand hält, ist keine Leitplanke (ADR 0020) — dieselbe Lage, die E11 für `ecu-session.ts` beschreibt. | Je Datei die unbeobachteten Zweige nachtesten und danach das Gate anheben (ADR 0017: erst Tests, dann Gate). Reihenfolge nach Puffer: `protocol.ts` (+1,0 Zweige), `bus.ts` (+2,5), `stream.ts` (+3,2), danach `report.ts` und `heuristic.ts` — beide gleichauf bei +4,5 Zweigen. Für `protocol.ts` und `stream.ts` sind Rahmen-Fehlerfälle der Hebel (unvollständige Frames, Timeouts, OBD-Modus-Wechsel), für `report.ts` die Berichtsvarianten ohne Befunde/Empfehlungen, für `heuristic.ts` die Signal-Kombinationen unterhalb der Schwellen. Keine neue Logik. |
| E15 | P3 | `apps/web/src/backend.ts` ist mit **1117 Zeilen** (vor E19: 1336; der node-freie Wire-Contract `apps/web/src/views.ts` samt Re-Export ist ausgelagert) das größte Modul des Baums (nächste: `runtime/services.ts` 726, `iso-tp/connection.ts` 724 — nachgemessen am 2026-09-13; `public/app.js` folgt mit 1097 Zeilen als reines Rendern ohne Vokabular (JSDoc-Typen seit E19, ADR 0027)). Es mischt Transportauswahl, Rohspur, Präsentation (`toEcuView`/`toDtcView`/`toTraceView`) und HTTP-Zustand — dieselbe Mischung, die ADR 0014 für die Engine aufgelöst hat. | In Kollaborateure teilen (Adapter-/Bus-Auswahl, View-Mapper, Präsentationszustand) ohne Verhaltensänderung; die View-Mapper sind der natürliche erste Schnitt, weil sie bereits als `*View`-Typen der Domain-Projektion gegenüberstehen (Roadmap-Schritt 9). Architekturtest-Allowlist bleibt unverändert. Dass der Schnitt trägt, zeigen drei Auslagerungen: `apps/web/src/vehicle-view.ts` (235 Zeilen View-Mapping statt in `backend.ts`), `packages/runtime/src/vehicle-resolution.ts` (112 Zeilen Faktensammlung statt in `services.ts`, das dadurch von 780 auf 717 Zeilen zurückkam) und `apps/web/src/dtc-knowledge-view.ts` (200 Zeilen View-Mapping am 2026-09-13): Schritt 15 wuchs `backend.ts` nur um 10 Zeilen (ein Feld in `DtcView` plus Mapper-Aufruf) und `services.ts` um 9 (Bindung des aufgelösten Fahrzeugs an den Scanner), während das Rendern mit +103 Zeilen in `app.js` blieb — ohne ein deutsches Wort dort, weil die Labels im View-Modul gegen die Union-Typen der Definitionsschicht typisiert sind. |
| E17 | P2 | **Die Gleichwertigkeit der Gates hängt an einem Test.** `ci.yml` kann mit der aktuellen GitHub-App-Installation nicht geändert werden (erneut gemessen 2026-09-14, wortgleich zu E10: `refusing to allow a GitHub App to create or update workflow … without 'workflows' permission`). Der Workflow führt deshalb weiterhin `npm ci` → `build` → `npm test` und **nicht** `npm run ci`; dass Biome und beide `--noEmit`-Pässe trotzdem laufen, liegt seit ADR 0026 daran, dass der `architecture`-Projektlauf sie selbst ausführt (+2 s, gemessen). Wird dieses Testfile entfernt oder aus dem Projekt genommen, verschwinden die Gates aus der CI, ohne dass ein Workflow-Diff das zeigt — sichtbar bleibt nur ein Testdiff. | Nach der Freischaltung (E10) den Quality-Job (`biome check` · `typecheck`) direkt in `ci.yml` ziehen und den Gate-Lauf im Architekturtest auf die reine Selbstbeschreibung zurückbauen. Bis dahin pinnt `guardrails.test.ts`, dass `ci.yml` `npm ci`, `npm test` und die Matrix `[22, 24]` behält. |

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

> **Stand 2026-09-11:** Der tatsächliche Baum entspricht dieser Struktur. `apps/desktop` existiert noch nicht (Phase 3); die Definition-Pakete `schema/generic/vag/mercedes` sind im Paket `@vdp/definitions` gebündelt statt als Unterordner. `packages/adapters/host` (Node-Host-Bindings, s. 0.A) existiert zusätzlich.

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
- VIN
- Datum
- Laufleistung
- ECU Overview
- DTC Summary
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
Legal/Licensed Documentation ⏳ Provenance je Quelle vorhanden, Lizenzprüfung offen
Community Knowledge        ⏳ noch kein Eingabepfad
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
- **Beide Wege, dieselben Regeln.** Der JSON-Parser ruft denselben Validator und
  verwirft kein Provenance-Feld still: ein Feld, das vorhanden, aber kein String
  ist, schlägt strukturell fehl (Regressionseintrag: `notes` ging auf dem Dateipfad
  verloren).
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

Dieser Ablauf ist seit ADR 0029 **ausführbarer Code** und nicht mehr nur ein
Diagramm: Validation/Preview → `describe()` der Operation, Confirmation +
Preconditions → `confirm`-Stufe mit `SafetyManager.requestPermit()`, Backup →
`prepare()`, Write → `execute()`, Verification → `verify()` (Re-Read, nicht
Glauben), Audit → `WritePort.history` plus `SafetyManager.audit`. Eine neue
Operation ist ein `WriteOperation`-Objekt und eine Zeile in
`createWritePort()` (`packages/core/src/writes/standard-operations.ts`) — die
Stufen und das Permit lassen sich dabei nicht umgehen.

Keine frühen Implementierungen zum Umgehen von SFD/SFD2 oder anderer Sicherheits-/Authentifizierungsmechanismen.

## 26. Safety Layer

Jede Schreiboperation muss über einen SafetyManager laufen. Seit ADR 0029 ist
das **strukturell** durchgesetzt und nicht nur eine Konvention: Der Lesepfad
(`DiagnosticEngine`, `DtcAccess`) hat keine Schreibmethode, und `WritePort`
erteilt kein Permit ohne `SafetyManager.evaluate()` — eine Operation, die eine
Vorbedingung hinzufügen möchte (Warnungen), kann keine entfernen
(fail-closed, AGENTS 26).

Seit ADR 0030 gilt dabei: **unbekannt ist nicht erfüllt.** Jede Vorbedingung
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

Vor echter Fahrzeughardware einen virtuellen ECU-Simulator schaffen.

```text
Virtual ECU
├── Identification
├── VIN
├── DIDs
├── DTCs
├── UDS sessions
├── timing
└── responses
```

Beispiel:

```text
Application
 ↓
Simulator
 ↓
UDS
 ↓
ISO-TP
 ↓
Virtual CAN
```

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
