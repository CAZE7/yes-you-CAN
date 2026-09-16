/**
 * Architecture tests (target architecture §28/§29: "Der Dependency Graph
 * sollte eine harte Regel bekommen", "Architekturtests schreiben").
 *
 * Unit tests prove behaviour; these tests prove *structure*. They no longer
 * carry the graph themselves — that was the duplication master backlog P0 #2
 * named: one copy in this file, one in the heads of the reviewers, and a rule
 * that only ever fired when somebody remembered to look. The rule now lives in
 * `architecture/architecture.yaml` and is enforced by
 * `tools/architecture/check-dependencies.mjs`, which runs in the CI path
 * (`npm run check:deps`, part of `npm run ci`) *before* the suite.
 *
 * What is left here is the part a tool cannot do for itself: that the tool is
 * wired in, that its graph is the real one, that the rules are the ones
 * documented, and that it actually bites. The last point is why the fixture
 * checks below exist — this suite was green for months while containing the
 * prefix `@vdp/adapters`, which matches none of the real `@vdp/adapter-*`
 * packages. A rule that cannot fail is not a rule (§34.21).
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { repoRoot as root } from "./workspace.js";

const TOOL = join(root, "tools/architecture/check-dependencies.mjs");
const RULES_FILE = join(root, "architecture/architecture.yaml");

interface RulePackage {
  layer: string;
  mayImport: readonly string[];
  why: string;
}

interface Rules {
  packages: Record<string, RulePackage>;
  rules: {
    nodeBuiltins: { allowedIn: readonly string[]; why: string };
    ui: { package: string; why: string };
    layerRules: ReadonlyArray<{ from: string; forbidden: readonly string[]; why: string }>;
    portableLayers: ReadonlyArray<{
      packages: readonly string[];
      forbidden: readonly string[];
      why: string;
    }>;
  };
}

interface GraphPackage {
  name: string;
  dir: string;
  imports: string[];
  nodeBuiltins: string[];
}

interface ToolRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

const rules = JSON.parse(readFileSync(RULES_FILE, "utf8")) as Rules;

/** Run the rule tool; never throws, so a failure can be asserted on. */
function runTool(args: readonly string[] = []): ToolRun {
  const result = spawnSync(process.execPath, [TOOL, ...args], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const run = runTool(["--json"]);
assert.equal(
  run.status,
  0,
  `the dependency rule must pass on this tree:\n${run.stdout}\n${run.stderr}`,
);
const graph = (JSON.parse(run.stdout) as { packages: GraphPackage[] }).packages;
const byName = new Map(graph.map((pkg) => [pkg.name, pkg]));

test("the rule tool runs in the CI path, not only in this test", () => {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  const scripts = manifest.scripts ?? {};
  assert.equal(
    scripts["check:deps"],
    "node tools/architecture/check-dependencies.mjs",
    "the rule needs a script of its own",
  );
  const ci = scripts.ci ?? "";
  assert.ok(
    ci.includes("check:deps"),
    "`npm run ci` must run the dependency rule before the tests",
  );
  assert.ok(ci.includes("check"), "the linter stays part of the same gate");
});

test("the rule lives in exactly one file", () => {
  // The stated edges are the tool's input; nothing else may restate them.
  const restated = readFileSync(TOOL, "utf8");
  assert.doesNotMatch(
    restated,
    /"@vdp\/shared":\s*\[/,
    "the tool must read the graph instead of carrying a second copy",
  );
  assert.ok(
    readFileSync(RULES_FILE, "utf8").includes('"@vdp/core"'),
    "the graph itself stays in architecture/architecture.yaml",
  );
  for (const [name, entry] of Object.entries(rules.packages)) {
    assert.ok(entry.why.trim().length > 0, `${name} must say why it sits where it sits`);
  }
});

test("every workspace package has a declared place in the dependency graph", () => {
  const unplaced = graph.filter((pkg) => !(pkg.name in rules.packages)).map((pkg) => pkg.name);
  assert.deepEqual(
    unplaced,
    [],
    "new packages must be placed consciously (architecture/architecture.yaml)",
  );
  const stale = Object.keys(rules.packages).filter((name) => !byName.has(name));
  assert.deepEqual(stale, [], `rules for packages that no longer exist: ${stale.join(", ")}`);
  assert.ok(graph.length >= 25, `all workspace packages are scanned (found ${graph.length})`);
});

test("all imports follow the allowed dependency graph (target architecture §28)", () => {
  const violations: string[] = [];
  for (const pkg of graph) {
    const allowed = new Set(rules.packages[pkg.name]?.mayImport ?? []);
    for (const dep of pkg.imports) {
      if (dep === pkg.name) continue;
      if (!allowed.has(dep)) violations.push(`${pkg.name} → ${dep}  (${pkg.dir})`);
    }
  }
  assert.deepEqual(violations, [], "forbidden dependency edges found:\n" + violations.join("\n"));
});

test("no package imports the UI", () => {
  const ui = rules.rules.ui.package;
  const offenders = graph.filter((pkg) => pkg.name !== ui && pkg.imports.includes(ui));
  assert.deepEqual(
    offenders.map((pkg) => pkg.name),
    [],
    "packages must never import the web app",
  );
});

test("portable layers stay free of Node builtins (§28: domain ❌ fs, protocols ❌ I/O)", () => {
  const allowed = new Set(rules.rules.nodeBuiltins.allowedIn);
  const violations: string[] = [];
  for (const pkg of graph) {
    if (allowed.has(pkg.name)) continue;
    for (const builtin of pkg.nodeBuiltins) violations.push(`${pkg.name} imports node:${builtin}`);
  }
  assert.deepEqual(violations, [], "Node builtins in portable layers:\n" + violations.join("\n"));
});

test("domain and application are protocol- and transport-free (§1, §3)", () => {
  const rule = rules.rules.portableLayers.find((candidate) =>
    candidate.packages.includes("@vdp/domain"),
  );
  assert.ok(rule, "the portability rule for domain/application must be declared");
  const violations: string[] = [];
  for (const name of rule.packages) {
    const pkg = byName.get(name);
    assert.ok(pkg, `${name} must exist`);
    for (const dep of pkg.imports) {
      if (rule.forbidden.some((prefix) => dep === prefix || dep.startsWith(`${prefix}-`))) {
        violations.push(`${name} → ${dep}`);
      }
    }
  }
  assert.deepEqual(
    violations,
    [],
    "domain/application must stay protocol-free:\n" + violations.join("\n"),
  );
});

test("protocols never import adapters, transports never import protocols (§28)", () => {
  // The rule that used to be dead: its prefix was `@vdp/adapters`, while the
  // packages are called `@vdp/adapter-*`. Asserted here against the *real*
  // package list so a prefix that matches nothing fails instead of passing.
  const violations: string[] = [];
  for (const rule of rules.rules.layerRules) {
    const subjects = graph.filter(
      (pkg) => pkg.name === rule.from || pkg.name.startsWith(`${rule.from}-`),
    );
    assert.ok(
      subjects.length > 0,
      `layer rule "${rule.from}" matches no package — it could never fire`,
    );
    for (const pkg of subjects) {
      for (const dep of pkg.imports) {
        if (rule.forbidden.some((prefix) => dep === prefix || dep.startsWith(`${prefix}-`))) {
          violations.push(`${pkg.name} → ${dep} (${rule.why})`);
        }
      }
    }
  }
  assert.deepEqual(violations, [], "layer violations:\n" + violations.join("\n"));
  const adapters = graph.filter((pkg) => pkg.name.startsWith("@vdp/adapter"));
  assert.ok(adapters.length >= 5, `the adapter packages are found (${adapters.length})`);
});

test("the production graph matches the documented structure snapshot", () => {
  // This snapshot is the *current* truthful graph. When an edge changes, the
  // diff forces a review: intentional architecture move or accident?
  const snapshot = graph
    .map((pkg) => `${pkg.name}: ${[...pkg.imports].sort().join(" ") || "(none)"}`)
    .join("\n");
  assert.match(snapshot, /@vdp\/domain: @vdp\/shared/);
  assert.match(snapshot, /@vdp\/application: @vdp\/domain/);
  // `@vdp/diagnostic-ir` joined the runtime's imports with the evidence service
  // (ADR 0038): the composition root serves the IR shapes to the workbench and to a
  // report, and a projection invented on the way out would be a second vocabulary.
  assert.match(
    snapshot,
    /@vdp\/runtime: @vdp\/application @vdp\/core @vdp\/definitions @vdp\/diagnostic-ir @vdp\/domain @vdp\/protocols-uds @vdp\/shared @vdp\/transport-can @vdp\/transport-doip/,
  );
  assert.match(snapshot, /@vdp\/protocols-uds: @vdp\/shared/);
  // DoIP stays low-level: it must not pull in the protocol layer itself.
  assert.doesNotMatch(snapshot, /@vdp\/transport-doip:.*protocols/);
});

test("a forbidden edge makes the tool fail, an allowed one keeps it quiet (§34.21)", () => {
  const workspace = mkdtempSync(join(tmpdir(), "vdp-deps-"));
  try {
    const rulesFile = join(workspace, "rules.json");
    const write = (name: string): void => {
      const dir = join(workspace, "packages", name);
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: `@vdp/${name}` }));
      writeFileSync(join(dir, "src/index.ts"), 'import "@vdp/alpha";\n');
    };
    write("alpha");
    write("beta");
    writeFileSync(
      rulesFile,
      JSON.stringify({
        schemaVersion: 1,
        packages: {
          "@vdp/alpha": { mayImport: [], why: "fixture leaf" },
          "@vdp/beta": { mayImport: [], why: "fixture consumer without the edge" },
        },
        rules: { nodeBuiltins: { allowedIn: [], why: "fixture" } },
      }),
    );

    const forbidden = runTool(["--root", workspace, "--rules", rulesFile, "--json"]);
    assert.equal(forbidden.status, 1, "a forbidden edge must fail the tool");
    const reported = JSON.parse(forbidden.stdout) as { violations: Array<{ message: string }> };
    assert.ok(
      reported.violations.some((violation) => violation.message.includes("@vdp/beta → @vdp/alpha")),
      `the violation names both ends:\n${forbidden.stdout}`,
    );

    // Same tree, edge allowed: the tool is quiet and says so.
    writeFileSync(
      rulesFile,
      JSON.stringify({
        schemaVersion: 1,
        packages: {
          "@vdp/alpha": { mayImport: [], why: "fixture leaf" },
          "@vdp/beta": { mayImport: ["@vdp/alpha"], why: "fixture consumer" },
        },
        rules: { nodeBuiltins: { allowedIn: [], why: "fixture" } },
      }),
    );
    const allowed = runTool(["--root", workspace, "--rules", rulesFile]);
    assert.equal(allowed.status, 0, `an allowed edge must pass:\n${allowed.stdout}`);

    // A rule that matches no package is itself a violation, not a silent pass.
    writeFileSync(
      rulesFile,
      JSON.stringify({
        schemaVersion: 1,
        packages: {
          "@vdp/alpha": { mayImport: [], why: "fixture leaf" },
          "@vdp/beta": { mayImport: [], why: "fixture consumer" },
        },
        rules: {
          nodeBuiltins: { allowedIn: [], why: "fixture" },
          layerRules: [{ from: "@vdp/adapters", forbidden: ["@vdp/nothing"], why: "typo" }],
        },
      }),
    );
    const blind = runTool(["--root", workspace, "--rules", rulesFile, "--json"]);
    assert.equal(blind.status, 1, "a prefix that matches no package must fail");
    const blindViolations = JSON.parse(blind.stdout) as { violations: Array<{ rule: string }> };
    assert.ok(
      blindViolations.violations.some((violation) => violation.rule === "blind-prefix"),
      `the tool reports the blind rule:\n${blind.stdout}`,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a malformed rules file is an error, never a silent pass", () => {
  const workspace = mkdtempSync(join(tmpdir(), "vdp-deps-broken-"));
  try {
    const rulesFile = join(workspace, "rules.json");
    writeFileSync(rulesFile, "{ not json");
    const run = runTool(["--root", workspace, "--rules", rulesFile]);
    assert.equal(run.status, 2, "a rules file nothing can read is a usage error");
    assert.match(run.stderr, /not valid JSON/);

    writeFileSync(rulesFile, JSON.stringify({ packages: { "@vdp/x": { mayImport: [] } } }));
    const typo = runTool(["--root", workspace, "--rules", rulesFile]);
    assert.equal(typo.status, 2, "a missing reason must not pass as a rule");
    assert.match(typo.stderr, /has no "why"/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
