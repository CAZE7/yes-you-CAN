# `@vdp/storage`

**Layer:** persistence · **Pfad:** `packages/storage/` ·
**Regeln-Quelle:** [`architecture/architecture.yaml`](../../architecture/architecture.yaml)

## Purpose

Die Persistenz-Schicht (ADR 0007, ADR 0014): Session-Aufbewahrung
(JSON + NDJSON), **versionierte Migrations** und ZIP-Export. Die App
persistiert über dieses Paket und bleibt damit `@vdp/core`-frei in der
Speicher-Angelegenheit.

## Responsibilities

- `repository.ts`: `SessionRepository`-Vertrag,
  `FileSystemSessionRepository`, `MemorySessionRepository`,
  `StoredSessionSummary`, Trace-/Sample-Parser, `assertSafeId` (Path-Traversal)
- `migrations.ts`: versionierte Schema-Migrations (`SESSION_SCHEMA_VERSION`)
- `zip.ts`: deterministisches ZIP-Archiv für den Export
- Re-Export der Session-Verträge aus `@vdp/core`
  (`VehicleSessionData`, `RawTraceEntry`, `SessionLogger`) — die
  Persistenz-Oberfläche

## Does NOT do

- keine Diagnose-Logik, keine Protokoll-Kenntnis
- keine Runtime-/UI-Kenntnis (es hängt *unter* der Runtime)
- keine „Bequemlichkeit“: eine Session ohne Roh-Trace ist nicht
  replaybar — das bleibt Absage, nicht Stillschweigen (ADR 0004)

## Public API

`src/index.ts`: `migrations.ts`, `repository.ts`, `zip.ts` komplett.

## Dependencies

`@vdp/shared`, `@vdp/core` (Session-Verträge).

## Data Flow

```text
Workbench (apps/web/src/backend.ts)
  → SessionRepository.save/load/list  (FileSystemSessionRepository)
  → Migrations (altes Schema → neues, nie verworfen)
  → zip.ts (Export-Archiv)
```

## Important invariants

- **Migrations versioniert** (ADR 0007) — Schema-Änderung = neue Version
  + Migration, alte Sessions bleiben lesbar (Regel 34.14).
- **`node:fs` ist hier erlaubt** (Regel in `architecture.yaml`) — der
  Dateizugriff der Plattform.
- **Id-Sicherheit:** `assertSafeId` verhindert Path-Traversal über
  Session-Ids (Gate 95/80).

## Tests

Co-lokatierte `src/*.spec.ts` (Gate 95/80; zip/repository/migrations
gemessen 100 %, ADR 0022).

## Examples

```ts
import { FileSystemSessionRepository, MemorySessionRepository } from "@vdp/storage";

const repo = new FileSystemSessionRepository({ rootDir: "./sessions" });
await repo.save(sessionData); // Id steckt in sessionData.id
const { data, appliedMigrations } = await repo.load(sessionData.id);
const archive = await repo.exportPackage(sessionData.id); // Uint8Array (ZIP)
```
