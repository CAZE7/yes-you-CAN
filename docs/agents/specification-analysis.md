# Produktspezifikation §22–§24 — KI-Schicht, Knowledge Base, Datenherkunft

> **Aus `AGENTS.md` verschoben** (2026-09-22, AGENTS 2.0 — die Wurzel-Datei ist der
> Einstieg, die Volltexte liegen hier). Normativer Teil der Spezifikation: Analyse und Provenance.
> Dieser Kasten ist neu; alles darunter ist **wortgleich** der Stand aus
> `AGENTS.md` 1.44. Abschnitts- und Regelnummern bleiben gültig: `AGENTS 34.12`
> ist §34.12 in [`rules.md`](rules.md), `AGENTS 0.E E15` ist E15 in
> [`backlog.md`](backlog.md).

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

