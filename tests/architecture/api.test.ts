/**
 * The contract record is a promise, and this file is what keeps it (ADR 0059).
 *
 * `dependencies.test.ts` proves the shape of the import graph and `manifests.test.ts`
 * proves the manifests. Neither can see the one thing an open-core boundary is made of:
 * the *surface* somebody outside this repository compiles against. That surface is
 * `architecture/public-api.json`, written by `tools/architecture/check-api.mjs` from the
 * emitted declarations, and — like every other rule in this repository — a rule that
 * cannot fail is not a rule (AGENTS 34.21). So the fixture checks below make it fail:
 * on a changed declaration, on a bumped version with a stale record, on a record entry
 * that no longer belongs to a contract, and on the file that is simply not built.
 *
 * Two properties are deliberately *not* failures, and both are asserted here, because
 * they are decisions: a doc comment is not the surface (hashing prose would cry wolf on
 * every wording fix) and prose is not an import (the first run of the tool invented a
 * dependency on a package named after a sentence in a comment).
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "vitest";
import { discoverWorkspaceDirs, repoRoot as root } from "./workspace.js";

const TOOL = join(root, "tools/architecture/check-api.mjs");
const RULES = join(root, "architecture/architecture.yaml");
const RECORD = join(root, "architecture/public-api.json");

interface ToolRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

interface ContractEntry {
  why?: string;
  entry?: string;
}

interface Rules {
  contracts?: Record<string, ContractEntry>;
  packages?: Record<string, { version?: string }>;
}

interface RecordedPackage {
  version: string;
  entry: string;
  files: Record<string, string>;
  external: string[];
}

interface ApiRecord {
  format: string;
  version: number;
  packages: Record<string, RecordedPackage>;
}

const rules = JSON.parse(readFileSync(RULES, "utf8")) as Rules;
const contracts = rules.contracts ?? {};

function runTool(args: readonly string[]): ToolRun {
  const result = spawnSync(process.execPath, [TOOL, ...args], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("the gate runs in the CI path, and after the build it measures", () => {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  const scripts = manifest.scripts ?? {};
  assert.equal(
    scripts["check:api"],
    "node tools/architecture/check-api.mjs",
    "the contract record needs a script of its own",
  );
  const ci = scripts.ci ?? "";
  assert.ok(ci.includes("check:api"), "`npm run ci` must measure the contracts");
  assert.ok(
    ci.indexOf("npm run build") < ci.indexOf("check:api"),
    "the record is compared with the *built* surface, so the build has to come first (AGENTS 34.26)",
  );
  assert.ok(ci.includes("check:licenses"), "the same gate chain carries the licence policy");
});

test("every declared contract is recorded, and the record is the built surface", () => {
  assert.ok(
    Object.keys(contracts).length >= 5,
    `a handful of surfaces carry the open/closed boundary (found ${Object.keys(contracts).length})`,
  );
  for (const [name, entry] of Object.entries(contracts)) {
    assert.ok(entry.why?.trim(), `${name} must say why its surface is frozen`);
    assert.ok(name in (rules.packages ?? {}), `${name} must be a placed package first`);
  }
  assert.ok(existsSync(RECORD), "the record is committed — a missing one is a defect, not a state");
  const record = JSON.parse(readFileSync(RECORD, "utf8")) as ApiRecord;
  assert.equal(record.format, "vdp.public-api", "the record names its own format");
  assert.deepEqual(
    Object.keys(record.packages).sort(),
    Object.keys(contracts).sort(),
    "the record and the manifest must name exactly the same surfaces — one source, no drift",
  );

  const dirs = new Map(
    discoverWorkspaceDirs().map((dir) => [
      (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string }).name,
      dir,
    ]),
  );
  for (const [name, recorded] of Object.entries(record.packages)) {
    const dir = dirs.get(name);
    assert.ok(dir, `${name} must be a workspace package`);
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      version?: string;
    };
    assert.equal(
      recorded.version,
      manifest.version,
      `${name}: the record cites a version, and a record that cites the wrong one is worse than none`,
    );
    assert.ok(
      Object.keys(recorded.files).length > 0,
      `${name}: an empty surface is a gate that cannot fire`,
    );
  }

  const run = runTool(["--json"]);
  if (run.status === 2 && /npm run build/.test(run.stderr)) {
    // A fresh clone before `npm run build`: the honest answer is the tool's exit code 2
    // and its reason, not a green test. CI runs `npm run build` before this suite, so
    // this branch is the local one — AGENTS 34.26: a run without `dist` is not a
    // passing run.
    process.stdout.write("api gate: NOT RUN (no build in this tree) — run `npm run build`\n");
    return;
  }
  assert.equal(run.status, 0, `the record must be the build:\n${run.stdout}\n${run.stderr}`);
  const measured = JSON.parse(run.stdout) as {
    contracts: Array<{ name: string; files: number; external: string[] }>;
  };
  assert.equal(measured.contracts.length, Object.keys(contracts).length);
  assert.ok(
    measured.contracts.some((contract) => contract.external.length > 0),
    "at least one contract leans on another package — the walk follows references",
  );
});

/* ------------------------------------------------------------------ fixtures */

