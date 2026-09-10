# Security Policy

## Scope

yes-you-CAN is a vehicle diagnostics workbench that runs locally. It is not a
safety-certified automotive tool, and it deliberately ships read-only first
(AGENTS 34.11): every write operation must pass the SafetyManager (AGENTS 26).

## Reporting a vulnerability

Please do **not** open a public issue. Contact the repository owner directly
(via the GitHub profile) — or, if enabled for this repository, use GitHub
private vulnerability reporting (Security → Report a vulnerability).

Where possible, include:

- the affected route or package and the commit SHA,
- a minimal reproduction — the simulator (`npm run demo`) is sufficient,
- the impact you see (path traversal, request smuggling, protocol abuse, …).

## Baseline expectations

- The web server binds localhost by default (ADR 0009); exposing it via
  `--host`/`VDP_HOST` is an explicit, logged decision. The UI has no
  authentication — treat any network exposure as granting full access.
- Request bodies are size-limited, static files are confined to `public/`,
  and session IDs are validated before any filesystem access (ADR 0007).
- No secrets in source (AGENTS 34.16); the AI gateway redacts the VIN before
  data leaves the machine.

## Update channel

Dependencies and GitHub Actions are kept current via Dependabot; CI runs the
full suite on Node 22 and 24 for every change.
