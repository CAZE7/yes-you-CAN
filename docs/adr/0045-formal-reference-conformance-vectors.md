# ADR 45 — Formale Referenz und Konformanz: gemeinsame Testvektoren statt Parallel-Exegese

- Status: akzeptiert (2026-09-18)
- Kontext: ADR 0032 (Schreibpfad als eigener Port), ADR 0039 (Fault-Injection auf
  der Link-Seam), ADR 0042 (Manifest ⇔ Importgraph), ADR 0043
  (AI-Kontextschicht — Topics, die auf diese Entscheidung verweisen), AGENTS 22/26,
  Master-Prompt §17–§21 (TypeScript ↔ Haskell Konformanz)
- Betrifft: `tools/formal-conformance/` (neu, `@vdp/formal-conformance`),
  `formal/Json.hs`, `formal/IsoTpTranscript.hs`, `formal/SafetyTranscript.hs`,
  `formal/ConformanceDriver.hs` (neu), `formal/SafetyCore.hs` (auf
  Produktionsvertrag gebracht), `packages/transport/iso-tp/src/connection.ts`
  (Wire-Guards), `architecture/architecture.yaml` (Paket + Topic `formal`),
  `package.json` (`formal:conform`), `tests/protocol/formal-conformance*.test.ts`,
  `tests/hardware/socketcan-conformance.test.ts`, `tests/architecture/hygiene.test.ts`
  (Exit-Punkt-Ausnahme), `formal/README.md` (neu)

## Problem

Die ISO-TP-Segmentierung und die Safety-Kette des Schreibpfads sind an ihren
eigenen Tests grün — aber „grün gegen den eigenen Test“ heißt nicht „grün gegen
die Norm“. Eine zweite Implementierung als Prüfstein löst das nur, wenn beide
dieselben Fälle mit demselben Erwartungsgrad laufen; sonst entstehen zwei
Wörterbücher für dieselbe Frage, und die Deutungshoheit wandert in die Tests.
Zusätzlich stand das Problem der Ehrlichkeit im Raum: eine Haskell-Referenz, die
im Sandbox-Alltag niemand ausführen kann, darf nicht als „verifiziert“ in einen
Bericht geschrieben werden.

## Entscheidung

1. **Vektordateien sind der Vertrag, nicht Kommentare.** `tools/formal-conformance/vectors/isotp.json`
   (28 Vektoren) und `vectors/safety.json` (44 Vektoren) beschreiben jede
   Konformanzstelle vollständig: Eingangstranskript, Zeitbasis, erwartetes
   Ausgangstranskript und erwartete Zustandsübergänge. Beide Seiten —
   TypeScript und Haskell — werden gegen **dieselbe Datei** grading; es gibt
   keine erwartungslose Seite. Der Parser (`src/vectors.ts`) ist strict:
   unbekannte Felder, fehlende Felder, ein weggelassener Vektor ohne Grund —
   Abbruch, nicht Toleranz. (Ein Vektor, der stillschweigend fällt, ist eine
   grün gemeldete Lücke.)
2. **Kanonische Codierung ist eine Funktion, kein Dialekt.** `src/canonical.ts`
   definiert Frame-Codierung (`id/dlc/data`), kanonisches JSON und einen
   strukturierten Diff (`diffPaths`) — die Haskell-Seite (`formal/Json.hs`,
   `formal/ConformanceDriver.hs`) implementiert dieselbe Kodierung gegen
   dieselben Vektoren, nicht gegen eine Abschrift.
3. **Der TypeScript-Läufer fährt Produktionscode.** `runIsoTpVector` treibt die
   echte `IsoTpConnection` über eine Bus-Seam (`ConformancePair`); default ist ein
   Skript-Bus, `tests/protocol/formal-conformance-bus.test.ts` fährt dieselben
   Vektoren über den `VirtualCanPair`. `runSafetyVector` treibt
   `SafetyManager.evaluate` (precheck), `WritePort.run` (flow) und
   `DiagnosticTransaction` (stages) — keine Test-Doubles der Policy.
4. **Die Haskell-Seite ist Referenz, nie Laufzeitabhängigkeit.** Der Treiber
   `formal/ConformanceDriver.hs` läuft mit `runghc`/`runhaskell` und schreibt
   JSONL; der Vergleich läuft nur, wenn das Toolchain-Discovery (`findHaskellInterpreter`)
   einen Interpreter findet. **Wo keiner gefunden wird, sagt der Bericht
   `haskell NOT RUN`** — im CLI-Abschluss, im Test (skip mit Grund), und im
   Final Report. Kein Gate behauptet je eine Verifikation, die nicht stattfand.
