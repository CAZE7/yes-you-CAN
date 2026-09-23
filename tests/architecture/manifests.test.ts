/**
 * Manifest metadata is a contract, not decoration (ADR 0015: structure is a test).
 *
 * License scanners, `npm outdated`, Renovate and GitHub's dependency graph read
 * these fields *per package*. A workspace where only the root declares them
 * answers "which license does @vdp/storage ship under?" with silence, and a
 * typo in `main` is only noticed by whoever imports the package last. Until
 * 2026-09-12 all 25 workspace packages were silent on license, engines and
 * repository; these tests keep them from drifting apart again.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test } from "vitest";
import { discoverWorkspaceDirs, repoRoot } from "./workspace.js";

interface Manifest {
  name?: string;
  version?: string;
  private?: boolean;
  license?: string;
  type?: string;
  engines?: { node?: string };
  repository?: { type?: string; url?: string; directory?: string };
  main?: string;
  types?: string;
  exports?: Record<string, { types?: string; default?: string }>;
}

const read = (file: string): Manifest => JSON.parse(readFileSync(file, "utf8")) as Manifest;

const rootManifest = read(join(repoRoot, "package.json"));

const packages = discoverWorkspaceDirs().map((dir) => ({
  dir,
  rel: relative(repoRoot, dir),
  manifest: read(join(dir, "package.json")),
}));

test("the whole workspace is discovered, so a new package cannot slip through", () => {
  assert.ok(packages.length >= 25, `expected the whole workspace, found ${packages.length}`);
  const names = packages.map((entry) => entry.manifest.name);
  assert.equal(new Set(names).size, names.length, "package names must be unique");
  // `workspaces` in the root manifest is the promise these directories keep.
  assert.ok(rootManifest.name === "yes-you-can", "the root manifest must be the workspace root");
});

test("every package declares the license the root declares", () => {
  for (const { rel, manifest } of packages) {
    assert.equal(
      manifest.license,
      rootManifest.license,
      `${rel} must declare license "${rootManifest.license}"`,
    );
  }
});

test("every package pins the Node version the CI matrix runs", () => {
  for (const { rel, manifest } of packages) {
    assert.deepEqual(
      manifest.engines,
      rootManifest.engines,
      `${rel} must declare the same engines as the root`,
    );
  }
});

test("repository.directory points at the package's real path", () => {
  for (const { rel, manifest } of packages) {
    assert.equal(manifest.repository?.type, "git", `${rel}: repository.type`);
    assert.equal(
      manifest.repository?.url,
      rootManifest.repository?.url,
      `${rel}: repository.url must match the root`,
    );
    assert.equal(
      manifest.repository?.directory,
      rel,
      `${rel}: repository.directory must be the path relative to the root`,
    );
  }
});

test("the workspace is versioned in lockstep, private and ESM", () => {
  for (const { rel, manifest } of packages) {
    assert.equal(manifest.version, rootManifest.version, `${rel} must follow the root version`);
    assert.equal(manifest.private, true, `${rel} must stay private — nothing here is published`);
    assert.equal(manifest.type, "module", `${rel} is ESM like the rest of the repo`);
  }
});

test("entry points describe sources that exist and agree with each other", () => {
  for (const { dir, rel, manifest } of packages) {
    if (!manifest.main) continue; // the root manifest has no entry point
    assert.ok(
      manifest.main.startsWith("./dist/") && manifest.types?.startsWith("./dist/"),
      `${rel}: main/types must point into dist, found ${manifest.main} / ${manifest.types}`,
    );
    // `dist` is a build artefact and may be absent in a fresh clone; the source
    // it is generated from is the invariant that can actually be checked.
    const source = manifest.main.replace("./dist/", "").replace(/\.js$/, ".ts");
    assert.ok(
      existsSync(join(dir, source)),
      `${rel}: main points at ${manifest.main}, but ${source} does not exist`,
    );
    const entry = manifest.exports?.["."];
    if (!entry) continue;
    assert.equal(entry.default, manifest.main, `${rel}: exports must name the same file as main`);
    assert.equal(entry.types, manifest.types, `${rel}: exports must name the same types`);
  }
});

/**
 * The version an analysis cites as `runtimeVersion` (P0 #42).
 *
 * `@vdp/runtime` declares `PLATFORM_VERSION` as a constant, which is a copy — and a
 * copy needs the check that keeps it true. Two assertions, both cheap: the whole
 * workspace moves as one version, and the constant names exactly that version. A
 * build stamp does not exist here (no bundler, no codegen), so the workspace version
 * is the honest floor of "which software answered"; an answer that cited a version
 * nothing else carries would be less reproducible than no version at all.
 */
