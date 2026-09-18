import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { parseIsoTpVectorFile, parseSafetyVectorFile } from "./vectors.js";

const isoFile = (vectors: unknown[]) =>
  JSON.stringify({
    vectorSet: "test",
    modelDomain: "test",
    vectors,
  });

const goodRx = {
  name: "ok-rx",
  side: "rx",
  input: [{ in: [1, 42] }],
  expect: {
    delivered: [42],
    sentFrames: [],
    counters: { sequenceErrors: 0, timeouts: 0, retries: 0 },
  },
};

describe("ISO-TP vector parsing", () => {
  test("a well-formed file parses and materialises defaults", () => {
    const parsed = parseIsoTpVectorFile(isoFile([goodRx]));
    assert.ok(parsed.ok, JSON.stringify("errors" in parsed ? parsed.errors : []));
    const vector = parsed.vectors[0];
    assert.ok(vector);
    assert.equal(vector.name, "ok-rx");
    assert.equal(vector.side, "rx");
    assert.deepEqual(vector.payload, []);
    // Defaults from the vector-file contract (same numbers the runner uses):
    assert.equal(vector.config.nBsMs, 60);
    assert.equal(vector.config.wftMax, 8);
  });

  test("an unknown key inside a vector is a parse error with the path", () => {
    const parsed = parseIsoTpVectorFile(isoFile([{ ...goodRx, unexpected: true }]));
    assert.ok(!parsed.ok);
    assert.ok(
      parsed.errors.some((e) => e.includes("vectors[0]") && e.includes('unknown key "unexpected"')),
      parsed.errors.join("\n"),
    );
  });

  test("duplicate vector names are refused — a name must select exactly one vector", () => {
    const parsed = parseIsoTpVectorFile(isoFile([goodRx, { ...goodRx }]));
    assert.ok(!parsed.ok);
    assert.ok(parsed.errors.some((e) => e.includes("duplicate vector name")));
  });

  test("bytes outside 0..255 are refused, not truncated", () => {
    const parsed = parseIsoTpVectorFile(isoFile([{ ...goodRx, input: [{ in: [300] }] }]));
    assert.ok(!parsed.ok);
    assert.ok(parsed.errors.some((e) => e.includes("byte 0..255")));
  });

  test("payloadLength materialises the canonical fill; both payload forms together are a conflict", () => {
    const ok = parseIsoTpVectorFile(
      isoFile([
        {
          name: "tx-fill",
          side: "tx",
          payloadLength: 9,
          peer: [],
          expect: { sentFrames: [], counters: { sequenceErrors: 0, timeouts: 0, retries: 0 } },
        },
      ]),
    );
    assert.ok(ok.ok, JSON.stringify("errors" in ok ? ok.errors : []));
    assert.deepEqual(ok.vectors[0]?.payload, new Array<number>(9).fill(0x5a));
    const conflict = parseIsoTpVectorFile(
      isoFile([{ ...goodRx, side: "tx", payload: [1], payloadLength: 9, expect: goodRx.expect }]),
    );
    assert.ok(!conflict.ok);
    assert.ok(conflict.errors.some((e) => e.includes("alternatives")));
  });

  test("an rx vector without frames and a tx vector without payload are both refused", () => {
    const rx = parseIsoTpVectorFile(isoFile([{ ...goodRx, input: [] }]));
    assert.ok(!rx.ok && rx.errors.some((e) => e.includes("needs input frames")));
    const tx = parseIsoTpVectorFile(
      isoFile([{ name: "t", side: "tx", expect: { sentFrames: [] } }]),
    );
    assert.ok(!tx.ok && tx.errors.some((e) => e.includes("payload or payloadLength")));
  });

  test("an unparseable JSON document is a parse error, not an empty vector set", () => {
    const parsed = parseIsoTpVectorFile("{ not json");
    assert.ok(!parsed.ok);
    assert.ok(parsed.errors[0]?.startsWith("invalid JSON"));
  });
});

const goodPrecheck = {
  family: "precheck",
  name: "ok",
  context: {
    risk: "low",
    userConfirmed: true,
    backupAvailable: true,
    sessionType: 3,
    definitionVersion: "1.0.0",
  },
  vehicle: { stationary: true, ignitionOn: true, batteryVoltage: 12.6, parkingBrake: null },
  expect: { granted: true },
};

describe("safety vector parsing", () => {
  const file = (vectors: unknown[]) =>
    JSON.stringify({ vectorSet: "t", modelDomain: "t", config: {}, vectors });

  test("a well-formed precheck vector parses with defaulted counts", () => {
    const parsed = parseSafetyVectorFile(file([goodPrecheck]));
    assert.ok(parsed.ok, JSON.stringify("errors" in parsed ? parsed.errors : []));
    const vector = parsed.vectors[0];
    assert.deepEqual(vector?.expect, { kind: "precheck", granted: true, failed: 0, unproven: 0 });
  });

  test("unproven must stay a subset of failed — a vector claiming more would lie", () => {
    const parsed = parseSafetyVectorFile(
      file([{ ...goodPrecheck, expect: { granted: false, failed: 1, unproven: 2 } }]),
    );
    assert.ok(!parsed.ok);
    assert.ok(parsed.errors.some((e) => e.includes("subset of failed")));
  });

  test("vehicle fields must all be named; null is the only way to say “unknown”", () => {
    const missing = parseSafetyVectorFile(
      file([
        { ...goodPrecheck, vehicle: { stationary: true, ignitionOn: true, batteryVoltage: 12.6 } },
      ]),
    );
    assert.ok(!missing.ok);
    assert.ok(missing.errors.some((e) => e.includes("parkingBrake: must be named")));
    const nullary = parseSafetyVectorFile(
      file([{ ...goodPrecheck, vehicle: { ...goodPrecheck.vehicle, parkingBrake: null } }]),
    );
    assert.ok(nullary.ok);
  });

  test("a flow vector states the session as bindingSessionType — a second source is refused", () => {
    const duplicated = parseSafetyVectorFile(
      file([
        {
          family: "flow",
          name: "f",
          permitExpiry: "fresh",
          bindingSessionType: 3,
          context: { ...goodPrecheck.context, sessionType: 3 },
          vehicle: goodPrecheck.vehicle,
          script: { prepareOk: true, executeOk: true, verify: "match", rollback: "ok" },
          expect: {
            ok: true,
            state: "verified",
            writeReached: true,
            verified: true,
            rolledBack: false,
          },
        },
      ]),
    );
    assert.ok(!duplicated.ok);
    assert.ok(duplicated.errors.some((e) => e.includes("not in the context")));
  });

  test("stages vectors require exactly one boolean per op", () => {
    const parsed = parseSafetyVectorFile(
      file([
        {
          family: "stages",
          name: "s",
          ops: [{ op: "prepare" }],
          expect: { state: "prepared", stageOk: [true, false] },
        },
      ]),
    );
    assert.ok(!parsed.ok);
    assert.ok(parsed.errors.some((e) => e.includes("one boolean per op")));
  });
});
