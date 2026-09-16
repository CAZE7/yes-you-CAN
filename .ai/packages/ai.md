# Lese-Paket: AI / Analyse-Layer

**Zweck:** Die Analyse-Schicht — Provider, Evidenz-Contract, Zitate,
Versionen.

## Lese-Liste

1. [`../../packages/ai/README.md`](../../packages/ai/README.md) —
   Purpose, **Does NOT do**, Invarianten.
2. [`../../docs/api/evidence.md`](../../docs/api/evidence.md) und
   [`../../docs/api/hypothesis.md`](../../docs/api/hypothesis.md).
3. [`../../docs/flows/ai-analysis.md`](../../docs/flows/ai-analysis.md).
4. ADR 0038 (Evidence Engine & AI-Input) + 0033 (fehlende Evidenz).
5. Beispiel: [`../../tests/examples/evidence-flow.example.ts`](../../tests/examples/evidence-flow.example.ts).

## Die Regeln, die du nicht brechen darfst

1. **`mayImport` bleibt genau `["@vdp/shared", "@vdp/diagnostic-ir"]`** —
   der Guardrail-Test rechnet die Transitiv-Hülle und fällt, sobald ein
   Lese-Layer Schreibfähigkeit erreicht (ADR 0038, maschinell).
2. **Faktischer Input = `EvidenceSet` + Hypothesen + Versionen** — ein
   Provider, der mehr „weiß“, hat eine zweite Kopie der Belege (Defekt).
3. **Befunde zitieren Item-Ids** (`basedOn`); ein Zitat auf ein nicht
   existierendes Item fällt weg — nicht: wird erfunden.
4. **Keine Konfidenz ohne Beleg:** `Hypothesis.confidence` ist die
   veröffentlichte Heuristik aus `@vdp/core`; erdichtete Zahlen brechen
   den Kontrakt (AGENTS 22).
5. **Eine Analyse schlägt vor, die Write-Kette entscheidet** (AGENTS 22):
   eine `recommendation` ändert nichts am Fahrzeug.
6. **Versionen sind Teil der Antwort** (`promptVersion` — steht im
   Prompttext selbst, `runtimeVersion` = `PLATFORM_VERSION`,
   `definitionVersion`, `packageVersions`) — P0 #42.
7. **Off-Box-Label ist Verpflichtung:** `sendsDataOffBox` wird angezeigt,
   nicht nur geloggt (AGENTS 22).

## Weiter

- Kontext-Bundle: `npm run ai:context ai`
- Evidenz-Formen: [`.ai/contracts/diagnostic-ir.md`](../contracts/diagnostic-ir.md)
