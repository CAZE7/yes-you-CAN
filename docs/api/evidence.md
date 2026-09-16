# Public API: Evidence (Belege, die zitiert werden können)

> Primäre Pakete: `@vdp/diagnostic-ir` (Formen), `@vdp/core`
> (`packages/core/src/evidence/collect.ts` → `collectEvidence`),
> `@vdp/runtime` (`EvidenceService`) ·
> ADRs: [0033](../adr/0033-missing-evidence-is-a-failure.md),
> [0038](../adr/0038-evidence-engine-and-ai-input.md)

Die Evidence Engine ist die **einzige** Stelle, die entscheidet, welche
Aussagen eine Session trifft. Workbench, Report und Analyse-Provider alle
lesen dasselbe Set — eine zweite Kopie der Belege ist ein Defekt.

## Primary API

| Symbol | Paket | Zweck |
|---|---|---|
| `EvidenceSet` | diagnostic-ir | `sessionId`, `collectedAt`, `items: EvidenceItem[]`, `conflicts: EvidenceConflict[]` |
| `EvidenceItem` | diagnostic-ir | `id` (stabil, zitierbar), `kind`, `subject`, `statement`, `at`, `evidence` |
| `EvidenceKind` | diagnostic-ir | `dtc` \| `anomaly` \| `freeze-frame` \| `signal` \| `vehicle` \| `history` \| `pattern` \| `gap` |
| `itemsOf()` / `itemById()` / `unprovenItems()` | diagnostic-ir | Zugriff auf das Set |
| `Evidence` = `Proven` \| `Unproven` | diagnostic-ir | Der Beleg: `proven({origin, at, ecuId, serviceId, raw, definitionVersion})` oder `unproven({reason})` |
| `describeEvidence()` / `isProven()` | diagnostic-ir | Evidence lesen, ohne die Union zu zerlegen |
| `collectEvidence(input)` | core | Baut das Set aus Session + letztem Scan + Statistik + Anomalien |
| `EvidenceService.collect()` / `.hypotheses()` | runtime | Die View über der laufenden Session (read-only) |

## Beispiel: Evidenz sammeln und zitieren

```ts
import { collectEvidence } from "@vdp/core";
import { itemsOf, itemById, unprovenItems } from "@vdp/diagnostic-ir";

const evidence = collectEvidence({ session, collectedAt: "2026-09-16T12:00:00Z" });

for (const item of itemsOf(evidence)) {
  console.log(`${item.id}\t${item.statement}`);
}
// "dtc:P0420@ecu-engine"   "P0420 — Katalysewirkungsgrad …"
// "freeze-frame:P0420@ecu-engine"   "Freeze Frame zu P0420 (8 Bytes) …"

// Unproven ist ein Befund, kein Warnhinweis:
const unproven = unprovenItems(evidence);
// → z. B. das Enrichment, weil das Definition-Paket den Code nicht dokumentiert

// Zitation: eine Analyse verweist auf die Id, nicht auf den Satz:
const cited = itemById(evidence, "dtc:P0420@ecu-engine");
```

## Verträge

1. **Ein Satz, eine Stelle:** Evidenz wird nur von `collectEvidence` /
   `EvidenceService` gebaut. UI/Report/AI *zitieren*, sie sammeln nicht.
2. **Stabile Ids:** dieselbe Tatsache in derselben Session → dieselbe Id;
   Replay zitiert die gleiche Id (ADR 0038).
3. **Konflikte werden genannt:** zwei Items, ein Gegenstand, keine Einigung →
   `EvidenceConflict`, kein stiller Gewinner.
4. **Unproven bleibt unproven:** kein Default-`proven`, kein
   Downgrade in eine Warning (ADR 0033).
5. **Das Set ist read-only:** es benennt keine Request, keinen
   Schreib-DID, kein Service (AGENTS 22).
