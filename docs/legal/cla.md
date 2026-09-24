# Contributor License Agreement (CLA) — Fassung 1.0

> **Status: in Kraft ab 2026-09-23 für Beiträge ab diesem Datum. Entwurf 1.0, noch
> nicht anwaltlich geprüft** — die Prüfung ist als offener Punkt in
> [`docs/architecture/open-core-phase-0-rights.md`](../architecture/open-core-phase-0-rights.md) §6
> vermerkt. Bis dahin gilt: Diese Vereinbarung ist die Grundlage, auf der Beiträge
> angenommen werden; sie ist **keine** Rechtsberatung und ersetzt keine.
>
> **Entscheidung:** ADR [0062](../adr/0062-contributions-need-a-cla.md) ·
> **Warum überhaupt:** Phase 0 des Konzepts
> ([`docs/architecture/open-core-dual-licensing.md`](../architecture/open-core-dual-licensing.md) §3) ·
> **Was die Lizenz davon nicht abdeckt:** [`TRADEMARK.md`](../../TRADEMARK.md)

**Fassung:** 1.0 · **Inkrafttreten:** 2026-09-23 · **Vertragspartner:** der Inhaber des
Repositories (`@CAZE7`, im Folgenden „das Projekt“)

Diese Vereinbarung gilt für **jeden Beitrag**, den du dem Projekt übermittelst
(Pull Request, Patch, Anhang an einem Issue, Datei-Upload — alles, was du nicht
ausdrücklich als „kein Beitrag“ kennzeichnest). Sie gilt **einmal je Beitragendem**,
nicht je Beitrag: Mit der ersten Annahme ist sie erteilt, und sie deckt auch die
folgenden Beiträge derselben Person.

---

## 1. Dein Urheberrecht bleibt deins

**Du bleibst Urheber.** Diese Vereinbarung überträgt dein Urheberrecht nicht — das ist in
Deutschland gar nicht möglich: Nach **§ 29 Abs. 1 UrhG** ist das Urheberrecht nicht
übertragbar. Was du einräumst, sind **Nutzungsrechte** (§ 31 UrhG); deine
Urheberpersönlichkeitsrechte (§§ 12–14 UrhG) bleiben unberührt. Ein CLA nach US-Vorbild,
der „Assignment“ verspricht, verspricht in Deutschland etwas, das es nicht gibt; dieser
hier tut es nicht.

## 2. Was du einräumst

Du räumst dem Projekt ein **räumlich, zeitlich und inhaltlich unbeschränktes,
übertragbares und unterlizenzierbares Nutzungsrecht** an deinem Beitrag ein.

Das umfasst ausdrücklich:

1. **alle Nutzungsarten**, einschließlich der zum Zeitpunkt dieser Vereinbarung
   **noch nicht bekannten** (§ 31 Abs. 4 UrhG) — sonst müsste jede künftige
   Verwertungsform neu verhandelt werden;
2. die **Vervielfältigung, Verbreitung, öffentliche Zugänglichmachung und Bearbeitung**
   (§§ 15 ff. UrhG) des Beitrags allein und als Teil des Gesamtwerks;
3. das Recht, den Beitrag **unter jeder Lizenz** zu veröffentlichen oder zu lizenzieren —
   einschließlich einer **kommerziellen** oder einer **Closed-Source**-Lizenz — und Rechte
   daran weiterzugeben (Sublizenzierung).

**Warum das über die Projektlizenz hinausgeht:** Ein Beitrag ohne diese Klausel steht
allein unter der Lizenz des Repositories („inbound = outbound“). Damit wäre jede spätere
Entscheidung des Projekts über seine Lizenz oder über ein kommerzielles Angebot an die
Zustimmung *jedes einzelnen* Beitragenden gebunden. Diese Vereinbarung ist die eine
Unterschrift, die das verhindert — und sie ist der Grund, warum sie existiert, nicht die
Absicht, dir etwas wegzunehmen.

## 3. Patentlizenz

Du räumst dem Projekt und allen Empfängern der Software eine **weltweite, unentgeltliche,
nicht ausschließliche, unwiderrufliche Patentlizenz** an den Patentansprüchen ein, die du
besitzt oder kontrollierst und die durch deinen Beitrag **notwendigerweise** verletzt
würden, soweit das zur Ausübung der Rechte aus dieser Vereinbarung erforderlich ist.

Wenn du gegen das Projekt oder einen Empfänger wegen eines Beitrags Patentklage erhebst,
erlischt diese Patentlizenz für dich mit dem Datum der Klage — dieselbe Vergeltungsklausel,
die auch Apache-2.0 § 3 vorsieht. Die Lizenz des Projekts selbst enthält den Patentgrant
ebenfalls (Apache-2.0 § 3); diese Vereinbarung wiederholt ihn, damit der Grant auch für
Beiträge gilt, die *vor* einem Lizenzwechsel eingereicht wurden.

## 4. Was du zusicherst

1. Der Beitrag ist **dein eigenes Werk**, oder du bist sonst berechtigt, die Rechte aus
   den Ziffern 2 und 3 einzuräumen.
2. Der Beitrag verletzt **keine Rechte Dritter** (Urheberrecht, Patent, Marke,
   Geschäftsgeheimnis, Persönlichkeitsrecht).
3. Wenn ein **Arbeitgeber** Rechte am Beitrag haben könnte (§ 43 UrhG), hast du dessen
   Zustimmung eingeholt oder der Arbeitgeber unterzeichnet Fassung A.2.
