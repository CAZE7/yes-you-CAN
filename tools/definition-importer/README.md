# `@vdp/definition-importer`

**Layer:** tool · **Pfad:** `tools/definition-importer/` ·
**Regeln-Quelle:** [`architecture/architecture.yaml`](../../architecture/architecture.yaml)

## Purpose

Definition-Import (ADR 0003): OEM-Quelldaten in **DBC-, CSV- oder
JSON-Format** werden in validierte Definition-Paket-Form überführt.
**Der Importer importiert; die Validierung ist Sache von
`@vdp/definitions`** (`validate.ts`) — keine zweite Validierungslogik.

## Responsibilities

- `importDbc(content, options)`: DBC → Definition-Struktur
- `importCsv(content, options)`: CSV (z. B. Signaltabellen) → Definition-Struktur
- `importJson(content, options)`: generischer JSON-Import
- `ImportOptions`/`ImportResult` (mit **Provenance** je Quelle)
- `diagnosticRequestFor(rxId, extended)`: Request-Id aus der Antwort-Id

## Does NOT do

- keine Validierungslogik: die Regeln stehen in `@vdp/definitions/validate.ts`
- keine Diagnose-Logik, keine I/O (die Inhalte werden übergeben, nicht gelesen)
- keine Schicht: nichts importiert `@vdp/definition-importer`

## Public API

`src/index.ts`: `importDbc`, `importCsv`, `importJson`, `ImportOptions`,
`ImportResult`, `diagnosticRequestFor`.

## Dependencies

`shared`, `definitions` (siehe `architecture.yaml`).

## Data Flow

```text
OEM-Quelle (DBC/CSV/JSON-Text)
  → importDbc/importCsv/importJson (Mapping + Provenance)
  → Definition-Paket-Struktur → packages/definitions/src/<oem>/ (validiert durch validate.ts)
```

## Important invariants

- **Provenance-Pflicht** (ADR 0003): jeder Import benennt Quelle +
  Quellentyp — ADR 0025 prüft das maschinell.
- **Keine zweite Validierung** (Regel in `architecture.yaml`).

## Tests

Co-lokatierte `src/*.spec.ts` (Projekt `unit`; `tools/**` ohne per-file-
Gate — siehe `vitest.config.ts`).

## Examples

```ts
import { importDbc, importJson } from "@vdp/definition-importer";

const result = importDbc(dbContent, {
  oem: "vag",
  provenance: { sourceType: "dbc-file", source: "vw_golf7.dbc", importedAt: "2026-09-16" },
});
// result → strukturierte Definition + Provenance; danach validate.ts
```
