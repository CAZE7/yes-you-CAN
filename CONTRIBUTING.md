# Contributing to yes-you-CAN

Thanks for working on the Vehicle Diagnostics Platform. This project trades
feature speed for correctness and architecture discipline — the constraints
below are intentional (see `AGENTS.md` and `docs/adr/`).

## Quick start

```bash
npm ci            # exact lockfile, Node >=22
npm run build     # tsc -b over all project references
npm run typecheck # + strict noEmit over specs and configs
npx biome check . # lint + format (Biome 1.9)
npm test          # 5 layers: unit · protocol · regression · replay · integration · architecture
npm run demo      # workbench with simulator on http://localhost:8080
```

Tests run directly on the TypeScript sources via Vitest workspace aliases
(`vitest.config.ts`). No `dist` step is needed for `npm test`.

## Workflow

1. Branch from `main`: `git checkout -b feat/short-topic` (one topic per PR).
2. Keep changes small and narrated: `<scope>: <what>` as the subject, the
   *why* and the *measurement* in the body.
3. Fill the PR template — it encodes the Definition of Done (AGENTS 35).
4. CI must be green on Node 22 **and** 24. No merge on red.
5. Architecture or toolchain decisions get an ADR in `docs/adr/` (AGENTS 34.15).
   Superseded ADRs are marked, never deleted.

## Project structure

- `packages/shared` — errors, hex/bytes, logger, events (dependency-free)
- `packages/domain` — projections, ports, capabilities, risk, events
- `packages/application` — Command-Bus, commands/queries, actions
- `packages/core` — engine, ECU discovery, DTC, recorder, safety
- `packages/transport/*` — CAN, ISO-TP, DoIP
- `packages/protocols/*` — UDS, KWP2000, OEM hooks
- `packages/definitions` — versioned schema, validator, provenance
- `packages/runtime` — `createDiagnosticRuntime` composition root
- `packages/adapters/*` — ELM327, CANable, SocketCAN, generic, host (Node bindings)
- `tools/*` — simulators, trace-analyzer, definition-importer
- `apps/web` — Node HTTP + SSE + Vanilla ESM workbench
- `tests` — integration / protocol / replay / regression / architecture (hardware is `tests/hardware`)

Dependency direction is enforced as a test
(`tests/architecture/dependencies.test.ts`, ADR 0015). Every workspace package
must appear in the allowlist — a new package without an entry fails the suite.

## Rules for agents and humans (short version)

- Never put CAN/UDS logic in the UI, never put OEM logic in the CAN layer.
- Keep `raw` and `decoded` data separate (ADR 0004).
- Read-only before write. Every write goes through `SafetyManager` (AGENTS 26).
- Definition packages carry mandatory `provenance` (ADR 0003). The shipped VAG/Mercedes
  packs are `example-placeholder` — never treat them as ground truth.
- No secrets in source, no unvetted data from competing products (AGENTS 24).
- Reference the ISO number in code comments when you touch norm details (AGENTS 34.18).
- A bug becomes a regression test with a symptom description.
- Measurement before claim: behaviour claims need a test run, build log or reproduction.

## Code style

- TypeScript 7 (`tsgo`) via `tsc -b`, `strict: true`, `verbatimModuleSyntax: true`.
- Biome for lint + format (`biome.json`): 2-space indent, 100-char line, double quotes,
  organized imports. Run `npx biome check --write .` before pushing.
- No runtime dependencies (ADR 0002) except where ADR 0010 explicitly allows them.
  Infrastructure deps need maintenance proof, license check (MIT/Apache-2.0/BSD) and
  a locally regenerated `package-lock.json` in the same PR.
- Frontend JS (`apps/web/public/*.js`) stays type-checked via `tsconfig.typecheck.json`
  and shares chart maths through `@vdp/charts` — do not duplicate graph rules.

## Testing

| Level | Command | Notes |
|---|---|---|
| unit | `npm run test:unit` | co-located `*.spec.ts`, fast feedback |
| protocol | `npm run test:protocol` | UDS/KWP2000/DoIP sequence tests |
| regression | `npm run test:regression` | one test per past bug, with symptom |
| replay | `npm run test:replay` | fixture-driven trace replay |
| integration | `npm run test:integration` | workbench + runtime as a system |
| architecture | `npm run test:architecture` | dependency graph is a test |
| hardware | `npm run test:hardware` | needs `vcan`, nightly only |
| coverage | `npm run test:coverage` | V8 provider, per-file gates (see `vitest.config.ts`) |

Use simulator and `ReplayTransport` instead of a real car wherever possible
(AGENTS 32, ADR 0005).

## Security

- Server binds `127.0.0.1` by default (ADR 0009). Exposing it (`VDP_HOST=0.0.0.0` /
  `--host`) is an explicit, logged decision.
- Security headers, body limit (1 MB) and GET-only stream are baseline — do not
  lower them without an ADR.
- Report vulnerabilities privately (see `SECURITY.md`), not via public issues.

## Documentation

If code and `AGENTS.md`/ADR disagree, the code is the source of truth — and
the PR that changes the code must also update the docs (AGENTS 34.24). ADRs are
short, dated and permanent.
