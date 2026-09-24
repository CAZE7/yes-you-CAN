# ADR 61 — Der Kern steht unter Apache-2.0, und der Name bleibt draußen

- Status: akzeptiert (2026-09-23)
- Kontext: [`docs/architecture/open-core-phase-0-rights.md`](../architecture/open-core-phase-0-rights.md)
  (Entscheidung E1, mit Messung), [`TRADEMARK.md`](../../TRADEMARK.md),
  ADR 0002 (keine Laufzeit-Abhängigkeiten), ADR 0059/0060 (Vertragsfläche, Lizenzen),
  `docs/architecture/open-core-dual-licensing.md` §3.1
- Betrifft: `LICENSE` (MIT → Apache-2.0), `NOTICE` (neu), `TRADEMARK.md` (neu),
  `"license"` in 30 Manifesten (Root + 29 Pakete), `README.md` (Badge),
  `CONTRIBUTING.md`, `docs/legal/` (neu), `tests/architecture/legal.test.ts` (neu),
  Konzept und AGENTS

## Problem

Das Repository stand unter MIT, mit der Copyright-Zeile „yes-you-CAN Contributors“.
Für die Zielarchitektur (offener Kern, geschlossene Module über Verträge, kommerzielle
Angebote daneben) fehlten drei Dinge, die MIT nicht regelt:

1. **Patentfrieden.** MIT erwähnt Patente nicht. Wer den Kern in ein Produkt einbaut,
   bekommt von den Beitragenden keine Patentlizenz — bei Fahrzeugdiagnose, wo
   Herstellerpatente auf Dienste und Verfahren liegen können, ist das die erste Frage
   einer Lieferantenprüfung.
2. **Marke.** MIT sagt nichts über den Namen. Ohne ausdrückliche Klarstellung kann ein
   Fork wie das Original auftreten (und das Original kann umgekehrt nicht sauber
   argumentieren, was es selbst duldet).
3. **Kennzeichnung von Änderungen.** Apache-2.0 verlangt (§ 4b/§ 4c), dass geänderte
   Dateien als geändert erkennbar sind und Attributionshinweise erhalten bleiben; MIT
   verlangt nur die Beibehaltung des Lizenztextes. Für Code, der in Prüfsummen,
   Konformanzbelege und einen Vertragsrecord (ADR 0059) eingeht, ist die erste Variante
   die belastbarere.

Dazu kam die Reihenfolge-Frage: Die Umstellung braucht die Zustimmung **aller**
Rechteinhaber. Gemessen am 2026-09-23: `git rev-list --count HEAD` = **1**, ein Autor,
keine Fremdbeiträge. Die Umstellung ist heute also ohne Fremdzustimmung möglich und nach
dem ersten angenommenen Fremdbeitrag nur noch mit Zustimmung jeder einzelnen Person — oder
per Clean Room.

## Entscheidung

**Der Quelltext dieses Repositories steht unter der Apache License 2.0.**

1. **`LICENSE`** enthält den vollständigen Apache-2.0-Text (kanonische Fassung,
   11357 Zeichen inklusive Anhang; nicht gekürzt, nicht umformuliert).
2. **`NOTICE`** nennt Projekt, Copyright und die Tatsache, dass Fremdcode seine
   Lizenzhinweise bei sich trägt (`npm run check:licenses`, ADR 0060) — die Pflicht aus
   § 4d, erfüllt mit einer Zeile, die nichts behauptet, was nicht gemessen ist.
3. **`"license": "Apache-2.0"`** in Root-Manifest und allen 29 Paketen
   (`manifests.test.ts` hält die Gleichheit; `legal.test.ts` hält den Wert fest).
4. **`TRADEMARK.md`** sagt, was die Lizenz **nicht** abdeckt: Namen und Marken (§ 6).
   Beschreibende Verwendung und Fork-Kennzeichnung sind ausdrücklich erlaubt, ein Produkt
   unter unserem Namen braucht Zustimmung.
