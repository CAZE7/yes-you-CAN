# `@vdp/ai`

**Layer:** ai · **Pfad:** `packages/ai/` ·
**Regeln-Quelle:** [`architecture/architecture.yaml`](../../architecture/architecture.yaml)

## Purpose

Die Analyse-Schicht (AGENTS 22, ADR 0038): austauschbare Analyse-Provider
(lokale Heuristik aus der Dose, HTTP-Provider für beliebige Modell-Gateways),
`AnalysisService` mit Quellen-Label und **versionierten Antworten**. Der
einzige Ort, an dem „Analyse“ im System existiert.

## Responsibilities

- `service.ts`: `AnalysisService` — Provider-Registry, `analyze()`,
  Historie, `listProviders()` (inkl. `sendsDataOffBox`-Label)
- `types.ts`: `AnalysisInput` (dtcs mit `evidence: {proven, line, itemId}`,
  signals, hypotheses, versions — dazu `recordingId` und `scenario` als
  Provenanz des Gelesenen, ADR 0046), `AnalysisResult` (findings mit
  `basedOn`, citations, `provenance`, optionales `nextTest:
  DiscriminatingTest`), `AnalysisProvider`
- `heuristic.ts`: `HeuristicAnalysisProvider` — der lokale Provider
  (deterministisch, off-box-frei)
- `http.ts`: `HttpAnalysisProvider` für Modell-Gateways (+ `redactVin`);
  ein vorgeschlagener `nextTest` zählt nur mit gültiger Citation
- `heuristic.ts`-`nextTestOf`: der führende nicht-widerlegte Dokumentations-
  Check der Hypothesen — nichts Erfundenes, nur was die Pakete schon nennen
- `prompt.ts`: Prompt-Bau mit `promptVersion` *im Prompttext selbst*
- `provenance.ts`: Provenance-Helfer für Zitate

## Does NOT do

- **kein Fahrzeug-Zugriff** — `mayImport` ist genau
  `["@vdp/shared", "@vdp/diagnostic-ir"]`; der Guardrail-Test rechnet die
  Transitiv-Hülle und fällt, sobald ein Lese-Layer Schreibfähigkeit erreicht
- keine Write-Operationen: eine Analyse *schlägt vor*, die Write-Kette
  *entscheidet* (AGENTS 22, P0 #16)
- keine eigene Konfidenz-Erfindung: Zahlen, die der Beleg nicht trägt,
  brechen den Kontrakt (AGENTS 22: keine falsche Sicherheit)
- keine zweite Evidenz-Kopie: faktischer Input ist das `EvidenceSet`

## Public API

`src/index.ts`: `types.ts`, `heuristic.ts`, `http.ts`, `service.ts`,
`prompt.ts`, `provenance.ts` komplett.

## Dependencies

**Genau** `@vdp/shared` + `@vdp/diagnostic-ir` (maschinell, ADR 0038).

## Data Flow

```text
runtime.evidence.collect() → EvidenceSet
runtime.evidence.hypotheses() → Hypothesis[]
  → (Frontend baut) AnalysisInput { dtcs, signals, hypotheses, versions }
  → AnalysisService.analyze() → Provider → AnalysisResult { findings (basedOn), provenance }
```

## Important invariants

- **Lese-fähig, nie schreib-fähig** — Guardrail-Test
  (`tests/architecture/guardrails.test.ts`).
- **Befunde zitieren Item-Ids**; ein Zitat auf ein nicht existierendes
  Item fällt weg (ADR 0038).
- **Versionen sind Teil der Antwort** (`promptVersion`, `runtimeVersion`,
  `definitionVersion`, `packageVersions`) — P0 #42.
- **Off-Box-Label ist Verpflichtung** (AGENTS 22): `sendsDataOffBox` wird
  angezeigt, nicht nur geloggt.

## Tests

Co-lokatierte `src/*.spec.ts` (Gate 95/85); End-to-End-Kette
`tests/integration/scenario-chain.test.ts`.

## Examples

```ts
import { AnalysisService, HeuristicAnalysisProvider } from "@vdp/ai";

const service = new AnalysisService({ providers: [new HeuristicAnalysisProvider()] });
const result = await service.analyze({ input: analysisInput });
result.provenance.promptVersion; // steht im Prompttext selbst
result.findings[0]?.basedOn; // → Evidenz-Item-Ids
```

Ausführbar: [`tests/examples/evidence-flow.example.ts`](../../tests/examples/evidence-flow.example.ts).