5. **Wire-Konformanz gehört in den Transport, nicht in den Läufer.** Die Guards
   gegen ISO-15765-2-Abweichungen (leere Payload, Classic-CAN > 4095, FF mit
   DL ≤ 7, Fluchtzeichen im SF, Sequenz-/Überlauf-Fehler als strukturierte
   Details) wohnen in `packages/transport/iso-tp/src/connection.ts`; die
   Vektormenge prüft sie, die Implementierung entscheidet sie.
6. **Der SafetyCore wurde nachgezogen, nicht die Produktion.** Die Haskell-
   Vorstufe (`formal/SafetyCore.hs`, ADR-0032-Zeit) hatte eine „Motor aus /
   Gang P-N“-Precheck-Tabelle, die es in der Produktion nie gab. Richtigstellung
   in der Gegenrichtung: die Haskell-Referenz bildet **den Produktionsvertrag**
   ab (stationär / Zündung / Spannung / Bremse, Typestate-GADTs bleiben).
   Eine Referenz, die der Produktion vorauseilt, erzeugt Differenzen, die keine sind.
7. **Bewusste Ausschlüsse sind dokumentiert, nicht stillschweigend:**
   (a) Flow-Vektoren erwarten `unproven`-Anteil 0, weil `WritePort.run` die
   unproven-Liste verwirft, `precheck` sie behält — dokumentiert im Vektorfeld
   `modelDomain`; (b) die „nie gemeldet“-Zweige der Session-/Stationär-Prechecks
   sind durch typisierte Aufrufer unerreichbar und bleiben aus den Vektoren
   draußen; (c) Verify-Mismatch-Caller-Policy (Core bricht ab, die UI fragt
   nach) ist Caller-Verhalten, nicht Modell — kein Vektor.
8. **Hardware-Konformanz ist vorbereitet, nicht behauptet.**
   `tests/hardware/socketcan-conformance.test.ts` fährt die Vektormenge über
   `vcan0` + echtem SocketCAN-Binding, gated auf beides; ohne Vcan antwortet der
   Test mit Skip und Grund, nicht mit Erfolg.

## Why

- **Eine Erwartungsquelle, zwei Geprüfte:** Vektordatei statt Prosa bedeutet,
  dass TypeScript-Refactoring und Haskell-Änderung gegeneinander messbar sind;
  die Differenzliste (`diffPaths`) ist das Artefakt, nicht das Gefühl.
- **Ehrlichkeit als Design:** every skip carries its reason (`{ skip:
  runner === null }`), every report line „NOT RUN“ is greppable. Ein Projekt, das
  formale Verifikation nicht vorspielt, aber ihre Buchhaltung ernst nimmt, ist
  glaubwürdiger als ein vorgetäuschtes Grün.
- **Kein Parallel-System:** der Läufer importiert `@vdp/core` und
  `@vdp/transport-iso-tp`, weil seine Aufgabe ist, sie zu fahren (tool-Layer im
  Manifest, ADR 0031/0042); nichts importiert ihn, kein Produktivpfad hängt an ihm.

## Alternatives

- **Golden Files statt Vektoren:** abgelehnt — ein Golden File vergibt
  Abweichungen, wo ein Vektor einen Grund verlangt; außerdem wäre die Haskell-
  Seite dann Zweite im Rat der Erwartungen.
- **Haskell via FFI/wasm in den Build holen:** abgelehnt — ADR 0002
  (Laufzeitabhängigkeiten) und der Zweck der Referenz (Prüfstein, nicht
  Laufzeit); der Build darf nicht an einen Toolchain-Knoten außerhalb des
  Repositorys hängen.
- **Nur TypeScript-Tests mit „spec notes“:** abgelehnt — notes sind die
  zweite Quelle für dieselbe Frage; die Vektordatei ist die erste.

## Affected packages

- `tools/formal-conformance/` (neu): `canonical.ts`, `vectors.ts`,
  `isotp-runner.ts`, `safety-runner.ts`, `report.ts`, `conformance.ts`
  (CLI-Kern, pure), `cli.ts` (Node-Verdrahtung) + 6 Specs; `vectors/*.json`.
- `packages/transport/iso-tp`: `connection.ts` Wire-Guards + Specs.
- `packages/core`: unverändert in der Logik, **neu geprüft** durch die
  Safety-Vektoren (precheck/flow/stages).
- `architecture/architecture.yaml`: Paket `@vdp/formal-conformance` (layer
  `tool`), `nodeBuiltins.allowedIn`, Topic `formal`.
