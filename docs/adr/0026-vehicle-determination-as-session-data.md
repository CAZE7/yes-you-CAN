# 0026 — Die Fahrzeugbestimmung ist Sitzungsdatum: Typ, Senke, Leser

Status: accepted · Datum: 2026-09-14 · Bezug: AGENTS 10, 11, 11.1, 20.1, 21, 23, 34.13/14/24; ADR 0003, 0004, 0023, 0024, 0025

## Kontext

ADR 0023 hat die Fahrzeugauflösung eingeführt (Rangliste mit Belegen), ADR 0024 das
Variantenwissen je Code. Beide Achsen endeten im Arbeitsspeicher der Workbench.
Gemessen am Baum vor diesem ADR, an der laufenden Demo und an den Dateien, die sie
schrieb:

- `apps/web/src/backend.ts:423` hielt `private resolution?: VehicleResolutionView` —
  die einzige Stelle, in der die Bestimmung existierte. Ein Neustart, ein anderes
  Frontend, ein Bericht aus einer gespeicherten Sitzung: weg.
- `session.json` dagegen enthielt **mehr, als der Typ hergab**: `engine.ts:491`/`:579`
  schoben die angereicherten Records des Scanners in ein als `DtcRecord[]` typisiertes
  Snapshot-Feld, und `repository.save` serialisiert `VehicleSessionData` komplett
  (`JSON.stringify(data)`). Nachgemessen an `sessions-local/session_mtzylh7p_1/session.json`:
  `records[0]` trug `description`, `hint`, `relatedSignals`, `ecuName`, `ecuId`,
  `knowledge`, `firstSeen`, `lastSeen` **und** `firstSeenInThisScan`. Von 8 Codes
  hatten 6 ein `hint`, 5 ein `knowledge`. Der Typ war die Lücke, nicht die Datei.
- Für die Leser war die Datei damit trotzdem blind: `ReportDtc` (`reports/report.ts:20`)
  kennt nur `code`/`description`/`severity`/`ecu`/`hint`, die Aufrufstelle
  (`apps/web/src/server.ts:370`) ließ sogar das `hint` weg — gemeldete Empfehlung der
  Demo: zweimal `inspect before further use`, während derselbe Record für `P0300` ein
  dokumentiertes `hint`, drei Muster und ein Messfenster trug.
- Die Analyse sah das Fahrzeug nicht: `AnalysisInput.vehicle` (`ai/types.ts:31`) war
  deklariert und wurde nie gefüllt; `toVehicleSummary` (`runtime/mappers.ts:61-74`)
  ließ `VehicleSummary.vehicleId` (`domain/model.ts:23`) dauerhaft leer, obwohl der
  Kandidat ihn in der Hand hatte (`runtime/services.ts:234` nahm `resolve().best`
  ausschließlich für die Scannerbindung).
- Und `session.data.vehicle` nannte im Bericht weiter nur das Messergebnis:
  Untertitel `2003 (1HGCM82633A004352)` — kein Hersteller, kein Modell, obwohl die
  Auflösung „Virtual Simulator vehicle (SIM-1) — 100 % belegt" wusste.

Der Rahmen, in dem das zu beheben war: `@vdp/reports` darf nur `@vdp/core`
(`tests/architecture/dependencies.test.ts:165`), `@vdp/storage` nur shared+core
(`:164`), `@vdp/domain` nur shared (`:108`). `VehicleCandidate` (definitions) und
`VehicleCandidateRef` (domain) sind von Report und Storage aus also nicht erreichbar.

## Entscheidung

1. **Der Snapshot trägt den Typ, den der Scanner erzeugt.** `dtcSnapshots[].records`
   ist `StoredDtcRecord[]` (`core/src/session/types.ts` via `session.ts`): die Felder
   des `DtcRecord` Pflicht, die Anreicherung (`description`, `hint`, `knowledge`,
   `ecuName`, `relatedSignals`, `firstSeen`, `lastSeen`) zusätzlich **optional** — weil
   eine gespeicherte Datei von einem anderen Build geschrieben sein kann und kein Feld
   zur Anforderung werden darf, die alte Sitzungen nicht erfüllen (AGENTS 34.14).
   `EcuSession.dtcs` bleibt das rohe Protokoll: roh und dekodiert getrennt (ADR 0004).
