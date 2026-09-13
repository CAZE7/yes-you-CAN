# 0024 — DTC-Wissen pro Variante: Schichten statt Ersetzen (Schema v3, Auflösung, Ehrlichkeit)

Status: accepted · Datum: 2026-09-13 · Bezug: AGENTS 11, 13, 20, 23, 24; ADR 0003, 0014, 0017, 0023

## Kontext

ADR 0023 hat die Zuordnung **VIN → Fahrzeug → Plattform → Motor/Getriebe → ECUs**
gebaut. Was danach fehlte, war der Nutzen dieser Achse im Fehlerspeicher. Gemessen
am Stand vor diesem ADR im Baum:

- Fehlertexte hingen ausschließlich am Steuergerät: `EcuDefinition.dtcs[]` mit
  `code`, `description`, `severity`, `hint`, `relatedSignals`, `freezeFrame`.
  `grep -rn "dtcKnowledge\|FailurePattern" packages --include=*.ts` → **0 Treffer**.
- `DtcScanner` baute daraus eine flache `Map<code, info>` — **erster Treffer
  gewinnt** (`const existing = this.descriptions.get(dtc.code); if (existing) continue;`).
  Derselbe Code auf zwei Steuergeräten oder in zwei Paketen hatte damit genau eine
  Bedeutung, und welche das war, entschied die Ladereihenfolge.