5. **Der MIT-Stand bleibt MIT.** Bereits veröffentlichte oder als Commit verbreitete
   Fassungen bleiben unter MIT nutzbar; Apache-2.0 gilt für alle neuen Fassungen ab
   diesem Datum. Das ist keine Rücknahme, sondern die übliche Wirkung eines
   Lizenzwechsels — und die einzige Richtung, die Konzept §4.7 zulässt.
6. **AGPL-3.0 wurde bewusst verworfen** (Begründung im Konzept §3.1): Sie würde das
   Zielbild gefährden — unser Closed-Teil *importiert* Kernmodule, und ob das eine
   abgeleitete Werkfrage auslöst, ist genau die Frage, die man nicht nachträglich klären
   will; zusätzlich ist sie für Werkstatt-/OEM-Deployments oft ein Ausschlusskriterium.

## Why

- **Der Nutzen liegt bei den Kunden, nicht bei uns.** Beide Lizenzen erlauben den
  kommerziellen Einsatz; Apache-2.0 fügt das hinzu, was eine Rechtsabteilung prüft:
  Patentgrant mit Vergeltungsklausel, Kennzeichnungspflicht, klare Markenabgrenzung.
- **Der Patentgrant ist nicht nachrüstbar.** Er gilt für Beiträge, die unter dieser
  Lizenz eingereicht wurden. Je später die Umstellung, desto mehr Beiträge stehen ohne
  ihn da — und desto teurer wird die Nachverhandlung.
- **Die Markenklarstellung ist ein Schutz, keine Beschneidung.** Ohne sie wäre jede
  Fork-Frage Auslegungssache; mit ihr ist die Antwort eine Zeile in `TRADEMARK.md`.
- **Beide Gates bleiben grün und werden schärfer:** `check:licenses` (ADR 0060) erlaubt
  Apache-2.0 in beiden Geltungsbereichen; die Lizenzprüfung ist vom Projektinhalt
  unabhängig. Ein neues Gate kommt hinzu (unten), weil eine Lizenz, die niemand prüft,
  eine Behauptung ist (ADR 0029).

## Alternatives

1. **MIT behalten.** Verworfen: kein Patentgrant, keine Markenaussage, keine
   Änderungskennzeichnung — genau die drei Punkte, für die umgestellt wird. Der
   Unterschied liegt *nicht* darin, ob jemand den Kern kommerziell nutzen darf.
2. **AGPL-3.0.** Verworfen, siehe Entscheidung 6.
3. **Dual „MIT OR Apache-2.0“ (Rust-Stil).** Verworfen: Die zweite Option existiert dort
   nur für GPL-2.0-Kompatibilität. Diese Kompatibilität brauchen wir nicht (wir nehmen
   keinen GPL-2.0-only-Code auf, `check:licenses` verbietet ihn), und zwei Lizenzen
   verdoppeln die Erklärungslast in jeder Lieferantenprüfung.
4. **Lizenzwechsel ohne CLA.** Verworfen: funktioniert genau einmal (heute), und danach
   nie wieder — deshalb ist ADR 0062 derselbe PR.
5. **`LICENSES/`-Ordner mit SPDX-Dateien statt `LICENSE`.** Verworfen: Für ein einzelnes
   Werk ist die Wurzel-`LICENSE` die Erwartung, die jedes Werkzeug liest; der
   REUSE-Stil ist ein eigenes Vorhaben und nicht Teil dieser Entscheidung.

## Affected packages

| Paket/Datei | Auswirkung |
|---|---|
| alle 29 Workspace-Pakete | `license`: `MIT` → `Apache-2.0`; kein Code geändert |
| `LICENSE`, `NOTICE`, `TRADEMARK.md` | neu bzw. ersetzt |
| `README.md`, `CONTRIBUTING.md` | Badge, Lizenzhinweis, Rechteabschnitt |
| `tests/architecture/legal.test.ts` | neues Gate (4 Tests) |
| `docs/legal/*` | CLA und Rechteregister (ADR 0062) |

