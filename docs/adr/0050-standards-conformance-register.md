# ADR 50 — Ein Konformanz-Register mit Belegen statt einer Aussage über Industriestandard

- Status: akzeptiert (2026-09-22)
- Kontext: AGENTS 34.21 (Messung vor Behauptung), AGENTS 34.24 (Doku im selben PR),
  ADR 0045 (ehrliches `haskell NOT RUN`), ADR 0049 (Geltungsbereich einer Aussage)
- Betrifft: `docs/standards/` (neu: `README.md`, `conformance.md`,
  `iso-26262-safety-concept.md`, `hara-template.md`, `iso-21434-cybersecurity.md`),
  `docs/adr/README.md`, `architecture/architecture.yaml` (Topic `formal`)

## Problem

Die Frage „ist das Industriestandard?" hatte zwei mögliche Antworten: **ja** oder
eine Tabelle. Ein „ja" wäre unbelegbar gewesen, und ein „nein" hätte den Teil
unterschlagen, der trägt.

Gemessen wurde beides. Produktseitig nennt der Baum **70** Verweise auf
ISO 14229-1, **28** auf ISO 15765-2, **19** auf ISO 13400-2, **10** auf SAE J1979,
**2** auf SAE J2012 — mit Implementierung und Tests dahinter. Prozessseitig nennt er
**0** Verweise auf ISO 26262, ASPICE, MISRA, AUTOSAR, IEC 61508 und ISO 21434. (Der
einzige Treffer für „ASIL" war das Wort „Bra**sil**" in
`packages/definitions/src/reference/wmi.ts:107`.) Dazu, ebenfalls gemessen:
`grep -c "authoriz\|bearer\|token" apps/web/src/server.ts` → **0** bei **37**
API-Routen.

Ohne eine Stelle, an der beides steht, bleibt die Antwort eine Stimmung — und die
nächste Person, die sie braucht, misst von vorn.

## Entscheidung

**1. Ein Register, in dem jede Zeile einen Anker trägt oder als Lücke dasteht.**
`docs/standards/conformance.md`: Norm → Status → Beleg (Datei, ggf. Zeile) → Lücke →
wer → Aufwand. „Implementiert" heißt eng: Regel im Code **und** durch einen Test
gepinnt. „Steht in einem Kommentar" ist kein Nachweis.

**2. Die Prozess-Normen bekommen Gerüste, keine Behauptungen.**
Sicherheitskonzept, HARA-Arbeitsblatt und TARA-Gerüst sind so weit ausgefüllt, wie es
ohne Organisation geht — Item-Definition, Gefährdungen mit Ursache im Code,
bestehende Gegenmaßnahmen mit Beleg. **S/E/C und ASIL bleiben leer.** Eine
Einstufung, die ein Entwickler selbst setzt, ist eine Zahl ohne Geltung; sie hier
„vorläufig" zu füllen wäre genau die Verwechslung, die AGENTS 34.21 im Kleinen
verbietet.

**3. Nicht Anwendbares wird als nicht anwendbar geführt, nicht als Lücke.**
MISRA gilt für C/C++; das Äquivalent ist hier maschinell getornt (kein `any`, kein
`@ts-ignore`, kein leeres `catch`, kein `process.exit` außerhalb des Einstiegs, keine
Datei über 800 Zeilen — `tests/architecture/hygiene.test.ts`). AUTOSAR ist kein
Thema: die Plattform ist ein Diagnose-Werkzeug, keine Steuergeräte-Software. Eine
Lücke, die keine ist, verwässert die Liste der echten.

**4. Die formale Referenzseite bleibt ehrlich unbelegt.** `haskell NOT RUN` und die
unverifizierte Rust-Crate stehen im Register als **nicht verifiziert**, nicht als
„geprüft". ADR 0045 hat diese Regel gesetzt; das Register führt sie weiter.

**5. Eine Zeile, die wächst, ohne dass ihre Norm-Zeile wächst, ist ein Fehler.**
Pflege im selben PR (AGENTS 34.24), wie bei jeder anderen Doku.

## Why

