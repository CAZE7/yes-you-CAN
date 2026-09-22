/**
 * The conformance gate (ADR 0045): the shared test vectors run against the
 * production TypeScript on every `npm test`, and — wherever a Haskell
 * toolchain exists — against the formal reference too.
 *
 * Three things this suite refuses to be:
 *
 * - a parser test: parsing is proven in the tool’s own spec; here the checked-in
 *   vector files must *run* through `IsoTpConnection`, `SafetyManager`,
 *   `WritePort` and `DiagnosticTransaction` and reproduce their expectations.
 * - a silent skip when GHC is absent: the Haskell comparison appears as a
 *   skipped test with its reason, never as an invisible green.
 * - a one-sided gate: the comparison machinery is itself graded against a
 *   deviating driver fixture, so a broken reporter cannot hide broken models.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compareAgainstExpectations,
  compareRecordSets,
  parseDriverJsonl,
  parseIsoTpVectorFile,
  parseSafetyVectorFile,
  runIsoTpVector,
  runSafetyVector,
} from "@vdp/formal-conformance";
import { describe, test } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const isoPath = join(repoRoot, "tools/formal-conformance/vectors/isotp.json");
const safetyPath = join(repoRoot, "tools/formal-conformance/vectors/safety.json");

const yield0 = (): Promise<void> => new Promise((resolve0) => setImmediate(resolve0));
const time = { sleep: async (): Promise<void> => yield0() };

/**
 * An interpreter that can run a standalone `.hs`. `ghc` (compile) is left to
 * the CLI path — the suite uses only the interpreters so it never writes a
 * build artefact during `npm test`.
 */
function findHaskellInterpreter(): "runghc" | "runhaskell" | null {
  for (const runner of ["runghc", "runhaskell"] as const) {
    const probe = spawnSync("sh", ["-c", `command -v ${runner}`], { encoding: "utf8" });
    if (probe.status === 0) return runner;
  }
  return null;
}