test("every workspace package carries the root version", () => {
  const drifted = packages
    .filter((entry) => entry.manifest.version !== rootManifest.version)
    .map((entry) => `${entry.manifest.name}: ${entry.manifest.version}`);
  assert.deepEqual(drifted, [], `packages that drifted from ${rootManifest.version}`);
});

test("PLATFORM_VERSION is the version the workspace actually has", () => {
  const source = readFileSync(join(repoRoot, "packages/runtime/src/version.ts"), "utf8");
  const declared = /export const PLATFORM_VERSION = "([^"]+)";/.exec(source);
  assert.ok(declared, "version.ts must declare the constant the analysis cites");
  assert.equal(
    declared?.[1],
    rootManifest.version,
    "the constant is a copy of the root version — this test is what keeps it true",
  );
});

/**
 * The manifest *is* the import graph (AGENTS 34.20; master backlog P0 #2's sibling).
 *
 * A hoisted workspace makes an undeclared import work, and makes an unused dependency
 * harmless — which is exactly why neither survives without a gate. The rule is a tool
 * (`tools/architecture/check-package-manifests.mjs`, `npm run check:manifests`, part of
 * `npm run ci`) and these tests are its three duties: that it is wired in, that the tree
 * passes it, and that it bites. The fixtures below are the bite proof — each is a whole
 * drift that must be reported, plus two shapes that must **not** be reported, because a
 * checker that invents dependencies out of prose is a checker whose findings get ignored.
 */

const MANIFEST_TOOL = join(repoRoot, "tools/architecture/check-package-manifests.mjs");

interface ManifestViolation {
  rule: string;
  package: string;
  dependency?: string;
  message: string;
}