- **Die Frage kommt wieder.** Ein Werkzeug, das an einem echten Fahrzeug schreibt,
  wird nach Normen gefragt — von einem OEM, einem Audit, oder der nächsten Person,
  die es einsetzen will. Die Antwort sollte eine Datei sein, keine Erinnerung.
- **Eine Lücke mit Namen ist bearbeitbar.** „ISO 21434 fehlt" ist ein Satz;
  „keine Authentifizierung bei 37 Routen, Token + HSTS + Rate-Limit, Code-Teil hier
  machbar" ist eine Aufgabe.
- **Ehrlichkeit ist hier die billigere Option.** Ein Register, das „alle Normen
  erfüllt" behauptet, müsste bei der ersten Nachfrage zurückgezogen werden — und
  hätte dann auch die Teile entwertet, die tatsächlich tragen.

## Alternatives

1. **Nichts dokumentieren, weil die Normen nicht erfüllt sind.** Verworfen: dann
   misst die nächste Person dasselbe von vorn, und der Teil, der trägt, bleibt
   unsichtbar.
2. **Eine Zertifizierung anstreben.** Nicht möglich und nicht Aufgabe eines PR:
   26262 und ASPICE sind Assessments einer Organisation.
3. **S/E/C/ASIL „vorläufig" ausfüllen, damit das Arbeitsblatt nicht leer aussieht.**
   Verworfen — eine Zahl ohne benannte Person ist Dekoration, und Dekoration in
   einem Sicherheitsdokument ist schlimmer als ein leeres Feld.
4. **MISRA als Lücke führen.** Verworfen: MISRA C/C++ auf einen TypeScript-Baum
   anwenden zu wollen wäre ein Missverständnis, das als Aufgabe getarnt ist.

## Affected packages

Kein Produktionscode. `docs/standards/` (5 Dateien), `docs/adr/README.md`,
`architecture/architecture.yaml` (ADR 0050 im Topic `formal`).

## Forbidden implementations

- **Einen Status ohne Beleg schreiben.** Jede „implementiert"-Zeile nennt eine Datei.
- **S/E/C oder ASIL setzen**, ohne benannt zu sein.
- **Eine nicht anwendbare Norm als Lücke führen** — das verwässert die echten.
- **`haskell NOT RUN` oder die Rust-Crate als verifiziert darstellen.**
- **Diese Dateien als Zertifikat oder Selbstauskunft zitieren.** Sie sind eine Karte,
  kein Nachweis — das steht in `docs/standards/README.md` und gilt.

## Tests

Kein Produktionscode, also keine neuen Tests. Was das Register behauptet, ist
nachgemessen und im Dokument selbst mit dem Befehl genannt:

- `grep -rhoE "ISO ?14229-1|ISO ?15765-2|…" packages/ apps/ tools/ docs/ formal/ crates/`
  → 70 / 28 / 24 / 19 / 10 / 5 / 4 / 3 / 3 / 2 Treffer
- `grep -ril "ISO 26262|ASPICE|MISRA|AUTOSAR|IEC 61508|ISO 21434|UNECE"` → **0** Dateien
  (der einzige ASIL-Treffer ist „Brasil")
- `npm run formal:conform` → **28/28 und 44/44**, wörtlich `haskell NOT RUN`
- `npm outdated` → 5 Pakete (`@biomejs/biome` 1.9.4 → 2.5.14, `@types/node`,
  `vitest`, `@vitest/coverage-v8`, `fast-check`), `npm audit` 0 Schwachstellen
- `command -v cargo ghc stack rustc` → keines vorhanden

## AI implementation notes

- Wer eine Norm-Implementierung ändert, ändert ihre Zeile in
  `docs/standards/conformance.md` **im selben PR**.
- Neue Belege brauchen Datei **und** Zeile, wenn die Zeile die Regel trägt. Ein
  Beleg, der nach einer Umbenennung nicht mehr stimmt, ist schlimmer als keiner.
- Die Gerüste sind Vorlagen: ausfüllen ja, ASIL setzen nein.
- `npm run ai:context formal` projiziert dieses ADR (Topic `formal`); ein neues
  Norm-Dokument gehört zusätzlich in `docs/standards/README.md`'s Tabelle.
