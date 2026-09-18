# `formal/` — die formale Referenz

Zwei Produktionsverträge haben hier ein zweites, maschinenlesbares Zuhause:
die **ISO-TP-Segmentierung** (ISO 15765-2) und die **Write-Safety-Kette**
(Permit, Stufenmaschine, Fail-closed-Regeln). Die Haskell-Module sind
*Referenzmodelle*, keine Laufzeit-Abhängigkeit — TypeScript bleibt die
Produktionssprache (ADR 0002, 0045). Nichts im Produktionsbaum importiert
diesen Ordner; `npm run ci` läuft ohne Haskell-Toolchain.

## Was hier steht

| Datei | Rolle |
|---|---|
| `IsoTpStateMachine.hs` | PDU-Typen, Sende-/Empfangs-Zustände, Schritt­funktionen, Längen- und Sequenz-Invarianten |
| `IsoTpTranscript.hs` | Die Referenz-Interpretation der Vektor-Sprache: aus einem Transkript von Frame-Ereignissen wird das kanonische Ergebnis (Delivery, gesendete Frames, Zähler) |
| `SafetyCore.hs` | Typestate des Schreib-Transaktionsablaufs (GADT), Permit-Fenster, Regeltabelle als Daten |
| `SafetyTranscript.hs` | Die Referenz-Interpretation der Safety-Vektoren: precheck-Regeltabelle, `WritePort`-Fluss, Stufenreihenfolge |
| `Json.hs` | Strenter, base-only JSON-Leser/Schreiber — genau die Grammatik der Vektordateien |
| `ConformanceDriver.hs` | CLI: liest eine Vektordatei, schreibt pro Vektor eine JSON-Zeile (`{name, result}` oder `{name, error}`) |

## Die Vektoren

Die gemeinsame Test-Definition lebt **einmal** in
[`../tools/formal-conformance/vectors/`](../tools/formal-conformance/vectors/)
(`isotp.json`, `safety.json`). Dieselben Dateien prüfen:

1. die TypeScript-Produktion (`IsoTpConnection`, `SafetyManager`,
   `WritePort`, `DiagnosticTransaction`) — das ist das Gate in `npm test`;
2. die Haskell-Referenz — über den Treiber unten; die Abweichung wird als
   Vektor, Input, TS-Ergebnis, Haskell-Ergebnis und Differenzpfad ausgegeben.

Das Modellgebiet ist in jedem Vektorfile unter `modelDomain` festgeschrieben
(classic CAN, keine Padding-/FD-Flows; Safety: zählbare Regeln statt Prosa,
Caller-Richtlinien nach fehlgeschlagener Verifikation ausgenommen). Regeln
außerhalb des Gebiets sind nicht „frei“, sondern schlicht nicht verglichen.

## Ausführen

```bash
# TS-Seite (braucht keine Haskell-Toolchain):
npm run formal:conform

# TS-Seite + Haskell-Differential (will runghc oder ghc auf dem PATH):
npm run formal:conform -- --compare

# direkt:
runghc formal/ConformanceDriver.hs isotp tools/formal-conformance/vectors/isotp.json
runghc formal/ConformanceDriver.hs safety tools/formal-conformance/vectors/safety.json
```

Ohne Toolchain meldet `--compare` Exit 2 — ein *nicht geführter* Vergleich
ist nie ein grüner. Der Vitest-Lauf (`tests/protocol/formal-conformance.test.ts`)
überspringt die Haskell-Zeile sichtbar und prüft die Vergleichsmaschinerie
gegen einen hinterlegten Stub-Treiber, damit das Diff-Werkzeug selbst getestet
ist, wo kein `ghc` existiert.

## Regeln

- Base only. Kein Cabal, kein Stack, keine externen Pakete in diesem Ordner.
- Ein Vektor, den das Modell nicht interpretieren kann, wird zur Fehlerzeile
  mit Vektor-Index — nie zu einer fehlenden Zeile.
- Die kanonische Frame-Kodierung (PCI-Nibble, FF_DL, SN-Modulo, FC-Bytes)
  steht in `tools/formal-conformance/src/canonical.ts` und wird hier
  nachgebildet; wer sie ändert, ändert beides in einem Commit, sonst beißt
  das Differential-Gate.
- Model update = change of contract. Ein ADR, das die Änderung begründet
  (Vorbild: ADR 0045 richtet SafetyCore auf den Produktionsvertrag aus,
  statt die Regel stillschweigend zu überholen).
