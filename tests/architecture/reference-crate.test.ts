/**
 * The reference crate stays outside every gate — and says so honestly.
 *
 * The situation this closes: `crates/yes_you_can_core` is 661 lines of Rust that
 * sit next to a 111k-line TypeScript platform. Measured 2026-09-24:
 *
 *  - **Nothing imports it.** `grep -rn "crates/" packages apps tools tests scripts`
 *    → no match outside the crate itself.
 *  - **No gate builds it.** No `cargo` step in `package.json`, none in any file
 *    under `.github/workflows/`. `cargo` and `rustc` are not installed in the
 *    development environment either (measured: `which cargo rustc` → nothing),
 *    so nothing here is compiled — which is exactly why it must not be allowed
 *    to look like part of the platform.
 *  - **It carried three claims that were not true.** AGENTS 0.E E25 recorded
 *    them on 2026-09-19; by 2026-09-24 two were already fixed in the source
 *    (the CAN-FD/32-bit-DL header of `isotp.rs`, and `safety.rs::execute`
 *    taking the permit expiry from the caller) and the third — "zero-copy" /
 *    "zero-allocation" — was corrected in this same change, because
 *    `signal.rs` allocates twice and `compute_statistics` clones its input.
 *
 * A rule that cannot fail is not a rule (ADR 0031). So this file turns the
 * crate's *status* into three assertions, and turns the claim discipline into a
 * scan: a performance claim that reappears without a measurement behind it
 * fails the suite, the same way `hygiene.test.ts` fails on a stray `any`.
 *
 * What this file deliberately does **not** do: compile or test the Rust. A
 * `#[cfg(test)]` block nobody translates is a test that does not run — the
 * exact disease `NOT RUN ≠ bestanden` exists to name. That work belongs in an
 * environment with a toolchain, and it is tracked in the crate's own README.
 */

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "vitest";
import { repoRoot as root } from "./workspace.js";

const CRATE_DIR = "crates/yes_you_can_core";
const CRATE_README = join(root, CRATE_DIR, "README.md");

/** Directories that hold reviewed production source — nothing here may reach the crate. */
const PRODUCTION_ROOTS = ["packages", "apps", "tools", "scripts"] as const;

/** Never reviewed source. */
const IGNORED_DIRS = new Set(["node_modules", "dist", "coverage", ".git", ".arena", ".cache"]);

function walk(dir: string, extensions: ReadonlyArray<string>): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      found.push(...walk(absolute, extensions));
    } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
      found.push(absolute);
    }
  }
  return found;
}

