# `@vdp/definitions`

**Layer:** contract · **Pfad:** `packages/definitions/` ·
**Regeln-Quelle:** [`architecture/architecture.yaml`](../../architecture/architecture.yaml)

## Purpose

OEM-Wissen als **validierte Daten** (ADR 0003/0023/0024/0025): Fahrzeuge,
ECUs, DIDs, Signale und DTC-Wissen *pro Variante* mit Pflicht-Provenance.
Daten, keine Diagnose-Logik.

## Responsibilities

- `DefinitionPackage`-Schema + `DefinitionRegistry` (mehrere OEM-Pakete)
- Fahrzeugauflösung: VIN → Kandidaten mit Belegen (`resolve.ts`, ADR 0023)
- DTC-Wissen Schema v3: Beschreibung, Severity, zugehörige Signale,
  dokumentierte Checks — Auflösung nach Spezifität (ADR 0024)
- Qualitäts-Gates: Provenance je Quellentyp, Checks ohne Stellvertreter-
  Signal, bewusste Lücken (`validate.ts`, ADR 0025)
- OEM-Pakete: `./generic`, `./vag`, `./mercedes` (+ `./high-fidelity` über
  die Simulator-Variante), `./simulator`-Form
- JSON-Import + Migrationen der Definition-Schemas (`json.ts`, `migrate.ts`)

## Does NOT do

- keine Diagnose-Logik, keine Protokoll-Kenntnis, keine I/O
- keine „Korrektur“ von Daten im Code: Wissen kommt aus den Paket-Dateien,
  Fehler im Wissen sind Daten-Fehler (mit ADR/PR), keine Patches im Decoder
- keine Provenance-Lücken: ein Eintrag ohne Quelle scheitert an `validate.ts`

## Public API

`src/index.ts` (Schema, Registry, Validate, Resolve, Vehicles) + Subpath-
Exports `./generic`, `./vag`, `./mercedes` (die Paket-Konstanten).

## Dependencies

Nur `@vdp/shared`.

## Data Flow

```text
tools/definition-importer → packages/definitions/src/<oem>/*.json (Daten)
                              ↓
                    validate.ts (Qualitäts-Gates)
                              ↓
          Core (Discovery, Decode, DTC-Enrichment) · Runtime (Resolve)
                              ↓
                Simulator (Vehicle-Definitionen)
```

## Important invariants

- **Daten, keine Logik** — `mayImport` bleibt `["@vdp/shared"]`.
- **Provenance ist Pflicht** (ADR 0003): jede Wissens-Quelle (Handbuch,
  Werkstatt, Import) wird benannt; ADR 0025 prüft das maschinell.
- **Ehrlichkeit als Datenmodell** (ADR 0024): ein nicht dokumentierter Code
  bleibt abwesend — keine erdichtete Beschreibung.
- **Schema-Änderungen** laufen als Version + Migration (`migrate.ts`), alte
  Pakete bleiben lesbar.

## Tests

Co-lokatierte `src/*.spec.ts` (Gate 88/81, seit ADR 0023 angehoben); Import-Pipeline in
`tools/definition-importer/src/*.spec.ts`.

## Examples

```ts
import { genericPackage } from "@vdp/definitions";
import { vagPackage } from "@vdp/definitions/vag";

genericPackage.ecus;        // ECU-Definitionen (rxId, txId, DIDs, Signale)
vagPackage.dtcs;            // DTC-Wissen pro Variante (Schema v3)
```

Neues OEM-Wissen hinzufügen: [`tools/definition-importer/`](../../tools/definition-importer/README.md)
und die Code-Map-Zeile „DTC-Wissen“.
