/**
 * The licence policy is a rule with a gate, and this file is the gate's own proof
 * (ADR 0060).
 *
 * `manifests.test.ts` already keeps every workspace package on the root licence; that
 * says nothing about what the *other* 108 packages in `package-lock.json` carry, and
 * "we checked the licences" was a sentence in AGENTS 34.20 with nothing behind it. The
 * fixtures below are what make the new gate believable: a GPL build tool, an unknown id,
 * a weak-copyleft package that is fine as a tool and not fine in the production closure,
 * and an exception that expired or stopped being needed.
 *
 * The policy is read from `architecture/architecture.yaml` and handed to the fixture
 * tree — the tests bind the *real* policy, not a copy of it, because a second copy of a
 * rule is the defect this repository keeps naming (ADR 0031).
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "vitest";
import { repoRoot as root } from "./workspace.js";

const TOOL = join(root, "tools/architecture/check-licenses.mjs");
const RULES = join(root, "architecture/architecture.yaml");

interface LicenceScope {
  allowed: string[];
  forbidden: string[];
  why: string;
}

interface LicencePolicy {
  production: LicenceScope;
  development: LicenceScope;
  exceptions: Array<{ package: string; why: string; until: string }>;
}

interface ToolRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

const policy = (JSON.parse(readFileSync(RULES, "utf8")) as { licenses: LicencePolicy }).licenses;

function runTool(args: readonly string[]): ToolRun {
  const result = spawnSync(process.execPath, [TOOL, ...args], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const run = runTool(["--json"]);

test("the gate runs in the CI path", () => {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  assert.equal(
    manifest.scripts?.["check:licenses"],
    "node tools/architecture/check-licenses.mjs",
    "the licence policy needs a script of its own",
  );
  assert.ok(
    (manifest.scripts?.ci ?? "").includes("check:licenses"),
    "`npm run ci` must measure the licences, not narrate them",
  );
});

test("the tree is measured: 0 production packages, and not a vacuous scan", () => {
  assert.equal(
    run.status,
    0,
    `the current tree must pass its own policy:\n${run.stdout}${run.stderr}`,
  );
  const measured = JSON.parse(run.stdout) as {
    scanned: Array<{ package: string; scope: string; verdict: string }>;
    scopeCounts: { production: number; development: number };
  };
  assert.ok(
    measured.scanned.length >= 50,
    `every third-party package is scanned (found ${measured.scanned.length})`,
  );
  // The claim ADR 0002 has been making all along, now measured instead of asserted:
  // nothing third-party is in a closure that could be distributed.
  assert.equal(
    measured.scopeCounts.production,
    0,
    "ADR 0002 keeps the production closure empty — this line is where that stops being a slogan",
  );
  assert.ok(measured.scopeCounts.development > 0, "and the development closure is real");
  for (const entry of measured.scanned) {
    assert.equal(entry.verdict, "allowed", `${entry.package} must be inside the policy`);
  }
});

test("both scopes carry a reason, and the production scope refuses weak copyleft", () => {
  for (const scope of ["production", "development"] as const) {
    assert.ok(policy[scope].why.trim().length > 20, `licenses.${scope} must explain itself`);
    assert.ok(policy[scope].allowed.length > 0, `licenses.${scope} must allow something`);
  }
  for (const weak of ["MPL", "LGPL"]) {
    assert.ok(
      policy.production.forbidden.includes(weak),
      `${weak} must stay out of anything we distribute (it is a decision, not an oversight)`,
    );
  }
  // And the finding that made the development scope say it out loud.
  assert.ok(
    policy.development.allowed.includes("MPL-2.0"),
    "MPL-2.0 arrives with the Vite toolchain; the policy records that instead of hiding it",
  );
  assert.ok(policy.development.forbidden.includes("GPL"));
});

/* ------------------------------------------------------------------ fixtures */

interface Tree {
  root: string;
  write(rel: string, content: string): void;
}

