# 0025 — Was Wissen tragen muss: Gates für Einträge und Quellen

Status: accepted · Datum: 2026-09-13 · Bezug: AGENTS 13, 20, 23, 24, 31; ADR 0003, 0020, 0024

## Kontext

ADR 0024 hat DTC-Wissen pro Variante als Daten eingeführt und vier Codes des
einzigen überall verfügbaren Fahrzeugs dokumentiert. Danach war die Frage nicht
mehr „wo liegt Wissen", sondern **was ein Eintrag tragen muss, bevor er eine
Aussage wird**. Gemessen am Stand vor diesem ADR im Baum:

- `validateProvenance` kannte fünf Regeln: `sourceType` und `source` sind Pflicht,
  `licensed` ohne `license` ist ein Fehler, `reverse-engineered` und
  `example-placeholder` warnen. **`community` kam nicht vor** — die Kategorie mit
  den unklarsten Rechten war die einzige ohne Regel, obwohl AGENTS 23 sie nennt
  und AGENTS 24 ungeklärte Daten verbietet.
- `licensed` brauchte weder `version` noch `retrievedAt`. Eine lizenzierte Quelle
  ohne Stand und ohne Abrufdatum kann nicht auf ein Update oder einen Widerruf
  geprüft werden — genau das verlangt AGENTS 13 („nachvollziehbar bleiben, auch
  wenn sich die Definition später ändert").
- `retrievedAt` war ein String ohne Form: `"gestern"` und `"11.09.2026"` wären
  als Datum durchgegangen und mit nichts vergleichbar gewesen.
- `coerceProvenance` kopierte `license`, `version` und `retrievedAt` — **nicht**
  `notes`. Ein lizenziertes Paket, das aus einer Datei geladen wurde, verlor damit
  den einzigen Satz, der die Lizenz in menschlicher Sprache einschränkt. Kein
  Typfehler (jedes Feld ist optional), keine Warnung (der Validator prüft nur,
  was ankam), kein Test: `grep -n "notes" packages/definitions/src/json.spec.ts`
  → 0 Treffer. Lizenziertes Wissen kommt als Datei — der Fehler lag also auf dem
  Weg, der für diesen Fall der einzige ist.
- Und in den Daten selbst: das Muster „intermittierendes Signal" zu `P0715`
  prüfte 30 s lang die **Getriebeöltemperatur** und nannte das einen
  Dropout-Wächter. Das Paket definiert kein Eingangsdrehzahlsignal, also
  beobachtete der Check einen anderen Fehler als den, zu dem er gehörte — und
  konnte praktisch nicht fehlschlagen. Aufgefallen ist das erst, als die laufende
  Demo den fertigen View ausgab.

Beides ist dieselbe Klasse von Fehler: **Daten, die aussehen, als wären sie
geprüft, und es nicht sind.** Eine Provenance ohne Datum sieht dokumentiert aus.
Ein Check mit `windowMs` sieht auswertbar aus.

## Entscheidung

### 1. Provenance-Gates nach Quellentyp

| Quellentyp | Regel | Grund |
|---|---|---|
| `licensed` | `license` fehlt → **Fehler**; `version` fehlt → Warnung; `retrievedAt` fehlt → Warnung | Verbreitung ohne Lizenztext ist unrechtmäßig; ohne Stand und Datum ist ein Widerruf nicht bemerkbar |
| `standard` | weder `version` noch `notes` → Warnung | „SAE J1979" ohne Ausgabe ist keine Zitierung, sondern ein Verweis |
| `community` | immer Warnung: Rechte unklar, vor Verbreitung klären | dieselbe Klasse wie `reverse-engineered`, nur ohne Prüfpfad |
| `reverse-engineered`, `example-placeholder` | Warnung (bestand) | unverändert |
| alle | `retrievedAt` vorhanden, aber kein ISO-8601-Datum → **Fehler** | ein Datum, das nichts parsen kann, ist schlimmer als keines: es sieht dokumentiert aus |

Fehler gegen Warnung ist hier keine Geschmacksfrage: Ein Fehler macht ein Paket
unbenutzbar, also darf er nur kommen, wenn die Daten **rechtlich oder logisch**
unbrauchbar sind (keine Lizenz, kein parsebares Datum). Eine schwache Zitierung
macht Daten nicht falsch — sie bleibt sichtbar, ohne sie zu verwerfen.

### 2. Beide Wege, dieselben Regeln

Der JSON-Parser ruft denselben Validator, und zusätzlich gilt: ein optionales
Provenance-Feld, das vorhanden, aber kein String ist, schlägt **strukturell fehl**
(`provenance.notes: must be a string`) statt still zu verschwinden; `notes` wird
kopiert. Begründung: Ein Gate, das nur auf dem Objektweg gilt, gilt für den Fall,
der zählt, nicht — lizenziertes und importiertes Wissen kommt als Datei.

### 3. Ein Check muss den Fehler beobachten können

Kein Stellvertreter-Signal. Kann das Paket den Fehler nicht beobachten — die
Simulator-Baseline definiert für das Getriebe nur Öltemperatur und Gangposition,
kein Eingangsdrehzahlsignal —, dann **sagt das Muster das** in `explanation` und
prüft nur die Bedingung, unter der der Fehler überhaupt auftritt (Öltemperatur
über 60 °C, weil ein gescheuerter Kabelbaum warm und ausgedehnt ausfällt). Der
Schritt, den nur ein Mensch gehen kann (30 s den Kabelbaum bewegen und die
Statusbits beobachten), steht als Text dort, wo er hingehört, statt als Fenster,
das eine Auswertbarkeit behauptet, die es nicht gibt. Zwei Tests im Paket pinnen
das: jeder Prüfschritt referenziert ein Signal, das das Paket deklariert, und
jeder Check trägt entweder eine Grenze oder ein Fenster.

### 4. Ein Fenster ist eine Messbedingung, keine Toleranz

`45…55 km/h` gilt für die im `expect`-Text genannte Geradeausfahrt bei rund
50 km/h; `≥ 60 °C` sagt, wann ein Monitor gelaufen sein kann. Beides sind
Bedingungen, unter denen ein Wert vergleichbar wird — keine Kalibrierwerte eines
Herstellers (AGENTS 24: keine fremden Daten). Wo keine Zahl zu begründen ist,
bleibt `windowMs` und die Grenze fällt weg: `measurable: false`, und die View sagt
„nur manuell beurteilbar" statt einen Bereich zu zeigen, den niemand dokumentiert
hat.

### 5. Ein Enum-Fenster liest das Paket

Ein numerisches Fenster für ein Signal, das eigentlich eine Zustandsmenge ist,
ist nur zulässig, wenn es die `enumMapping` **desselben Pakets** liest:
`gear_position` 3…4 sind drive und sport, weil das Paket sie so abbildet. Eine
eigens erfundene Skala wäre eine zweite Wahrheit neben der Definition.

### 6. Eine Lücke ist eine Entscheidung, wenn die Variante nichts beitragen kann

`U0121` (Kommunikation mit dem ABS-Steuergerät verloren) hat **bewusst keinen**
Varianteneintrag: ein Kommunikationscode bedeutet für jeden Motor, jedes Getriebe
und jede Ausstattung dasselbe — seine Ursachen liegen in Versorgung, Masse und
Busleitung, und keine davon engt diese Variante ein. Variantenwissen dafür wäre
Füllung, die sich als Wissen ausgibt. Die Antwort bleibt paketweit und sagt das
(`scope: "package"` plus Note). Ein Test zählt die Codes, die das Paket
beschreibt, gegen die, die Wissen tragen — die Differenz ist damit benannt und
nicht zufällig, und sie wächst nicht unbeobachtet.

## Konsequenzen

**Positiv**

- Eine Quelle kann jetzt auf drei Fragen geprüft werden: Woher (Typ + Quelle),
  welcher Stand (`version`), wann gezogen (`retrievedAt`, parsebar). Für
  lizenziertes Wissen ist das die Mindestausstattung, um einen Widerruf zu
  bemerken.
- Datenverlust auf dem Dateipfad ist ein Regressionseintrag mit Biss: ohne die
  `notes`-Kopie `1 failed | 19 passed`, mit ihr grün.
- Die Demo zeigt an drei Codes drei verschiedene Ehrlichkeitsstufen: `C0035` mit
  drei auswertbaren Fenstern und einem manuellen Wächter, `P0700` mit einem
  Muster ohne Check (kein Signal dieses Pakets entscheidet es) und `U0121` als
  „nur paketweit beschrieben".
- Die Regeln stehen im Validator, nicht in einer Review-Checkliste: sie gelten
  auch für Pakete, die jemand später importiert.

**Negativ / Kosten**

- Vier neue Warnungen können bestehende Pakete lauter machen. Gemessen: kein
  eingebautes Paket warnt neu — `genericPackage` zitiert `standard` mit `version`
  **und** `notes`, die Simulator-Pakete sind `own`, VAG und Mercedes bleiben
  `example-placeholder` (Warnung bestand).
- Ein Check ohne Grenze ist für Schritt 16 schwerer auszuwerten: ein Ablauf muss
  den Fall „nur manuell beurteilbar" als Zustand führen, nicht als „offen".
  Das ist Absicht — ein nicht auswertbarer Schritt, der als auswertbar durchgeht,
  ist der teurere Fehler.

## Alternativen

1. **Alle neuen Regeln als Fehler.** Ein Paket, das `standard` ohne Ausgabejahr
   zitiert, wäre ungültig. Verworfen: Es verwirft Daten, die richtig, aber
   schwach belegt sind — und erzeugt einen Anreiz, das Feld lieber wegzulassen
   oder auszudenken, statt es zu ergänzen.
2. **Gates nur im JSON-Parser.** Kürzer, aber zwei Wege mit zwei Wahrheiten; der
   Objektweg (eingebaute Pakete, Tests, `definition-importer`) bliebe ungeprüft.
3. **Dem Simulator ein Eingangsdrehzahlsignal geben**, damit der P0715-Check
   auswertbar wird. Verworfen: ein neuer DID mit erfundener Belegung wäre
   erfundene Fahrzeugwahrheit (AGENTS 24) — der Simulator ist kein OEM, und die
   Baseline bildet öffentliche PID-Semantiken ab, nicht Wunschmesspunkte.
4. **`notes` weiter verwerfen und stattdessen eine strukturierte Lizenzform**
   (`license: { id, scope, validUntil }`) einführen. Verworfen als *Ersatz*: mehr
   Struktur wäre richtig, behebt aber den gemessenen Datenverlust nicht und wäre
   eine Schema-Änderung für ein Feld, das heute niemand strukturiert liefert.
5. **`U0121` mit allgemeinem Text füllen**, damit in der Demo keine Lücke
   sichtbar ist. Verworfen: genau das Verkleiden paketweiter Aussagen als
   Variantenwissen, gegen das AGENTS 20.1 existiert.

## Messwerte

- Suite: **1300 Tests / 90 Dateien in ~25 s grün** (`npm test`; ein bloßes
  `npx vitest run` meldet 91/1301, weil es `hardware` mitnimmt — AGENTS 0.A).
  Coverage global 96,48 Statements / 89,67 Zweige / 97,52 Funktionen /
  97,86 Zeilen; `packages/definitions` 97,91 / 94,15 / 100 / 99,08;
  `validate.ts` 94,22 / 92,06, `json.ts` 98,61 / 94,37, `knowledge.ts`
  unverändert 100 Zeilen / 96,98 Zweige. Per-file-Gate `definitions` 85/80
  gehalten (ADR 0020, 0023).
- Neu: `validate.ts` 525 → 574 Zeilen (Gates + ISO-Prüfung), `json.ts` 536 → 545
  (Feld-Schleife statt vier Einzelzugriffen, `notes` dabei), `simulator-knowledge.ts`
  326 → 506 (zwei Einträge, ein korrigiertes Muster, Dateikopf mit den Regeln).
  Tests: `validate.spec.ts` +5, `json.spec.ts` +1, `simulator-package.spec.ts` +2,
  `knowledge.spec.ts` +1 Block, Integration und Server-Test umgeschrieben auf die
  neuen Antworten, **1 neuer Regressionseintrag**.
- Wissen: 4 → **6 Codes** (P0420, P0300, P0171, P0700, P0715, C0035), `U0121`
  bewusst ohne, `C1234` weiterhin undokumentiert (der Demo-Backend injiziert ihn
  als undeklarierter Code, um den Pfad „nichts erfunden" zu zeigen).
- Live gemessen am 2026-09-13 über `POST /api/dtc/scan`: `C0035` →
  „Varianten-Wissen · Fahrzeug", Pill „Fahrzeug", drei Checks
  „45 … 55 · 5 s messen · automatisch prüfbar" und einer „30 s messen · nur
  manuell beurteilbar"; `P0700` → „Varianten-Wissen · Getriebe", drei Muster, das
  dritte ohne Check; `U0121` → „nur paketweit beschrieben" mit Note.