function runHaskellDriver(runner: string, set: string, vectorsFile: string): string {
  const driver = join(repoRoot, "formal", "ConformanceDriver.hs");
  const run = spawnSync(runner, ["-i" + join(repoRoot, "formal"), driver, set, vectorsFile], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (run.status !== 0) {
    throw new Error(`haskell driver failed: ${(run.stderr || run.stdout).slice(0, 400)}`);
  }
  return run.stdout;
}

describe("ISO-15765-2 vectors against the production transport", () => {
  const parsed = parseIsoTpVectorFile(readFileSync(isoPath, "utf8"));
  test("the checked-in vector file parses against its own strict reader", () => {
    assert.ok(parsed.ok, JSON.stringify("errors" in parsed ? parsed.errors : []));
  });
  if (!parsed.ok) throw new Error("vector file does not parse");
  const vectors = parsed.vectors;

  test("the family coverage gate: every segment corner carries vectors", () => {
    const rx = vectors.filter((v) => v.side === "rx").length;
    const tx = vectors.filter((v) => v.side === "tx").length;
    assert.ok(rx >= 14, `rx vectors dropped below 14 (found ${rx})`);
    assert.ok(tx >= 10, `tx vectors dropped below 10 (found ${tx})`);
    // The corners a release depends on are pinned by *name*, not only by count:
    // a vector whose name stops matching is a deleted behaviour, and deleting one
    // of these is a model change that needs an ADR, not a quieter suite.
    for (const area of ["sequence-error", "timeout", "overflow", "escape", "wrap", "refused"]) {
      assert.ok(
        vectors.some((v) => v.name.includes(area)),
        `no vector left for the "${area}" corner — the ISO-TP gate has a hole`,
      );
    }
  });

  for (const vector of vectors) {
    test(`vector ${vector.name}: the transport behaves as the formal model defines`, async () => {
      const result = await runIsoTpVector(vector, time);
      assert.deepEqual(result, vector.expect, `deviation in ${vector.name}`);
    });
  }
});

describe("write-safety vectors against the production safety chain", () => {
  const parsed = parseSafetyVectorFile(readFileSync(safetyPath, "utf8"));
  test("the checked-in vector file parses against its own strict reader", () => {
    assert.ok(parsed.ok, JSON.stringify("errors" in parsed ? parsed.errors : []));
  });
  if (!parsed.ok) throw new Error("vector file does not parse");
  const entries = parsed.vectors;

  test("the family coverage gate: precheck, flow and stage order all carry vectors", () => {
    const count = (family: string): number => entries.filter((e) => e.family === family).length;
    assert.ok(count("precheck") >= 20, `precheck vectors dropped below 20 (${count("precheck")})`);
    assert.ok(count("flow") >= 10, `flow vectors dropped below 10 (${count("flow")})`);
    assert.ok(count("stages") >= 6, `stages vectors dropped below 6 (${count("stages")})`);
    // The release-critical behaviours, pinned by name: an expired permit must be
    // rechecked, every stage-order violation must keep its vector, and the write
    // permission rules (session, definition, ECU identity, transport security)
    // must each keep at least one graded example.
    assert.ok(
      entries.some((e) => e.name.includes("expired")),
      "no vector left for permit expiry — the gate has a hole",
    );
    for (const area of ["refused", "skipping", "before", "without"]) {
      assert.ok(
        entries.some((e) => e.name.includes(area)),
        `no stage vector left matching "${area}" — the order gate has a hole`,
      );
    }
    for (const area of ["session", "definition", "ecu", "tls"]) {
      assert.ok(
        entries.some((e) => e.name.includes(area)),
        `no precheck vector left for the "${area}" permission — the gate has a hole`,
      );
    }
  });

  for (const vector of entries) {
    test(`vector ${vector.name}: the safety chain decides as the formal model defines`, async () => {
      const result = await runSafetyVector(vector);
      assert.deepEqual(result, vector.expect, `deviation in ${vector.name}`);
      if (result.kind === "precheck" || result.kind === "flow") {
        // ADR 0033 as a live invariant, on every run and not only in the
        // vector: unproven is a subset of failed.
        assert.ok(
          result.unproven <= result.failed,
          `invariant broken in ${vector.name}: ${result.unproven} unproven exceeds ${result.failed} failed`,
        );
      }
    });
  }
});

describe("TypeScript ⇄ Haskell differential", () => {
  const runner = findHaskellInterpreter();

  test("the Haskell reference reproduces the same results for every vector", {
    // coverage gate carries the same bound for the same reason. // not fit the global 20 s window (measured on the runner: cold >20 s); the // Two `runghc` legs — each interprets the whole formal tree from source — do
    skip: runner === null,
    timeout: 10 * 60_000,
  }, async () => {
    assert.ok(runner !== null);
    for (const [set, file] of [
      ["isotp", isoPath],
      ["safety", safetyPath],
    ] as const) {
      const hsText = runHaskellDriver(runner, set, file);
      const hs = parseDriverJsonl(hsText);
      if (set === "isotp") {
        const parsed = parseIsoTpVectorFile(readFileSync(file, "utf8"));
        assert.ok(parsed.ok);
        const ts = [];
        for (const vector of parsed.vectors) {
          ts.push({ name: vector.name, result: await runIsoTpVector(vector, time) });
        }
        const diffs = compareRecordSets(
          ts,
          hs,
          parsed.vectors.map((v) => ({ name: v.name })),
        );
        assert.deepEqual(
          diffs,
          [],
          `${set}: ${diffs.length} deviation(s) between TS and Haskell\n` +
            diffs
              .map(
                (deviation) =>
                  `${deviation.name}: ${deviation.difference.join(", ")}\n` +
                  `${deviation.input.slice(0, 1200)}`,
              )
              .join("\n"),
        );
      } else {
        const parsed = parseSafetyVectorFile(readFileSync(file, "utf8"));
        assert.ok(parsed.ok);
        const ts = [];
        for (const vector of parsed.vectors) {
          ts.push({ name: vector.name, result: await runSafetyVector(vector) });
        }
        const diffs = compareRecordSets(
          ts,
          hs,
          parsed.vectors.map((v) => ({ name: v.name })),
        );
        assert.deepEqual(
          diffs,
          [],
          `${set}: ${diffs.length} deviation(s) between TS and Haskell\n` +
            diffs
              .map(
                (deviation) =>
                  `${deviation.name}: ${deviation.difference.join(", ")}\n` +
                  `${deviation.input.slice(0, 1200)}`,
              )
              .join("\n"),
        );
      }
    }
  });

  // The flip side of the skip above: exactly when no toolchain exists, this
  // test grades the comparison machinery itself — a deviating driver result
  // must produce a named, path-carrying diff. The “driver” is a mutated copy
  // of the TS results, so the reporter is covered even where no compiler is.
  // Where a toolchain exists the test has nothing to add and is skipped.
  const whenNoToolchain = runner === null ? test : test.skip;
  whenNoToolchain(
    "without a toolchain the comparison machinery is graded against a simulated driver — never quietly green",
    () => {
      const parsed = parseIsoTpVectorFile(readFileSync(isoPath, "utf8"));
      assert.ok(parsed.ok);
      const vector = parsed.vectors[0];
      assert.ok(vector);
      const records = [
        { name: vector.name, result: vector.expect },
        { name: "ghost", result: null, runError: "not in the vector set" },
      ];
      const clean = compareAgainstExpectations(
        [{ name: vector.name, expect: vector.expect }],
        records,
      );
      assert.equal(clean.matches, 1, "the reporter must agree with a clean side");
      const deviations = compareRecordSets(records, records, [{ name: vector.name }]);
      assert.deepEqual(deviations, [], "identical records never deviate");
      const mutated = structuredClone(records[0]);
      assert.ok(mutated && typeof mutated.result === "object");
      (mutated.result as { delivered: number[] }).delivered = [0xff, 98, 99];
      const found = compareRecordSets(records, [mutated], [{ name: vector.name }]);
      assert.equal(found.length, 1);
      assert.deepEqual(found[0]?.difference, ["delivered[0]"]);
    },
  );
});
