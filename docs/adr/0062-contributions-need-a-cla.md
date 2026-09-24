# ADR 62 — Beiträge brauchen eine Vereinbarung: Nutzungsrechte statt „Assignment“

- Status: akzeptiert (2026-09-23)
- Kontext: [`docs/architecture/open-core-phase-0-rights.md`](../architecture/open-core-phase-0-rights.md)
  (Entscheidung E2, mit Messung), [`docs/legal/cla.md`](../legal/cla.md) (Fassung 1.0),
  ADR [0061](0061-license-apache-2-0.md) (Apache-2.0), ADR 0059/0060,
  AGENTS 24/35, GitHub-Teilnahmebedingungen (inbound = outbound)
- Betrifft: `docs/legal/cla.md` (neu), `docs/legal/contributors.md` (neu),
  `CONTRIBUTING.md` (Abschnitt *Contributions and rights*),
  `tests/architecture/legal.test.ts` (neu), `.github/CODEOWNERS`

## Problem

Ohne Beitragsvereinbarung gilt für jeden Pull Request **inbound = outbound**: Der Beitrag
steht unter der Lizenz des Repositories, und darüber hinaus wurde nichts eingeräumt.
Gemessen am 2026-09-23 im Baum: kein CLA, kein DCO, kein `Signed-off-by`
(`grep -ri "dco\|signed-off" CONTRIBUTING.md .github/` → nichts), ein Commit, ein Autor.

Für ein Projekt, das

1. den Kern später unter einer anderen Lizenz führen,
2. geschlossene Module daneben verkaufen, oder
3. das Projekt übertragen/verkaufen

will, ist das zu wenig: **Jede** dieser Entscheidungen bräuchte die Zustimmung **jedes
einzelnen** Beitragenden, der jemals Code beigesteuert hat. Ein einziger Widerspruch
blockiert dauerhaft — und die Kosten wachsen monoton mit der Zahl der Beitragenden.

Dazu kommt eine deutsche Besonderheit, an der viele CLA-Vorlagen scheitern: Ein
„Copyright Assignment“-CLA (US-Vorbild) verspricht die **Übertragung** des Urheberrechts.
Das ist nach **§ 29 Abs. 1 UrhG nicht möglich**; möglich sind die Einräumung von
Nutzungsrechten (§ 31) und Rechtsgeschäfte über Urheberpersönlichkeitsrechte (§ 39). Ein
CLA, der „assign“ sagt, erzeugt hier also nicht, was er behauptet.

## Entscheidung

**Beiträge werden erst nach einer unterschriebenen Vereinbarung angenommen** — einer
CLA-Fassung, die Nutzungsrechte einräumt (nicht „Assignment“), plus DCO als
Herkunftssignal.

1. **`docs/legal/cla.md`, Fassung 1.0** ist der Vertragstext: Individual (A.1),
   Corporate-Kurzform (A.2), Erfassung der Zustimmung (A.3, versioniert).
2. **Was eingeräumt wird** (§ 2 des Vertrags): ein räumlich, zeitlich und inhaltlich
   unbeschränktes, übertragbares und unterlizenzierbares Nutzungsrecht — ausdrücklich
   **einschließlich noch unbekannter Nutzungsarten** (§ 31 Abs. 4 UrhG) und des Rechts,
   unter jeder Lizenz zu veröffentlichen, auch unter einer kommerziellen oder
   Closed-Source-Lizenz.
3. **Patentlizenz** mit Vergeltungsklausel (§ 3) — auch für Beiträge *vor* einem
   Lizenzwechsel, damit der Grant nicht an der Umstellung hängt.
4. **Was ausdrücklich *nicht* passiert** (§ 1, § 5): kein Verlust des Urheberrechts, keine
   exklusive Bindung, kein Supportzwang, keine Vergütung; Widerruf wirkt nur für die
   Zukunft.
5. **DCO zusätzlich:** `git commit -s` bleibt verlangt, ist aber **kein Ersatz** — es
   bescheinigt Herkunft, nicht Rechte.
6. **Das Register liegt im Repository** (`docs/legal/contributors.md`): Handle, Datum,
   **Fassungsnummer**. Eine neue Fassung verlangt erneute Zustimmung — die Fassungsnummer
   ist deshalb Pflichtspalte.
7. **Der Inhaber braucht keine Zustimmung** (eigenes Werk) — die Datei sagt das, damit
   niemand eine fehlende Zeile als Lücke liest.
8. **Die Vereinbarung ist ab Inkrafttreten Bedingung für den Merge** eines Fremdbeitrags;
   Zustimmungen werden im PR-Kommentar erteilt (Satz wörtlich in `cla.md`). Ein
   Signaturwerkzeug/Bot ist **noch nicht** verdrahtet und in 0.E E28 als offen vermerkt —
   bis dahin ist der PR-Kommentar der Beleg, und das steht so im Text.

## Why

- **Es ist der eine Moment, in dem es billig ist.** Heute ist der Rechteinhaber eine
  Person; nach dem ersten Fremdbeitrag ist die Umstellung nur noch mit Zustimmung aller
  möglich. Ein später eingeführter CLA kann die Vergangenheit nicht heilen — nur die
  Zukunft.
- **Die Argumentation ist offen, nicht versteckt.** Der Vertrag sagt in § 2 selbst, *warum*
  er über die Projektlizenz hinausgeht. Wer das nicht will, trägt nicht bei — und das ist
  besser als ein Beitrag, dessen Rechte unklar sind.
- **Der Verzicht auf „Assignment“ ist der deutsche Punkt, der zählt.** Nutzungsrechte
  einräumen (§ 31) statt Urheberrecht übertragen (§ 29) — dieselbe wirtschaftliche Wirkung
  für die Entscheidungen des Projekts, ohne einen unwirksamen Satz im Vertrag.
