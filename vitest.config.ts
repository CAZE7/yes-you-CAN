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
    outputFile: junitFile ? { junit: junitFile } : undefined,
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
      include: ['packages/**/src/**/*.ts'],
      exclude: [
        // Barrel files re-export only; they carry no behaviour to cover.
        'packages/**/src/index.ts',
        // Type-only modules have no executable lines.
        'packages/**/src/**/types.ts',
        '**/*.d.ts',
      ],
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      reportsDirectory: 'coverage',
      // Standards: coverage must be produced even when the run fails.
      reportOnFailure: true,
      thresholds: {
        // Global gate.
        lines: 85,
        branches: 85,
        functions: 85,
        statements: 85,
        // Per-file floor everywhere (testing standards: "Global: 85% with
        // per-file thresholds").
        perFile: true,
        // Protocol core is safety-adjacent: 95% lines / 90% branches, per file.
        'packages/core/src/**': { lines: 95, branches: 90, perFile: true },
        'packages/protocols/**/src/**': { lines: 95, branches: 90, perFile: true },
        // Adapter/transport glue (mocked hardware paths): 80%.
        'packages/adapters/**/src/**': { lines: 80, branches: 80, perFile: true },
        'packages/transport/**/src/**': { lines: 80, branches: 80, perFile: true },
      },
    },
  },
});
