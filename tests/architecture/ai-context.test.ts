/**
 * The AI context generator is a projection of `architecture/architecture.yaml`
 * (ADR 0043). This test keeps the projection honest: every topic must generate,
 * the bundle must name every package and ADR the topic claims, and every doc /
 * flow / example reference must point at a real file. A bundle that drifts from
 * the manifest is a second source of truth — the thing ADR 0031/0042 removed.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";
import { repoRoot as root } from "./workspace.js";

const TOOL = join(root, "tools/architecture/ai-context.mjs");
const OUTPUT_DIR = join(root, ".ai", "generated");

interface Topic {
  title: string;
  summary: string;
  packages: string[];
  adrs: string[];
  docs?: string[];
  flows?: string[];
  examples?: string[];
}

const manifest = JSON.parse(
  readFileSync(join(root, "architecture", "architecture.yaml"), "utf8"),
) as {
  packages: Record<string, { layer: string; mayImport: string[]; why: string }>;
  topics: Record<string, Topic>;
};

/** Run the generator; never throws, so a failure can be asserted on. */
function runTool(args: readonly string[]): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(process.execPath, [TOOL, ...args], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("the generator has a script of its own (npm run ai:context)", () => {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  assert.equal(
    manifest.scripts?.["ai:context"],
    "node tools/architecture/ai-context.mjs",
    "the generator needs a script of its own",
  );
});

test("generated bundles are not committed (a committed bundle is a second source)", () => {
  const gitignore = readFileSync(join(root, ".gitignore"), "utf8");
  assert.ok(gitignore.includes(".ai/generated/"), ".ai/generated/ must stay out of the commit");
});

test("--list names every topic of the manifest", () => {
  const run = runTool(["--list"]);
  assert.equal(run.status, 0, run.stderr);
  for (const name of Object.keys(manifest.topics)) {
    assert.ok(run.stdout.includes(name), `--list must name topic "${name}"`);
  }
});

test("an unknown topic fails with exit 2 and names the available topics", () => {
  const run = runTool(["definitely-not-a-topic"]);
  assert.equal(run.status, 2, "a typo must not look like a generated context");
  assert.ok(run.stderr.includes("Available"), "the error must point at the topics");
  for (const name of Object.keys(manifest.topics)) {
    assert.ok(run.stderr.includes(name), `the error lists the available topics (${name})`);
  }
});

for (const [name, topic] of Object.entries(manifest.topics)) {
  test(`topic "${name}" generates a complete bundle`, () => {
    const run = runTool([name]);
    assert.equal(run.status, 0, `generator failed for "${name}": ${run.stderr}`);
    const out = join(OUTPUT_DIR, `${name}-context.md`);
    assert.ok(existsSync(out), "the bundle was written");
    const text = readFileSync(out, "utf8");

    // Every package the topic claims is in the bundle, with its rule:
    for (const pkg of topic.packages) {
      assert.ok(text.includes(`\`${pkg}\``), `bundle names package ${pkg}`);
    }
    // Every ADR the topic claims is linked:
    for (const adr of topic.adrs) {
      assert.ok(text.includes(`ADR ${adr}`), `bundle names ADR ${adr}`);
    }
    // Every doc / flow / example reference points at a real file:
    for (const path of [...(topic.docs ?? []), ...(topic.flows ?? []), ...(topic.examples ?? [])]) {
      assert.ok(existsSync(join(root, path)), `topic "${name}" references missing file ${path}`);
    }
    // The bundle declares its own origin:
    assert.ok(text.includes("architecture/architecture.yaml"), "the bundle names its source");
  });
}
