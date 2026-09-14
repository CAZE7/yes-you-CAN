/**
 * Root Vitest configuration (testing standards: "Test pyramid" + "Coverage gates").
 *
 * Projects mirror the test pyramid:
 *  - `unit`         co-located `src/*.spec.ts` next to the code under test
 *  - `protocol`     domain suite `tests/protocol`
 *  - `regression`   domain suite `tests/regression` (error-injection cases)
 *  - `replay`       domain suite `tests/replay` (fixture-driven, golden snapshots)
 *  - `integration`  `tests/integration` + app-level tests (no CAN hardware)
 *  - `hardware`     `tests/hardware` — vcan only, run by the nightly CI job
 *
 * `test:unit` is the fast default; it never touches sockets, CAN hardware or
 * real time (determinism rule). Hardware tests are a separate project so they
 * can never run implicitly.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';

// Vite may execute this config from a bundled temp file, so import.meta paths
// are unreliable. Everything below is rooted at the workspace (the scripts and
// CI always run from the repository root).
const root = process.cwd();

/**
 * Resolve every workspace package's export map to its TypeScript sources so
 * tests run against `src/` directly — no build step, no stale dist.
 * `./dist/src/foo.js` → `<pkgRoot>/src/foo.ts`.
 */
interface AliasEntry {
  find: RegExp;
  replacement: string;
}

function workspaceAliases(): AliasEntry[] {
  const aliases: AliasEntry[] = [];
  const roots = [resolve(root, 'packages'), resolve(root, 'tools'), resolve(root, 'apps')];
  const manifests: string[] = [];
  for (const workspaceRoot of roots) {
    for (const entry of listDirs(workspaceRoot)) {
      const nested = resolve(workspaceRoot, entry);
      manifests.push(resolve(nested, 'package.json'));
      for (const sub of listDirs(nested)) {
        const manifest = resolve(nested, sub, 'package.json');
        if (existsSync(manifest)) manifests.push(manifest);
      }
    }
  }
  for (const manifest of manifests) {
    let json: { name?: string; exports?: Record<string, unknown> };
    try {
      json = JSON.parse(readFileSync(manifest, 'utf8'));
    } catch {
      continue;
    }
    if (!json.name || !json.exports) continue;
    for (const [subpath, target] of Object.entries(json.exports)) {
      const targetDefault =
        typeof target === 'string' ? target : ((target as { default?: string }).default ?? '');
      if (!targetDefault.startsWith('./dist/')) continue;
      const srcPath = resolve(
        dirname(manifest),
        targetDefault.replace(/^\.\/dist\//, './').replace(/\.js$/, '.ts'),
      );
      if (!existsSync(srcPath)) continue;
      // Anchored regex: exact match only, so `@vdp/definitions` never
      // swallows `@vdp/definitions/generic` (object-form aliases match by
      // prefix and would break subpath exports).
      const find = subpath === '.' ? new RegExp(`^${json.name.replace(/[\\/]/g, '\\$&')}$`) : null;
      const subFind = subpath === '.' ? null : new RegExp(`^${json.name.replace(/[\\/]/g, '\\$&')}${subpath.replace(/^\./, '').replace(/[\\/.*+?^${}()|[\]\\]/g, '\\$&')}$`);
      if (find) aliases.push({ find, replacement: srcPath });
      if (subFind) aliases.push({ find: subFind, replacement: srcPath });
    }
  }
  return aliases;
}

function listDirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).filter(
      (entry) => !entry.startsWith('.') && entry !== 'node_modules' && entry !== 'dist',
    );
  } catch {
    return [];
  }
}

/**
 * Our NodeNext codebase imports siblings with explicit `.js` extensions. This
 * maps those to the `.ts` sources so tests execute without a build step.
 */
function jsExtensionToTs(): Plugin {
  return {
    name: 'js-extension-to-ts',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer || !/\.tsx?$/.test(importer) || !source.startsWith('.') || !source.endsWith('.js')) {
        return null;
      }
      const candidate = resolve(dirname(importer), source.replace(/\.js$/, '.ts'));
      return existsSync(candidate) ? candidate : null;
    },
  };
}

