# Phase 0 — Rechte, Lizenz, Beitragsinstrument: die Entscheidungen vor der ersten Veröffentlichung

> **Status: Entscheidungsvorlage (2026-09-23). Nicht normativ, keine Rechtsberatung.**
> Dieses Dokument entscheidet nichts. Es legt die Wahl mit Folgen vor, damit Inhaber und
> Juristin in einer Sitzung entscheiden können, statt sie über Monate zu schieben — und
> es nennt die Stellen, an denen die Entscheidung dann im Repo landet (Regel 34.24).
> Mit der Unterschrift wird daraus **ADR 0061** (Lizenz des Kerns) und **ADR 0062**
> (Beitragsinstrument); bis dahin ist der Zustand hier der gemessene Ist-Zustand plus
> Empfehlung. Kontext und Zielbild:
> [`docs/architecture/open-core-dual-licensing.md`](open-core-dual-licensing.md), §3 und §5.

---

## 1. Warum jetzt (und warum es mit jedem Beitrag teurer wird)

Die Kosten dieser Entscheidung sind **nicht** konstant — sie hängen an der Zahl der
Rechteinhaber, und die wächst mit jedem angenommenen Fremdbeitrag.

**Gemessen am Stand `dc4d7d7` (2026-09-23):**

| Messung | Wert | Kommando |
|---|---|---|
| Commits in der Historie | **1** | `git rev-list --count HEAD` |
| Autoren in der Historie | **1** (`arena-ai-coding-agent[bot]`) | `git log --format='%an <%ae>' \| sort -u` |
| Lizenzdatei | MIT (`Copyright (c) 2026 yes-you-CAN Contributors`) | `LICENSE` |
| Beitragsinstrument | **keines** — kein CLA, kein DCO, kein `Signed-off-by` | `grep -ri "dco\|signed-off" CONTRIBUTING.md .github/` |
| Workspace-Pakete | 29, **alle `private: true`**, alle MIT | `npm run check:manifests` |
| Veröffentlichte Artefakte | **keine** | `npm pack --dry-run` (Befund §4) |

Zwei Dinge daran sind für die Entscheidung entscheidend:

1. **Die Rechtekette ist heute nicht aus der Historie belegbar.** Ein Commit, ein
   Bot-Autor, keine Datei-Historie: Wer welchen Teil geschrieben hat, steht nirgends. Das
   ist kein Defekt am Code — aber es heißt, dass die Rechteklärung *außerhalb* der Historie
   passieren muss und ab jetzt **belegbar** werden sollte (genau das leistet ein
   Beitragsinstrument, §3).
2. **Es gibt genau einen Rechteinhaber.** Jede der Entscheidungen unten ist heute ohne
   Fremdzustimmung möglich. Nach dem ersten angenommenen externen PR gilt: „Alle
   Rechteinhaber müssen zustimmen“ — und ein Nein blockiert dauerhaft.

> **Merksatz aus der Praxis:** Ein Projekt, das seine Beitragsregeln nicht vor dem ersten
> Fremdbeitrag festlegt, kann später nur noch die Zustimmung aller nachträglich einkaufen —
> oder den Code neu schreiben (Clean Room). Das Konzept nennt diesen Weg in §4.7 bereits als
> Risiko.

---

## 2. Entscheidung E1 — die Lizenz des Kerns

**Empfehlung: Apache-2.0** (Umstellung von MIT), **vor** der ersten Veröffentlichung.
Alternative: MIT behalten und die Grenze nur über die private Registry ziehen.

### Was die drei realistischen Optionen konkret bedeuten

