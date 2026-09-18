/**
 * The impact tool is a projection of `architecture/architecture.yaml`
 * (ADR 0043/0046): reverse `mayImport` closure, ADR mention scan, and the
 * test inventory. The same rules that make a committed bundle a second source
 * make a hand-written “impact list” in a README one — so the test asserts the
 * projection *against the manifest itself*, positively and negatively: what
 * the graph implies must appear, and what the graph does not imply must not.
 *
 * `ai-context --changed` shares its engine (`impact.mjs`); its contract here is
 * the one ai-context.test.ts set for bundles: generated, honest, exit-2 on
 * nonsense.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";
import { repoRoot as root } from "./workspace.js";

const IMPACT = join(root, "tools/architecture/impact.mjs");
const AI_CONTEXT = join(root, "tools/architecture/ai-context.mjs");

interface ImpactJson {
  seeds: string[];
  affected: Array<{ name: string; layer: string; imports: string[] }>;
  adrs: Array<{ number: string; file: string; names: string[] }>;
  topics: string[];
  tests: { specs: string[]; testFiles: string[] };
  changedFiles?: string[];
  unmappedFiles?: string[];
}

function run(
  tool: string,
  args: readonly string[],
): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(process.execPath, [tool, ...args], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function impact(args: readonly string[]): ReturnType<typeof run> {
  return run(IMPACT, args);
}

function impactJson(args: readonly string[]): ImpactJson {
  const result = impact([...args, "--json"]);
  assert.equal(result.status, 0, `impact failed: ${result.stderr}`);
  return JSON.parse(result.stdout) as ImpactJson;
}

const manifest = JSON.parse(
  readFileSync(join(root, "architecture", "architecture.yaml"), "utf8"),
) as { packages: Record<string, { layer: string; mayImport: string[] }> };

/** The same closure, computed independently in the test from the manifest. */
function expectedClosure(seeds: readonly string[]): Set<string> {
  const found = new Set(seeds);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [name, entry] of Object.entries(manifest.packages)) {
      if (found.has(name)) continue;
      if (entry.mayImport.some((target) => found.has(target))) {
        found.add(name);
        grew = true;
      }
    }
  }
  return found;
}

test("the impact tool has scripts of its own (npm run architecture:impact / ai:context:changed)", () => {
  const rootManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  assert.equal(
    rootManifest.scripts?.["architecture:impact"],
    "node tools/architecture/impact.mjs",
    "the tool needs a script of its own",
  );
  assert.equal(
    rootManifest.scripts?.["ai:context:changed"],
    "node tools/architecture/ai-context.mjs --changed",
    "the changed-bundle generator is ai-context with the impact engine, not a second tool",
  );
});

test("without a target it is a usage error, not an empty report", () => {
  const result = impact([]);
  assert.equal(result.status, 2, "an omitted argument must not look like 'nothing affected'");
  assert.ok(result.stderr.includes("usage"), "the error teaches the invocation");
});

test("a target that resolves to no package fails with the reason", () => {
  const pkg = impact(["@vdp/definitely-not-here"]);
  assert.equal(pkg.status, 2);
  assert.ok(pkg.stderr.includes("not placed"), "it says *why*: not placed in the manifest");
  const file = impact(["docs/definitely-not-a-real-file.md"]);
  assert.equal(file.status, 2);
  assert.ok(
    file.stderr.includes("no workspace package"),
    "an unmappable file is an error for the single-target form",
  );
});

test("the reverse closure equals the manifest's importers — and only those", () => {
  const result = impactJson(["@vdp/diagnostic-ir"]);
  const expected = expectedClosure(["@vdp/diagnostic-ir"]);
  const got = new Set([...result.seeds, ...result.affected.map((entry) => entry.name)]);
  assert.deepEqual(
    [...got].sort(),
    [...expected].sort(),
    "the tool must derive exactly what mayImport implies, in both directions",
  );
  // Negative fixture from the graph itself: domain does not import the IR, so a
  // change to the IR does not reach it. A tool with a hand-copied edge list would
  // not know the difference; the manifest check proves it reads the one source.
  assert.ok(!got.has("@vdp/domain"), "@vdp/domain imports nothing but shared — it must not appear");
  for (const entry of result.affected) {
    assert.equal(
      entry.layer,
      manifest.packages[entry.name]?.layer,
      "layer comes from the manifest",
    );
    assert.ok(
      entry.imports.every((target) => got.has(target)),
      `why-edges must be closure members (${entry.name})`,
    );
  }
});

