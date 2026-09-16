# Flow: AI-Analyse (nur Belege, nie das Fahrzeug)

> Pipeline: `Session → EvidenceSet + Hypothesen → AnalysisInput →
> Provider → AnalysisResult mit Zitaten und Versionen`.
> ADR 0038 ist der Kontrakt dieser Pipeline.

```text
Laufende Session (oder Replay/Report-Kontext)
  ▼
@vdp/runtime  EvidenceService
  ├─ collect()        → EvidenceSet  (items mit stabilen Ids + conflicts)
  └─ hypotheses()     → Hypothesis[] (geurteilt, mit checks[] und nextTest)
  ▼
apps/web/src/analysis-input.ts  (oder ein anderes Frontend)
  │  baut AnalysisInput:
  │    dtcs[] (mit scope + evidence: { proven, line, itemId })
  │    signals[] (Statistik-Zusammenfassung)
  │    hypotheses[]
  │    versions: { promptVersion, runtimeVersion, definitionVersion, packageVersions }
  ▼
@vdp/ai  AnalysisService.analyze({ input, providerId? })
  ├─ Provider aus der Dose: HeuristicProvider (lokal, sendsDataOffBox: false)
  └─ oder: HttpProvider → beliebiges Modell-Gateway (sendsDataOffBox: true)
  ▼
AnalysisResult
  ├─ findings[]: jedes Befund zitiert basedOn: string[]  (Evidenz-Item-Ids)
  ├─ citations[]: Zitate auf Item-Ids — ein Zitat auf ein nicht existierendes
  │   Item fällt weg (nicht: wird erfunden)
  └─ provenance: { promptVersion, runtimeVersion, definitionVersion?, provider }
```

**Die harten Kanten (maschinell geprüft):**

1. **`@vdp/ai` importiert genau `@vdp/shared` + `@vdp/diagnostic-ir`** —
   der Guardrail-Test rechnet die Transitiv-Hülle aus
   `architecture/architecture.yaml` und fällt, sobald ein Lese-Layer
   Schreibfähigkeit erreicht (`tests/architecture/guardrails.test.ts`).
2. **Faktischer Input = EvidenceSet + Hypothesen + Versionen.** Ein Provider,
   der mehr „weiß“, hat eine zweite Kopie der Belege — ein Defekt.
3. **Eine Analyse schlägt vor, die Write-Kette entscheidet** (AGENTS 22):
   ein Befund mit `recommendation` ändert nichts am Fahrzeug; schreiben
   läuft über `WritePort` (Flow [`diagnostic-write.md`](diagnostic-write.md)).
4. **Keine Konfidenz ohne Beleg:** `Hypothesis.confidence` ist die
   veröffentlichte Heuristik aus `@vdp/core`; ein Gateway, das eigene
   Zahlen erfindet, bricht den Kontrakt.
5. **Versionen sind Teil der Antwort:** dieselbe Session kann je nach
   Prompt-Version/Runtime-Version/Definition-Paket anders antworten —
   `provenance` macht das zitierbar (P0 #42).

**UI-Seite:** die Workbench zeigt „generiert von lokaler Regel-Engine“ vs.
„generiert von Modell“ (`listProviders().sendsDataOffBox`) — das Label ist
Verpflichtung, nicht Kosmetik (AGENTS 22).

**Zugehörig:** [`docs/api/evidence.md`](../api/evidence.md),
[`docs/api/hypothesis.md`](../api/hypothesis.md),
[`tests/examples/evidence-flow.example.ts`](../../tests/examples/evidence-flow.example.ts).
