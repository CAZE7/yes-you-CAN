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
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
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
