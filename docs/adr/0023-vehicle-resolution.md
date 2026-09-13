# 0023 — Fahrzeugauflösung: Belege statt Behauptungen (Schema v2, Resolver, Attributionsregel)

Status: accepted · Datum: 2026-09-12 · Bezug: AGENTS 11, 13, 22, 24, 25; ADR 0003, 0014, 0017, 0022

## Kontext

Die Definitions-Pakete beschrieben bis zu diesem Stand, was ein Steuergerät
kann — DIDs, Signale, Dienste, Fehlertexte — aber **nicht, in welchem Fahrzeug
es steckt**. Gemessen am 2026-09-12 im Baum:

- `schemaVersion: 1`, keine Fahrzeugtabelle: `grep -rn "vehicles" packages/definitions/src/schema.ts`
  → 0 Treffer für ein Fahrzeugmodell; `VehicleDefinition` existierte nicht.
- `vehicle.get` lieferte, was die ECUs über sich selbst sagen (VIN, ggf. ein
  Modellstring aus einem DID). Die Workbench zeigte daraus „Honda of America
  Mfg." — die WMI-Interpretation einer Demo-VIN, mehr nicht.
- `grep -rniE "guided|hypothes[ie]s|resolveVehicle" packages apps tools --include=*.ts`
  → **0 Treffer**. Es gab keinen Ort, an dem „welches Fahrzeug ist das?"
  beantwortet wurde, und damit auch keinen Ort, an dem Variantengenauigkeit
  hätte wachsen können.

