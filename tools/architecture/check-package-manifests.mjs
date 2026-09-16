#!/usr/bin/env node
/**
 * The manifest rule: `package.json` says exactly what the code imports (AGENTS 34.20;
 * the sibling question of master backlog P0 #2).
 *
 * `check-dependencies.mjs` answers *may* a package import another one. This tool answers
 * the other half — *does the manifest know about it* — because a hoisted workspace
 * answers that question with silence: an import of a package nobody declared works,
 * until the day it does not, and a declared dependency nothing imports makes `npm audit`,
 * Renovate and a license scan report a relationship that does not exist.
 *
 * Four rules, one per direction of that drift:
 *
 *  - `missing-production-dependency` — production source imports a workspace or npm
 *    package the manifest does not declare. Hoisting hides it today; a flat install, a
 *    published package or a re-ordered `node_modules` does not.
 *  - `unused-production-dependency` — declared, imported by nothing. A dependency is a
 *    claim about the package's footprint, and a false claim is worse than no claim.
 *  - `test-only-dependency` — declared as a *production* dependency while only the
 *    package's own tests import it. The honest place for it is `devDependencies`.
 *  - `dep-version-drift` / `unknown-workspace-dependency` — the workspace moves in
 *    lockstep (ADR 0010), so a `@vdp/*` range is either the root version or a mistake.
 *
 * Test sources are exempt from *declaring* workspace packages deliberately: npm links
 * every workspace package into the root, so requiring a per-package devDependency on the
 * whole tree would be noise that says nothing. What is not exempt is a production import —
 * the surface every consumer depends on — and a dependency that only exists for tests.
 *
 * Usage:
 *   node tools/architecture/check-package-manifests.mjs [--root <dir>] [--json]
 *
 * Exit codes: 0 = every manifest matches its imports, 1 = drift, 2 = the tool could not
 * read the tree (so a broken manifest is never mistaken for a clean workspace).
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(HERE, "../..");

/** Workspace roots, mirroring the `workspaces` field of the root manifest. */
const WORKSPACE_ROOTS = [
  { root: "packages", depth: 1 },
  { root: "packages", depth: 2 },
  { root: "tools", depth: 1 },
  { root: "apps", depth: 1 },
];

/**
 * Everything that names a module: static import/export, dynamic `import()`, `require()`
 * and `require.resolve()`.
 *
 * `require.resolve` is in the list on purpose: a server that *serves a module's files*
 * has a real dependency on it. `apps/web` resolves `@vdp/charts` to hand the browser the
 * very module the tests run against (ADR 0011), and a checker that read only `from`
 * clauses would demand the removal of a load-bearing dependency.
 */
/**
 * The specifier patterns, each anchored at a position only code can have.
 *
 * Prose is the hazard here, not syntax: a doc comment that says the model distinguishes
 * "no start" from "misfire" contains exactly the characters of an import statement, and a
 * checker that matched on them would invent a dependency on a package called `misfire`.
 * So every pattern is anchored to a line start (where a comment's `*` or `//` gets in the
 * way) or to a call's closing paren, and the tool is then allowed to read *comments as
 * comments* without stripping them first.
 */