function runManifestTool(args: readonly string[] = []): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(process.execPath, [MANIFEST_TOOL, ...args], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("the manifest rule runs in the CI path, not only in this test", () => {
  const root = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  const scripts = root.scripts ?? {};
  assert.equal(
    scripts["check:manifests"],
    "node tools/architecture/check-package-manifests.mjs",
    "the rule needs a script of its own",
  );
  assert.ok(
    (scripts.ci ?? "").includes("check:manifests"),
    "`npm run ci` must run the manifest rule before the tests",
  );
  assert.ok(
    (scripts.ci ?? "").includes("check:deps"),
    "the layer rule stays part of the same gate — two questions, one gate",
  );
});

test("every manifest matches its imports", () => {
  const run = runManifestTool(["--json"]);
  assert.equal(
    run.status,
    0,
    `the manifest rule must pass on this tree:\n${run.stdout}\n${run.stderr}`,
  );
  const violations = JSON.parse(run.stdout) as { violations: ManifestViolation[] };
  assert.deepEqual(violations.violations, []);
});

test("the manifest rule reads the graph, it does not restate it (ADR 0031)", () => {
  const tool = readFileSync(MANIFEST_TOOL, "utf8");
  // The allowed-edge list belongs to architecture/architecture.yaml. A second copy here would be
  // a second rule, and the two would drift exactly like the lint config did before ADR
  // 0029 — so the manifest tool must not contain a single `mayImport` entry.
  assert.doesNotMatch(tool, /mayImport/, "the manifest tool must not restate the layer rules");
  assert.doesNotMatch(
    tool,
    /"@vdp\/[a-z-]+":\s*\[/,
    "no dependency allow list may live in this file",
  );
});

/** A two-package workspace with `code` written into `packages/one/src/index.ts`. */
function fixtureWorkspace(files: Record<string, string>): {
  dir: string;
  run: () => { status: number | null; stdout: string };
} {
  const dir = mkdtempSync(join(tmpdir(), "vdp-manifest-"));
  for (const [name, content] of Object.entries(files)) {
    const full = join(dir, name);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return {
    dir,
    run: () => {
      const result = spawnSync(process.execPath, [MANIFEST_TOOL, "--root", dir, "--json"], {
        encoding: "utf8",
      });
      return { status: result.status, stdout: result.stdout };
    },
  };
}

const ROOT_MANIFEST = JSON.stringify({
  name: "fixture-root",
  version: "0.1.0",
  private: true,
  workspaces: ["packages/*"],
  devDependencies: { vitest: "5.0.0" },
});

const TWO_PACKAGES = {
  "package.json": ROOT_MANIFEST,
  "packages/two/package.json": JSON.stringify({
    name: "@vdp/two",
    version: "0.1.0",
    private: true,
    main: "./dist/src/index.js",
    dependencies: {},
  }),
  "packages/two/src/index.ts": "export const two = 2;\n",
};

function violationsOf(fixture: ReturnType<typeof fixtureWorkspace>): ManifestViolation[] {
  const run = fixture.run();
  assert.notEqual(run.status, 2, `the tool must not fail to read a fixture: ${run.stdout}`);
  return run.status === 0
    ? []
    : (JSON.parse(run.stdout) as { violations: ManifestViolation[] }).violations;
}

function rulesOf(fixture: ReturnType<typeof fixtureWorkspace>): string[] {
  return violationsOf(fixture).map((violation) => violation.rule);
}

test("an import nobody declared is reported", () => {
  const fixture = fixtureWorkspace({
    ...TWO_PACKAGES,
    "packages/one/package.json": JSON.stringify({
      name: "@vdp/one",
      version: "0.1.0",
      private: true,
      main: "./dist/src/index.js",
      dependencies: {},
    }),
    "packages/one/src/index.ts": 'import { two } from "@vdp/two";\nexport const one = two + 1;\n',
  });
  try {
    assert.deepEqual(rulesOf(fixture), ["missing-production-dependency"]);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("a declared dependency nothing imports is reported", () => {
  const fixture = fixtureWorkspace({
    ...TWO_PACKAGES,
    "packages/one/package.json": JSON.stringify({
      name: "@vdp/one",
      version: "0.1.0",
      private: true,
      main: "./dist/src/index.js",
      dependencies: { "@vdp/two": "0.1.0" },
    }),
    "packages/one/src/index.ts": "export const one = 1;\n",
  });
  try {
    assert.deepEqual(rulesOf(fixture), ["unused-production-dependency"]);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("a dependency only tests import is reported, and says where it belongs", () => {
  const fixture = fixtureWorkspace({
    ...TWO_PACKAGES,
    "packages/one/package.json": JSON.stringify({
      name: "@vdp/one",
      version: "0.1.0",
      private: true,
      main: "./dist/src/index.js",
      dependencies: { "@vdp/two": "0.1.0" },
    }),
    "packages/one/src/index.ts": "export const one = 1;\n",
    "packages/one/src/one.spec.ts": 'import { two } from "@vdp/two";\nexport const used = two;\n',
  });
  try {
    const violations = violationsOf(fixture);
    assert.deepEqual(
      violations.map((violation) => violation.rule),
      ["test-only-dependency"],
      "the production surface is what a manifest states, so a test-only entry is a wrong statement",
    );
    assert.match(violations[0]?.message ?? "", /devDependencies/);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("a workspace dependency that is not the root version is reported", () => {
  const fixture = fixtureWorkspace({
    ...TWO_PACKAGES,
    "packages/one/package.json": JSON.stringify({
      name: "@vdp/one",
      version: "0.1.0",
      private: true,
      main: "./dist/src/index.js",
      dependencies: { "@vdp/two": "^0.0.3" },
    }),
    "packages/one/src/index.ts": 'import { two } from "@vdp/two";\nexport const one = two;\n',
  });
  try {
    assert.deepEqual(rulesOf(fixture), ["dep-version-drift"]);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("a dependency that is not a workspace package is reported", () => {
  const fixture = fixtureWorkspace({
    ...TWO_PACKAGES,
    "packages/one/package.json": JSON.stringify({
      name: "@vdp/one",
      version: "0.1.0",
      private: true,
      main: "./dist/src/index.js",
      dependencies: { "@vdp/gone": "0.1.0" },
    }),
    "packages/one/src/index.ts": "export const one = 1;\n",
  });
  try {
    assert.ok(rulesOf(fixture).includes("unknown-workspace-dependency"));
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("a module served by resolved path counts as a dependency — and prose does not", () => {
  // Both halves matter. `apps/web` serves `@vdp/charts` to the browser through
  // `createRequire(...).resolve("@vdp/charts")`, which is a dependency the naive reader
  // of `from` clauses would demand be removed; and a doc comment that says a model tells
  // "no start" apart from "misfire" must never be read as an import of a package called
  // `misfire`. One fixture, both directions.
  const fixture = fixtureWorkspace({
    ...TWO_PACKAGES,
    "packages/one/package.json": JSON.stringify({
      name: "@vdp/one",
      version: "0.1.0",
      private: true,
      main: "./dist/src/index.js",
      // No `dependencies` at all: the point is that the resolve below *is* the reason it
      // would be wrong to call this clean — reported as missing, not as unused.
      devDependencies: {},
    }),
    "packages/one/src/index.ts": `/**
 * A checker that matched prose would report a dependency on "misfire" here, from a
 * sentence that says "no start" differs from "misfire" — and miss the real one below.
 */
import { createRequire } from "node:module";

const served = createRequire(import.meta.url).resolve("@vdp/two");
export const one = served.length;
`,
  });
  try {
    const violations = violationsOf(fixture);
    assert.deepEqual(
      violations.map((violation) => `${violation.rule}:${violation.dependency}`),
      ["missing-production-dependency:@vdp/two"],
      "the resolved workspace module is the only import, and prose is not an import",
    );
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("a broken manifest is exit 2, never a clean report", () => {
  const fixture = fixtureWorkspace({
    "package.json": ROOT_MANIFEST,
    "packages/broken/package.json": "{ not json",
  });
  try {
    const run = fixture.run();
    assert.equal(run.status, 2, "an unreadable manifest must not look like a passing tree");
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

/**
 * The publication boundary (ADR 0059).
 *
 * `private` is the field that decides whether a package can be installed by somebody
 * outside this repository. A publishable package that depends on a private one describes
 * an installation that cannot succeed — and with an open core beside closed modules the
 * mistake would stay invisible until a consumer tried it, which is the most expensive
 * moment to find out. The fixtures below prove the rule bites, that it is the *field* and
 * not the edge doing the work, and that a development-only relation stays allowed.
 */
test("a publishable package may not depend on a private one", () => {
  const fixture = fixtureWorkspace({
    "package.json": ROOT_MANIFEST,
    "packages/secret/package.json": JSON.stringify({
      name: "@vdp/secret",
      version: "0.1.0",
      private: true,
      main: "./dist/src/index.js",
    }),
    "packages/secret/src/index.ts": "export const secret = 1;\n",
    "packages/open/package.json": JSON.stringify({
      name: "@vdp/open",
      version: "0.1.0",
      main: "./dist/src/index.js",
      dependencies: { "@vdp/secret": "0.1.0" },
    }),
    "packages/open/src/index.ts":
      'import { secret } from "@vdp/secret";\nexport const open = secret;\n',
  });
  try {
    assert.deepEqual(
      rulesOf(fixture),
      ["private-dependency-leak"],
      "a published package cannot install a private one",
    );
    assert.equal(
      violationsOf(fixture)[0]?.dependency,
      "@vdp/secret",
      "the report names the dependency a consumer would trip over",
    );
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("the same edge is fine while both sides are private, or when only development uses it", () => {
  const privateBoth = fixtureWorkspace({
    "package.json": ROOT_MANIFEST,
    "packages/secret/package.json": JSON.stringify({
      name: "@vdp/secret",
      version: "0.1.0",
      private: true,
    }),
    "packages/host/package.json": JSON.stringify({
      name: "@vdp/host",
      version: "0.1.0",
      private: true,
      dependencies: { "@vdp/secret": "0.1.0" },
    }),
    "packages/host/src/index.ts": 'import "@vdp/secret";\n',
  });
  try {
    assert.deepEqual(
      rulesOf(privateBoth),
      [],
      "inside the organisation the edge is the point — the rule is about publication",
    );
  } finally {
    rmSync(privateBoth.dir, { recursive: true, force: true });
  }

  const devOnly = fixtureWorkspace({
    "package.json": ROOT_MANIFEST,
    "packages/secret/package.json": JSON.stringify({
      name: "@vdp/secret",
      version: "0.1.0",
      private: true,
    }),
    "packages/open/package.json": JSON.stringify({
      name: "@vdp/open",
      version: "0.1.0",
      devDependencies: { "@vdp/secret": "0.1.0" },
    }),
    "packages/open/src/index.ts": "export const open = 1;\n",
    "packages/open/src/index.spec.ts": 'import "@vdp/secret";\n',
  });
  try {
    assert.deepEqual(
      rulesOf(devOnly),
      [],
      "npm does not install devDependencies of a dependency — a build-time helper stays allowed (the reason is in the rule)",
    );
  } finally {
    rmSync(devOnly.dir, { recursive: true, force: true });
  }
});
