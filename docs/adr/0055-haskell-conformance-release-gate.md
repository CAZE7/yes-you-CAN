# ADR 55 — Haskell-Konformanz ist ein Release-Gate, kein manueller Schritt

- Status: akzeptiert (2026-09-22)
- Kontext: ADR 0045 (gemeinsame Vektoren, zwei Leser), ADR 0029 §1 („ein Tor, das
  niemand ausführt, ist eine Gewohnheit"), ADR 0029 §4 (Gates im Testlauf tragen,
  weil `ci.yml` nicht schreibbar ist — E10/E20), AGENTS 34.21 (Messung vor
  Behauptung)
- Betrifft: `tests/architecture/haskell-conformance-gate.test.ts` (neu),
  `tools/formal-conformance/src/cli.ts` (Runner-Reihenfolge),
  `tools/formal-conformance/src/conformance.ts` (Nutztext), `formal/README.md`,
  `tools/formal-conformance/README.md`, `AGENTS.md` (0.A/0.B)

## Problem

ADR 0045 legte die gemeinsame Definition: dieselben 28 ISO-15765-2- und
44 Write-Safety-Vektoren gegen die TypeScript-Produktion **und** die
Haskell-Referenz. Die TS-Hälfte lief in jedem CI-Lauf (`npm test`, Projekt
`protocol`). Die Cross-Language-Hälfte war dagegen ein **manueller Schritt**:
`npm run formal:conform -- --compare` nur auf einer Maschine mit GHC — und in
dieser Arbeitsumgebung war GHC nicht installierbar (gemessen: `apt`/deb.debian.org,
downloads.haskell.org, Hackage, Nix-Channels, Conda und GitHub-Release-Assets
alle blockiert). Die Folge: die Haskell-Seite war nur *syntaxgeprüft*, nie
gefuhrt — und ein Release, das von einer Maschine ohne GHC geschnitten wurde,
hatte das Differential per Konstruktion nie gesehen. Optional heißt: das Gate ist
eine Gewohnheit, und eine Gewohnheit ist kein Gate (ADR 0029 §1).

## Entscheidung

1. **Das Differential läuft in jedem äußeren CI-Lauf genau einmal.** Neu
   `tests/architecture/haskell-conformance-gate.test.ts` (Projekt `architecture`,
   derselbe Träger-Mechanismus wie `coverage-gate.test.ts`): Das Coverage-Kind
   (`VDP_COVERAGE_CHILD=1`) trägt nur Coverage und lässt diesen Träger aus; sein
   Elternlauf trägt den einen Release-Vergleich. Das Kind des Release-Trägers ist das
   eigne Skript `npm run formal:conform -- --compare` — Gate und Kommando können
   nicht auseinanderlaufen, eine Abfrage auf den Skripttext bemerkt, wenn das
   Skript nicht mehr auf das CLI zeigt. Exit 0 muss für **beide** Sätze die
   Zeile `TS ⇄ Haskell differential clean (N vectors)` tragen (gematcht, nicht
   nur Exit-Code geprüft), Exit 1 fällt mit dem Bericht des CLI (Vektor, Input,
   beide Ergebnisse, Differenzpfade) — und Exit 2 fällt **in der CI**: ein
   Runner, auf dem der Vergleich nicht laufen kann, darf kein Release schneiden,
   das Konformität für ISO-TP und Write-Safety behauptet. `retry: 0` (ein Retry
   wäre ein zweites Compilieren), Timeout 10 min.
