# Public API: Hypothesen (geurteilte Muster, keine Modell-Glaubwürdigkeit)

> Primäre Pakete: `@vdp/diagnostic-ir` (Formen), `@vdp/core`
> (`packages/core/src/evidence/hypotheses.ts` → `rankHypotheses`,
> `evaluateGuidedDiagnosis`) · ADR: [0038](../adr/0038-evidence-engine-and-ai-input.md)

Eine **Hypothese** ist ein dokumentiertes Fehlermuster (aus einem
Definition-Paket), das *gegen die Messungen geurteilt* wurde. Sie trägt
deshalb nicht eine Modell-Konfidenz, sondern: jedes Check-Ergebnis, die
Item-Ids, auf denen sie ruht, den Grund in einer Zeile und den nächsten
Test, der sie weiterbewegen würde.

## Primary API

| Symbol | Paket | Zweck |
|---|---|---|
| `Hypothesis` | diagnostic-ir | `id`, `code`, `ecuId`, `claim`, `explanation?`, `likelihood?` (`common`\|`plausible`\|`rare`), `outcome`, `confidence`, `evidence: string[]` (Item-Ids), `checks: HypothesisCheck[]`, `reason`, `nextTest?` |
| `HypothesisOutcome` | diagnostic-ir | `confirmed` \| `refuted` \| `untested` |
| `HypothesisCheck` | diagnostic-ir | `test` + `outcome` + `window?` — das Check-Urteil mit dem Fenster, auf dem es gefällt wurde |
| `HypothesisTest` | diagnostic-ir | `signal`, `expect`, `min?/max?/windowMs?`, `measurable` — `false`, wenn das Paket nur Prosa schrieb |
| `DiscriminatingTest` | diagnostic-ir | `hypothesisId` + `test` + `rationale` + `discriminatesAgainst?` |
| `GuidedDiagnosisState` | diagnostic-ir | `status` (`in-progress`\|`resolved`\|`inconclusive`), `leadingHypothesis?`, `nextRecommendedTest?` |
| `rankHypotheses()` | core | Rangfolge der letzten-Scan-Muster nach der veröffentlichten Heuristik (Zahlen im Modul, nicht im Modell) |
| `evaluateGuidedDiagnosis()` | core | Der geführte Zustand aus Set + Messungen |
| `EvidenceService.hypotheses()` | runtime | Bequem über der laufenden Session |

## Beispiel: eine Hypothese lesen

```ts
import { EvidenceService } from "@vdp/runtime"; // über createDiagnosticRuntime()

const hypotheses = runtime.evidence.hypotheses();

const h = hypotheses[0];
if (!h) throw new Error("keine Hypothese in der letzten Scan-Runde");
console.log(h.claim, "→", h.outcome, "weil:", h.reason);
for (const check of h.checks) {
  console.log(`  ${check.test.signal}: ${check.outcome}`);
  // "engine.o2_voltage: confirmed  (Fenster 4000 ms)"
  // "battery.voltage: refuted"
}
// h.evidence = ["dtc:P0420@ecu-engine", "signal:engine.o2_voltage"] → zitierbare Ids
if (h.nextTest) console.log("nächster Test:", h.nextTest.expect);
```

## Verträge

1. **`outcome` leitet sich aus `checks[]` ab** — `refuted` schlägt `confirmed`,
   `confirmed` schlägt `untested`; `reason` sagt in einer Zeile, warum. Ein
   Leser sieht, *welcher* Check entschied (ADR 0038).
2. **`measurable: false` bleibt Prosa:** ein Check ohne numerische Grenze oder
   Fenster kann kein Urteil fällen — die Formulierung muss den Unterschied
   tragen (AGENTS 22: keine falsche Sicherheit).
3. **`confidence` ist die Heuristik aus `@vdp/core`** mit veröffentlichten
   Zahlen — keine Modell-Blackbox, keine Zahl, die der Beleg nicht trägt.
4. **`evidence[]` sind Item-Ids** des `EvidenceSet`; ein leerer Array heißt
   „noch nichts stützt sie“ — kein stiller Fallback.
5. **`nextTest`** ist der erste unentschiedene Check — „was als Nächstes
   messen“ steht also nicht in der Prosa, sondern in den Daten.
