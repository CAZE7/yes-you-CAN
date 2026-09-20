# `data/definitions/` — definition packages as files

Built-in packages (`genericPackage`, `simulatorPackage`, the VAG/Mercedes
*placeholders*) live in TypeScript. **Real** knowledge does not: a licensed OEM
file, a community pack, a workshop's own notes belong here as JSON.

The workbench loads every `*.json` in this directory at startup through
`parseDefinitionPackage` — the same parser the importer uses, with the same
provenance gates (ADR 0003, 0025). A broken file stops the server and names the
file. An empty directory is fine: the demo boots on the built-ins.

## What a file must contain

A `DefinitionPackage` at the current schema version (see
`packages/definitions`). Minimum:

```json
{
  "schemaVersion": 3,
  "oem": "example",
  "name": "Example pack",
  "version": "1.0.0",
  "provenance": {
    "sourceType": "licensed",
    "source": "OEM documentation",
    "license": "workshop licence …",
    "version": "2026-01",
    "retrievedAt": "2026-09-20"
  },
  "ecus": [],
  "signals": [],
  "vehicles": []
}
```

`sourceType` `example-placeholder` is allowed and is treated as untrusted
(score penalty, UI label). Do not copy databases from competing products
(AGENTS 24).

Override the directory with `VDP_DEFINITIONS_DIR` if the process does not run
from the repository root.