function tree(): Tree {
  const base = mkdtempSync(join(tmpdir(), "vdp-lic-"));
  return {
    root: base,
    write(rel, content) {
      const file = join(base, rel);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
    },
  };
}

/**
 * A lockfile with the given third-party entries, plus the *real* policy — unless a test
 * wants to break the policy itself.
 */
function withFixture(
  entries: Record<
    string,
    { license?: unknown; dev?: boolean; devOptional?: boolean; link?: boolean }
  >,
  body: (base: Tree) => void,
  licenses: unknown = policy,
): void {
  const base = tree();
  try {
    const packages: Record<string, unknown> = {
      "": { name: "fixture", version: "0.0.0", license: "MIT" },
      // The root manifest and the workspace directories are *our* code; the rule for
      // them lives in manifests.test.ts, and this tool must not invent a second one.
      "packages/alpha": { name: "@vdp/alpha", version: "0.0.0", license: "GPL-3.0-only" },
      "node_modules/@vdp/alpha": { link: true, resolved: "packages/alpha" },
    };
    for (const [name, entry] of Object.entries(entries)) {
      packages[`node_modules/${name}`] = { version: "1.0.0", ...entry };
    }
    base.write(
      "package-lock.json",
      JSON.stringify({ name: "fixture", version: "0.0.0", lockfileVersion: 3, packages }),
    );
    base.write("architecture/architecture.yaml", JSON.stringify({ licenses }));
    body(base);
  } finally {
    rmSync(base.root, { recursive: true, force: true });
  }
}

function rulesOf(run: ToolRun): string[] {
  return (JSON.parse(run.stdout) as { violations: Array<{ rule: string }> }).violations.map(
    (violation) => violation.rule,
  );
}

/* ------------------------------------------------------------------ the bite */

test("a forbidden licence in a build tool fails the gate", () => {
  withFixture({ copyleft: { license: "GPL-3.0-only", dev: true } }, (base) => {
    const result = runTool(["--root", base.root, "--json"]);
    assert.equal(result.status, 1, "a GPL dependency is a decision nobody has taken");
    assert.ok(rulesOf(result).includes("forbidden-license"), result.stdout);
    assert.match(result.stdout, /decided by GPL-3\.0-only/);
  });
});

test("AND binds both obligations, OR lets the consumer choose", () => {
  withFixture({ both: { license: "MIT AND GPL-3.0-only", dev: true } }, (base) => {
    const result = runTool(["--root", base.root, "--json"]);
    assert.equal(result.status, 1, "`AND` means both apply — one of them is GPL");
    assert.ok(rulesOf(result).includes("forbidden-license"));
  });
  withFixture({ either: { license: "(MIT OR GPL-3.0-only)", dev: true } }, (base) => {
    const result = runTool(["--root", base.root, "--json"]);
    assert.equal(result.status, 0, `\`OR\` means the consumer may pick MIT:\n${result.stdout}`);
  });
});

test("an exception clause does not soften a copyleft licence", () => {
  withFixture(
    { some: { license: "GPL-2.0-only WITH Classpath-exception-2.0", dev: true } },
    (base) => {
      const result = runTool(["--root", base.root, "--json"]);
      assert.equal(result.status, 1, "the base licence still binds us");
      assert.ok(rulesOf(result).includes("forbidden-license"));
    },
  );
});

test("a licence nobody has decided about is a violation, never a pass", () => {
  withFixture({ mystery: { license: "Foobar-1.0", dev: true } }, (base) => {
    const result = runTool(["--root", base.root, "--json"]);
    assert.equal(result.status, 1);
    assert.ok(rulesOf(result).includes("unknown-license"), result.stdout);
  });
  withFixture({ silent: { dev: true } }, (base) => {
    const result = runTool(["--root", base.root, "--json"]);
    assert.equal(
      result.status,
      1,
      "a package without a licence is the worst case, not the quiet one",
    );
    assert.ok(rulesOf(result).includes("unknown-license"));
  });
});

