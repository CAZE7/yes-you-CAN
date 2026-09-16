# Lese-Paket: Invarianten („was darf ich nicht brechen?“)

**Zweck:** Die Verträge, die ein Agent nicht brechen darf — maschinell
geprüfte zuerst, dann die normativen.

## Maschinell geprüfte Invarianten (fehlen = Build-FAIL)

| Invariante | Wo geprüft | Quelle |
|---|---|---|
| `mayImport`-Graph: jede Kante muss erlaubt sein | `npm run check:deps` → `tests/architecture/dependencies.test.ts` | `architecture/architecture.yaml` |
| Layer-Regeln (protocols≠adapters, transports≠protocols, adapters≠protocols/core) | dito | dito |
| Portabilität: domain/application ohne I/O; `node:`-Builtins nur in adapter-host/storage/web/golden-sessions | dito | dito |
| UI wird von niemandem importiert | dito | dito |
| AI bleibt lese-fähig, nie schreib-fähig (Transitiv-Hülle) | `tests/architecture/guardrails.test.ts` | `mayImport` des YAML |
| `@vdp/ai` importiert genau `shared` + `diagnostic-ir` | dito | ADR 0038 |
| `package.json` ⇔ tatsächliche Imports (tote/fehlende Dependencies) | `npm run check:manifests` → `tests/architecture/manifests.test.ts` | ADR 0042 |
| Hygiene: kein `any`, keine fixen Sleeps (nur `tests/helpers/wait.ts`), Zeilen-Budgets | `tests/architecture/hygiene.test.ts` | ADR 0029 |
| Coverage-Gates (global 90/80/90/90 + per-file) | `npm run test:coverage` | `vitest.config.ts`, ADR 0017/0020/0022 |
| Lint/Format/Typecheck | `npm run check`, `npm run typecheck` | `biome.json`, ADR 0010 |

## Normative Invarianten (brechen ein Review garantiert)

1. **Write-Kette:** ein Write existiert nur als `WriteOperation` hinter
   `WritePort` mit `SafetyManager`-Permit und Audit (ADR 0032, AGENTS 26).
   Abgelehnte Writes sind Antworten mit Gründen, keine Fehler (ADR 0018).
2. **Evidenz an einer Stelle:** nur `collectEvidence` (core) /
   `EvidenceService` (runtime) bauen Evidenz; alle anderen zitieren
   Item-Ids (ADR 0038). Fehlende Evidenz ist ein Fehlschlag (ADR 0033).
3. **Roh + dekodiert getrennt**, immer nebeneinander (ADR 0004).
4. **Keine UI-Logik im Core, keine Core-Logik in der UI** (ADR 0014,
   Regel 34.4).
5. **Simulatoren antworten über den Draht** — Tests poken nie
   Simulator-Felder; `runScenario` assertet nie (ADR 0040).
6. **Provenance-Pflicht** für OEM-Daten (ADR 0003/0025).
7. **Doku-Stand = Code-Stand:** Widerspruch Doku↔Repo ist ein Defekt, der
   im selben PR behoben wird (Regel 34.24).

## Weiter

- Schichten-Verträge: [`../ARCHITECTURE.md`](../ARCHITECTURE.md) §2/§3
- Domänen-Verträge: [`.ai/contracts/`](contracts/diagnostic-ir.md)
