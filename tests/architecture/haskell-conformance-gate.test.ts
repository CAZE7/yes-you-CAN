/**
 * The TypeScript ⇄ Haskell differential has a CI carrier (ADR 0055).
 *
 * The situation this closes: the shared vectors run against the production
 * TypeScript on every `npm test` (project `protocol`), and the cross-language
 * half of that gate — the differential against the formal reference — only ran
 * where a developer happened to have a Haskell toolchain. On a machine without
 * one the comparison was a visible skip, and a release cut from such a machine
 * could ship with the reference side never having spoken. Optional means the
 * gate is a habit, and a habit is not a gate (ADR 0029 §1).
 *
 * The shape is the one `coverage-gate.test.ts` established: CI runs the tests,
 * so the gate goes in the test run. Two deliberate differences from that
 * carrier:
 *
 *  - CI is where the toolchain is guaranteed. The GitHub-hosted runner ships
 *    GHC preinstalled (measured against the `actions/runner-images` Ubuntu
 *    24.04 image documentation: "Haskell Tools — GHC 9.14.1"), so under `CI`
 *    the comparison *must* run: a missing toolchain there is a gate failure,
 *    not a skip — a release machine that cannot run the differential must not
 *    cut a release that claims conformance. Locally the same discipline cannot
 *    hold (many developers have no GHC), so the test runs only when a
 *    toolchain is present and is an honest skip otherwise.
 *  - The child is the repository's own `formal:conform` script with
 *    `--compare`, so gate and command cannot drift apart: the assertion on the
 *    script text notices if the script stops pointing at the conformance CLI.
 *
 * Exit codes are the contract (ADR 0045): 0 = both sets ran and agreed,
 * 1 = a deviation, 2 = the comparison could not run (no toolchain, or a
 * vector file the readers refuse). The first two are release failures with the
 * CLI's own report attached; the second is a release failure in CI (nothing
 * less is honest) and a real error locally, where the toolchain was present.
 *
 * Cost: one `ghc` compile of the small base-only formal tree plus one driver
 * run per vector set (the CLI prefers `ghc` for exactly this reason —
 * interpreting the tree twice from source was the cold-runner cost this gate
 * was not about to pay per CI run). Bound at ten minutes, `retry: 0`: a
 * retried gate here is a second compile, and a compile either links or it
 * does not.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";
import { repoRoot } from "./workspace.js";

const isCi = process.env.CI === "true" || process.env.CI === "1";

function hasToolchain(runner: string): boolean {
  return spawnSync("sh", ["-c", `command -v ${runner}`], { encoding: "utf8" }).status === 0;
}

const hasHaskell = ["ghc", "runhaskell", "runghc"].some(hasToolchain);

/** One line into the CI log, as an annotation — the coverage gate's channel:
 * job logs are not always readable from here, `::notice` lines are. Escaping
 * order is `%` before `::`. */
const notice = (message: string): void => {
  process.stdout.write(
    `::notice title=Haskell conformance gate::${message
      .replaceAll("%", "%25")
      .replaceAll("::", "%3A%3A")}\n`,
  );
};

const tail = (value: string, lines = 40): string =>
  value
    .split("\n")
    .filter((line) => line.trim() !== "")
    .slice(-lines)
    .join("\n");

notice(
  isCi
    ? `mode=armed (CI=${String(process.env.CI)}, toolchain=${hasHaskell ? "present" : "MISSING"}): ` +
        "the differential below decides — a release needs both legs"
    : hasHaskell
      ? "mode=local (toolchain present): running the differential in the developer loop"
      : "mode=skipped: no Haskell toolchain on this machine — the CI run carries the gate",
);

/**
 * CI: always runs — a missing toolchain is the failure mode this test exists
 * to make visible. Locally: runs where a toolchain exists, skips where none
 * does (a visible skip, never an invisible green).
 */
test.skipIf(!isCi && !hasHaskell)(
  "the TypeScript ⇄ Haskell differential is clean for ISO-TP and write-safety (release gate)",
  { timeout: 10 * 60_000, retry: 0 },
  () => {
    const rootManifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    // The gate and the command agree by construction: the child below is this
    // script, so the assertion is on what the script still says.
    const script = rootManifest.scripts?.["formal:conform"] ?? "";
    assert.match(
      script,
      /formal-conformance\/dist\/src\/cli\.js/,
      "this carrier only gates the differential as long as `formal:conform` " +
        "still runs the conformance CLI — the target lives in the script, not in the spawn",
    );

    const startedAt = Date.now();
    const result = spawnSync("npm", ["run", "formal:conform", "--", "--compare"], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      // The child runs its own `npm run build` first; it would otherwise fight
      // the parent run for the same CI artifact.
      env: { ...process.env, VITEST_JUNIT_FILE: undefined },
    });

    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);

    if (result.status === 0) {
      const iso = output.match(/iso15765-2: TS ⇄ Haskell differential clean \((\d+) vectors\)/);
      const safety = output.match(
        /write-safety: TS ⇄ Haskell differential clean \((\d+) vectors\)/,
      );
      notice(
        `mode=measured ${seconds}s — iso15765-2 clean (${iso?.[1] ?? "?"} vectors), ` +
          `write-safety clean (${safety?.[1] ?? "?"} vectors)`,
      );
      assert.ok(
        iso,
        "the clean run reported no ISO-TP differential line — the comparison did not run " +
          `the set it claims to gate:\n\n${tail(output)}\n`,
      );
      assert.ok(
        safety,
        "the clean run reported no write-safety differential line — the comparison did " +
          `not run the set it claims to gate:\n\n${tail(output)}\n`,
      );
      return;
    }

    if (result.status === 1) {
      // A deviation: the release gate biting. The report names vector, input,
      // both results and the differing paths — that is the failure, verbatim.
      notice(`mode=deviation ${seconds}s — the differential found a disagreement (exit 1)`);
      throw new Error(
        "release gate: the TypeScript ⇄ Haskell differential found a deviation — " +
          "the production code and the formal reference disagree (or one of the vector " +
          `files no longer matches its expectations):\n\n${tail(output)}\n`,
      );
    }

    // Exit 2: the comparison could not run at all.
    if (isCi) {
      notice(
        `mode=unrunnable ${seconds}s — no comparison on a CI runner (exit 2): ` +
          "a release without the differential is not a release",
      );
      throw new Error(
        "release gate: the Haskell differential could not run on a CI runner — the " +
          "toolchain is missing or the vector files are unreadable. A release cut from " +
          "a runner that cannot verify the reference side must not claim conformance " +
          `for ISO-TP and write-safety:\n\n${tail(output)}\n`,
      );
    }
    throw new Error(
      "the Haskell differential could not run although a toolchain is present — " +
        `check the formal/ tree and the vector files:\n\n${tail(output)}\n`,
    );
  },
);
