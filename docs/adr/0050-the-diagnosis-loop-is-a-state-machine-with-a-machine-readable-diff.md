# ADR 050 — Der Diagnose-Loop ist eine Zustandsmaschine mit maschinenlesbarem Diff

- Status: akzeptiert (2026-09-22)
- Kontext: ADR 0043 (AI-Kontextschicht), ADR 0046 (Szenariodateien, Next-Test in der
  Analyse), AGENTS 22 (keine erfundene Diagnose), AGENTS 24 (Schreiben läuft durch die
  Write-Kette), AGENTS 34.21 (Messung vor Behauptung)
- Betrifft: `packages/diagnostic-ir/src/evidence.ts`, `packages/core/src/evidence/`
  (`hypotheses.ts`, `guided-diagnosis.ts`), `packages/runtime/src/evidence-service.ts`,
  `packages/ai/src/` (`types.ts`, `heuristic.ts`, `http.ts`), `apps/web/src/`
  (`views.ts`, `backend.ts`, `analysis-input.ts`)

## Problem

Der Diagnose-Loop „Evidence → Hypothese → nächster Test → Messung → Evidenz-Update →
Hypothese-Update" existierte als *Funktionsaufruf* (`evaluateGuidedDiagnosis`), nicht als
*Zustand*: Jede Neuaufruf war ein Bild vom jetzigen Moment, aber niemand wusste, was der
letzte Schritt geändert hatte. Drei Fragen ließ das System unbeantwortet, und genau diese
drei sind die Fragen, die ein Werkstatt-Screen beantworten muss:

1. **Welche Evidenz spricht für diese Hypothese?** — Das `evidence`-Feld der Hypothese
   war eine flache ID-Liste ohne Seite: ein Zitat sagt nicht, ob es *für* oder *gegen*
   zählt. Gegen-Evidenz wurde still in die Confidence verrechnet statt sichtbar zu sein.
2. **Was spricht dagegen?** — gar nicht. Refutierte Checks und undokumentierte Codes
   verschwanden in einem Score.
3. **Welcher Test reduziert die Unsicherheit am stärksten?** — Die Auswahl war
   „erster ungetesteter Check der führenden Hypothese". Ein Signal, das drei Hypothesen
   gleichzeitig entscheidet, verlor gegen ein Signal, das nur die eine führende
   Hypothese betrifft — obwohl die Messung dreimal so viel informiert.

Und im AI-Pfad: die Analyse kannte den Loop-Zustand nicht, also konnte ein Gateway oder
die Heuristik einen Next-Test empfehlen, der den Zustand des Loops widersprach —
unkontrollierbar, weil der Zustand nie mitreiste.

## Entscheidung

