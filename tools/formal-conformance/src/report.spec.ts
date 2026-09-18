import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  compareAgainstExpectations,
  compareRecordSets,
  formatDiff,
  parseDriverJsonl,
  recordsToJsonl,
} from "./report.js";

describe("expectation comparison", () => {
  test("a result equal to the expectation counts as a match, key order aside", () => {
    const vectors = [{ name: "v1", expect: { b: 2, a: 1 } }];
    const compared = compareAgainstExpectations(vectors, [{ name: "v1", result: { a: 1, b: 2 } }]);
    assert.equal(compared.matches, 1);
    assert.deepEqual(compared.mismatches, []);
  });

  test("a missing record is reported as missing, never as agreement", () => {
    const compared = compareAgainstExpectations([{ name: "v1", expect: {} }], []);
    assert.equal(compared.matches, 0);
    assert.equal(compared.mismatches[0]?.difference[0], "<missing:result>");
  });

  test("a stuck run (runError) names its reason in the diff", () => {
    const compared = compareAgainstExpectations(
      [{ name: "v1", expect: {} }],
      [{ name: "v1", result: null, runError: "did not settle" }],
    );
    assert.deepEqual(compared.mismatches[0]?.difference, ["did not settle"]);
  });
});

describe("differential comparison", () => {
  const vectors = [{ name: "v1" }, { name: "v2" }];

  test("identical records compare clean", () => {
    const records = [
      { name: "v1", result: { x: 1 } },
      { name: "v2", result: { x: 2 } },
    ];
    assert.deepEqual(compareRecordSets(records, records, vectors), []);
  });

  test("a differing field yields a named path and both sides are shown", () => {
    const diffs = compareRecordSets(
      [{ name: "v1", result: { x: 1 } }],
      [{ name: "v1", result: { x: 2 } }],
      [{ name: "v1" }],
    );
    assert.equal(diffs.length, 1);
    const diff = diffs[0];
    assert.ok(diff);
    assert.deepEqual(diff.difference, ["x"]);
    const text = formatDiff(diff);
    for (const field of ["input:", "ts:", "haskell:", "difference:"]) {
      assert.ok(text.includes(field), `report must carry the field ${field}: ${text}`);
    }
  });

  test("one side lacking a vector is itself a deviation", () => {
    const diffs = compareRecordSets([{ name: "v1", result: {} }], [], [{ name: "v1" }]);
    assert.equal(diffs.length, 1);
    assert.ok(diffs[0]?.difference.some((d) => d.startsWith("haskell:")));
  });
});

describe("driver output parsing", () => {
  test("JSONL lines with a result parse to records; error lines keep their message", () => {
    const records = parseDriverJsonl(
      '{"name":"a","result":{"x":1}}\n{"name":"b","error":"vectors[1]: bad side"}\n',
    );
    assert.deepEqual(records, [
      { name: "a", result: { x: 1 } },
      { name: "b", result: null, runError: "vectors[1]: bad side" },
    ]);
  });

  test("a non-JSON line fails loudly — a driver that died mid-output must not look empty", () => {
    assert.throws(() => parseDriverJsonl('{"name":"a","result":1}\nnot json'), /line 2: not JSON/);
  });

  test("records round trip through the JSONL writer", () => {
    const records = [
      { name: "a", result: { x: 1 } },
      { name: "b", result: null, runError: "stuck" },
    ];
    assert.deepEqual(parseDriverJsonl(recordsToJsonl(records)), records);
  });
});
