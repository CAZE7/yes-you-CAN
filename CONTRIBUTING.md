# Contributing to yes-you-CAN

Thanks for working on the Vehicle Diagnostics Platform. This project trades
feature speed for correctness and architecture discipline — the constraints
below are intentional (see [`AGENTS.md`](AGENTS.md) and [`docs/adr/`](docs/adr/)).

## Quick start

```bash
npm ci            # exact lockfile, Node >=22
npm run build     # tsc -b over all project references
npm run typecheck # + strict noEmit over specs, configs and the frontend JS
npx biome check . # lint + format (Biome 1.9)
npm test          # build + 6 layers: unit · protocol · regression · replay · integration · architecture
npm run demo      # workbench with simulator on http://localhost:8080
```

Tests run directly on the TypeScript sources via Vitest workspace aliases
(`vitest.config.ts`). `npm test` still runs `npm run build` first, because the
workbench integration tests serve the compiled chart core from `/lib`
(AGENTS 34.26).

## Workflow

1. Branch from `main`: `git checkout -b feat/short-topic` (one topic per PR).
2. Keep changes small and narrated: `<scope>: <what>` as the subject, the
   *why* and the *measurement* in the body.
3. Fill the PR template — it encodes the Definition of Done (AGENTS 35).
4. CI must be green on Node 22 **and** 24. No merge on red.
5. Architecture or toolchain decisions get an ADR in `docs/adr/` (AGENTS 34.15).
   Superseded ADRs are marked, never deleted.
6. Read the contract in `AGENTS.md`; read *history* in
   `docs/changelog/agents-contract.md`, *status* in `docs/architecture/status.md`
   and *open work* in `docs/architecture/backlog.md` (ADR 0059). A rule lives in
   `AGENTS.md` — never in a changelog bullet.

## Workflow files and the `workflows` permission

**State 2026-09-24: the four hardened workflows are in the repository.** `ci.yml`
(quality job + test matrix + coverage artifact), `codeql.yml`,
`dependency-review.yml` and `hardware.yml` (nightly `vcan0` smoke) are on `main`
— pushed by the repository's owner, not by the GitHub App.

The App still cannot write that directory. Measured 2026-09-24, twice: `git push`
→ `refusing to allow a GitHub App to create or update workflow
'.github/workflows/ci.yml' without 'workflows' permission`; the contents API →
`403 Resource not accessible by integration`. A push that touches nothing under
`.github/workflows/` succeeds — the refusal is scoped to that directory, not to
the branch. Consequence for an agent: **do not plan a CI change you cannot
push.** Either the owner commits it, or the permission is granted.

**To unblock:** GitHub → *Settings → Applications → Arena (GitHub App) →
Repository Permissions → **Workflows: Read & write***.

**What is still missing, and what it costs.** `ci.yml` uploads `coverage/` as an
artifact with `if: always()` — an artifact is uploaded whether or not the
thresholds held, so it is a report, not a gate. The coverage thresholds are
carried by `tests/architecture/coverage-gate.test.ts`, which spawns
`npm run test:coverage` as a child *inside* `npm test` (CI only, recursion-guarded,
`retry: 0`; measured 65 s per leg). The honest form is a step in the workflow:

```yaml
      - name: Run the suite under coverage (the thresholds are the gate)
        run: npm run test:coverage
```

That one step needs someone who can write `.github/workflows/`. Until it exists,
`npm run ci` plus the carrier is what keeps the floors real.

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
- **Every rule that is not an error carries its reason** (`tests/architecture/guardrails.test.ts`
  reads `biome.json`): a rule is either made sharper or listed with the finding that keeps it
  open, overrides may only relax test sources, and the strict TypeScript flags from
  `tsconfig.base.json` are inherited, not negotiated (ADR 26).
- No runtime dependencies (ADR 0002) except where ADR 0010 explicitly allows them.
  Infrastructure deps need maintenance proof, license check (MIT/Apache-2.0/BSD) and
  a locally regenerated `package-lock.json` in the same PR.
- Frontend JS (`apps/web/public/*.js`) is type-checked (`checkJs` with the DOM
  lib) by its own project `tsconfig.frontend.json`, which `npm run typecheck`
  runs alongside the backend pass — and it shares chart maths through
  `@vdp/charts`. Do not duplicate graph rules.

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

**PTY suites are evidence, not a gate carrier.** `tests/integration/adapter-rehearsal.spec.ts`
and `host-serial.spec.ts` build a real serial link with `socat` and skip when it is
missing — and the GitHub runners do not ship `socat` (measured 2026-09-24: the CI job
failed with `ERROR: Coverage for branches (77.27%) does not meet "packages/adapters/**/src/**"
threshold (78%)` and **no** failing test, E38). A production path that only these suites
cover therefore loses its coverage in CI. Every branch a PTY suite touches needs a
socat-free unit test as well; the PTY suite proves the integration, the unit test
carries the gate.

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