Die Folge ist strukturell, nicht kosmetisch: Ohne die Zuordnung
**Fahrzeug → Plattform → Motor/Getriebe → ECUs → Softwarestand** kann kein
DTC-Wissen pro Variante entstehen, keine geführte Diagnose („welcher Sensor ist
bei *diesem* Motor an *diesem* Steckplatz"), kein Coding mit korrekten
Langnamen und keine Aussage darüber, ob ein Softwarestand zum Fahrzeug passt.
Jede dieser Funktionen steht auf derselben fehlenden Schicht.

Zweite Messung, dieselbe Ursache: der Simulator antwortete auf **jedes**
ASCII-Signal mit der VIN (`signalValue`: `if (signal.encoding === "ascii")
return this.vin`). Die Teilenummer unter DID 0xF187 lieferte also
`1HGCM82633A00435` — ein Wert, den kein Definition-Paket der Welt deklarieren
kann, ohne Unsinn zu behaupten. Solange das so war, ließ sich Fahrzeugauflösung
nicht einmal im Simulator ehrlich demonstrieren.

## Entscheidung

### 1. Schema v2: Fahrzeuge sind Teil des Pakets

`DefinitionPackage.vehicles[]` mit `id`, `brand`, `model`, `platform`,
`generation`, `bodyStyles`, `modelYears`, `vinMatch` (`wmi`, `vdsPattern`,
`modelYearChars`, `plantChars`), `engines[]`, `gearboxes[]` (je mit `codes`) und
`ecus[]` (`ecu`, `partNumbers`, `softwareVersions`, `engine`, `gearbox`,
`optional`) — plus eigener `provenance` je Fahrzeug, weil ein Paket sowohl
dokumentierte als auch beispielhafte Fahrzeuge tragen kann.

`migrate.ts` hebt v1 → v2 (`vehicles: []`), Validator und JSON-Parser prüfen die
neuen Felder strukturell **und** semantisch (unbekannte ECU-Referenz, doppelte
Fahrzeug-/Motor-ID, WMI mit den in VINs verbotenen Zeichen I/O/Q). Die
WMI-Referenztabelle (ISO 3780) liegt als Referenzdaten mit eigener Provenance in
`reference/wmi.ts` — sie ist Standard, kein OEM-Wissen, und sie gehört nicht in
`core`: `core` darf `definitions` importieren, nicht umgekehrt
(`tests/architecture/dependencies.test.ts`).

### 2. Auflösung ist Belegsammlung, keine Klassifikation

`VehicleResolver.resolve(input)` nimmt, was bekannt ist — VIN,
Identifikationswerte (`ecu`, `oem`, `did`, `value`), die Adressen, die geantwortet
haben, und was der Bediener angibt — und liefert **Kandidaten mit Belegen**:

| Gewicht | Kriterium |
|---|---|
| 4 | `part-number` |
| 3 | `vin-wmi`, `powertrain-code`, `ecu-coverage` |
| 2 | `vin-vds`, `software-version`, `declared-model`, `unexpected-ecu` |
| 1 | `vin-model-year`, `vin-plant`, `hardware-version`, `declared-oem`, `declared-brand`, `declared-platform`, `declared-model-year`, `ecu-not-in-vehicle` |

`score = (support − conflict) / evaluated` über Gewichte, auf zwei Stellen
gerundet; `ecu-coverage` trägt anteilig bei (2 von 3 ECUs = 2/3 des Gewichts).
Kandidaten mit `score <= 0` erscheinen nicht, `best` ist der höchste, und
`provenanceTrust` (own/standard/licensed 1,0 · community 0,8 ·
reverse-engineered 0,6 · example-placeholder 0,3) bricht **nur** Gleichstände —
ADR 0003 bleibt gültig: dokumentierte Daten gewinnen, Platzhalter drängen sich
nicht nach vorn.

Jeder Kandidat trägt `evidence[]` **und** `conflicts[]` mit `observed`,
`expected`, `weight` und `reason`, dazu `coverage`, die eingeengten
`engineIds`/`gearboxIds` und `unresolved`/`notes`/`unexplained` auf der
Ergebnisebene. Ein Widerspruch wird berichtet, nicht verrechnet und nicht
versteckt (AGENTS 24).

### 3. Attributionsregel: ein Wert ohne Bezug ist kein Widerspruch

Der Entwurfsfehler, den die Tests gefunden haben: „Identifikationswert passt zu
keinem deklarierten Token" ist **nicht** automatisch ein Widerspruch. Ein ECU,
der unter 0xF18C eine Seriennummer liefert, sagt nichts darüber aus, ob die
Teilenummer des Fahrzeugs stimmt.

Regel: Ein Identifikationswert widerspricht nur, wenn sein DID im Paket als
**Art** dokumentiert ist — Teilenummer, Softwarestand oder Hardwarestand
(`identificationKindForLabel(label)`, öffentlich, damit Paketautoren sie prüfen
können). Ist der DID nicht zugeordnet (Seriennummer, unbekannte DID), stützt ein
Treffer, und alles andere ist neutral. Ohne diese Regel bestraft der Resolver
Fahrzeuge für Werte, die er nicht versteht.

### 4. Belege brauchen einen Namensraum

Die Engine nennt ein zugeordnetes Steuergerät `"<oem>:<id>"`
(`discovery.findDefinitionEcu`). Zwei Pakete dürfen dasselbe ECU-Id tragen
(`generic:engine`, `vag:engine`), also trägt `IdentificationFact` jetzt `oem`
**und** das nackte `ecu`-Id; der Resolver verwirft Fakten fremder Pakete. Ohne
das schreibt eine Registry mit mehreren Paketen Belege dem falschen Paket gut.

### 5. Vom Port bis ins Panel

`DefinitionProvider.resolveVehicle(ResolveVehicleQuery)` (Domain, mit
`NullDefinitionProvider`/`StaticDefinitionProvider` und
`unresolvedVehicleResolution(reason)`), Query `vehicle.resolve` (Application,
`ResolveVehicleHints` für VIN und Angaben), `VehicleService.resolve` (Runtime,
Faktensammlung in `vehicle-resolution.ts`), `PackageDefinitionProvider`
(Mapping auf stabile Refs) und in der Workbench `POST /api/vehicle/resolve`
plus SSE-Ereignis `vehicle` und das Panel „Fahrzeugbestimmung".
`apps/web/src/vehicle-view.ts` übersetzt Kriterium-Schlüssel und Provenance in
Bedienersprache und ist gegen die Union-Typen der Definitionsschicht typisiert:
Ein neues Kriterium ohne Übersetzung bricht den Build, statt als `ecu-not-in-vehicle`
auf dem Bildschirm zu landen. Auflösung ist durchgehend read-only — §25/§26
bleiben unberührt.

### 6. Der Simulator wird auflösbar, ohne OEM-Daten zu erfinden

`simulatorPackage` ist `genericPackage` mit denselben Adressen, Signalen und
Fehlertexten plus einem Fahrzeug (`virtual-vehicle`, Marke „Virtual", Plattform
„SIM-1", Provenance `own`/„derived from @vdp/simulators VirtualVehicle"). Es
**ersetzt** `genericPackage` in Simulator- und Replay-Betrieb; gegen echte
Hardware bleibt die OEM-neutrale Baseline aktiv — ein Kundenfahrzeug mit den
Identifikationswerten des Simulators zu beschreiben wäre erfundene
Fahrzeugwahrheit. Zusätzlich registrieren geht nicht: `collectCandidates`
dedupliziert nicht, zwei Pakete auf denselben Adressen würden doppelt proben.

Der Simulator antwortet jetzt nur noch auf DID 0xF190 mit der VIN; jedes andere
ASCII-Signal liefert `<ECU-ID>-<DID>` (z. B. `ENGINE-f187`) — dieselbe Form wie
der Identifikationspfad. Ein Kopplungstest in `tools/simulators` rechnet die
Antworten aus den Definitionen nach und verlangt, dass jeder Wert deklariert
oder nach Regel 3 neutral ist; er hat die Groß-/Kleinschreibung der DID-Hexwerte
als echten Fehler gefunden.

### 7. Leitplanke

Neues per-file-Gate `packages/definitions/**/src/**` = **85 Zeilen / 80 Zweige**.
Gemessen: `resolve.ts` 100/92,8, `evidence.ts`, `vehicles.ts`, `schema.ts`,
`reference/wmi.ts` und alle vier Pakete 100/100, `json.ts` 99,1/92,8,
`validate.ts` 96,1/89,8, `migrate.ts` 87,5/87,5 — dort ist die Obergrenze der
letzte `throw`, der nur feuert, wenn eine Schema-Version ohne Migrationsschritt
in `SUPPORTED_SCHEMA_VERSIONS` aufgenommen wird; kein Input erreicht ihn, und
genau das sagt der Kommentar an der Zeile. Dass das Gate beißt, ist nach Regel
34.21 belegt: mit `lines: 99` endet der Lauf mit `EXIT=1` und benennt
`migrate.ts (87.5%)` und `validate.ts (96.07%)`.

## Folgen

**Gemessen am 2026-09-12** (Basis: 1066 Tests / 78 Dateien):

- Suite **1223 Tests in 88 Dateien**, grün in 24,73 s; Coverage global 96,26 %
  Statements / 89,08 % Zweige / 97,52 % Funktionen / 97,73 % Zeilen.
- `packages/definitions`: 98,68 % Zeilen / 92,87 % Zweige im Paket.
- Die Demo bestimmt das simulierte Fahrzeug mit **score 1,00** aus 11 Belegen
  (VIN-Positionen, Teilenummer, Softwarestand, zwei Motor-/Getriebekennungen,
  Hardwarestand, ECU-Abdeckung, angegebenes Modelljahr) und 0 Widersprüchen;
  `vinLookup` nennt daneben „Honda of America Mfg." als das, was die WMI der
  Demo-VIN aussagt.
- Derselbe Bus mit fremdem VIN (`WVWZZZ1JZHW000001`): **score 0,39**, vier
  benannte Widersprüche (`vin-wmi`, `vin-vds`, `vin-model-year`, `vin-plant`) —
  die Busspuren wiegen schwerer als eine eingegebene VIN, und der Widerspruch
  steht im Ergebnis statt unterdrückt zu werden (Integrationstest).
- Ein Paket ohne Fahrzeugdefinitionen meldet `unresolved` **mit Grund** („none of
  the 1 registered package(s) declares vehicle definitions …") statt einer leeren
  Liste; die WMI-Auflösung funktioniert trotzdem.

**Was es nicht ist:** keine Fahrzeugwahrheit. VAG- und Mercedes-Paket bleiben
`example-placeholder` mit erfundenen Werten, das Simulator-Paket ist `own`, aber
ein Testfahrzeug. Der Resolver entscheidet nicht, welches Auto in der Werkstatt
steht — er sagt, welche Definition am besten zu dem passt, was gelesen wurde,
und wie viel davon belegt ist.

**Nächste Schritte auf dieser Schicht** (Reihenfolge in
`docs/architecture/migration-roadmap.md`): DTC-Wissen pro Fahrzeug/Motorvariante,
geführte Diagnose als Verbraucher desselben Wissens, danach Coding/Adaption.
Die KI-Schicht bleibt Konsument (AGENTS 22): Sie bekommt Kandidaten mit Belegen,
nicht Rohdaten zum Raten.

## Alternativen

- **Fahrzeugwissen in `core` (VIN-Decoder + Modelltabelle):** verworfen.
  `core` importiert `definitions`, nicht umgekehrt — der Architekturtest würde
  rot, und Modellwissen ist OEM-Wissen mit Provenance-Pflicht (ADR 0003), keine
  Engine-Annahme.
- **Klassifikation statt Belegen (Score aus einem Modell, Embeddings, „KI
  erkennt das Fahrzeug"):** nicht nachvollziehbar und damit unbrauchbar für eine
  Werkstatt, die eine Entscheidung begründen muss. AGENTS 24 verlangt
  Datenherkunft je Aussage; ein Kandidat ohne `observed`/`expected`/`reason`
  wäre eine Behauptung.
- **Absoluter Punktestand statt Anteil:** würde Pakete mit vielen Kriterien
  systematisch bevorzugen und „1 von 2" anders bewerten als „5 von 10", obwohl
  beide dieselbe Aussage treffen. Der Anteil ist die ehrlichere Zahl; die
  absolute Belegstärke steht daneben als `weight` je Kriterium.
- **Widerspruch bei jedem nicht deklarierten Wert:** die naheliegende, aber
  falsche Regel — sie bestraft Seriennummern, Werkstattcodes und alles, was ein
  Paket nicht kennt (siehe Entscheidung 3; gefunden durch den Kopplungstest des
  Simulators).
- **`simulatorPackage` zusätzlich zu `genericPackage` registrieren:** verdoppelt
  die Probes auf denselben Adressen, weil `collectCandidates` nicht
  dedupliziert. Ersetzen ist die einzige Variante, die das Discovery-Zeitbudget
  (ADR 0019) hält.