2. **Die CI ist die Maschine, auf der die Toolchain garantiert ist.** Die
   GitHub-hosted-Runner liefern GHC vorinstalliert (gemessen an der
   `actions/runner-images`-Dokumentation für Ubuntu 24.04: „Haskell Tools — GHC
   9.14.1"). Lokal gilt dieselbe Disziplin nur, wo sie tragbar ist: mit Toolchain
   läuft der Vergleich im Entwickler-Lauf, ohne ist er ein **sichtbarer Skip**
   (`skipIf(!isCi && !hasHaskell)`) — nie ein unsichtbares Grün.
3. **Ein Compile statt zwei Interpretationen — und ein Ausgabeverzeichnis pro
   Prozess.** Die CLI bevorzugt `ghc` (ein Compile in ein per `mkdtemp` isoliertes
   tmp-Verzeichnis, je ein Lauf pro Vektorsatz); `runhaskell`/`runghc` bleiben für
   Interpreter-only-Maschinen. Ein gemeinsames `-outputdir /tmp` ist verboten:
   der erste echte CI-Lauf (`35769274998`) ließ Coverage- und Release-Träger
   gleichzeitig kompilieren und GHC verlor beim atomaren Rename von `Json.o.tmp` —
   das Gate fand einen Compiler-Workspace-Race, keine Konformanzabweichung.
   Gemessener Grund für den Compile-Pfad: der Interpreter liest den ganzen formale
   Baum pro Satz von Source neu — auf einem kalten Runner ist das der Kostenanteil
   des Gates pro Lauf, den ein Release-Gate nicht tragen soll.
4. **Die Ehrlichkeit bleibt.** Wo der Vergleich nicht lief, steht es
   wortgleich so (`haskell NOT RUN`, Exit 2). Der Träger meldet seinen Modus
   als `::notice`-Annotation (der Job-Log-Kanal, den `coverage-gate.test.ts`
   etabliert hat), damit ein Lauf ohne Differential auch lesbar ist.

## Why

- **Release bedeutet: beide Seiten haben gesprochen.** Die Vektoren sind die
  Definition der Konformität; ein Release, das nur eine der zwei Lesarten
  gemessen hat, hat halbe Konformität. Die CI ist der Ort, an dem Releases
  entstehen — also gehört das Differential hin, nicht an den Laptop des
  Release-Managers.
- **Fehlende Toolchain ist in der CI ein Fehlerfall, lokal einer der
  Umgebung.** Dieselbe Regel, zwei tragbare Scharfschaltungen: in der CI fehlt
  GHC nur, wenn sich der Runner ändern lässt — dann muss es auffallen. Lokal
  hat ein Teil der Entwickler keine Haskell-Umgebung; ein hartes Rot dort würde
  das Gate umgehen statt es tragen (der klassische „lokal rot, CI grün"-
  Umwegweg).
- **`ghc` zuerst, weil das Gate pro Lauf bezahlt wird.** Einmal kompilieren und
  zweimal ausführen ist die billigste korrekte Ausführung; die Reihenfolge ist
  dokumentiert und die Spec prüft die reine Kerner weiter ohne Toolchain.

## Alternatives

- **Differential nur vor dem Release (wie bisher) als Release-Skript:**
  abgelehnt — „vor dem Release" ist genau der Moment, in dem niemand zwingend
  eine Maschine mit GHC in der Hand hat; und ein Schritt, der nicht in jedem
  Lauf läuft, driftet (ADR 0029 §1).
- **`actions/setup-haskell` in `ci.yml`:** abgelehnt — Workflow-Dateien sind mit
  der App-Installation nicht schreibbar (E10, drei Messläufe), und der
  Runner-Default (GHC vorinstalliert) reicht für ein Base-only-Modell; eine
  zusätzliche Abhängigkeit von einem Action ist eine Regel, die ein anderer
  Host nicht mitbringt.
- **Haskell-Runner als drittes Testprojekt mit eigenem vitest-Setup:**
  abgelehnt — der Treiber ist ein Kompilieren und Ausführen, kein
  Testframework-Subjekt; ein vitest-Projekt dafür wäre eine Schicht über
  einem Kindprozess, den es schon gibt.

## Affected packages

- `tests/architecture`: neue Trägerdatei (kein Paket, Projekt `architecture`).
- `tools/formal-conformance` (Layer `tool`): `cli.ts` Runner-Reihenfolge
  (`ghc` → `runhaskell` → `runghc`), `conformance.ts` Nutztext. Keine neue
  Importkante, kein `node:*` außerhalb `cli.ts`.
- Wurzeldokumente: `formal/README.md` (Release-Regel),
  `tools/formal-conformance/README.md`, `AGENTS.md`.

## Forbidden implementations

- **Kein `haskell NOT RUN` als grüner CI-Lauf.** In der CI ist der
  Nicht-Geführte-Vergleich ein Fehlschlag; wer die Zeile aus dem Report löscht,
  um den Lauf grün zu bekommen, entfernt das Gate.
- **Kein zweiter Treiber.** Der Vergleich läuft über
  `formal/ConformanceDriver.hs` und die CLI; ein zweiter Haskell-Einstieg
  (eigener `runghc`-Aufruf im Test, eigenes Script) wäre eine zweite Definition
  desselben Laufs.
- **Kein Skip im äußeren CI-Lauf.** `skipIf` gilt dort nur ohne lokale Toolchain;
  in CI überspringt ausschließlich das markierte Coverage-Kind den doppelten
  Träger — sein Elternlauf muss das Differential ausführen. Ein anderer CI-Skip
  ist der alte Defekt mit neuem Datum.

## Tests

- `tests/architecture/haskell-conformance-gate.test.ts` (1 Test, vier Modi):
  CI+Toolchain → Kind `--compare`, Zeilen für beide Sätze gematcht; CI ohne
  Toolchain → **Rot** mit „a release without the differential is not a release"
  (gemessen in dieser Umgebung: `CI=true`-Lauf fällt mit Exit-2-Bericht); das
  markierte Coverage-Kind → sichtbarer Skip, weil sein Elternlauf die Messung
  trägt; lokal ohne Toolchain → sichtbarer Skip mit Modus-Annotation. Biss des
  Exit-1-Zweigs durch den bestehenden
  `formal-conformance.test.ts`-Mechanismus (Stub-Treiber mit Abweichung) und
  durch das CLI-Verhalten (Vektordatei kaputt → Exit 2).
- Vorhanden, unverändert: `tests/protocol/formal-conformance.test.ts`
  (TS-Seite in jedem Lauf + Differential wo Toolchain vorhanden),
  `tools/formal-conformance/src/*.spec.ts` (reiner Kern, Runner-agnostisch).

## AI implementation notes

- Der Träger kopiert das Muster von `coverage-gate.test.ts` eins zu eins
  (`isCi`, `::notice`, `tail`, `retry: 0`, Skripttext-Abfrage) — wer ihn
  änderd, ändert die Begründung im Header im selben Zug.
- Die Exit-Code-Kontrakt (0/1/2) steht in `conformance.ts` und darf dort
  geändert werden, wenn die drei Zweige im Träger mitgezogen werden — sie
  gehören zusammen (eine zweite Kodierung derselben Regel wäre der alte
  Defekt).
- Diese Arbeitsumgebung hat keine Haskell-Toolchain (gemessen, s. Problem);
  der erste CI-Lauf auf einem GHC-Runner ist damit die **erste Messung** der
  Haskell-Seite. Ist er rot, hat das Gate seinen Job getan — die Abweichung
  ist dann in der CI-Log-Zeile benannt (Vektor, Input, beide Ergebnisse,
  Differenzpfade), nicht zu vermuten.