1. **Jede Hypothese trägt ihre Evidenz mit Seite.** Pflichtfelder
   `Hypothesis.supporting` und `Hypothesis.against` (jeweils `{itemId, why}`):
   - ein *proven* DTC-Item des Codes → `supporting`;
   - ein *unproven* DTC-Item → `against` („no loaded definition documents this code");
   - ein *proven* Pattern-Item → `supporting`;
   - Signal-Items nach dem Check-Verdict: `confirmed` → `supporting`,
     `refuted` → `against`, unentschieden → zitierlos (neutral wird nicht behauptet).
   Jedes Zitat wird existenzgeprüft gegen den Evidence-Set — ein Zitat, das nicht im
   Set ist, ist kein Zitat (derselbe Biss wie die `basedOn`-Regel der Analyse).
2. **Die Unsicherheit wird gemessen, nicht vermutet.** Der empfohlene Test ist der
   mit dem höchsten Wert

   `value = owner.confidence + 0.1 × |{ h′ ≠ owner : h′.checks teilt das Signal }|`

   über **alle** ungetesteten Checks aller Hypothesen (Kandidaten), Tie-Break:
   kleinere `windowMs` (fehlende = ∞), dann Owner-Rang, dann Check-Ordnung.
   `DiscriminatingTest.uncertaintyReduction` trägt den Wert,
   `discriminesAgainst` die gegeneinander entschiedenen Hypothesen, und die Rationale
   endet mit dem Wert selbst („— uncertainty reduction 0.500"): eine Empfehlung, die
   ihre eigene Zahl nicht nennt, ist Meinung.
3. **Der Loop ist ein Zustand, und ein Schritt ist ein Diff.**
   `GuidedDiagnosisState` trägt jetzt `evidenceIds` (Pflicht) — die ID-Menge, über die
   ein Schritt diffed wird. `advanceGuidedDiagnosis(before, afterInput)` liefert
   `DiagnosisStep { before, after, changes }` mit `DiagnosisTransition` als Union:
   `outcome` (inklusive `absent` für hinzugekommene/verschwundene Hypothesen),
   `confidence` (nur bei Δ > 1e-9) und `evidence` (added/removed, nur über die
   `evidenceIds`-Sets). Gleiche Welt rein, gleiche Welt raus → **leeres Diff**.
4. **Der Runtime-Dienst hält die Diff-Basis.** `EvidenceService` führt
   `heldState` (das zuletzt bewertete `GuidedDiagnosisState`);
   `advanceDiagnosis(signalId, value, stepsCompleted)` misst in den Recorder,
   re-bewertet und liefert den Schritt; `resetGuidedDiagnosis()` wirft die Basis weg
   (neue Verbindung = neuer Loop). Der Schritt-Counter des Backends bleibt die
   Autorität für `stepsCompleted` (der Dienst bekommt `steps - 1` und rechnet +1).
5. **Die Confidence-Regel bleibt veröffentlicht — und wird korrigiert.** Prior
   `common 0.6 / possible 0.45 / rare 0.25 / unknown 0.4`; `confirmed +0.25`,
   `untested −0.1`, `refuted ×0.25`, conclusive Fenster `±0.05`, undokumentierter
   Code `−0.15`; Clamp auf `[0.05, 0.9]`. Auflösung nur bei „leading confirmed
   ≥ 0.65 und (einzige oder Gap ≥ 0.2 zur Zweiten)". **Korrigiert dabei:** die
   Definition-Domäne schreibt `possible`, die Prior-Tabelle kannte nur `plausible` —
   jede dokumentierte `possible`-Hypothese fiel still auf den Unknown-Prior (0.4).
   Beide Schreibweisen gelten jetzt, mit 0.45.
6. **Der Zustand reist mit der Analyse — abgeleitet, nicht behauptet.**
   `AnalysisInput.diagnosis?` und `AnalysisResult.diagnosis?`. Die Heuristik gibt
   den Zustand des Inputs unverändert weiter und bevorzugt in `nextTest` die
   Loop-Empfehlung (nur wenn die Hypothese im Input ist **und** das Signal die
   dokumentierte `nextTest`-Signal ist). Der HTTP-Provider validiert per
   `diagnosisOfAnswer`: Status-Union; die Hypothesen-*Objekte* kommen aus dem Input
   (die Antwort listet nur IDs — ist keine einzige bekannt, fällt der ganze Block);
   `evidenceIds` ⊆ zitierbar; `nextRecommendedTest` nur wenn die zugehörige
   `nextTest` des Inputs signalgleich ist, sonst wird der Teil, nicht der Block,
   verworfen. Regel: **ein Zustand, den man nicht gegen die Aufnahme prüfen kann,
   ist eine Geschichte.**
7. **Der Screen zeigt die drei Antworten in Feldern.** `GuidedDiagnosisView` trägt
   je Hypothese `supporting`/`against` (Pflicht, dürfen leer sein), optional
   `changes` (die Transition-Union, inline) und
   `nextRecommendedTest.uncertaintyReduction`. Der Backend-Pfad
   `guidedDiagnosis()` läuft jetzt über `advanceDiagnosis`: Schritt = Messung +
   Diff, der Zähler zählt mit.

## Why

- **Netto-Zahlen sind für eine Werkstatt nicht prüfbar.** „Confidence 0.62"
  beantwortet keine der drei Fragen; „bestätigt durch dtc:P0420@engine, widerlegt
  durch signal:engine.o2_voltage, nächster Test engine.short_term_fuel_trim
  (reduziert 0.500)" ist eine Aussage, die jemand mit der Aufnahme in der Hand
  nachrechnen kann. Seiten getrennt zu halten ist der Unterschied zwischen
  *Erklärung* und *Score*.
- **Der Diff ist der Trust-Anker des interaktiven Loops.** Ein Loop, der nach einem
  Messschritt „nichts geändert" melden kann (weil die Messung konsolidiert wurde,
  nicht neu), und nach einem Schritt, der etwas ändert, *nennen kann*, was sich
  geändert hat, ist ein Loop, dem ein Werkstatt-Mensch folgen kann. Ein Loop, der
  immer Fortschritt meldet, ist einer, den niemand mehr liest.
- **Die Unsicherheitsregel ist billig und vollständig.** Keine
  Wahrscheinlichkeitsrechnung über Hypothesen (die Priors sind Heuristiken, keine
  Verteilungen — Bayes darüber wäre Präzision aus Nichts); nur „wer else schaut auf
  dasselbe Signal", gewichtet mit dem Abstand des Owners. Das beantwortet die Frage
  „welcher Test informiert am meisten" mit einer Zahl, die aus demselben Zustand
  kommt, in dem die Empfehlung steht.
- **Der AI-Pfad bekommt den Loop, ohne dass der Loop der AI gehört.** Die
  Heuristik *trägt* den Zustand weiter, das Gateway *listet* IDs, der Input ist die
  Quelle: damit bleibt jede Antwort gegen die Aufnahme prüfbar — dieselbe Regel wie
  bei `nextTest` und Provenance (ADR 0043), jetzt für den Zustand.

## Alternatives

- **Full Bayesian updating mit Priors pro Check:** abgelehnt — die Priors sind
  veröffentlichte Heuristik (0.6/0.45/0.25), keine geschätzten Verteilungen; ein
  Likelihood-Modell darüber wäre Präzision ohne Datenbasis und würde die Regel
  unleserlich machen.
- **Support/Against als zusätzliche Listen neben dem bestehenden `evidence`-Feld:**
  abgelehnt — zwei Darstellungen derselben Zitate sind zwei Definitionen derselben
  Regel; `supporting`/`against` *sind* die Zitate, `evidence` bleibt die flache
  ID-Liste der alten Leser.
- **`advanceDiagnosis` als Methode des Backends statt des Evidence-Service:**
  abgelehnt — der Service hält bereits die Session-, Recorder- und Scan-Daten und
  die Diff-Basis; der Backend-Counter bleibt Autorität für den Schritt, aber die
  Zustandslogik gehört an den Ort, der den Zustand kennt (Outward-API, ADR 0014).

## Affected packages

- `@vdp/diagnostic-ir`: `HypothesisCitation`, `Hypothesis.supporting/against`
  (Pflicht), `DiscriminatingTest.uncertaintyReduction?`,
  `GuidedDiagnosisState.evidenceIds` (Pflicht), `DiagnosisTransition`,
  `DiagnosisStep`; Re-Exports in `index.ts`.
- `@vdp/core`: `hypotheses.ts` (`citationsOf`, Prior-Korrektur `possible`),
  `guided-diagnosis.ts` (Unsicherheits-Selektion, `advanceGuidedDiagnosis`).
- `@vdp/runtime`: `evidence-service.ts` (`heldState`, `advanceDiagnosis`,
  `resetGuidedDiagnosis`; `EvidenceService` öffentlich in `index.ts`).
- `@vdp/ai`: `types.ts` (`diagnosis?` auf Input und Result), `heuristic.ts`
  (Pass-through + Loop-Empfehlung in `nextTestOf`), `http.ts`
  (`diagnosisOfAnswer`).
- `apps/web`: `views.ts` (View-Vertrag), `backend.ts` (Loop durch
  `advanceDiagnosis`), `analysis-input.ts` (Pass-through).

## Forbidden implementations

- **Kein Netzen von Gegen-Evidenz in die Confidence.** Widerlegende Zitate müssen in
  `against` sichtbar bleiben; ein Score, der sie still verrechnet, ist der alte
  Defekt.
- **Kein Next-Test aus dem Modell.** Ein Gateway darf nominieren, aber nur über
  dokumentierte Checks der eigenen Hypothesen (Signal-Match); das Loop-`value`
  wird von der Rule berechnet, nie von der Antwort getragen.
- **Kein Diff gegen eine fremde Basis.** Der Schritt diffed gegen den
  `evidenceIds`-Set des *eigenen* `before`; ein Schritt, der Fortschritt meldet,
  den die Welt nicht macht, ist eine Lüge mit Zeitstempel.
- **Kein `plausible`/`possible`-Zweikopf bei den Priors.** Die Domäne schreibt
  `possible`; der Alias bleibt, ein drittes Synonym ist eine neue Behauptung.

## Migration

Abgeschlossen in diesem Stand (kein Daten-Migration, nur API- und Fixturen-Update):

1. IR-Typen erweitert; alle Fixtures mit `evidenceIds` und `supporting`/`against`
   aktualisiert (IR-Spec, AI-Spec, View-Spec).
2. `guided-diagnosis.spec.ts` pinn die neue Selektion (ein Signal mit drei
   Hypothesen schlägt das Solo-Signal der führenden), den Schritt-Transition
   (0.45 → 0.9, exakt) und das leere Diff.
3. `evidence-service.spec.ts` pinn `advanceDiagnosis` (Messung → Evidenz-Add,
   Konsolidierung → leeres Diff, `resetGuidedDiagnosis` → neue Basis).
4. AI-Spec §15 pinn Pass-through, den validierten Gateway-Block und die Drop-Regel.

## Tests

- `packages/core/src/evidence/guided-diagnosis.spec.ts`: Unsicherheits-Selektion,
  Schritt mit exakten Zahlen, leeres Diff, Evidenz-Transition.
- `packages/runtime/src/evidence-service.spec.ts`: Loop-Schritt auf dem Runtime,
  Konsolidierung, Reset, no-session-Refusal.
- `packages/ai/src/ai.spec.ts` §15: Loop-State reist byte-for-byte (Heuristik);
  Gateway-Block nur über Input-IDs (HTTP); Drop bei unbekannter Hypothese oder
  signal-fremdem Check.
- `packages/diagnostic-ir/src/diagnostic-ir.spec.ts`: State-Vertrag (`evidenceIds`,
  `uncertaintyReduction`).
- `apps/web/test/views.spec.ts`: View-Vertrag inkl. `supporting`/`against`,
  `changes`, `uncertaintyReduction`.

## AI implementation notes

- `citationsOf` in `hypotheses.ts` ist die *einzige* Stelle, die Zitat-Seiten
  entscheidet; wer eine neue Evidenz-Art einführt, ergänzt dort und nicht im
  Renderer.
- Das `value`-Formula in `selectDiscriminatingTest` und die Zahlen in der Rationale
  gehören zusammen: ein Ändern des Gewichts (0.1) ohne Update der Spec-Nummern ist
  ein stiller Regelwechsel.
- `heldState` im `EvidenceService` ist die Diff-Basis; `guidedDiagnosis()`
  (ohne Schritt) *setzt* sie. Wer `resetGuidedDiagnosis` nach einer Verbindung
  vergisst, diffed gegen eine andere Session.
- `diagnosisOfAnswer` in `http.ts` droppt den Block, wenn **keine** der gelisteten
  Hypothesen-IDs im Input ist — nicht wenn *die führende* fehlt; die Granularität
  (Block vs. Teilfeld) ist die Entscheidung.