2. **`firstSeenInThisScan` endet an der Grenze.** Die Markierung beantwortet „neu in
   dem Scan, der gerade läuft". In einem gespeicherten Snapshot würde sie nach dem
   Neuladen als „neu in dieser Sitzung" gelesen; `addDtcSnapshot` kopiert die Records
   und lässt das Feld weg. Katalogisiert als Regressionseintrag
   („a stored fault snapshot claimed a code was new in the session") — die Demo hatte
   alle 8 Codes damit geschrieben.
3. **Neu: `VehicleDetermination` als Typ-Only-Modul im Session-Layer**
   (`core/src/session/types.ts`), nicht in `domain` und nicht in `definitions`, damit
   beide Leser (Storage, Report) und die Analyse daran kommen, ohne eine Kante im
   Architekturtest zu öffnen. Inhalt: `resolvedAt`, `match` (oem, packageVersion,
   vehicleId, brand, model, platform, `score`, `trust`, provenanceType,
   engine/gearbox-Engung, ECU-Abdeckung, `evidence[]`, `conflicts[]`), `reason`,
   `notes`, `unexplained`, `alternatives` (nur `vehicleId`/`oem`/`score`).
4. **Kein Schema-Bump.** `SESSION_SCHEMA_VERSION` bleibt 1 und `defaultMigrations`
   leer; die Bestimmung ist additives optionales Feld. Ein Bump wäre hier keine
   Formalie: `MigrationRegistry.migrate` wirft für jede Version ohne registrierten
   Schritt (`storage/migrations.ts:69`), ein Bump ohne Schritt macht also **jede**
   gespeicherte Sitzung unlesbar. Festgehalten, weil die Verbotsregel „kein Schema-Bump
   ohne Migration + ADR" sonst als Bürokratie gelesen wird.
5. **Geschrieben wird an einer Stelle:** `runtime/services.ts` nach der Auflösung
   (dieselbe Zeile, die den Scanner bindet) — `connect()` und jedes `resolve(hints)`
   laufen darüber; letzte Antwort gewinnt, `resolvedAt` sagt, welche Attempt im
   Record steht. Kein zweiter Ablageort, keine neue Engine-Methode (§11.1 Regel 9:
   Auflösung bleibt eine Query — die Sitzung *protokolliert* nur ihr Ergebnis).
6. **Die Schlussfolgerung darf nicht zur Prämisse werden.** Der erste Entwurf schrieb
   `brand`/`model` des Kandidaten in `session.data.vehicle`. Die Suite hat widerlegt:
   `resolveVehicleQuery` nimmt die Fahrzeugidentität als `declared`-Beleg (§11.1
   Regel 7), also bewertete die nächste Auflösung ihre eigene Antwort als zusätzlichen
   Beleg und hob den Score eines widersprüchlichen VIN auf 1. Deshalb überlagert **nur
   das Read Model** (`toVehicleSummary`), die Messung bleibt unangetastet; gepinnt durch
   den Regressionseintrag „a resolved vehicle confirmed itself in the next resolution".
7. **Leser:** Bericht (`@vdp/reports`) setzt die Knowledge-Scope-Spalte in die
   DTC-Tabelle, führt einen Abschnitt „Variant knowledge" (Scope, Enable-Bedingung,
   dokumentierte Ursache, erstes auswertbares Messfenster, Reparatur**hinweis**,
   Quelle, offene Punkte) und zitiert im Empfehlungsfallback das dokumentierte
   Erstmessen statt der generischen Zeile; die Fahrzeugsektion bekommt die
   Bestimmungen (Evidence, Criteria, Data trust, Powertrain, Coverage, Other
   candidates). Die Wissenszeilen kommen aus dem **Session-Record**, nicht vom
   Aufrufer — ein Bericht aus einer wieder geöffneten Sitzung behält damit die Aussage,
   auf der er beruht. Analyse (`apps/web`) speist `AnalysisInput.vehicle` und das
   Wissen je Code aus derselben Kette.
8. **Leere Zustände bleiben verschieden:** nie aufgelöst · aufgelöst ohne Treffer
   (mit `reason` des Providers) · aufgelöst, aber nichts dokumentiert (`scope: package`
   plus Note) · gar kein Record zum Code. Der Bericht schreibt für jeden dieser Fälle
   einen eigenen Satz; „nichts gefunden" ist ein Ergebnis, keine Lücke (§20.1).
9. **PDF-Faltung nachgezogen:** `pdf.ts:mapUnicode` kannte `→ • ≥ ≤ €`. Varianten-
   texte schreiben `45…55 km/h` und trennen mit `—`; gemessen wurde
   `45?55 km/h ? Kühlung`, und jedes Leerwert-„—" des Berichts wurde zu `?`. Neu:
   `…` → `...`, `—`/`–`/`−` → `-`; `∞` bewusst nicht — statt eines Zeichens, das es
   in Latin-1 nicht gibt, schreibt der Bericht `≥ 90`/`≤ 5`. Dieselbe Klasse wie
   ADR 0021, mit Byte-Test.