4. Der Beitrag enthält **keine Daten oder Software aus unlizenzierten Quellen** — das
   schließt OEM-Diagnosedaten, ODX-Dateien und Code aus Fremdprodukten ein (AGENTS 24).
   Eine Messung an einem eigenen oder beauftragten Fahrzeug ist zulässig und muss als
   solche gekennzeichnet sein (AGENTS 1.46/ADR 0058).
5. Du kennzeichnest Beiträge, die **fremden Code** enthalten, mit Herkunft und Lizenz.

## 5. Was du nicht schuldest

- **Keine Vergütung.** Das Projekt schuldet dir für den Beitrag keine Zahlung.
- **Keinen Support.** Du musst deinen Beitrag nicht pflegen, nicht erklären und nicht
  aktualisieren; das Projekt kann ihn ändern, ersetzen oder entfernen.
- **Keine Exklusivität.** Du darfst denselben Code anderswo unter jeder Lizenz
  verwenden — die eingeräumten Rechte sind **nicht ausschließlich**, und du bleibst
  Inhaber.

## 6. Was das Projekt zusichert

1. **Der Beitrag wird nicht ohne Lizenz weitergegeben.** Jede Verteilung, die deinen
   Beitrag enthält, erfolgt unter einer Lizenz, die die Rechte der Empfänger regelt —
   heute Apache-2.0 (siehe `LICENSE`).
2. **Namensnennung.** Dein Name bzw. Git-Handle darf in `CONTRIBUTORS.md` und in den
   Commit-Metadaten genannt werden; die Lizenztexte und `NOTICE` bleiben unverändert.
3. **Keine Markenrechte.** Diese Vereinbarung überträgt **keine** Rechte an Namen oder
   Marken — in beide Richtungen (`TRADEMARK.md`).
4. **Kein Entzug deiner Rechte aus der Lizenz des Projekts.** Was du unter Apache-2.0
   erhalten hast, bleibt dir unabhängig von dieser Vereinbarung erhalten.

## 7. Form, Fassung, Kündigung

- **Form:** Die Zustimmung erfolgt elektronisch (Kommentar mit dem unten stehenden Satz
  oder Signatur über das vorgesehene Werkzeug). Sie ist nur wirksam, wenn sie die
  **Fassungsnummer** nennt; diese Datei wird versioniert, und für jede neue Fassung ist
  eine erneute Zustimmung erforderlich (Fassung 1.0 ist die erste).
- **Widerruf** wirkt **für die Zukunft**. Für bereits eingereichte und aufgenommene
  Beiträge bleiben die Nutzungsrechte nach Ziffer 2 bestehen — anders wäre die Zusage
  gegenüber Empfängern nicht haltbar.
- **Anwendbares Recht:** Recht der Bundesrepublik Deutschland. Gerichtsstand ist, soweit
  zulässig, der Sitz des Inhabers.
- **Salvatorische Klausel:** Sollte eine Bestimmung unwirksam sein, bleibt der Rest
  wirksam; an die Stelle der unwirksamen Bestimmung tritt die zulässige Regelung, die dem
  wirtschaftlichen Zweck am nächsten kommt.

---

## Wie du zustimmst (Individual, Fassung A.1)

Hinterlasse im Pull Request einen Kommentar mit genau diesem Satz:

```text
I have read the CLA (docs/legal/cla.md, version 1.0) and I agree to it: I license my
past and future contributions to this project under its terms, allowing the project to
use, modify, sublicense and relicense them, while I remain the author.
```

Zusätzlich — als Herkunftssignal für jede einzelne Zeile — trage deine Commits mit
`git commit -s` ein (Developer Certificate of Origin, `Signed-off-by:`). Das DCO ist
**kein Ersatz** für diese Vereinbarung: Es bescheinigt Herkunft, gewährt aber keine
Rechte über die Projektlizenz hinaus.

## Fassung A.2 — Corporate CLA (Kurzform)

Gilt, wenn der Beitrag im Rahmen eines Arbeits- oder Auftragsverhältnisses entsteht und
Rechte beim Arbeitgeber liegen können.

> Der unterzeichnende **Arbeitgeber** räumt dem Projekt für die Beiträge der unten
> genannten Mitarbeitenden die Rechte aus den Ziffern 2 und 3 dieser Vereinbarung ein,
> bestätigt, dass die Beiträge arbeitsvertraglich erfasst sind (bzw. dass die
> Nutzungsrechte übertragen wurden), und nennt die berechtigten Personen. Weitere
> Mitarbeitende können in Textform nachgemeldet werden. Die Zusicherungen aus Ziffer 4
> gelten entsprechend für den Arbeitgeber.
>
> Unternehmensangaben: ______________________ · Berechtigte Personen: ______________________
> · Ort/Datum: ______________________ · Unterschrift (zeichnungsberechtigt): ______________________

## Fassung A.3 — Wie die Zustimmung erfasst wird

| Was | Wo |
|---|---|
| Vertragstext (diese Datei), versioniert | `docs/legal/cla.md` im Repository, jede Fassung unter eigener Nummer |
| Zuständigkeit und Stand der Zustimmungen | [`docs/legal/contributors.md`](contributors.md) — Handle, Datum, **Fassungsnummer** |
| Zustimmende Signatur | Kommentar im Pull Request (oben) bzw. Signaturwerkzeug; das Werkzeug ist noch nicht verdrahtet (0.E E28) |
| Herkunft je Commit | `Signed-off-by:` (DCO), geprüft im Review |

**Wer keine Zustimmung braucht:** der Inhaber des Repositories. Seine Beiträge sind sein
eigenes Werk; die Zeile in `contributors.md` nennt ihn deshalb als Rechteinhaber, nicht als
Zustimmenden.
