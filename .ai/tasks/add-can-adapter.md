# Task: CAN-Adapter hinzufügen

**Kontext:** `npm run ai:context transport`. Regeln:
[`.ai/contracts/transport.md`](../contracts/transport.md), ADR 0001.

## Schritte

1. **Neues Workspace-Paket** `packages/adapters/<name>/`:
   - `package.json` (Name `@vdp/adapter-<name>`, Dependencies:
     `@vdp/shared`, `@vdp/transport-can` — nichts anderes,
     ADR 0002/0042: das Manifest ist eine Behauptung, `check:manifests`
     prüft sie),
   - `tsconfig.json` (Pattern: `packages/adapters/elm327/tsconfig.json`),
   - `src/index.ts`: `CanBus`-Implementierung +
     `create<Name>Factory(...) → CanAdapterFactory`.
2. **Physikalische Seite injizierbar:** Stream (wie ELM327) oder Binding
   (wie SocketCAN) — die Hardware-Klammer bleibt austauschbar,
   `node:`-Builtins bleiben aus dem Paket heraus (außer: es ist
   `host`).
3. **Host-Katalog:** `packages/adapters/host/src/catalog.ts` —
   `AdapterEntry` mit Defaults, Probing (`isAvailable`), Bitrates;
   `catalog.spec.ts` erweitern (ADR 0016: Probing ohne Nebenwirkungen).
4. **YAML-Eintrag (vor dem ersten Import!):**
   `architecture/architecture.yaml` → `packages."@vdp/adapter-<name>"`
   mit `layer: "adapter"`, `mayImport`, `why`. `check:deps` fällt sonst
   mit `unplaced-package`.
5. **Root-Konfiguration:** `tsconfig.json` (references),
   `tsconfig.typecheck.json` (paths), `package.json` (workspaces decken
   `packages/adapters/*` bereits ab).
6. **Tests:** co-lokatierte `src/*.spec.ts` (Gate 92/78) — Hardware-Pfad
   mit injiziertem Binding/Stream; echter Hardware-Test (falls Linux/
   vcan relevant) nach `tests/hardware/` (manual).
7. **Doku im selben PR:** `packages/adapters/<name>/README.md` (fixer
   Aufbau, v. a. „Does NOT do“), `packages/adapters/README.md`
   (Tabelle), `docs/code-map.md` (Zeile „CAN-Adapter hinzufügen“ bleibt
   gültig), ggf. `docs/api/transport.md`.
8. **Tor:** `npm run check:deps && npm run check:manifests && npm test`.

## Stop-Signale

- Adapter importiert `@vdp/protocols-*` oder `@vdp/core` → Layer-Regel.
- `node:serialport`/`node:net` in einem Nicht-Host-Adapter → Portabilität.
- Zweite ELM327/slcan-Parsing-Kopie → die geteilte Schicht (canable-
  README „Important invariants“).
- Engine/Workbench kennt den Adapter-`id` hardkodiert → Katalog ist die
  eine Stelle.