| Kriterium | MIT (heute) | **Apache-2.0 (Empfehlung)** | AGPL-3.0 |
|---|---|---|---|
| Patentgrant der Beitragenden | ❌ fehlt | ✅ ausdrücklich (§3), mit Vergeltungsklausel | ✅ (§11) |
| Marke | nicht geregelt | §6 — Marke wird **nicht** lizenziert | nicht geregelt |
| „Änderungen kennzeichnen“ / NOTICE | ❌ | ✅ (§4b/§4d) | ✅ |
| Kann ein Dritter den Kern nehmen und geschlossen verkaufen? | ✅ ja | ✅ ja (Patent- und Markenlage sind der Unterschied, nicht das Verkaufsrecht) | ❌ nein (Copyleft, Netzwerkklausel) |
| Verträglich mit unserem Baum | ✅ | ✅ | ⚠️ kollidiert mit dem Zielbild „Closed-Modul daneben“ nur, wenn das Closed-Modul den Kern *linkt*; unser Closed-Teil **importiert** den Kern — das ist genau die Frage, die die Juristin beantworten muss |
| Verträglichkeit mit Fremdcode, den wir aufnehmen | — | ⚠️ **unverträglich mit GPL-2.0-only** (Patent-/Indemnity-Klauseln gelten dort als zusätzliche Beschränkung); verträglich mit GPL-3.0 (in einer Richtung) | ⚠️ strenger: nimmt Apache-2.0 auf, gibt aber Copyleft |
| Wirkung auf Kunden (Werkstatt, OEM) | minimal | minimal bis positiv (Patentfrieden) | für viele OEM-Rechtsabteilungen ein Ausschlusskriterium |

**Warum Apache-2.0 und nicht MIT behalten:** Der Unterschied liegt nicht im „darf man
kommerziell nutzen“ (das erlauben beide), sondern in dem, was ein OEM-Jurist prüft. Ein
Patentgrant plus Vergeltungsklausel ist die Zusage, die ein Embedded-Diagnosekunde in einer
Lieferantenbewertung sehen will; MIT sagt dazu nichts. Für ein Werkzeug, das in
Fahrzeugnetze schreibt, ist „wir haben die Patente unserer Beitragenden lizenziert“ ein
Argument, das man nicht nachträglich erfinden kann.

**Warum nicht AGPL-3.0:** Sie wäre das schärfste Werkzeug gegen ein „Closed-Fork durch
Dritte“ — und würde gleichzeitig das Zielbild gefährden: unser Closed-Teil importiert
Kernmodule, und ob ein importiertes Modul unter Copyleft fällt, ist genau die Frage, die
man nicht im Nachhinein klären will. Zusätzlich ist AGPL für Werkstatt- und OEM-Deployments
oft ein Ausschlusskriterium. Die Entscheidung *gegen* AGPL ist also eine Entscheidung *für*
die Trennung „offener Kern, geschlossene Module über Verträge“ — nicht gegen Copyleft als
Idee.

### Was die Umstellung kostet (und was sie verlangt)

1. **Zustimmung aller Rechteinhaber.** Heute: eine Person (gemessen §1). Nach dem ersten
   Fremdbeitrag ohne CLA: jede einzelne, mit Nein-Recht.
2. **Was veröffentlicht ist, bleibt veröffentlicht.** Der MIT-Stand `dc4d7d7` bleibt für
   immer MIT — Apache-2.0 gilt ab der Umstellung für neue Versionen (und genau das ist
   ausreichend; niemand muss auf den alten Stand zurück).
3. **Datei-Kopfzeilen sind nicht nötig.** Apache-2.0 verlangt `LICENSE` + `NOTICE` (falls
   vorhanden) und das Kennzeichnen von Änderungen; pro Datei reicht die `LICENSE`.
4. **Die Lizenzprüfung zieht mit:** `architecture/architecture.yaml` (`licenses`) verbietet
   nicht Apache-2.0 — sie erlaubt es bereits in beiden Geltungsbereichen; der Root-Wechsel
   berührt `LICENSE`, `package.json` (`license` in allen 29 Paketen), `LICENSE`-Verweise in
   README/CONTRIBUTING und die Attribution derzeitiger MIT-Zusagen.

> **Faktengrundlage:** §3 (Patentgrant + Vergeltung), §6 (Marke) und §4 (NOTICE/Kennzeichnung)
> der Apache-2.0; Unverträglichkeit mit GPL-2.0-only und Ein-Richtungs-Verträglichkeit mit
> GPL-3.0 nach FSF/Apache-Position. Die Zuordnung „was ist für unser Closed-Modul
> erforderlich“ ist eine **Rechtsfrage** und der erste Termin mit der Juristin (§6).