- Root: `package.json` (`formal:conform`), `tsconfig.json` (references),
  `tsconfig.typecheck.json` (paths), `tests/architecture/hygiene.test.ts`
  (Exit-Ausnahme für `cli.ts`).
- `formal/`: `Json.hs`, `IsoTpTranscript.hs`, `SafetyTranscript.hs`,
  `ConformanceDriver.hs`, `SafetyCore.hs` (Rewrite auf Produktionsvertrag),
  `IsoTpStateMachine.hs` (unverändert), `formal/README.md` (neu).

## Forbidden implementations

- **Keine Vektor-Kopie in den Tests.** `tests/protocol/*` lesen
  `tools/formal-conformance/vectors/`; ein Test, der Fälle nachbaut, ist die
  zweite Quelle.
- **Kein zweiter Precheck.** Die Safety-Vektoren fahren `SafetyManager` und
  `WritePort`; eine Runner-eigene Policy-Tabelle (außer der expliziten
  Haskell-Referenzab bildung) ist verboten.
- **Kein „haskell verified“ ohne Lauf.** Wer den Vergleich nicht ausgeführt hat,
  schreibt `NOT RUN` — in Bericht, README und Changelog (Regel 34.21).
- **Kein Toleranz-Parser.** `parseIsoTpVectorFile`/`parseSafetyVectorFile`
  lehnen Unbekanntes ab; `optional`-Felder, die stillschweigend Defaults setzen,
  wo die Norm einen Wert verlangt, sind ein Rückfall in die Prosa.
- **Kein Live-Anschluss des Haskell-Treibers an CI-Pflicht:** der Skip ist
  erlaubt, weil er benannt ist; ein Build-Gate, das an `ghcup` hängt, ist es nicht.

## Migration

1. `npm install` (Workspace-Link für `@vdp/formal-conformance`).
2. `npm run formal:conform` — baut und fährt beide Domänen gegen die Vektoren;
   ohne Haskell-Toolchain erwartbar mit `haskell NOT RUN`, Exit 0 nur bei
   TS-seitiger Übereinstimmung.
3. Bestehende ISO-TP-Tests bleiben, wie sie sind; die Guards in
   `connection.ts` sind additive Absagen, die alten Pfade unverändert
   durchlassen (leere Payload und > 4095 gab es vorher nicht als legitimen Input).

## Tests

- `tools/formal-conformance/src/*.spec.ts` (6 Dateien): Codec, Vektor-Parser
  inkl. Abweisungsgründe, Runner-Klassifikation, Report, CLI-Kern (55 Tests,
  Projekt `unit`).
- `tests/protocol/formal-conformance.test.ts`: alle Vektoren gegen TS;
  Haskell-Vergleich nur bei gefundenem Interpreter (sonst dokumentierter Skip);
  Mechanismus-Vergleich gegen einen Stub-Treiber, damit die Vergleichsmaschine
  selbst getestet ist, auch ohne Toolchain.
- `tests/protocol/formal-conformance-bus.test.ts`: dieselben ISO-TP-Vektoren
  über den `VirtualCanPair` (Bus-Seam, keine Skript-Kopie der Zustände).
- `tests/hardware/socketcan-conformance.test.ts`: vcan0 + SocketCAN-Binding,
  beides gated.
- `tests/architecture/*`: `check:deps` (neues Paket + nodeBuiltins),
  `check:manifests`, Hygiene-Ausnahme, `ai-context formal` (Topic ⇔ ADR 0045).

## AI implementation notes

- Neue Vektoren: erst `vectors/*.json`, dann beide Seiten; **niemals**
  Erwartung in einen Runner-Test schreiben, ohne den Vektor zu ergänzen —
  die Vektordatei ist der Vertrag.
- `runIsoTp(vector, time, pair?)`: der dritte Parameter ist die Bus-Seam; für
  Normalfälle `ScriptedPair` (default), für Bus-Ehrlichkeit `VirtualCanPair`
  (Muster im Bus-Test).
- Die Haskell-Treiber-Ausgabe ist JSONL mit genau einem Feld `{name, result}`
  oder `{name, error}`; der Diff vergleicht `result` kanonisch.
- Frame-Payload-Auffüllung in Vektoren folgt der Regel `n × 0x5A`
  (`payloadLength`-Feld); Wer das erfindet, verliert gegen die Referenz.
- Bei Toolchain-Frage: `findHaskellInterpreter` sucht `runghc`/`runhaskell`;
  fehlt er, ist der Skip **korrektes Ergebnis** — keine Workarounds, kein
  eingebauter Fake-Treiber im CLI.