const SPECIFIER_PATTERNS = [
  // `import x from "…"`, `export * from "…"`, `import type { A } from "…"` — one line.
  /^[ \t]*(?:import|export)\b[^;]*?\bfrom\s*['"]([^'"]+)['"]/gm,
  // The tail of the multi-line form: `} from "…"`.
  /^[ \t]*from\s*['"]([^'"]+)['"]/gm,
  // `import "…"` — a side-effect import.
  /^[ \t]*import\s+['"]([^'"]+)['"]/gm,
  // `import("…")` and `require("…")` — the closing paren is what separates a call from
  // a sentence that happens to contain the word.
  /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

/**
 * `resolve("@vdp/…")` — a module *located* rather than imported.
 *
 * `apps/web` serves the chart core to the browser by resolving its file path
 * (`createRequire(import.meta.url).resolve("@vdp/charts")`), which is a dependency in
 * every sense that matters, and `require.resolve` for a bare name is the same shape.
 * Restricted to workspace specifiers: `path.resolve("x")` and `Promise.resolve("ok")`
 * are not imports, and pretending otherwise is how a checker starts to lose trust.
 */
const RESOLVED_WORKSPACE = /\bresolve\s*\(\s*['"](@vdp\/[^'"]+)['"]\s*\)/g;

const TEST_SUFFIXES = [".spec.ts", ".test.ts", ".spec.tsx", ".test.tsx"];

function fail(message) {
  process.stderr.write(`check-package-manifests: ${message}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const options = { root: DEFAULT_ROOT, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") options.json = true;
    else if (arg === "--root") options.root = resolve(argv[++i] ?? fail("--root needs a path"));
    else fail(`unknown argument ${arg}`);
  }
  return options;
}

function readManifest(dir) {
  const path = join(dir, "package.json");
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`${path} is not valid JSON: ${error.message}`);
  }
}

function subDirs(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith(".") && name !== "node_modules" && name !== "dist");
}

/** Every directory below `root` that holds a `package.json`, in workspace layout. */
function discoverWorkspaceDirs(root) {
  const found = new Set();
  for (const { root: base, depth } of WORKSPACE_ROOTS) {
    const start = join(root, base);
    if (!existsSync(start)) continue;
    const collect = (dir, level) => {
      if (existsSync(join(dir, "package.json"))) {
        found.add(dir);
        return;
      }
      if (level >= depth) return;
      for (const name of subDirs(dir)) collect(join(dir, name), level + 1);
    };
    collect(start, 0);
  }
  return Array.from(found).sort();
}

/** Source files of one directory, each tagged production or test. */
function collectFiles(dir, bucket) {
  if (!existsSync(dir)) return bucket;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith("."))
      continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(full, bucket);
      continue;
    }
    if (!/\.(mjs|cjs|ts|tsx|js|jsx)$/.test(entry.name)) continue;
    bucket.push({ file: full, test: TEST_SUFFIXES.some((suffix) => entry.name.endsWith(suffix)) });
  }
  return bucket;
}

/**
 * `@vdp/definitions/generic` → `@vdp/definitions`, `../../x` → null.
 *
 * Returns `null` for anything that is not a package: a relative path, a `node:` builtin
 * (whose rules the portable-layer check already owns) and a file specifier.
 */
function packageName(specifier) {
  if (specifier.startsWith("node:") || specifier.startsWith(".") || specifier.startsWith("/"))
    return null;
  // A package name is `[scope/]?name[/sub]` with a narrow alphabet. Anything else —
  // prose, a URL, a path with spaces — is not an import, whatever preceded it.
  if (!/^(@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+(\/[A-Za-z0-9._@-]+)*$/.test(specifier)) return null;
  if (/\.(ts|js|mjs|cjs|json|css)$/.test(specifier)) return null;
  const parts = specifier.split("/");
  if (specifier.startsWith("@")) return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
  return parts[0];
}

/** Bare specifiers a set of files imports, split by production and test sources. */
function scanFiles(files, root) {
  const production = new Map();
  const tests = new Map();
  for (const { file, test } of files) {
    let source;
    try {
      source = readFileSync(file, "utf8");
    } catch (error) {
      fail(`cannot read ${file}: ${error.message}`);
    }
    for (const pattern of [...SPECIFIER_PATTERNS, RESOLVED_WORKSPACE]) {
      pattern.lastIndex = 0;
      for (const match of source.matchAll(pattern)) {
        const name = packageName(match[1]);
        if (name === null || name === undefined) continue;
        const bucket = test ? tests : production;
        const seen = relative(root, file).split("\\").join("/");
        const list = bucket.get(name);
        if (list === undefined) bucket.set(name, [seen]);
        else if (!list.includes(seen)) list.push(seen);
      }
    }
  }
  return { production, tests };
}

function keysOf(manifest, section) {
  return Object.keys(manifest[section] ?? {});
}

function evaluatePackage(entry, workspaceNames, workspaceVersion) {
  const violations = [];
  const { manifest, rel } = entry;
  const files = [];
  collectFiles(join(entry.dir, "src"), files);
  for (const extra of ["test", "tests"]) collectFiles(join(entry.dir, extra), files);
  const { production, tests } = scanFiles(files, entry.root);

  const declared = new Set([
    ...keysOf(manifest, "dependencies"),
    ...keysOf(manifest, "optionalDependencies"),
    ...keysOf(manifest, "peerDependencies"),
  ]);
  const declaredDev = new Set(keysOf(manifest, "devDependencies"));
  const where = (name) => (production.get(name) ?? tests.get(name) ?? [rel])[0];

  for (const [name, seen] of production) {
    if (name === manifest.name || declared.has(name) || declaredDev.has(name)) continue;
    violations.push({
      // A workspace package is *missing* from the manifest; anything else that is not in
      // the workspace is an npm dependency the root installs by accident of hoisting, and
      // that has to be declared with a licence and maintenance check (AGENTS 34.20).
      rule: workspaceNames.has(name)
        ? "missing-production-dependency"
        : "undeclared-external-dependency",
      package: manifest.name,
      dependency: name,
      message: `${rel}: production source imports ${name} (${seen[0]}) without declaring it`,
    });
  }

  for (const name of declared) {
    if (production.has(name)) continue;
    if (tests.has(name)) {
      violations.push({
        rule: "test-only-dependency",
        package: manifest.name,
        dependency: name,
        message: `${rel}: ${name} is a dependency, but only tests import it (${where(name)}) — move it to devDependencies or drop it`,
      });
      continue;
    }
    violations.push({
      rule: "unused-production-dependency",
      package: manifest.name,
      dependency: name,
      message: `${rel}: ${name} is declared and no source imports it`,
    });
  }

  for (const name of declaredDev) {
    if (production.has(name) || tests.has(name)) continue;
    violations.push({
      rule: "unused-production-dependency",
      package: manifest.name,
      dependency: name,
      message: `${rel}: ${name} is a devDependency and no source imports it`,
    });
  }

  for (const [section, list] of [
    ["dependencies", manifest.dependencies ?? {}],
    ["devDependencies", manifest.devDependencies ?? {}],
  ]) {
    for (const [name, version] of Object.entries(list)) {
      if (!name.startsWith("@vdp/")) continue;
      if (version !== workspaceVersion) {
        violations.push({
          rule: "dep-version-drift",
          package: manifest.name,
          dependency: name,
          message: `${rel}: ${section}.${name} is "${version}" — the workspace moves in lockstep, so the root version ${workspaceVersion} is the only right number`,
        });
      }
      if (!workspaceNames.has(name)) {
        violations.push({
          rule: "unknown-workspace-dependency",
          package: manifest.name,
          dependency: name,
          message: `${rel}: ${section} names ${name}, which is not a workspace package`,
        });
      }
    }
  }
  return violations;
}

function evaluate(root) {
  const violations = [];
  const dirs = discoverWorkspaceDirs(root);
  const manifests = dirs
    .map((dir) => {
      const manifest = readManifest(dir);
      return manifest === undefined
        ? undefined
        : { dir, root, rel: relative(root, dir).split("\\").join("/"), manifest };
    })
    .filter((entry) => entry !== undefined && entry.manifest.name !== undefined);
  const workspaceNames = new Set(manifests.map((entry) => entry.manifest.name));

  const rootManifest = readManifest(root);
  if (rootManifest === undefined) fail(`no package.json at ${root}`);
  const workspaceVersion = rootManifest.version;

  for (const entry of manifests) {
    violations.push(...evaluatePackage(entry, workspaceNames, workspaceVersion));
  }

  // A package that exists but is not in any workspace glob cannot be built, linked or
  // imported through the workspace — the enumeration above is the only place that knows
  // what "the workspace" is, so the root manifest's promise is checked against it.
  const declaredGlobs = rootManifest.workspaces ?? [];
  if (declaredGlobs.length === 0) {
    violations.push({
      rule: "root-workspaces-empty",
      package: rootManifest.name,
      dependency: undefined,
      message: "the root manifest declares no `workspaces`, so nothing above is meaningful",
    });
  }

  /*
   * The root manifest is *not* checked for unused devDependencies, and that is a
   * decision rather than a gap: `typescript` is called as `tsc`, `@vitest/coverage-v8`
   * is loaded by vitest from the name in `coverage.provider`, and a `@types/*` entry is
   * picked up by TypeScript's own resolution. A name-matching rule would flag all three
   * and be right none of the time; the per-package rules below are the ones that prevent
   * a wrong import graph, which is what this tool exists for.
   */
  for (const name of keysOf(rootManifest, "dependencies")) {
    violations.push({
      rule: "root-production-dependency",
      package: rootManifest.name,
      dependency: name,
      message: `the root declares a production dependency ${name}; the workspace root is a tooling manifest, not a shippable package (AGENTS 34.20)`,
    });
  }
  return violations;
}

function humanReport(violations, packageCount) {
  if (violations.length === 0) {
    return `manifest rule: ${packageCount} packages checked, imports and package.json agree.`;
  }
  const lines = [`${violations.length} manifest violation(s):`];
  for (const violation of violations) lines.push(`  ✗ [${violation.rule}] ${violation.message}`);
  return lines.join("\n");
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!existsSync(join(options.root, "package.json"))) fail(`no workspace root at ${options.root}`);
  const violations = evaluate(options.root);
  const packageCount = discoverWorkspaceDirs(options.root).length;
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ root: options.root, violations }, null, 2)}\n`);
  } else {
    process.stdout.write(`${humanReport(violations, packageCount)}\n`);
  }
  process.exit(violations.length === 0 ? 0 : 1);
}

main();