---

## 3. Entscheidung E2 — das Beitragsinstrument

**Empfehlung: CLA mit breiter Lizenzgewährung (nicht „Assignment“), dazu DCO als
Herkunftssignal.** Beides freiwillig erst ab dem ersten externen Beitrag; ab Inkraftsetzung
verbindlich für alle Beiträge.

### Warum ein CLA, obwohl das Projekt MIT/Apache-2.0 ist

Ein DCO bestätigt nur, *dass* man beitragen durfte — **inbound = outbound**. Damit gilt
jeder Beitrag genau unter der Projektlizenz. Für ein Unternehmen, das

- den Kern später auf eine andere Lizenz umstellen,
- Closed-Module daneben verkaufen,
- oder das Projekt je veräußern will,

ist das zu wenig: **Ohne CLA gibt es kein Recht, den Beitrag anders als unter der
Projektlizenz zu nutzen.** Ein CLA ist genau diese Zusatzgewährung. Der Preis ist sozial:
Manche Beitragenden (und Arbeitgeber) lehnen CLAs ab. Deshalb: schlank halten, nur für
Fremdbeiträge, automatisiert (Signatur über einen Bot), und den Grund offen hinschreiben.

### Der deutsche Punkt, den man kennen muss

**Das Urheberrecht ist nicht übertragbar** (§ 29 Abs. 1 UrhG) — möglich sind nur die
Einräumung von Nutzungsrechten (§ 31), schuldrechtliche Einwilligungen und die
Rechtsgeschäfte über Urheberpersönlichkeitsrechte (§ 39). Ein „Copyright Assignment“-CLA
nach US-Vorbild erzeugt hier also nicht, was sein Name verspricht. Ein wirksamer deutscher
CLA **räumt Nutzungsrechte ein** — und zwar so, wie das Zielbild sie braucht:

- **Umfang:** alle Nutzungsarten, zeitlich unbeschränkt, räumlich unbeschränkt,
  **auch für künftige Verwertungen** (sonst ist jede Lizenzumstellung neu zu verhandeln),
- **Umstellungs- und Sublizenzierungsrecht** ausdrücklich, sonst bleibt es bei der
  Projektlizenz,
- **Patent-Lizenz** des Beitragenden (nicht nur Copyright) — sonst gewährt der CLA weniger
  als Apache-2.0 selbst,
- **Zusicherung**, den Beitrag beitragen zu dürfen (Arbeitgeberfall!), und
- **kein Entzug** des Urheberpersönlichkeitsrechts (das geht nicht, § 39).

Ein Entwurf steht in **Anhang A** (Individual- und Kurzform für Firmenbeiträge). Er ist als
Vorlage gedacht, nicht als geprüftes Dokument — was fehlt, ist der Blick einer Juristin
(§6).

### Was tatsächlich schon gilt (ohne CLA)

Beitragende, die heute einen PR einreichen, stellen ihren Beitrag unter die Lizenz des
Repositories — weil GitHub-Teilnahmebedingungen das vorsehen und `CONTRIBUTING.md` es
nicht widerspricht. Das ist für die *Weitergabe* ausreichend und für die *Umstellung* nicht:
Für die steht in §2 Punkt 1, warum.

---

## 4. Was der Trockenlauf gefunden hat (Messung, vor jeder Veröffentlichung)

Der vierte Punkt der Phase-0-Liste ist der Trockenlauf. Er hat einen echten — und billigen —
Fund ergeben, **bevor** irgendetwas veröffentlicht ist:

```text
$ cd packages/domain && npm pack --dry-run --json
Dateien im Tarball: 20
dist-Dateien: 0
src-Dateien: 17        # einschließlich src/capabilities.spec.ts, src/events.spec.ts, …
$ cd tools/harvest && npm pack --dry-run --json
Dateien: 24 | dist: 0 | src: 21 | spec: 9
```