interface Tree {
  root: string;
  write(rel: string, content: string): void;
  readJson<T>(rel: string): T;
  remove(rel: string): void;
}

function tree(): Tree {
  const base = mkdtempSync(join(tmpdir(), "vdp-api-"));
  const at = (rel: string): string => join(base, rel);
  return {
    root: base,
    write(rel, content) {
      mkdirSync(dirname(at(rel)), { recursive: true });
      writeFileSync(at(rel), content);
    },
    readJson<T>(rel: string): T {
      return JSON.parse(readFileSync(at(rel), "utf8")) as T;
    },
    remove(rel) {
      rmSync(at(rel), { force: true });
    },
  };
}

/**
 * One publishable package with two declaration files, and a manifest that calls it a
 * contract. The record is *not* written here: the tool writes it, which is also how the
 * round trip gets tested.
 */
function fixture(
  base: Tree,
  options: { entry?: string; contracts?: Record<string, ContractEntry> } = {},
): void {
  base.write(
    "architecture/architecture.yaml",
    JSON.stringify({
      schemaVersion: 2,
      layers: { contract: "fixture layer" },
      packages: { "@vdp/alpha": { layer: "contract", mayImport: [], why: "fixture leaf" } },
      rules: { nodeBuiltins: { allowedIn: [], why: "fixture" } },
      contracts: options.contracts ?? { "@vdp/alpha": { why: "fixture contract" } },
    }),
  );
  base.write(
    "packages/alpha/package.json",
    JSON.stringify({
      name: "@vdp/alpha",
      version: "1.0.0",
      types: "./dist/src/index.d.ts",
      ...(options.entry === undefined ? {} : { entry: options.entry }),
    }),
  );
  base.write(
    "packages/alpha/dist/src/index.d.ts",
    'export type { AlphaConfig } from "./config.js";\nexport declare const alphaVersion: string;\n',
  );
  base.write(
    "packages/alpha/dist/src/config.d.ts",
    "export interface AlphaConfig {\n  readonly retries: number;\n}\n",
  );
}