test("no production source reaches into the reference crate", () => {
  const importers: string[] = [];
  for (const base of PRODUCTION_ROOTS) {
    const absoluteBase = join(root, base);
    if (!existsSync(absoluteBase)) continue;
    for (const file of walk(absoluteBase, [".ts", ".mjs", ".js", ".json"])) {
      const source = readFileSync(file, "utf8");
      // A path segment, not a bare word: `crates/` appears in prose too.
      if (/(^|["'\s/(])crates\//.test(source)) {
        importers.push(`${relative(root, file)}`);
      }
    }
  }
  assert.deepEqual(
    importers,
    [],
    "the crate is a reference model, not a dependency — an import would make an unbuilt, " +
      "untested library part of the platform",
  );
});

test("no gate builds the reference crate", () => {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  const cargoScripts = Object.entries(manifest.scripts ?? {}).filter(([, command]) =>
    /\b(cargo|rustc|rustup)\b/.test(command),
  );
  assert.deepEqual(
    cargoScripts,
    [],
    "a cargo step in package.json would put the crate on the critical path without a toolchain " +
      "to run it",
  );

  const workflowDir = join(root, ".github", "workflows");
  if (!existsSync(workflowDir)) return;
  const cargoWorkflows = walk(workflowDir, [".yml", ".yaml"]).filter((file) =>
    /\b(cargo|rustc|rustup)\b/.test(readFileSync(file, "utf8")),
  );
  assert.deepEqual(
    cargoWorkflows.map((f) => relative(root, f)),
    [],
    "a cargo step in a workflow would claim the crate is verified by CI, which it is not",
  );
});

/**
 * The claim scan.
 *
 * These words were in the crate on 2026-09-19 and each of them was a statement
 * about performance with no measurement behind it. The scan reads **source and
 * manifest only** (`.rs`, `.toml`) — never `README.md`, which legitimately
 * *quotes* the old claims in order to refute them, and a gate that punishes the
 * correction is a gate that teaches people to stop correcting.
 *
 * A line that negates itself is not a claim. `signal.rs` now says "**Not
 * zero-allocation.** … The module header used to claim …"; that is the honest
 * sentence, and it contains the forbidden word because it has to. So the
 * detector requires the claim *and* the absence of a negation on the same line
 * — the same distinction a reader makes, written down once.
 */
test("the crate makes no unmeasured performance claim", () => {
  const crateRoot = join(root, CRATE_DIR);
  assert.ok(
    existsSync(crateRoot),
    "the reference crate directory must exist for this gate to mean anything",
  );

  /** Words that turn a claim into a correction. English and German, deliberately. */
  const NEGATION =
    /\b(not|no|never|without|kein|keine|keinen|nicht|ohne|unbelegt|used to|behauptete|statt)\b/i;

  const forbidden: ReadonlyArray<[RegExp, string]> = [
    // (1) the CAN-FD / escape-sequence claims — the implementation is Classic CAN only.
    [/CAN[- ]FD/i, "the crate implements Classic CAN (8-byte frames, 12-bit FF length) only"],
    [/32-bit DL|4\s?GB/i, "there is no 32-bit escape-sequence length in this implementation"],
    // (2) the allocation claims — `signal.rs` allocates, `compute_statistics` clones.
    [/zero[- ]copy/i, "no benchmark measures this; `isotp.rs` says 'borrows a slice' instead"],
    [/zero[- ]allocation/i, "`signal.rs` allocates twice; the claim is false"],
    [/zero dynamic reallocation/i, "no allocation measurement exists"],
    // (3) the speed claims — nothing here has been timed against the TypeScript core.
    [
      /high[- ]performance|blazing|fastest|zero[- ]cost/i,
      "no benchmark exists, so no speed claim is available",
    ],
  ];

  const violations: string[] = [];
  for (const file of walk(crateRoot, [".rs", ".toml"])) {
    const rel = relative(root, file);
    for (const [index, line] of readFileSync(file, "utf8").split("\n").entries()) {
      if (NEGATION.test(line)) continue; // a correction, not a claim
      for (const [pattern, why] of forbidden) {
        if (pattern.test(line)) {
          violations.push(`${rel}:${index + 1}  ${line.trim().slice(0, 90)}  — ${why}`);
        }
      }
    }
  }

  assert.deepEqual(
    violations,
    [],
    `the reference crate carries a claim it cannot back:\n${violations.join("\n")}\n\n` +
      "Either measure it, or say what the code actually does (AGENTS 34.21 applies across " +
      "language boundaries too).",
  );
});

/**
 * The status label exists and says the three things that are true.
 *
 * A crate with no README is a crate a reader has to guess about, and the guess
 * is always "it is probably part of the platform". The label is checked here so
 * deleting it fails — the same treatment `hygiene.test.ts` gives a size
 * exemption.
 */
test("the crate's README states its status, not its ambitions", () => {
  assert.ok(existsSync(CRATE_README), "the crate needs a README that says what it is");
  const readme = readFileSync(CRATE_README, "utf8");
  for (const phrase of [
    "nicht gebaut", // not built
    "nicht getestet", // not tested
    "nicht importiert", // not imported
  ]) {
    assert.ok(
      readme.includes(phrase),
      `the README must say "${phrase}" — a reference model that reads like a dependency is the ` +
        "confusion this label exists to prevent",
    );
  }
});
