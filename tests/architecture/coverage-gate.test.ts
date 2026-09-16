/**
 * The coverage gates have a CI carrier.
 *
 * The situation this closes: `vitest.config.ts` declares thresholds (90 % lines /
 * 80 % branches / 90 % functions globally, per-file floors per layer — ADR 0027,
 * ADR 0028) that no CI path ever executed. `npm test` runs without `--coverage`, and
 * `.github/workflows/ci.yml` cannot be extended from here: re-measured 2026-09-16,
 * the push is refused with `refusing to allow a GitHub App to create or update
 * workflow '.github/workflows/ci.yml' without 'workflows' permission` (AGENTS 0.E
 * E10/E20). A threshold nobody runs is a wish — it fails neither when coverage
 * drops nor when the floor is lowered, and both directions were open.
 *
 * The shape is the one ADR 0029 §4 used for Biome and TypeScript: put the gate in
 * the test run, because CI does run the tests. Three deliberate differences:
 *
 *  - CI only. The fast local loop must not pay for a second full suite (measured
 *    below), and `npm run test:coverage` stays the command a developer runs by hand.
 *    A skipped test is an honest record of that, not a hidden gate.
 *  - The child runs the repository's *own* script by name, so the gate and the
 *    command cannot disagree about what the thresholds are. The assertion on the
 *    script text is what notices if `test:coverage` stops passing `--coverage`: the
 *    carrier would then silently measure a suite instead of a measurement.
 *  - Recursion guard. `test:coverage` includes the `architecture` project, which
 *    contains this test; without `VDP_COVERAGE_CHILD` the child would spawn a
 *    grandchild. The guard is read before the spawn, so editing the project list in
 *    `vitest.config.ts` cannot re-open the loop.
 *  - `retry: 0`, against the config's CI default of two. A retried test here is
 *    not a re-run of an assertion, it is a second full suite: measured on a red
 *    threshold, the test cost 203 s instead of 65 s and printed the same threshold
 *    error three times. Retries exist for flaky timing, and a gate that spawns a
 *    suite has no timing to be flaky about — the child either reports the table or
 *    it does not, and both branches are asserted below.
 *
 * Cost and bite, measured on this tree: the `architecture` project runs in 5,5 s with
 * this test skipped (every local `npm test`) and in 73,2 s with the child (every CI
 * leg, both matrix entries); `npm run test:coverage` alone is 66,2 s, so ≈65 s per leg
 * is bought for the gates that previously had no CI carrier at all. Child and local
 * command agree by construction (94,74 / 86,67 / 96,09 / 96,04 in both runs measured
 * here) — which is what running the script instead of restating its numbers buys. It is
 * *not* a claim that the numbers are stable: the branch total moves by 0,01 between a
 * quiet and a loaded machine, because one `chaos-lab.ts` branch (its realtime-`sleep`
 * fallback, line 58) is covered only when a run has to wait — a floor, not a promise.
 *
 * Bite measured: raising the global `lines` threshold to 99 (ist 96,04) makes this test
 * the project's only failure, and its message carries the child's own line `ERROR:
 * Coverage for lines (96.04%) does not meet global threshold (99%)`. Once — because of
 * `retry: 0`; the first version of this file lacked it, and CI retried the whole child
 * suite: the same error three times, 203 s instead of 65 s.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";
import { repoRoot } from "./workspace.js";

/** Same predicate `vitest.config.ts` uses for `retry`. Copied on purpose: the root
 * config is not a module this project imports, and a second `isCi` in the config
 * would be the worse duplicate. */
const isCi = process.env.CI === "true" || process.env.CI === "1";

/** Set for the child run only — see the recursion guard in the header. */
const isCoverageChild = process.env.VDP_COVERAGE_CHILD === "1";

/** A full suite with instrumentation on a cold runner: bound it, but do not let the
 * global 20 s `testTimeout` kill a measurement that is merely slow. */
const COVERAGE_TIMEOUT_MS = 15 * 60_000;

/**
 * One line into the CI log, as an annotation.
 *
 * Why this exists: the job's raw log is not readable with the credentials this
 * repository is worked with (`actions/jobs/<id>/logs` redirects to a results blob the
 * API here cannot fetch), but `::notice` lines become check annotations and *are*
 * readable — the same channel `tools/test-reporters/flaky-reporter.ts` uses for flaky
 * tests. A gate that reports nothing cannot be told apart from a gate that did not
 * run; without a line here, a CI leg of the same length as before this file existed
 * would be a belief about `process.env.CI` instead of an annotation. Escaping order is
 * `%` before `::`, otherwise the escape itself is escaped twice.
 */
const notice = (message: string): void => {
  process.stdout.write(
    `::notice title=Coverage gate::${message.replaceAll("%", "%25").replaceAll("::", "%3A%3A")}\n`,
  );
};

notice(
  isCoverageChild
    ? "mode=child (VDP_COVERAGE_CHILD is set): carrier off, that is the recursion guard"
    : isCi
      ? `mode=armed (CI=${String(process.env.CI)}): the child run below decides`
      : `mode=skipped (CI=${String(process.env.CI)}): local loop, \`npm run test:coverage\` is the command here`,
);

const tail = (value: string, lines = 30): string =>
  value
    .split("\n")
    .filter((line) => line.trim() !== "")
    .slice(-lines)
    .join("\n");

// `(name, options, fn)`, not the trailing form: that overload takes a bare number.
// `retry: 0` is the gate against the config's CI default of two retries — each retry
// here is a whole second suite (measured), and a gate has nothing to retry.
test.skipIf(!isCi || isCoverageChild)(
  "coverage gates hold in the CI run (`npm run test:coverage`)",
  { timeout: COVERAGE_TIMEOUT_MS, retry: 0 },
  () => {
    const rootManifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    const script = rootManifest.scripts?.["test:coverage"] ?? "";
    assert.match(
      script,
      /--coverage/,
      "this carrier only enforces the gates as long as `test:coverage` actually measures " +
        "coverage — the flag lives in the script, not in the spawn below",
    );

    const startedAt = Date.now();
    const result = spawnSync("npm", ["run", "test:coverage"], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env,
        VDP_COVERAGE_CHILD: "1",
        // Both runs would otherwise write the same CI artifact (`junitFile` in the
        // root config) and an artifact torn between two writers is worse than absent.
        VITEST_JUNIT_FILE: undefined,
      },
    });

    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    const row =
      output.split("\n").find((line) => line.trimStart().startsWith("All files")) ?? "no table";
    notice(`mode=measured ${seconds}s — ${row.trim().replaceAll(/\s+/g, " ")}`);
    assert.equal(
      result.status,
      0,
      `the coverage gates failed — \`npm run test:coverage\` is the same command locally:\n\n${tail(output)}\n`,
    );
    assert.match(
      output,
      /All files/,
      "the run did not report a coverage table, so it did not measure what this test " +
        `claims to enforce:\n\n${tail(output)}\n`,
    );
  },
);
