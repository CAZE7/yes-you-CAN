import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { runSafetyVector } from "./safety-runner.js";
import { parseSafetyVectorFile } from "./vectors.js";

const context = {
  risk: "low",
  userConfirmed: true,
  backupAvailable: true,
  sessionType: 3,
  definitionVersion: "1.0.0",
};
const vehicle = { stationary: true, ignitionOn: true, batteryVoltage: 12.6, parkingBrake: null };

async function single(json: unknown) {
  const parsed = parseSafetyVectorFile(
    JSON.stringify({ vectorSet: "t", modelDomain: "t", config: {}, vectors: [json] }),
  );
  assert.ok(parsed.ok, JSON.stringify("errors" in parsed ? parsed.errors : []));
  const vector = parsed.vectors[0];
  assert.ok(vector);
  return { result: await runSafetyVector(vector), expect: vector.expect };
}

describe("safety runner over the production chain", () => {
  test("a granted precheck reports no blockers of either kind", async () => {
    const { result, expect } = await single({
      family: "precheck",
      name: "ok",
      context,
      vehicle,
      expect: { granted: true },
    });
    assert.deepEqual(result, expect);
  });

  test("a missing voltage blocks as unproven — and unproven ⊆ failed holds", async () => {
    const { result } = await single({
      family: "precheck",
      name: "voltage-unknown",
      context,
      vehicle: { ...vehicle, batteryVoltage: null },
      expect: { granted: false, failed: 1, unproven: 1 },
    });
    assert.deepEqual(result, { kind: "precheck", granted: false, failed: 1, unproven: 1 });
  });

  test("the full flow verifies exactly when the read-back matches", async () => {
    const flow = {
      family: "flow",
      name: "happy",
      permitExpiry: "fresh",
      bindingSessionType: 3,
      context: {
        risk: "low",
        userConfirmed: true,
        backupAvailable: true,
        definitionVersion: "1.0.0",
      },
      vehicle,
      script: { prepareOk: true, executeOk: true, verify: "match", rollback: "ok" },
      expect: {
        ok: true,
        state: "verified",
        writeReached: true,
        verified: true,
        rolledBack: false,
        failed: 0,
        unproven: 0,
      },
    };
    const { result, expect } = await single(flow);
    assert.deepEqual(result, expect);

    const mismatch = await single({
      ...flow,
      name: "mismatch",
      script: { ...flow.script, verify: "mismatch" },
      expect: { ...flow.expect, ok: false, state: "executed", verified: false, failed: 1 },
    });
    assert.deepEqual(mismatch.result, mismatch.expect);
  });

  test("a refused precheck aborts before the permit — nothing reached the bus", async () => {
    const { result } = await single({
      family: "flow",
      name: "denied",
      permitExpiry: "fresh",
      bindingSessionType: 3,
      context: {
        risk: "low",
        userConfirmed: true,
        backupAvailable: true,
        definitionVersion: "1.0.0",
      },
      vehicle: { ...vehicle, batteryVoltage: 11.0 },
      script: { prepareOk: true, executeOk: true, verify: "match", rollback: "ok" },
      expect: {
        ok: false,
        state: "aborted",
        writeReached: false,
        verified: false,
        rolledBack: false,
      },
    });
    assert.deepEqual(result, {
      kind: "flow",
      ok: false,
      state: "aborted",
      writeReached: false,
      verified: false,
      rolledBack: false,
      failed: 1,
      unproven: 0,
    });
  });

  test("an expired permit fails at the bus gate and takes the rollback policy with it", async () => {
    const { result } = await single({
      family: "flow",
      name: "expired",
      permitExpiry: "expired",
      bindingSessionType: 3,
      context: {
        risk: "low",
        userConfirmed: true,
        backupAvailable: true,
        definitionVersion: "1.0.0",
      },
      vehicle,
      script: { prepareOk: true, executeOk: true, verify: "match", rollback: "ok" },
      expect: {
        ok: false,
        state: "rolled-back",
        writeReached: false,
        verified: false,
        rolledBack: true,
        failed: 1,
      },
    });
    assert.deepEqual(result, {
      kind: "flow",
      ok: false,
      state: "rolled-back",
      writeReached: false,
      verified: false,
      rolledBack: true,
      failed: 1,
      unproven: 0,
    });
  });

  test("the order table: a lone verify aborts, and a terminal transaction never moves", async () => {
    const lone = await single({
      family: "stages",
      name: "lone-verify",
      ops: [{ op: "verify" }],
      expect: { state: "aborted", stageOk: [false] },
    });
    assert.deepEqual(lone.result, { kind: "stages", state: "aborted", stageOk: [false] });

    const sticky = await single({
      family: "stages",
      name: "terminal-rollback",
      ops: [
        { op: "prepare" },
        { op: "confirm", grant: true },
        { op: "execute" },
        { op: "verify" },
        { op: "rollback" },
      ],
      expect: { state: "verified", stageOk: [true, true, true, true, false] },
    });
    assert.deepEqual(sticky.result, sticky.expect);
  });

  test("execute without an attached permit fails closed even in perfect order", async () => {
    const { result } = await single({
      family: "stages",
      name: "no-permit",
      ops: [{ op: "prepare" }, { op: "confirm", grant: false }, { op: "execute" }],
      expect: { state: "aborted", stageOk: [true, true, false] },
    });
    assert.deepEqual(result, { kind: "stages", state: "aborted", stageOk: [true, true, false] });
  });
});