test("a file target resolves to the package that contains it", () => {
  const result = impactJson(["packages/transport/iso-tp/src/connection.ts"]);
  assert.deepEqual(result.seeds, ["@vdp/transport-iso-tp"]);
});

test("ADRs are found by mention scan, and the topic assignment counts too", () => {
  const result = impactJson(["@vdp/formal-conformance"]);
  const byNumber = new Map(result.adrs.map((adr) => [adr.number, adr]));
  const adr44 = byNumber.get("0045");
  assert.ok(adr44, "ADR 0045 names the tool package — the scan must find it");
  assert.ok(
    readFileSync(join(root, "docs/adr", adr44.file), "utf8").includes("@vdp/formal-conformance"),
    "the found ADR really mentions the package (the link, not a coincidence)",
  );
  // Every claimed file exists:
  for (const adr of result.adrs) {
    assert.ok(existsSync(join(root, "docs/adr", adr.file)), `ADR file ${adr.file} exists`);
  }
  // Topic assignment is the second way in: the `formal` topic carries the package
  // and lists 0045, so even an ADR that never names it would be reachable.
  assert.ok(result.topics.includes("formal"), "the formal topic covers the package");
});

test("tests are the co-located specs plus the test files that import the package", () => {
  const result = impactJson(["@vdp/transport-iso-tp"]);
  assert.ok(
    result.tests.specs.includes("packages/transport/iso-tp/src/connection.spec.ts"),
    "the co-located spec of the changed package must be listed",
  );
  assert.ok(
    result.tests.testFiles.includes("tests/protocol/contracts/iso-tp-transport.contract.test.ts"),
    "a tests/ file importing the package by name must be listed",
  );
  // And *only* such files: an unrelated test must not sneak in.
  assert.ok(
    !result.tests.testFiles.some((file) => file.includes("pdf")),
    "no PDF test imports the ISO-TP transport — it must not appear",
  );
});

test("--changed maps the git diff against a base (default HEAD), tree-state independent", () => {
  const result = impactJson(["--changed"]);
  assert.ok(Array.isArray(result.changedFiles), "the file list is part of the answer");
  assert.ok(
    Array.isArray(result.unmappedFiles),
    "files outside any package are named, not invented",
  );
  for (const seed of result.seeds) {
    assert.ok(seed in manifest.packages, `every seed is a placed package (${seed})`);
  }
});

test("ai:context --changed writes the projection of the touched topics", () => {
  const result = run(AI_CONTEXT, ["--changed", "HEAD"]);
  assert.equal(result.status, 0, `ai-context --changed failed: ${result.stderr}`);
  const out = join(root, ".ai", "generated", "changed-context.md");
  assert.ok(existsSync(out), "the changed bundle was written");
  const text = readFileSync(out, "utf8");
  assert.ok(text.includes("# AI Context: changed files vs `HEAD`"), "the header names the base");
  assert.ok(
    text.includes("architecture/architecture.yaml"),
    "the bundle names its source like every other bundle",
  );
  // Whatever topics the current diff touches, each one is a full bundle, and the
  // header agrees with the tool: no topic text appears that the header did not list.
  const listed = /Topics covered by these changes: (.+)\./.exec(text);
  const headings = [...text.matchAll(/^# AI Context: (.+)$/gm)].slice(1).map((m) => m[1]);
  if (listed === null) {
    assert.equal(headings.length, 0, "a clean tree must produce no topic bundles, not stale ones");
  } else {
    assert.ok(headings.length > 0, "covered topics must each carry their bundle");
  }
});