**Befund:** Kein Paket dieses Repos deklariert `files`. npm fällt dann auf `.gitignore`
zurück — und `.gitignore` schließt `dist/` aus, weil das der lokale Build-Ordner ist. Ein
veröffentlichtes Paket hätte damit **den Quelltext samt Tests und keinen Build** enthalten:
für einen Konsumenten unbenutzbar, für uns eine Offenlegung, die niemand entschieden hat.

**Behoben wurde die Regel, nicht nur der Fall:** `check-package-manifests.mjs` prüft jetzt
drei Dinge, sobald ein Paket veröffentlichbar ist (`private` fehlt oder ist `false`):

| Regel | Was sie verlangt |
|---|---|
| `publishable-without-files` | Ein veröffentlichbares Paket nennt `files` |
| `publishable-ships-sources` | `files` enthält kein `src` (und kein `*`/`**`) |
| `publishable-without-dist` | `files` liefert `dist/`, wenn `main`/`types`/`exports` dorthin zeigen |

Heute ist das strukturell ruhig (29/29 privat) — bewiesen ist es in
`tests/architecture/manifests.test.ts` (vier Fixtures: der Fall ohne `files`, mit `src`,
ohne `dist` und der korrekte). Der **erste konkrete Schritt der späteren Veröffentlichung**
ist damit: `files: ["dist"]` je veröffentlichbarem Paket + `private: false` in **einem** PR,
und die Regel prüft das Ergebnis.

---

## 5. Was noch zu Phase 0 gehört

| # | Aufgabe | Stand | Artefakt |
|---|---|---|---|
| 0.1 | Rechte klären (dieses Dokument) | 🟡 vorgelegt, Entscheidung offen | diese Datei + §6 |
| 0.2 | Lizenzwahl E1 | 🟡 Empfehlung Apache-2.0 | §2, ADR 0061 nach Unterschrift |
| 0.3 | Beitragsinstrument E2 | 🟡 Entwurf in Anhang A | ADR 0062 nach Unterschrift |
| 0.4 | Registry-Zugang (Scopes, OIDC, 2FA) + Trockenlauf | 🟡 **Trockenlauf gemessen** (§4), Zugang offen | [`docs/operations/registry.md`](../operations/registry.md) |
| 0.5 | Ist-Baseline messen (Regel 34.21) | ✅ `npm run ci` EXIT 0, 2537 Tests grün | Commit-Message `dc4d7d7` |

---

## 6. Was die Juristin beantworten muss (Fragenliste für den Termin)

1. Trägt der Umstieg MIT → Apache-2.0 bei einem Ein-Personen-Copyright-Inhaber und
   Bot-Historie? Welche Nachweise will sie dafür?
2. Ist der CLA-Entwurf (Anhang A) als **Nutzungsrechteeinräumung** nach §§ 29, 31, 39 UrhG
   wirksam — insbesondere für **künftige Verwertungsarten** (§ 31 Abs. 4) und für
   Firmenbeiträge (Arbeitgeberrechte, § 43 UrhG)?
3. Kann ein Kunde/OEM-Modul unter eigener Lizenz die Apache-2.0-importierten
   Vertragspakete nutzen (das Zielbild „Closed-Modul importiert Kernmodule“)? Wo ist die
   Grenze zu einem abgeleiteten Werk?
4. Wie ist der Umgang mit **OEM-Daten** abzugrenzen: Sind die Definitionspakete
   (`@vdp/definitions`) Software (Lizenz) oder Datenbanken/Inhalte (Datenbankherstellerrecht,
   §§ 87a ff. UrhG)? Die Antwort entscheidet, was ein Kunde mit gelieferten Daten tun darf.
5. Marke: Welche Klauseln gehören in `TRADEMARK.md` (Name, Logo, „yes-you-CAN compatible“),
   damit Dritte den Code nutzen, aber nicht als unser Produkt auftreten dürfen?
6. Datenschutz (AGENTS 27/30): Muss der AI-/HTTP-Pfad im Lizenztext oder in den AGB
   gesondert adressiert werden, solange er VIN und Fahrzeugdaten verlassen kann?

---

## Anhang A — CLA-Entwurf (Vorlage, nicht geprüft, nicht in Kraft)

