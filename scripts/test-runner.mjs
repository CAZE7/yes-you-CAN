#!/usr/bin/env node
/**
 * Test runner orchestrator.
 *
 * In CI, runs Vitest directly with `--coverage` in a single pass so that:
 * 1. Vitest measures coverage and enforces all thresholds in vitest.config.ts.
 * 2. VDP_COVERAGE_CHILD=1 prevents coverage-gate.test.ts from redundantly
 *    spawning a second full test suite as a child process.
 * 3. CI finishes in a single pass (~35s instead of ~110s).
 *
 * In local development (CI unset), runs Vitest without coverage for fast feedback.
 */

import { spawnSync } from "node:child_process";

const isCi = process.env.CI === "true" || process.env.CI === "1";
const isChild = process.env.VDP_COVERAGE_CHILD === "1";

const projects = [
  "--project",
  "unit",
  "--project",
  "protocol",
  "--project",
  "regression",
  "--project",
  "replay",
  "--project",
  "integration",
  "--project",
  "architecture",
];

const passThroughArgs = process.argv.slice(2);

const args =
  isCi && !isChild
    ? ["run", "--coverage", ...projects, ...passThroughArgs]
    : ["run", ...projects, ...passThroughArgs];

const env = isCi && !isChild ? { ...process.env, VDP_COVERAGE_CHILD: "1" } : process.env;

const executable = process.platform === "win32" ? "npx.cmd" : "npx";
const result = spawnSync(executable, ["vitest", ...args], {
  stdio: "inherit",
  env,
  shell: process.platform === "win32",
});

process.exit(result.status ?? 1);