/** Run a fixture body with a temporary tree, and always take the tree down again. */
function withTree(body: (base: Tree) => void): void {
  const base = tree();
  try {
    body(base);
  } finally {
    rmSync(base.root, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ the bite */

test("--update writes the record, says what changed, and then the tool is quiet", () => {
  withTree((base) => {
    fixture(base);
    const first = runTool(["--root", base.root, "--update"]);
    assert.equal(first.status, 0, `the first record must be written:\n${first.stderr}`);
    assert.match(
      first.stdout,
      /changed: @vdp\/alpha/,
      "an update must name what it rewrote — a silent `--update` is how a contract changes unnoticed",
    );
    const second = runTool(["--root", base.root, "--update"]);
    assert.match(second.stdout, /unchanged/, "a second update on the same tree changes nothing");
    const check = runTool(["--root", base.root]);
    assert.equal(check.status, 0, `and then it stays quiet:\n${check.stdout}${check.stderr}`);
    assert.match(check.stdout, /1 contracts, 2 surface files/);
  });
});

test("a changed declaration is drift, and the report names the file", () => {
  withTree((base) => {
    fixture(base);
    assert.equal(runTool(["--root", base.root, "--update"]).status, 0);
    base.write(
      "packages/alpha/dist/src/config.d.ts",
      "export interface AlphaConfig {\n  readonly retries: number;\n  readonly timeoutMs?: number;\n}\n",
    );
    const drift = runTool(["--root", base.root, "--json"]);
    assert.equal(drift.status, 1, "a changed surface must fail the gate");
    const reported = JSON.parse(drift.stdout) as {
      violations: Array<{ rule: string; package: string; message: string }>;
    };
    const violation = reported.violations.find((entry) => entry.rule === "contract-drift");
    assert.ok(violation, `the drift is reported as contract-drift:\n${drift.stdout}`);
    assert.equal(violation.package, "@vdp/alpha");
    assert.match(violation.message, /~ dist\/src\/config\.d\.ts/, "the message names the file");
  });
});

test("a doc comment is not the surface — a wording fix must not cry wolf", () => {
  withTree((base) => {
    fixture(base);
    assert.equal(runTool(["--root", base.root, "--update"]).status, 0);
    base.write(
      "packages/alpha/dist/src/config.d.ts",
      "/** How many times the adapter retries. */\nexport interface AlphaConfig {\n  readonly retries: number;\n}\n",
    );
    const after = runTool(["--root", base.root]);
    assert.equal(
      after.status,
      0,
      `comments and whitespace are stripped before hashing:\n${after.stdout}${after.stderr}`,
    );
  });
});

test("the walk follows what the surface references, so a new file is drift too", () => {
  withTree((base) => {
    fixture(base);
    assert.equal(runTool(["--root", base.root, "--update"]).status, 0);
    base.write("packages/alpha/dist/src/deep.d.ts", "export type Deep = { readonly level: 2 };\n");
    base.write(
      "packages/alpha/dist/src/index.d.ts",
      'export type { AlphaConfig } from "./config.js";\nexport type { Deep } from "./deep.js";\nexport declare const alphaVersion: string;\n',
    );
    const drift = runTool(["--root", base.root, "--json"]);
    assert.equal(drift.status, 1);
    const reported = JSON.parse(drift.stdout) as {
      violations: Array<{ rule: string; message: string }>;
    };
    const violation = reported.violations.find((entry) => entry.rule === "contract-drift");
    assert.ok(violation);
    assert.match(violation.message, /\+ dist\/src\/deep\.d\.ts/, "the new file is named as added");
  });
});

test("prose is not an import (regression: the first run invented a package)", () => {
  withTree((base) => {
    fixture(base);
    base.write(
      "packages/alpha/dist/src/config.d.ts",
      '/**\n * Where the value came from: `from "we never reached it"` in the recording.\n */\nexport interface AlphaConfig {\n  readonly retries: number;\n}\n',
    );
    assert.equal(runTool(["--root", base.root, "--update"]).status, 0);
    const record = base.readJson<ApiRecord>("architecture/public-api.json");
    assert.deepEqual(
      record.packages["@vdp/alpha"]?.external,
      [],
      "a sentence in a doc comment must not become an external type source",
    );
  });
});

test("a bumped version with a stale record is a violation, not a footnote", () => {
  withTree((base) => {
    fixture(base);
    assert.equal(runTool(["--root", base.root, "--update"]).status, 0);
    base.write(
      "packages/alpha/package.json",
      JSON.stringify({ name: "@vdp/alpha", version: "1.1.0", types: "./dist/src/index.d.ts" }),
    );
    const drift = runTool(["--root", base.root, "--json"]);
    assert.equal(drift.status, 1);
    const reported = JSON.parse(drift.stdout) as {
      violations: Array<{ rule: string; message: string }>;
    };
    const violation = reported.violations.find((entry) => entry.rule === "version-drift");
    assert.ok(violation, `the version must agree with the record:\n${drift.stdout}`);
    assert.match(violation.message, /record says version 1\.0\.0, the package is 1\.1\.0/);
  });
});

test("a record entry for a surface that is no longer a contract is dropped, not kept", () => {
  withTree((base) => {
    fixture(base);
    assert.equal(runTool(["--root", base.root, "--update"]).status, 0);
    const record = base.readJson<ApiRecord>("architecture/public-api.json");
    record.packages["@vdp/beta"] = {
      version: "1.0.0",
      entry: "dist/src/index.d.ts",
      files: {},
      external: [],
    };
    base.write("architecture/public-api.json", JSON.stringify(record, null, 2));
    const drift = runTool(["--root", base.root, "--json"]);
    assert.equal(drift.status, 1);
    const reported = JSON.parse(drift.stdout) as { violations: Array<{ rule: string }> };
    assert.ok(
      reported.violations.some((entry) => entry.rule === "stale-api-entry"),
      `an entry nothing declares is a decision that outlived its finding:\n${drift.stdout}`,
    );
  });
});

test("a contract that is not built is 'not measured', never 'clean'", () => {
  withTree((base) => {
    fixture(base);
    assert.equal(runTool(["--root", base.root, "--update"]).status, 0);
    base.remove("packages/alpha/dist/src/index.d.ts");
    const unmeasured = runTool(["--root", base.root]);
    assert.equal(unmeasured.status, 2, "a missing build is a usage error, not a pass");
    assert.match(unmeasured.stderr, /npm run build/);
    assert.match(unmeasured.stderr, /not built is not measured/);
  });
});

test("an empty contract list is a gate that cannot fire, and says so", () => {
  withTree((base) => {
    fixture(base, { contracts: {} });
    const empty = runTool(["--root", base.root, "--update"]);
    assert.equal(empty.status, 2);
    assert.match(empty.stderr, /no contracts declared/);
  });
});

test("a contract entry that is not a package is not blessed by --update", () => {
  withTree((base) => {
    fixture(base, {
      contracts: {
        "@vdp/alpha": { why: "fixture contract" },
        "@vdp/nowhere": { why: "a typo in the manifest" },
      },
    });
    const attempted = runTool(["--root", base.root, "--update"]);
    assert.equal(
      attempted.status,
      1,
      "--update rewrites the record; it must not write a record over a broken configuration",
    );
    assert.match(attempted.stdout, /undeclared-contract-package/);
    assert.ok(
      !existsSync(join(base.root, "architecture/public-api.json")),
      "and it must not have written anything on the way",
    );
  });
});