> **This is a draft. It is not in force, it is not legal advice, and it must be reviewed by
> qualified counsel before it is used.** (Deutsch als Arbeitssprache, weil der Inhaber in
> Deutschland sitzt; eine englische Fassung gehört daneben, sobald der erste
> nicht-deutschsprachige Beitrag kommt.)

### A.1 Individual Contributor License Agreement (Entwurf)

**Parteien:** Der/die Beitragende („Sie“) und <Inhaber/Träger> („das Projekt“).

1. **Begriffe.** „Beitrag“ ist jeder Code, jede Dokumentation, jede Testdatei oder sonstige
   urheberrechtlich geschützte Leistung, die Sie dem Projekt übermitteln (Pull Request,
   Patch, Issue-Anhang) und die Sie nicht ausdrücklich als „kein Beitrag“ kennzeichnen.
2. **Urheberrecht bleibt bei Ihnen.** Dieser Vertrag überträgt Ihr Urheberrecht nicht
   (das ist nach § 29 Abs. 1 UrhG nicht möglich). Sie räumen dem Projekt die in Ziffer 3
   beschriebenen Nutzungsrechte ein.
3. **Nutzungsrechteeinräumung.** Sie räumen dem Projekt ein **räumlich, zeitlich und
   inhaltlich unbeschränktes, übertragbares und unterlizenzierbares Nutzungsrecht** an
   Ihrem Beitrag ein, **einschließlich der Nutzungsarten, die zum Zeitpunkt dieses Vertrags
   noch nicht bekannt sind** (§ 31 Abs. 4 UrhG). Das umfasst ausdrücklich: Vervielfältigung,
   Verbreitung, öffentliche Zugänglichmachung, Bearbeitung und die Lizenzierung des
   Beitrags — allein oder als Teil eines Gesamtwerks — unter **jeder** Lizenz, auch unter
   einer kommerziellen oder einer Closed-Source-Lizenz.
4. **Patentlizenz.** Sie räumen dem Projekt und allen Empfängern der Software eine
   weltweite, unentgeltliche, nicht ausschließliche Patentlizenz an den Patenten ein, die
   Ihr Beitrag verletzen würde, soweit das zur Nutzung des Beitrags erforderlich ist.
5. **Zusicherungen.** Sie sichern zu: der Beitrag ist Ihr eigener oder Sie sind sonst zur
   Einräumung berechtigt; der Beitrag verletzt keine Rechte Dritter; wenn ein Arbeitgeber
   Rechte am Beitrag haben könnte, haben Sie dessen Zustimmung eingeholt oder der
   Arbeitgeber unterzeichnet Anhang A.2.
6. **Keine Pflicht zur Aufnahme.** Das Projekt muss keinen Beitrag aufnehmen.
7. **Keine Vergütung, kein Support.** Sie schulden keinen Support; das Projekt schuldet
   keine Vergütung.
8. **Namensnennung.** Das Projekt darf Ihren Namen/Git-Handle in `CONTRIBUTORS.md` und in
   Commit-Metadaten nennen; eine Pflicht dazu besteht nicht.
9. **Anwendbares Recht/Gerichtsstand:** <zu ergänzen — Deutschland, Sitz des Inhabers>.

### A.2 Corporate CLA (Kurzform, Entwurf)

Der Arbeitgeber als Rechteinhaber räumt die Rechte der Ziffer 3/4 für Beiträge seiner
Mitarbeitenden ein, nennt die berechtigten Personen (oder eine Liste mit Nachmeldung) und
bestätigt, dass die Beiträge arbeitsvertraglich erfasst sind. Unterschrift zeichnungsberechtigt.

### A.3 Wie die Signatur erfasst wird (Vorschlag, technisch)

1. **Einmalig, nicht pro Commit:** ein Bot (z. B. `cla-assistant`-Muster) hängt die
   Signatur an den PR ab dem ersten Fremdbeitrag; die Signatur wird als Datensatz
   (Name, Handle, Zeitpunkt, Vertragsfassung) versioniert gespeichert — **die Fassung**
   gehört dazu, sonst ist nach einer Änderung offen, was zugestimmt wurde.