const isCi = process.env.CI === 'true' || process.env.CI === '1';
const junitFile = process.env.VITEST_JUNIT_FILE;

/** Shared per-project test options. */
const baseTest = {
  environment: 'node' as const,
  // Workspace packages must be transformed by Vite (sources, not dist).
  // Without inlining they are externalized to native node resolution, which
  // loads compiled `dist/` output and hides source coverage.
  server: { deps: { inline: [/@vdp\//] } },
  // `retry` is allowed in CI only; the flaky reporter turns every retried pass
  // into a visible warning — retries are never silently swallowed.
  retry: isCi ? 2 : 0,
  testTimeout: 20_000,
  hookTimeout: 20_000,
  restoreMocks: true,
};

/** Every non-hardware project, in pyramid order. */
export const defaultProjects = ['unit', 'protocol', 'regression', 'replay', 'integration', 'architecture'] as const;

/**
 * Vite-level options must be repeated per project: inline projects do not
 * inherit the root `resolve`/`plugins` sections. Without the alias, bare
 * `@vdp/*` imports would silently resolve to compiled `dist/` output and
 * coverage would be attributed to build artefacts instead of sources.
 */
const viteShared = {
  plugins: [jsExtensionToTs()],
  resolve: { alias: workspaceAliases() },
};

function project(options: { name: string; include: string[]; testTimeout?: number }) {
  return { ...viteShared, test: { ...baseTest, ...options } };
}

export default defineConfig({
  test: {
    reporters: [
      'default',
      // NOTE: vitest has no built-in "github" reporter id — `'github'` makes it
      // try to import a module named `github` and abort the run at startup
      // (exactly what CI saw). CI failure lines come from the default reporter;
      // our flaky reporter emits the ::warning annotations itself.
      ...(junitFile ? (['junit'] as const) : []),
      './tools/test-reporters/flaky-reporter.ts',
    ],
    ...(junitFile ? { outputFile: { junit: junitFile } } : {}),
    projects: [
      project({
        name: 'unit',
        include: ['packages/**/src/**/*.spec.ts', 'tools/**/src/**/*.spec.ts'],
      }),
      project({ name: 'protocol', include: ['tests/protocol/**/*.test.ts'] }),
      project({ name: 'regression', include: ['tests/regression/**/*.test.ts'] }),
      project({ name: 'replay', include: ['tests/replay/**/*.test.ts'] }),
      project({
        name: 'integration',
        include: ['tests/integration/**/*.test.ts', 'apps/web/test/**/*.spec.ts'],
        testTimeout: 30_000,
      }),
      // Static analysis of the import graph — the dependency rules are tests
      // (target architecture §29), so they run in CI like any other suite.
      project({
        name: 'architecture',
        include: ['tests/architecture/**/*.test.ts'],
      }),
      // Only the nightly CI job runs this (virtual CAN interface required);
      // it is excluded from every default script.
      project({
        name: 'hardware',
        include: ['tests/hardware/**/*.test.ts'],
        testTimeout: 60_000,
      }),
    ],
    coverage: {
      provider: 'v8',
      // The measurement covers the whole tree that has behaviour, not only `packages`:
      // apps/web (server, backend, mappers to the screen) and tools (importer,
      // simulators, trace analyzer, flaky reporter) are product code too. Their 77 web
      // tests ran without ever appearing in a coverage number (ADR 0027).
      include: ['packages/**/src/**/*.ts', 'apps/web/src/**/*.ts', 'tools/**/*.ts'],
      exclude: [
        // Barrel files re-export only; they carry no behaviour to cover. Scoped to
        // `**/src/` so a tool's entry point outside a src directory stays visible.
        '**/src/index.ts',
        // Type-only modules have no executable lines.
        '**/src/**/types.ts',
        '**/*.d.ts',
        // Hardware-bound modules: require OS serial / socketcan / vcan; covered
        // by integration/hardware suites, not by unit thresholds.
        'packages/adapters/host/src/serial.ts',
        'packages/adapters/socketcan/src/binding.ts',
      ],
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      reportsDirectory: 'coverage',
      // Standards: coverage must be produced even when the run fails.
      reportOnFailure: true,
      thresholds: {
        // Global gate, enforced as project average (not per file) so hardware
        // glue modules do not distort it. Raised 80/75 → 90/80 on 2026-09-12
        // after the DoIP and chart-core backfill measured 96.3% lines / 84.2%
        // branches / 95.9% functions / 94.4% statements (ADR 0017: tests first,
        // gates only move up).
        lines: 90,
        branches: 80,
        functions: 90,
        statements: 90,
        perFile: false,
        // Safety-adjacent cores: per-file gates stay high but branches relaxed
        // to 65 while coverage is backfilled (was 95/90, causing 87 red thresholds).
        // Raised 85/65 -> 88/80 on 2026-09-14 after the E11 backfill (ADR 0017: tests
        // first, then the gate). Measured per file: weakest lines `dtc/clear.ts` 90,24,
        // weakest branches `diagnostics/engine.ts` 82,10 — `ecu-session.ts` itself went
        // 85,58/71,26 -> 99,09/90,80 with its own spec (19 tests over probes, NRC
        // handling, session timing and the write precondition). The gap of ~2 points is
        // what makes the gate bite: a new uncovered file in core now fails the run.
        'packages/core/src/**': { lines: 88, branches: 80, perFile: true },
        'packages/protocols/**/src/**': { lines: 90, branches: 75, perFile: true },
        // Adapter glue — hardware paths are injected, not mocked away.
        // Raised 65/45 → 85/75 on 2026-09-12: `host/catalog.ts` was the reason
        // the old gate existed (68.0/48.6, the thinnest file in the tree) and now
        // measures 100/95.2, because probing, creation and cleanup are tested
        // through an injected SocketCAN binding and a regular file standing in
        // for a serial device. Weakest adapter file: elm327/protocol.ts 96.3/76.
        // `serial.ts` and `socketcan/binding.ts` stay excluded (ADR 0016 §2).
        // Raised 85/75 -> 92/78 on 2026-09-14 (E16): `elm327/protocol.ts` 96,3/76,0 and
        // `elm327/stream.ts` 88,2/100 are at 100/100 now, and the weakest files measured
        // 95,40 lines / 83,78 branches (`host/selection.ts`) in the same run.
        'packages/adapters/**/src/**': { lines: 92, branches: 78, perFile: true },
        // Raised 75/50 → 85/70 on 2026-09-12: after the DoIP backfill the
        // weakest transport file is iso-tp/connection.ts at 92.9/75.3 and
        // doip/transport.ts went from 78.6/68.3 to 98.5/88.7 (ADR 0017).
        // Raised 85/70 -> 88/72 on 2026-09-14 after `transport/can/src/bus.ts` was
        // backfilled to 100/100 (registry lookups and the unknown-adapter message, E16);
        // weakest measured: `iso-tp/connection.ts` 92,85 lines / 75,62 branches.
        'packages/transport/**/src/**': { lines: 88, branches: 72, perFile: true },
        // Raised from 70/45 on 2026-09-11 after backfilling the crash-tolerance,
        // migration-persistence and list-resilience paths (ADR 0017: tests first).
        // Raised again 90/55 -> 95/80 on 2026-09-12 after the corrupt-archive and
        // migration-order tests: zip.ts 100/83.9, migrations.ts 100/92.3,
        // repository.ts 100/86.1. 80 is the honest ceiling for zip.ts — its
        // remaining `?? 0` arms exist only because `noUncheckedIndexedAccess`
        // cannot see that `offset + 4 <= archive.length` already proved the index.
        'packages/storage/**/src/**': { lines: 95, branches: 80, perFile: true },
        // New on 2026-09-12 after the foundation backfill: all five files in
        // `packages/shared` measure 100 % lines / 100 % branches / 100 %
        // statements, so the gate pins exactly that. Branches keep five points of
        // room for defensive arms; lines do not, because every statement in the
        // package every other package logs and parses through is executed by a
        // test — and a new line here has to arrive with one.
        'packages/shared/**/src/**': { lines: 100, branches: 95, perFile: true },
        // New on 2026-09-12: the export path had no per-file gate at all, which
        // is how a UTF-8/Latin-1 encoding bug survived in `pdf.ts`. Measured
        // pdf.ts 100/88.9 and report.ts 100/79.5.
        // Raised 95/75 -> 95/80 on 2026-09-14: report.ts and pdf.ts both measure 100
        // lines, and the weakest branches are 83,33 (`report.ts`, after the variant-
        // knowledge tests of ADR 0026) — 3,3 points of room, so a new branch in the
        // export path has to arrive with a test.
        'packages/reports/**/src/**': { lines: 95, branches: 80, perFile: true },
        // New on 2026-09-12: measured heuristic.ts 94.9/79.5, http.ts 100/87.7,
        // service.ts 100/100 after the transport, timeout and gateway-junk tests.
        // Raised 90/75 -> 95/85 on 2026-09-14 after the analysis-input backfill
        // (E16, ADR 0017: tests first). Measured in this tree: heuristic.ts 94,9/79,5 ->
        // 100/89,4 (empty-recommendation, unknown-severity and threshold-configuration
        // arms included), http.ts 100/87,7 — the binding file — service.ts 100/100.
        // 85 sits 2,7 points under the weakest branch count, so a new untested branch in
        // `ai` is a red run instead of a drift.
        'packages/ai/**/src/**': { lines: 95, branches: 85, perFile: true },
        // New on 2026-09-12 with the vehicle-definition layer (ADR 0023): the
        // resolver decides which car a workshop is looking at, so its criteria,
        // its weights and its evidence strings are all tested per file. Measured
        // resolve.ts 100 lines / 92.8 % branches, evidence.ts, vehicles.ts,
        // schema.ts and every built-in package 100/100, validate.ts 96.1/89.8,
        // json.ts 99.1/92.8. `migrate.ts` is the ceiling at 87.5/87.5: its last
        // throw fires only when a schema version is added to
        // SUPPORTED_SCHEMA_VERSIONS without a migration step, so no input can
        // reach it — that is the point of the line, and it says so in a comment.
        'packages/definitions/**/src/**': { lines: 85, branches: 80, perFile: true },
        // New on 2026-09-14 with the measurement scope widened to the whole tree
        // (ADR 0027). This is a FLOOR, not a target: measured per file — server.ts
        // 69,63 lines / 65,53 branches, backend.ts 89,61/73,22, adapters.ts
        // 73,68/54,54 (functions 60), paths.ts 100/91,66, vehicle-view.ts 100/87,5,
        // dtc-knowledge-view.ts and analysis-input.ts 100/100 and 100/97,4. The gate
        // sits one point under the weakest measured value per column, so it cannot be
        // satisfied by moving code around and it fails the moment coverage slips — the
        // web layer used to be invisible to this file entirely, which is how its two
        // thin files stayed thin. Closing the gap is 0.E E17, not a gate to dream up.
        'apps/web/src/**': { lines: 69, branches: 54, perFile: true },
        // `tools/**` is measured now (definition-importer 97,9/95,3 lines, simulators
        // 94,9/82,0, trace-analyzer 97,8/75,3) but deliberately has NO per-file gate:
        // `tools/test-reporters/flaky-reporter.ts` measures 0 % — lines 29-101, no
        // test — because nothing can run it (E10: the hardened CI workflows are not
        // pushable, so the flaky reporter has no host). Excluding it would raise the
        // number by deleting the finding, so it stays visible at 0 % and named in 0.E.
        // Raised 75/70 → 90/75 on 2026-09-12: `group.ts` was the reason the old
        // gate existed (77.0/77.6, one refactor away from red) and is now at
        // 99.1/91.3; the weakest chart file is viewport.ts at 92.5/77.1.
        'packages/charts/**/src/**': { lines: 90, branches: 75, perFile: true },
        // New 2026-09-14 with the diagnostic IR (P0 #6): builders and evidence
        // helpers are pure data transformation, so they are gated like shared —
        // every branch of "value, or the reason there is none" is a test case.
        'packages/diagnostic-ir/**/src/**': { lines: 95, branches: 85, perFile: true },
      },
    },
  },
});