## Forbidden implementations

- **Den Lizenztext kürzen oder umformulieren.** Ein „eigener Apache-2.0-Text“ ist eine
  abweichende Lizenz.
- **`LICENSES`/`NOTICE` mit Behauptungen füllen, die nicht gemessen sind** (z. B.
  „enthält keine Fremdkomponenten“, solange es einen Lockfile gibt).
- **Die alte MIT-Zusage zurücknehmen.** Was unter MIT verbreitet wurde, bleibt MIT.
- **Markenrechte aus der Lizenz ableiten.** Apache-2.0 § 6 gewährt keine; wer den Namen
  braucht, fragt (oder benennt es anders).
- **Eine weitere Lizenz einführen, ohne `architecture/architecture.yaml` (`licenses`) und
  `check:licenses` mitzuziehen.**

## Migration

1. `LICENSE` (kanonischer Text), `NOTICE`, `TRADEMARK.md`.
2. `"license"` in Root + 29 Paketen auf `Apache-2.0` (ein Commit, `manifests.test.ts`
   prüft die Gleichheit mit dem Root).
3. `README.md`-Badge, `CONTRIBUTING.md` (inkl. Rechteabschnitt aus ADR 0062).
4. `docs/adr/0061` (diese Datei) + Register + `CHANGELOG.md`.
5. Gate: `tests/architecture/legal.test.ts` prüft die Entscheidung selbst — vollständiger
   Apache-Text (nicht der MIT-KurztExt), `NOTICE` vorhanden, alle Manifeste auf
   `Apache-2.0`, CLA verlinkt und versioniert.
6. Nachziehen (Regel 34.24): Konzept-Phase-0-Zeilen, `docs/standards/conformance.md`,
   AGENTS-Changelog + 0.E.

## Tests

- `tests/architecture/legal.test.ts` — 4 Tests: (1) `LICENSE` ist der vollständige
  Apache-2.0-Text (§§ 1–9, „END OF TERMS AND CONDITIONS“, Anhang, > 10 000 Zeichen) und
  enthält den MIT-Haftungskurztext nicht als Ersatz; (2) `NOTICE` existiert und nennt
  Projekt und Copyright; (3) das Root-Manifest **und** jedes Workspace-Manifest nennen
  `Apache-2.0` (der Wert, nicht nur die Gleichheit — das ist die Entscheidung);
  (4) `docs/legal/cla.md` existiert, trägt eine Fassungsnummer, `docs/legal/contributors.md`
  existiert, und `CONTRIBUTING.md` verlinkt beide.
- `tests/architecture/docs.test.ts` — Link-Check deckt `TRADEMARK.md` und `docs/legal/*`
  mit ab (Dateien **und** Anker).
- `npm run check:licenses` — unverändert grün: 108 Drittpakete, 0 Produktion /
  108 Entwicklung, Apache-2.0 ist in beiden Geltungsbereichen erlaubt (ADR 0060).
- `npm test` — `manifests.test.ts` („every package declares the license the root
  declares“) ist der zweite Zeuge der Umstellung.

## AI implementation notes

- Eine neue Datei mit Lizenzkopf trägt `Apache-2.0`; die alte MIT-Zeile gehört nirgends
  mehr hinein.
- Wer fremden Code aufnimmt, prüft ihn gegen `check:licenses` **und** nennt Herkunft und
  Lizenz im PR (AGENTS 24/34.20) — Apache-2.0 nimmt Apache-2.0/ MIT/ BSD auf, aber kein
  GPL-2.0-only.
- Der Markenabschnitt ist für Agenten verbindlich wie für Menschen: Ein Agent darf den
  Namen nicht als Produktnamen verwenden, und er darf keine Markenrechte zusagen.
- Die Lizenzaussage **nicht** in README-Badges oder Docs „modernisieren“, ohne
  `LICENSE`/`NOTICE`/Manifeste und `legal.test.ts` mitzuziehen — der Test liest die
  Entscheidung, nicht die Prosa.