- `grep -rniE "known failure pattern|measurement relationship|repair information" packages apps --include=*.ts`
  → **0 Treffer**: drei der in AGENTS 23 genannten Wissens-Kategorien
  („Known Failure Patterns", „Measurement Relationships", „Repair Information")
  existierten nicht als Daten, auch nicht als Begriff.
- Die Folge im Produkt: `P0420` lieferte einen Satz, der für jeden Motor gleich
  war, plus einen Hinweis, der „Lambda-Sonden vergleichen" sagt — ohne
  Messfenster, ohne Reihenfolge, ohne Angabe, ob die Aussage zum verbundenen
  Fahrzeug gehört. Für Schritt 16 (geführte Diagnose) gab es nichts auszuführen.

Der strukturelle Punkt: **Bedeutung ist variantenabhängig.** Derselbe Code hat bei
einem Motor mit Abgasrückführung andere wahrscheinliche Ursachen, andere
Messpunkte und andere Enable-Bedingungen als bei einem ohne. Wissen, das nur am
Paket hängt, ist entweder zu allgemein (es stimmt für alle) oder falsch (es gilt
für einen Motor und wird für alle angezeigt). Beides ist für eine Werkstatt
wertlos — das zweite ist gefährlich.

## Entscheidung

### 1. Schema v3: Wissen hängt an der Fahrzeugvariante

`VehicleDefinition.dtcKnowledge[]` mit drei neuen Typen in `packages/definitions`:

| Typ | Felder | Rolle |
|---|---|---|
| `DtcKnowledgeDefinition` | `code`, `ecu?`, `engine?`, `gearbox?`, `description?`, `severity?`, `hint?`, `conditions?`, `patterns[]`, `relatedSignals[]`, `provenance?` | eine Aussage über einen Code, scoped auf eine Variante |
| `FailurePatternDefinition` | `id`, `name`, `explanation?`, `likelihood?` (`common`/`possible`/`rare`), `checks[]`, `repair?` | benannte Hypothese (AGENTS 23 „Known Failure Patterns") |
| `MeasurementCheckDefinition` | `signal`, `expect`, `min?`, `max?`, `windowMs?` | Messbeziehung: welcher Messpunkt, welches Fenster (AGENTS 23 „Measurement Relationships") |

`CURRENT_SCHEMA_VERSION` 2 → 3, `SUPPORTED_SCHEMA_VERSIONS` `[1, 2, 3]`;
`upgradePackage` verkettet jetzt 1→2→3 (v2→v3 hebt nur die Version, weil Wissen
**fehlen darf** — ein Paket ohne `dtcKnowledge` behauptet nichts, und die
Migration erfindet nichts). Eingebaute Pakete deklarieren
`CURRENT_SCHEMA_VERSION` statt einer Zahl, damit ein Bump nicht an drei Stellen
nachgezogen werden muss (der Importer machte es bereits so).

Validator und JSON-Parser prüfen strukturell **und** semantisch: Code-Format
(SAE J2012), unbekannte ECU-/Motor-/Getriebe-/Signalreferenzen, doppelte
Scopes (`code|ecu|engine|gearbox`), doppelte Pattern-IDs **je Fahrzeug** (eine
Pattern-ID ist damit global adressierbar — Schritt 16 braucht das als
Schlüssel), `min > max`, nicht-ganzzahliges `windowMs`, leere Texte,
`likelihood`/`severity` außerhalb der Union, Provenance je Eintrag.
Reparaturinformation ohne Provenance wird zur **Warnung mit Regelverweis**
(AGENTS 24) — sie ist die einzige Kategorie, an der Rechte hängen können.

### 2. Auflösung: Spezifität schlägt Reihenfolge

`findDtcKnowledge(packages, query)` (in `packages/definitions`, damit das
per-file-Coverage-Gate greift) beantwortet einen Code für **ein** Fahrzeug:

| Gewicht | Achse |
|---|---|
| 16 | Motor durch Belege bestätigt (`engineIds` enthält ihn) |
| 8 | Getriebe durch Belege bestätigt |
| 4 | ECU benannt und identisch mit dem lesenden Steuergerät |
| 2 | Motor **angenommen** (siehe unten) |
| 1 | Getriebe **angenommen** |

- Ein Eintrag für einen anderen Motor/anderes Getriebe/anderes Steuergerät ist
  **kein schwacher Treffer, sondern keiner** (`undefined` statt kleinem Gewicht).
- **Patterns werden über alle zutreffenden Einträge gesammelt**, spezifischster
  zuerst, IDs eindeutig: eine motorspezifische und eine variantenweite Ursache
  ergänzen sich — den breiteren Eintrag zu verwerfen, weil ein engerer existiert,
  würde dokumentiertes Wissen verstecken.
- **Texte** (description/severity/hint) kommen aus dem spezifischsten Eintrag,
  der sie deklariert; sonst aus der Paketbeschreibung des **lesenden**
  Steuergeräts; sonst aus der ersten Definition des Codes im Paket.
- **Eine bewusste Ausnahme von der Strenge:** hat die Auflösung *nichts* zum
  Antriebsstrang eingeengt und deklariert die Variante **genau einen** Motor
  (bzw. ein Getriebe), gilt der darauf gescopete Eintrag — unter allem
  Bestätigten rangierend und mit Note („the evidence did not narrow the
  powertrain, so engine "sim-petrol" is assumed — it is the only one this
  variant declares“). Sind mehrere deklariert, wird **abgelehnt**:
  zwischen zwei Motoren ohne Beleg zu wählen wäre ein Münzwurf, der als Antwort
  serviert wird. Praktisch heißt das: Nur-VIN-Auflösung liefert das Wissen des
  einzigen dokumentierten Motors; sobald die Identifikations-DIDs gelesen sind
  (im Simulator `ENGINE-f18c`), verschwindet die Annahme und die Note mit ihr.
- `dtcKnowledgeQuery(candidate, code, ecu)` bildet einen
  `VehicleCandidate` direkt auf die Query ab — Aufrufer müssen die Einengung
  nicht selbst auspacken und können sie dabei nicht versehentlich verengen.

### 3. Schichtung im DTC-System, nicht Ersetzen

`DtcScanner` behält die paketweite Anreicherung und legt das Variantenwissen
**darüber** (`packages/core` darf `definitions` zur Laufzeit importieren,
`tests/architecture/dependencies.test.ts`):

- `setVehicle(context)` bindet das aufgelöste Fahrzeug; `enrich(records, ecuName, ecuId, definition?)`
  fragt je Code `findDtcKnowledge` (Cache je Kontext+Code, bei `setVehicle`
  verworfen) und überschreibt damit description/severity/hint, **merged**
  `relatedSignals` (Paket + Variante, eindeutig, nur im Paket definierte IDs) und
  hängt `knowledge: DtcVariantKnowledge` an.
- `DtcVariantKnowledge` ist die **Record-Form** (scope, vehicleId, conditions,
  patterns, `provenanceType`/`-Source`, notes) — bewusst flacher als das
  Lookup-Ergebnis, weil jeder gespeicherte DTC klein und selbstständig bleiben
  soll (Sitzungs-NDJSON, PDF-Report).
- `DiagnosticEngine.setVehicleContext` gibt die Bindung weiter;
  `VehicleService.connect()` bindet **sofort nach dem Verbinden** (VIN und
  Identifikation sind dann bereits gelesen — der erste Scan trägt das Wissen,
  ohne dass der Bediener etwas tut), `VehicleService.resolve(hints)` bindet mit
  den Angaben des Bedieners neu, `engine.disconnect()` **löst** — Wissen darf
  die Sitzung, für die es aufgelöst wurde, nicht überleben.
- Ohne gebundenes Fahrzeug wird **kein** `knowledge` erzeugt: die paketweite
  Beschreibung steht bereits am Record, sie als Variantenwissen auszugeben wäre
  genau die Verwechslung, gegen die die ganze Fahrzeugachse existiert.

### 4. Ehrlichkeit als Datenmodell

Jede Antwort trägt, woraus sie besteht und was ihr fehlt:

- `scope` ∈ `vehicle-engine | vehicle-gearbox | vehicle | package` — die UI
  übersetzt `package` als „nur paketweit beschrieben" und zeigt es **nicht** im
  Stil von Variantenwissen.
- `notes[]` — „kein Variantenwissen dokumentiert", „nur Text, keine Muster",
  „kein Zahlenfenster, ein Mensch muss beurteilen", „Antriebsstrang angenommen",
  „Fahrzeug im Paket nicht deklariert".
- `checks[].measurable` — `false`, wenn `min`/`max` fehlen; die View sagt dann
  „nur manuell beurteilbar" statt ein Fenster zu zeigen, das nie dokumentiert war.
- `knowledgeProvenance` ist die Quelle **der angezeigten Aussage**: Entry →
  sonst Fahrzeug (nur wenn ein Entry gewann) → sonst Paket. Ein package-scope
  Treffer nennt damit das Paket, nicht das Fahrzeug — sonst wird eine Variante
  für einen Satz gelobt, den sie nie gemacht hat.
- **Keine erfundenen Messpunkte.** `genericPackage` definiert keine Lambda-Sonden
  (PID 0x14–0x1B); also prüft das Katalysator-Muster über Kraftstoffkorrektur und
  Kühlmitteltemperatur und sagt im Text, was das belegt und was nicht. Eine
  Signal-ID zu erfinden, hätte einen Prüfschritt erzeugt, der nie laufen kann.

### 5. Präsentation

`apps/web/src/dtc-knowledge-view.ts` (200 Zeilen) übersetzt wie
`vehicle-view.ts`: Scope-/Likelihood-Labels sind gegen die Union-Typen der
Definitionsschicht typisiert (ein neuer Scope bricht den Build, statt als Key
beim Bediener anzukommen), unbekannte Werte bleiben als sie selbst sichtbar,
`checkWindow()` bildet `min`/`max`/`windowMs` auf „-5 … 5 · 2 s messen" ab,
`provenance` wird mit `provenanceLabel()` komponiert. `public/app.js` enthält
damit **kein** Vokabular mehr: Es rendert Muster als Karten, Messpunkte als
Tabelle (Messpunkt · Erwartung · Fenster · Bewertung), Reparaturhinweise als
solche labelt und Notes als Warnungen. In der Fehlerliste trägt ein Code mit
Variantenwissen ein Pill („Motor"/„Getriebe"/„Fahrzeug"), einer ohne keines.

## Konsequenzen

**Positiv**

- `P0420` antwortet in der Demo mit Variantentext, Enable-Bedingung („closed
  loop, > 80 °C, drei Fahrzyklen"), zwei Mustern, fünf Messfenstern und
  Reparaturhinweis — `P0715` über die Getriebe-Achse, `P0300` variantenweit,
  `C0035`/`U0121`/`P0700` ehrlich als „nur paketweit beschrieben".
- Schritt 16 (geführte Diagnose) hat einen Verbraucher: Muster sind Hypothesen,
  Checks sind Messschritte mit auswertbarem Fenster, `likelihood` ist die
  Reihenfolge, Pattern-IDs sind global adressierbar.
- Wissen ist importierbar (JSON-Pfad geprüft: 21 Strukturfehler-Formulierungen,
  Round-Trip-Test) und lizenzierbar (Provenance je Eintrag, `licensed` nur mit
  `license`).

**Negativ / Kosten**

- Drei nahezu parallele Formen desselben Inhalts (Definition → Hit → Record →
  View). Bewusst: die Schichten dürfen einander nicht importieren (domain kennt
  `definitions` nicht), und jede Form hat eine eigene Aufgabe. Der Preis ist
  Mapping-Code, der Gewinn ist, dass keine Schicht eine andere mit Annahmen
  ansteckt.
- `apps/web/src/backend.ts` wächst auf 1336 Zeilen (Budget 800, E15) — die
  Auslagerung der DTC-View ist überfällig und wird in ADR 0022/E15 geführt, nicht
  hier gelöst.
- `public/app.js` wächst auf 1009 Zeilen; DOM-Code bleibt ungetestet (kein
  DOM-Harness im Baum), getestet ist die Übersetzungsschicht davor.

**Als Nächstes**

- Schritt 16: Prüfabläufe aus `patterns[].checks[]` ausführen (messen, Fenster
  bewerten, Ergebnis je Muster) — inkl. der Frage, was „nicht prüfbar" für den
  Ablauf bedeutet.
- Lambda-Signale (PID 0x14–0x1B) in `genericPackage` würden die
  Katalysator-Prüfung von „Korrektur neutral" auf „Downstream-Schaltverhalten"
  heben — Standarddaten, also ohne Rechtefrage ergänzbar.

## Alternativen

1. **Wissen am Steuergerät statt am Fahrzeug** (`EcuDefinition.dtcs[]`
   erweitern): kleiner, aber falsch — ein Steuergerät ist über Motoren hinweg
   dasselbe, die Ursache ist es nicht. Genau diese Verwechslung war der
   Ausgangszustand.
2. **Wissen als eigenes Paket/Service** (Knowledge-Registry neben den
   Definitionen): sauberere Rechte-Trennung, aber ein zweiter Auflösungsweg
   (welches Wissen gehört zu welchem Paketstand?) und Versionen, die
   auseinanderlaufen können. Sitzungen referenzieren einen Paketstand (§16) —
   Wissen im Paket referenziert denselben.
3. **Strenge Motor-Bindung ohne Annahme-Regel**: formal sicher, aber die Demo und
   jede Nur-VIN-Auflösung hätten weiterhin nur paketweite Texte gezeigt. Die
   gewählte Regel macht dieselbe Sicherheit mit einer sichtbaren Note.
4. **Erzeugtes Wissen (LLM) pro Code**: ohne Quelle, ohne Rechte, ohne
   Widerrufsmöglichkeit — verstößt gegen AGENTS 24 und gegen die Regel, dass
   Definitionen Daten sind (ADR 0003).
5. **Nur der spezifischste Eintrag** (Patterns nicht sammeln): weniger Ausgabe,
   aber dokumentiertes Wissen würde durch engeres Wissen verdrängt.

## Messwerte

- Suite: **1290 Tests / 90 Dateien in ~25 s grün** (`npm test`); Coverage global
  96,4 Statements / 89,6 Zweige / 97,5 Funktionen / 97,8 Zeilen,
  `packages/definitions` 97,8 / 94,1 / 100 / 99,0; `knowledge.ts`
  **100 Zeilen / 96,9 Zweige**, `scanner.ts` 100/87,8, per-file-Gate
  `definitions` 85/80 gehalten. Biome und beide Typecheck-Projekte
  (`tsconfig.typecheck.json`, `tsconfig.frontend.json`) grün.
- Neu: `knowledge.ts` (438 Zeilen), `simulator-knowledge.ts` (326),
  `dtc-knowledge-view.ts` (200); `validate.ts` +163, `json.ts` +118,
  `scanner.ts` +110, `services.ts` 717 → 726 (Budget 800).
- Ende-zu-Ende belegt: `tests/integration/vehicle-resolution.test.ts` scannt
  nach dem Verbinden und findet `scope: "vehicle-engine"`, zwei Muster,
  auswertbare Fenster und `notes: []`; `apps/web/test/server.spec.ts` prüft
  dieselbe Antwort über HTTP inkl. der deutschen Labels.
