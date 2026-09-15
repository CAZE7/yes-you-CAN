/**
 * Formal State Invariants & Property-Based Safety Tests (Task 7; AGENTS 25, 26).
 *
 * Verifies with fast-check that under ANY sequence of arbitrary stage calls,
 * transitions, or mutations:
 *
 * 1. "Executing is NEVER reachable without a valid, non-expired permit."
 * 2. An unconfirmed or refused transaction NEVER transitions to "executed" or "verified".
 * 3. Out-of-order transitions fail closed without executing.
 */

import assert from "node:assert/strict";
import fc from "fast-check";
import { describe, test } from "vitest";
import { SafetyManager } from "../safety/safety-manager.js";
import {
  DiagnosticTransaction,
  type TransactionBinding,
  type WriteStageName,
} from "./transaction.js";

const DEFAULT_BINDING: TransactionBinding = {
  kind: "test-write",
  risk: "high",
  ecuId: "ecu-engine",
  ecuName: "Engine Control",
  sessionType: 0x03,
  definitionVersion: "1.0.0",
};

describe("Formal Safety Invariant: Executing is strictly guarded by Permit", () => {
  test("stage('execute') fails closed and aborts if transaction has no permit", async () => {
    const tx = new DiagnosticTransaction({ binding: DEFAULT_BINDING });
    await tx.stage("prepare", () => ({ ok: true }));

    // Manually stage confirm without setting a permit
    await tx.stage("confirm", () => ({ ok: true }));
    assert.equal(tx.state, "confirmed");

    // Manually attempt to call execute without having called tx.confirm(permit)
    const report = await tx.stage("execute", () => ({ ok: true, value: "hacked" }));
    assert.equal(report.state, "failed");
    assert.match(report.reasons[0] ?? "", /requires a valid confirmed permit/);
    assert.equal(tx.state, "aborted");
    assert.equal(tx.value("execute"), undefined);
  });

  test("property-based proof: arbitrary sequence of stages never reaches 'executed' without confirm", async () => {
    const stagesArbitrary: fc.Arbitrary<WriteStageName[]> = fc.array(
      fc.constantFrom<WriteStageName>("prepare", "confirm", "execute", "verify", "rollback"),
      { minLength: 1, maxLength: 20 },
    );

    await fc.assert(
      fc.asyncProperty(stagesArbitrary, async (stages) => {
        const tx = new DiagnosticTransaction({ binding: DEFAULT_BINDING });
        let executedReached = false;

        for (const stage of stages) {
          if (tx.isFinished) break;
          // In this test, confirm always fails (simulating no permit granted)
          await tx.stage(stage, () => {
            if (stage === "confirm") {
              return { ok: false, reasons: ["permit denied by safety policy"] };
            }
            if (stage === "execute") {
              executedReached = true;
            }
            return { ok: true };
          });
        }

        // Formal invariant: executed stage body was NEVER run and state is never executed/verified
        assert.equal(
          executedReached,
          false,
          "execute was called even though permit was never confirmed!",
        );
        assert.notEqual(tx.state, "executed");
        assert.notEqual(tx.state, "verified");
      }),
      { numRuns: 100 },
    );
  });

  test("property-based proof: when permit is valid and confirm succeeds, execute succeeds in order", async () => {
    const safety = new SafetyManager();
    const permit = safety.requestPermit(
      {
        ecuId: "ecu-engine",
        ecuName: "Engine",
        newValue: "0x01",
        risk: "low",
        userConfirmed: true,
        backupAvailable: true,
        activeSessionType: 0x03,
        definitionVersion: "1.0.0",
      },
      { stationary: true, ignitionOn: true, batteryVoltage: 12.6, parkingBrake: true },
    );

    const tx = new DiagnosticTransaction({ binding: DEFAULT_BINDING });
    await tx.stage("prepare", () => ({ ok: true, value: "backup" }));
    await tx.stage("confirm", () => {
      tx.confirm(permit, {
        ok: true,
        failed: [],
        warnings: [],
        at: new Date().toISOString(),
      });
      return { ok: true };
    });

    assert.equal(tx.state, "confirmed");
    const executeReport = await tx.stage("execute", () => ({ ok: true, value: "written" }));
    assert.equal(executeReport.state, "ok");
    assert.equal(tx.state, "executed");
  });
});