test("the scope decides: the same licence is a finding in production and a decision in development", () => {
  withFixture({ lightningcss: { license: "MPL-2.0", dev: true } }, (base) => {
    const result = runTool(["--root", base.root, "--json"]);
    assert.equal(
      result.status,
      0,
      `file-level copyleft is a recorded decision at build time:\n${result.stdout}`,
    );
  });
  withFixture({ shipped: { license: "MPL-2.0" } }, (base) => {
    const result = runTool(["--root", base.root, "--json"]);
    assert.equal(result.status, 1, "the same licence inside the distributed closure is not");
    assert.ok(rulesOf(result).includes("forbidden-license"));
    const measured = JSON.parse(result.stdout) as { scopeCounts: { production: number } };
    assert.equal(measured.scopeCounts.production, 1, "and it is counted in the production scope");
  });
});

test("an exception excuses in time, and only in time", () => {
  const one = { license: "GPL-3.0-only", dev: true };
  withFixture(
    { tool: one },
    (base) => {
      const result = runTool(["--root", base.root, "--json"]);
      assert.equal(result.status, 0, `a dated exception covers it:\n${result.stdout}`);
    },
    { ...policy, exceptions: [{ package: "tool", why: "fixture", until: "2999-01-01" }] },
  );
  withFixture(
    { tool: one },
    (base) => {
      const expired = runTool(["--root", base.root, "--json"]);
      assert.equal(expired.status, 1, "an expired exception is not an exception");
      assert.ok(rulesOf(expired).includes("expired-exception"), expired.stdout);
    },
    { ...policy, exceptions: [{ package: "tool", why: "fixture", until: "2020-01-01" }] },
  );
  withFixture(
    { tool: one },
    (base) => {
      const undated = runTool(["--root", base.root, "--json"]);
      assert.equal(
        undated.status,
        1,
        "an exception without an end is a policy — and it does not excuse anything (fail closed)",
      );
      assert.ok(rulesOf(undated).includes("forbidden-license"));
    },
    { ...policy, exceptions: [{ package: "tool", why: "fixture" }] },
  );
});

test("an exception that is not needed, or names nothing, is a violation", () => {
  withFixture(
    { harmless: { license: "MIT", dev: true } },
    (base) => {
      const unused = runTool(["--root", base.root, "--json"]);
      assert.equal(unused.status, 1);
      assert.ok(rulesOf(unused).includes("unused-exception"), "the decision outlived its finding");
    },
    { ...policy, exceptions: [{ package: "harmless", why: "fixture", until: "2999-01-01" }] },
  );
  withFixture(
    {},
    (base) => {
      const stale = runTool(["--root", base.root, "--json"]);
      assert.equal(stale.status, 1);
      assert.ok(rulesOf(stale).includes("stale-exception"), stale.stdout);
    },
    { ...policy, exceptions: [{ package: "gone", why: "fixture", until: "2999-01-01" }] },
  );
});

test("our own packages are not third-party — that rule lives in the manifest test", () => {
  withFixture({}, (base) => {
    const result = runTool(["--root", base.root, "--json"]);
    assert.equal(
      result.status,
      0,
      `the root and the workspace entries carry GPL in this fixture and must not be scanned:\n${result.stdout}`,
    );
    const measured = JSON.parse(result.stdout) as { scanned: unknown[] };
    assert.deepEqual(measured.scanned, [], "nothing third-party, nothing scanned");
  });
});

test("a half-written policy is an error, not an empty promise", () => {
  withFixture(
    { tool: { license: "MIT", dev: true } },
    (base) => {
      const broken = runTool(["--root", base.root, "--json"]);
      assert.equal(broken.status, 2);
      assert.match(broken.stderr, /licenses\.development/);
    },
    { production: policy.production },
  );
  withFixture(
    { tool: { license: "MIT", dev: true } },
    (base) => {
      const noReason = runTool(["--root", base.root, "--json"]);
      assert.equal(noReason.status, 2);
      assert.match(noReason.stderr, /no "why"/);
    },
    { ...policy, development: { ...policy.development, why: "" } },
  );
});
