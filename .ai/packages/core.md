# Lese-Paket: `@vdp/core`

**Zweck:** Der Diagnosekern — Engine, DTC, Messwerte, WritePort, Evidenz.

## Lese-Liste

1. [`../../packages/core/README.md`](../../packages/core/README.md) —
   Purpose, **Does NOT do**, Invarianten.
2. [`../../docs/api/runtime.md`](../../docs/api/runtime.md) — die vordere
   Tür (der Runtime ist der Public Surface; die Engine ist internes
   Detail, ADR 0014).
3. Flows: [`diagnostic-read`](../../docs/flows/diagnostic-read.md),
   [`diagnostic-write`](../../docs/flows/diagnostic-write.md),
   [`dtc-analysis`](../../docs/flows/dtc-analysis.md).
4. ADRs: 0004 (Raw vs. Decoded), 0032 (WritePort), 0033 (Evidenz),
   0037 (IR für DTC/Session), 0038 (Evidence Engine).

## Die Regeln, die du nicht brechen darfst

1. **Public Surface = Runtime** — nichts außerhalb des Runtime greift in
   `DiagnosticEngine` (ADR 0014).
2. **Writes nur als `WriteOperation` hinter `WritePort`** (ADR 0032) —
   gestuft: describe → Safety → prepare → Permit → execute → Audit.
3. **Evidenz wird hier gebaut** (`evidence/collect.ts`) — die einzige
   Stelle (ADR 0038); die Projektion in Domain-Views macht der Runtime
   (`mappers.ts`).
4. **Roh + dekodiert getrennt** (ADR 0004) — `raw`/`rawHex` neben `value`.
5. **IR-Formen aus `@vdp/diagnostic-ir`** — keine parallele Vokabel
   (Glossar).
6. **per-file-Coverage 88/80** — eine neue Datei kommt mit ihrem Test.

## Häufige Aufgaben

- Neue DTC-Logik: `src/dtc/` → Code-Map-Zeile „DTC-Analyse“
- Neue Write-Operation: `src/writes/` → Code-Map-Zeile „Write-Operation
  hinzufügen“
- Neue Observation: `src/session/observation.ts` →
  [`.ai/contracts/diagnostic-ir.md`](../contracts/diagnostic-ir.md)
- Kontext-Bundle: `npm run ai:context dtc`