- **Das DCO ist trotzdem nützlich.** Es ist die Herkunftsbestätigung je Commit (kein
  fremder Code, keine unlizenzierten Daten — AGENTS 24) und passt zu einem Repo, dessen
  Tests Herkunft prüfen (`provenance`, ADR 0003).

## Alternatives

1. **Nur DCO.** Verworfen: Das DCO gewährt **nichts** zusätzlich, es bescheinigt nur. Ohne
   CLA wäre jede spätere Lizenzentscheidung blockierbar — also genau das Risiko, das E2
   adressiert.
2. **Keines von beiden (Status quo).** Verworfen: Es funktioniert bis zum ersten
   Fremdbeitrag und erzeugt Abhängigkeit von dessen Wohlwollen.
3. **Copyright Assignment (US-Stil).** Verworfen: Nach § 29 Abs. 1 UrhG nicht wirksam;
   ein Vertrag, der Unmögliches verspricht, ist schlechter als keiner.
4. **CLA erst ab dem ersten Fremdbeitrag einführen.** Verworfen: Der Text muss *vor* dem
   ersten Beitrag stehen, sonst muss man mit dessen Autor nachverhandeln; die Datei kostet
   jetzt nichts und ist später Bedingung.
5. **Ein Signaturwerkzeug als Voraussetzung.** Verworfen: Das Repo kann Workflows nicht
   schreiben (0.E E10), und ein Werkzeug ohne Beiträge ist Aufschub. Der Vertrag sagt
   ehrlich, wie die Zustimmung bis dahin belegt wird.
6. **Verzicht auf die Markenklausel in § 6.3.** Verworfen: Der CLA könnte sonst so gelesen
   werden, als gäbe er einem Beitragenden Markenrechte — die Klarstellung ist
   für beide Seiten besser (ADR 0061, `TRADEMARK.md`).

## Affected packages

| Datei | Auswirkung |
|---|---|
| `docs/legal/cla.md` | neu: Vertragstext Fassung 1.0 (Individual, Corporate, Erfassung) |
| `docs/legal/contributors.md` | neu: Rechteregister (heute leer, mit Begründung) |
| `CONTRIBUTING.md` | Abschnitt *Contributions and rights* + Hinweis im Schnellstart |
| `tests/architecture/legal.test.ts` | prüft, dass Vereinbarung und Register existieren und verlinkt sind |
| `.github/CODEOWNERS` | Rechtsfragen an den Inhaber (Kommentar) |
| Quellcode | **keine** Änderung |

## Forbidden implementations

- **„Assignment“/„übertragen“ in irgendeine Fassung schreiben.** Es verspricht etwas, das
  § 29 Abs. 1 UrhG nicht zulässt.
- **Die Zustimmung als gegeben annehmen**, weil jemand einen PR geöffnet hat. Ohne
  Vereinbarung gilt inbound = outbound — und damit nichts über die Projektlizenz hinaus.
- **Eine Zeile im Register ohne Fassungsnummer.** Nach einer Textänderung wäre offen, was
  zugestimmt wurde.
- **Eine Zustimmung erfinden, ergänzen oder „nachtragen“.** Das Register ist ein Beleg,
  kein Protokoll über Meinungen.
- **Die Vereinbarung als Deckmantel für eine Rechteübernahme darstellen.** Die
  Zusicherungen in § 5/§ 6 gehören zum Vertrag wie die Einräumung in § 2.

## Migration

1. `docs/legal/cla.md` (Fassung 1.0) und `docs/legal/contributors.md` (leer, mit Messung).
2. `CONTRIBUTING.md`: Abschnitt, Verweis, DCO-Satz.
3. Register-Eintrag ADR 0062, `CHANGELOG.md`.
4. Gate in `tests/architecture/legal.test.ts` (Existenz, Fassung, Verlinkung, Register).
5. Konzept-Phase 0, `docs/standards/conformance.md`, AGENTS 1.50 + 0.E E28 (offen: Bot,
   juristische Prüfung).
6. **Erste Fremdbeitragung:** Zustimmungssatz im PR, Zeile im Register mit Datum und
   Fassung — und erst dann der Merge.

## Tests

- `tests/architecture/legal.test.ts`: `docs/legal/cla.md` existiert, nennt eine
  Fassungsnummer und die Wirksamkeitsgrenze („§ 29 Abs. 1 UrhG“, Nutzungsrechte);
  `docs/legal/contributors.md` existiert und nennt die Fassung; `CONTRIBUTING.md` verlinkt
  beide; `TRADEMARK.md` verlinkt den CLA.
- `tests/architecture/docs.test.ts`: der Link-Check deckt die neuen Dateien mit ab (Datei
  **und** Anker) — eine Rechte-Seite, die ins Leere verlinkt, ist keine Rechte-Seite.
- `npm run ci`: unverändert grün; der CLA-Text ist Doku, kein Build-Schritt.

## AI implementation notes

- Ein Agent darf **keine** CLA-Zustimmung formulieren, ergänzen oder im Namen einer Person
  abgeben. Fehlt sie bei einem Fremdbeitrag, ist der Merge blockiert — das ist der Punkt,
  nicht eine Formalie.
- Beim Schreiben über die Vereinbarung nie „assignment“, „übertragen“ oder „abtreten“
  verwenden: Nutzungsrechte werden eingeräumt (§ 31), das Urheberrecht bleibt (§ 29).
- Änderungen am Vertragstext sind Fassungsänderungen: Nummer erhöhen, Register-Spalte
  mitziehen, erneute Zustimmung verlangen.
- Die juristische Prüfung ist offen (ADR 0061/0062 ➜ 0.E E28); ein Agent darf den Text
  nicht als „geprüft“ bezeichnen.