## Konsequenzen

- Ein Bericht und eine Analyse beantworten jetzt, **welches** Auto mit **welcher
  Beleglage** beurteilt wurde, ohne dass dafür ein neues System entsteht: Typ,
  eine Schreibstelle, drei Leser.
- Sitzungendaten sind der Ort, an dem Auflösung und Variantenwissen zusammentreffen —
  Schritt 16 (geführte Diagnose) kann darauf aufbauen, ohne eine zweite
  Auflösungsebene zu erfinden; das ist Absicht dieser Schicht, nicht Vorgriff.
- Die Demo misst den Unterschied: `inspect before further use` 2 → 1 (die eine bleibt
  `U0121`, weil dort bewusst nichts variantenspezifisch dokumentiert ist), PDF 0
  Fragezeichen, Workbench-Header „Virtual Simulator vehicle 2003" statt „2003",
  `session.json` mit `determination` (score 1, trust 1, 11 Belege).
- Coverage: `report.ts` 100/79,5 → 99,5/83,3 Zweige (E16-Puffer gewachsen, nicht
  Gate abgesenkt), Suite 1300 → 1326 Tests, global 96,54/89,61/97,56/97,89.
- Offen, bewusst: die volle Kandidatenliste wird nicht gespeichert (rekonstruierbar,
  und eine zweite Kopie wäre eine zweite Wahrheit); `determination` erscheint nicht in
  `StoredSessionSummary` (die Liste zeigt `vin`), weil dafür ein Lesertest fehlt.

## Nachtrag (Punkt 3, 2026-09-14) — die Analyse liest dieselbe Kette

Gemessen am Input, den `apps/web/src/backend.ts::analyze()` bis dahin baute: Signale,
Anomalien, Notizen, Laufleistung und `code/description/severity/ecu` je Code —
`AnalysisInput.vehicle` (`ai/types.ts:31`) war deklariert und wurde **nie** gefüllt. Der
eingebaute Provider antwortete daraus `C0035 stored in ABS / Brake Control Unit` und
`diagnose before further use`, während dieselbe Sitzung die Auflösung und das
Variantenwissen schon trug. Der Auftrag war deshalb eine Leitung, kein Feature:

- `vehicle` aus dem Read Model plus Bestimmung (`brand`/`model`/`modelYear`/`vehicleId`/
  `score`/`trust`/`provenanceType`, `unresolvedReason` bei leerem Ergebnis). **Kein VIN**:
  `@vdp/ai` kann per Konfiguration an ein Modell-Gateway hängen (AGENTS 27).
- Pro Code `hint`, `scope`, `conditions` und `measure` (mit `measurable`). Der Mapper lebt
  in `apps/web/src/analysis-input.ts` und deklariert seine Eingabe schmal-strukturell
  (`AnalysisDtcSource`) statt `DtcView` aus `backend.ts` zurückzuimportieren — ein Mapper,
  der von seinem Aufrufer abhängt, ist ein Zyklus.
- Der Provider **übersetzt keine Scope-Tabelle**; die vierstufige Benennung gehört in
  Bericht (`scopeSentence`) und UI (`SCOPE_LABELS`). Ein Austauschbarer Analyse-Layer,
  der Fahrzeugvokabular besitzt, wäre eine zweite Wahrheit über dieselbe Achse.
- Konfidenz ist eine Obergrenze, keine Belohnung: ohne bestimmte Auflösung, bei Score
  < 60 % oder bei `example-placeholder`/`reverse-engineered`/`community`-Daten gilt
  `min(base, 0,3)` plus begründete Warnung. Ein Anstieg *weil* Wissen vorhanden ist, wäre
  genau die Scheinsicherheit, die AGENTS 22 verbietet.

Nachweis (Demo, `POST /api/analyze`): Summary
`2 critical finding(s) on Virtual Simulator vehicle 2003 (virtual-vehicle). …`,
eine Empfehlung zitiert `measure first: Wheel speed front left · 45…55 km/h … · 5 s`,
`confidence` 0,4 bei einer einzigen standing warning. Für eine Sitzung ohne
Auflösung: 0,3 und der Hinweis, dass alles paketweit gemeint ist (`ai.spec.ts`).
Suite 1326 → 1351 Tests, `heuristic.ts` 94,9/79,5 → 100 Zeilen/89,4 Zweige, Gate `ai`
90/75 → 95/85 (ADR 0017: erst Tests, dann Gate).