2. **DCO bleibt zusätzlich** als Herkunftssignal: `git commit -s`, Prüfung im Test
   (`COVERED` ist damit nicht nur Vertrauen, sondern nachweisbar).
3. **Protokoll im Baum:** `docs/legal/contributors.md` (Handle, Datum, Vertragsfassung) —
   damit die Rechtekette nicht in einem SaaS-Dashboard liegt, das wir nicht besitzen.

---

## Anhang B — Was bei welcher Entscheidung im Repo passiert (Checkliste, 1 PR)

**Wenn E1 = Apache-2.0:**

- [ ] `LICENSE` → Apache-2.0-Text, `Copyright 2026 <Inhaber>`; `NOTICE` anlegen
- [ ] `"license": "Apache-2.0"` in Root + 29 Paketen (eine Änderung, `npm run check:manifests`
      und `manifests.test.ts` prüfen die Gleichheit mit dem Root)
- [ ] `README.md`, `CONTRIBUTING.md`, `package.json`-Verweise; `docs/adr/0061-*.md`;
      `CHANGELOG.md`: „Wechsel MIT → Apache-2.0, gilt ab Version X; bis dahin Veröffentlichtes
      bleibt MIT“
- [ ] `architecture/architecture.yaml` (`licenses`): Apache-2.0 bleibt erlaubt — Eintrag prüfen,
      `npm run check:licenses` laufen lassen

**Wenn E2 = CLA:**

- [ ] `CONTRIBUTING.md`: Abschnitt „Contributions and rights“ mit Verweis auf den CLA und
      darauf, was er **nicht** verlangt (kein Copyright-Verlust)
- [ ] `CODEOWNERS`: Rechtsfragen an den Inhaber; `TRADEMARK.md` verlinken
- [ ] `docs/legal/` mit Vertragsfassung + `contributors.md`
- [ ] `docs/adr/0062-*.md`, Test/Workflow erst ab dem ersten Fremdbeitrag (heute hat das
      Repo keinen externen Beitrag — die Datei sagt das ehrlich)

**Wenn E2 = DCO (Alternative):**

- [ ] `CONTRIBUTING.md` + PR-Template: `Signed-off-by` verlangt; Prüfung im Test, sobald der
      erste Fremdbeitrag da ist
- [ ] Dokumentierte Konsequenz: **keine Umstellung ohne Zustimmung aller Beitragenden**

**In jedem Fall:**

- [ ] `docs/standards/conformance.md` (Prozess-Normen: Rechte/Prozess-Zeile) und
      `docs/architecture/open-core-dual-licensing.md` (Phase-0-Zeilen) im selben PR
      (Regel 34.24)
- [ ] `AGENTS.md`-Changelog + 0.E-Einträge schließen

---

## Anhang C — Warum die Reihenfolge so ist

```text
Rechte geklärt (E1/E2 entschieden, CLA liegt vor)
   ▼
Beitragsinstrument in Kraft  ←—— ab hier wächst die Rechtekette *belegbar*
   ▼
Veröffentlichungsreife (files/dist-Regeln greifen, Registry-Zugang aus dem Runbook)
   ▼
erste Veröffentlichung der Vertragspakete (Phase 3)
   ▼
Closed-Module daneben (Phase 2/3) — erst jetzt hat die Grenze einen Gegenstand
```

Die Kette ist nicht umsortierbar: Eine Veröffentlichung ohne geklärte Rechte ist die eine
Handlung, die sich nicht zurücknehmen lässt (Konzept §4.7: „nichts zurücknehmen, was schon
veröffentlicht war“).

**Zugehörig:** [`docs/operations/registry.md`](../operations/registry.md) (Runbook
Veröffentlichung), [`docs/flows/open-core-boundary.md`](../flows/open-core-boundary.md)
(die gebaute Grenze), ADR [0059](../adr/0059-contracts-are-frozen-and-measured.md)/[0060](../adr/0060-third-party-licences-are-checked.md),
`LICENSE`, `CONTRIBUTING.md`, `.github/CODEOWNERS`.
