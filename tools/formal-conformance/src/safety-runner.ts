/**
 * Drives the production safety chain through one conformance vector.
 *
 * Three families, in increasing closeness to the machine:
 *
 * - **precheck** — `SafetyManager.evaluate` directly: the rule table, as data.
 * - **flow** — `WritePort.run` with a scripted stub operation: the whole
 *   staged flow, so permit, expiry, rollback and audit are the production
 *   ones and the vector sees only outcomes.
 * - **stages** — `DiagnosticTransaction.stage`: the order table itself
 *   (out-of-order refused, fail-closed abort, terminal stickiness).
 *
 * The stub operation is the seam the vectors inject into: `prepare` captures a
 * backup (or fails), `execute` re-checks the permit — the production pattern
 * `dtc-clear` uses — records whether the write reached the bus, and `verify`
 * compares the read-back. What the stub cannot decide, the vectors don't ask:
 * the result is built from the real objects' answers.
 */

import {
  DiagnosticTransaction,
  SafetyManager,
  type StageOutcome,
  type WriteOperation,
  type WritePermit,
  WritePort,
  type WriteRequestContext,
} from "@vdp/core";
import { type Logger, createLogger } from "@vdp/shared";
import type { SafetyState } from "./canonical.js";
import type {
  ParsedSafetyVector,
  SafetyContextInput,
  SafetyFlowVector,
  SafetyPrecheckVector,
  SafetyStagesVector,
  SafetyVehicleInput,
} from "./vectors.js";

const QUIET_LOGGER: Logger = createLogger("formal-safety", { level: "ERROR" });

const ECU_ID = "ecu-conformance";
const ECU_NAME = "Conformance ECU";

function contextOf(input: SafetyContextInput, sessionType: number): WriteRequestContext {
  return {
    ecuId: ECU_ID,
    ecuName: ECU_NAME,
    risk: input.risk,
    userConfirmed: input.userConfirmed,
    backupAvailable: input.backupAvailable,
    activeSessionType: sessionType,
    newValue: "1",
    previousValue: "0",
    ...(input.definitionVersion !== null ? { definitionVersion: input.definitionVersion } : {}),
    ...(input.expectedEcuType !== null ? { expectedEcuType: input.expectedEcuType } : {}),
    ...(input.actualEcuType !== null ? { actualEcuType: input.actualEcuType } : {}),
    ...(input.expectedSoftwareVariant !== null
      ? { expectedSoftwareVariant: input.expectedSoftwareVariant }
      : {}),
    ...(input.actualSoftwareVariant !== null
      ? { actualSoftwareVariant: input.actualSoftwareVariant }
      : {}),
    ...(input.networkTls !== null || input.networkRouting !== null || input.networkUnauthorized
      ? {
          network: {
            ...(input.networkTls !== null ? { tlsActive: input.networkTls } : {}),
            ...(input.networkRouting !== null ? { routingActivationOk: input.networkRouting } : {}),
            unauthorizedDevicesInSegment: input.networkUnauthorized,
          },
        }
      : {}),
  };
}

function vehicleOf(input: SafetyVehicleInput) {
  return {
    stationary: input.stationary,
    ...(input.ignitionOn !== null ? { ignitionOn: input.ignitionOn } : {}),
    ...(input.batteryVoltage !== null ? { batteryVoltage: input.batteryVoltage } : {}),
    ...(input.parkingBrake !== null ? { parkingBrake: input.parkingBrake } : {}),
  };
}

function managerOf(vector: SafetyPrecheckVector | SafetyFlowVector): SafetyManager {
  const ttlMs = vector.family === "flow" && vector.permitExpiry === "expired" ? -1 : 60_000;
  return new SafetyManager({
    ...(vector.minBatteryVoltage !== null ? { minBatteryVoltage: vector.minBatteryVoltage } : {}),
    permitTtlMs: ttlMs,
    logger: QUIET_LOGGER,
  });
}

function runPrecheck(vector: SafetyPrecheckVector): ParsedSafetyVector["expect"] {
  const safety = managerOf(vector);
  const checks = safety.evaluate(
    contextOf(vector.context, vector.context.sessionType ?? 0x03),
    vehicleOf(vector.vehicle),
  );
  return {
    kind: "precheck",
    granted: checks.ok,
    failed: checks.failed.length,
    unproven: checks.unproven.length,
  };
}

function permitStub(): WritePermit {
  return {
    id: "permit-conformance",
    issuedAt: "1970-01-01T00:00:00.000Z",
    ecuId: ECU_ID,
    risk: "medium",
    checks: { ok: true, failed: [], unproven: [], warnings: [] },
    expiresAt: "2999-01-01T00:00:00.000Z",
  };
}

async function runStages(vector: SafetyStagesVector): Promise<ParsedSafetyVector["expect"]> {
  const tx = new DiagnosticTransaction({
    binding: {
      kind: "conformance-stub",
      risk: "medium",
      ecuId: ECU_ID,
      ecuName: ECU_NAME,
      sessionType: 0x03,
      definitionVersion: "1.0.0",
    },
    clock: () => 0,
  });
  const stageOk: boolean[] = [];
  for (const op of vector.ops) {
    if (op.grant) {
      tx.confirm(permitStub(), {
        ok: true,
        failed: [],
        warnings: [],
        at: "1970-01-01T00:00:00.000Z",
      });
    }
    const report = await tx.stage(op.op, () =>
      op.bodyOk ? { ok: true } : { ok: false, reasons: [`${op.op} body reported a failure`] },
    );
    stageOk.push(report.state === "ok");
  }
  return { kind: "stages", state: tx.state as SafetyState, stageOk };
}

async function runFlow(vector: SafetyFlowVector): Promise<ParsedSafetyVector["expect"]> {
  const safety = managerOf(vector);
  let writeReached = false;
  const written = [0x01, 0x02, 0x03];
  const port = new WritePort({ safety, logger: QUIET_LOGGER });
  const operation: WriteOperation<undefined, { backup: string }, number[]> = {
    kind: "conformance-stub",
    title: "Conformance write",
    risk: vector.context.risk,
    async prepare(): Promise<StageOutcome<{ backup: string }>> {
      if (!vector.script.prepareOk) {
        return { ok: false, reasons: ["backup read failed — the vehicle did not answer the read"] };
      }
      return { ok: true, value: { backup: "0" } };
    },
    describe(_transaction, _input, _prepared, sessionType) {
      return { context: contextOf(vector.context, sessionType) };
    },
    async execute(_transaction, _input, _prepared, permit): Promise<StageOutcome<number[]>> {
      // The production pattern (dtc-clear, coding, adaptation): the write
      // re-checks its permit, so an expired one never reaches the bus.
      safety.verifyPermit(permit, ECU_ID);
      if (vector.script.writeBeforeFail) writeReached = true;
      if (!vector.script.executeOk) throw new Error("the ECU refused the write request");
      writeReached = true;
      return { ok: true, value: written };
    },
    ...(vector.script.verify === "absent"
      ? {}
      : {
          verify: async (): Promise<StageOutcome<number[]>> =>
            vector.script.verify === "match"
              ? { ok: true, value: written }
              : { ok: false, reasons: ["read-back differs from the written value"] },
        }),
    ...(vector.script.rollback === "absent"
      ? {
          rollbackUnavailable: "conformance stub: written values have no undo besides re-reading",
        }
      : {
          rollback: async (): Promise<StageOutcome<unknown>> =>
            vector.script.rollback === "ok"
              ? { ok: true, value: true }
              : { ok: false, reasons: ["the ECU did not accept the old value back"] },
        }),
  };
  port.register(operation);
  const result = await port.run("conformance-stub", undefined, {
    ecuId: ECU_ID,
    ecuName: ECU_NAME,
    sessionType: vector.bindingSessionType,
    vehicleState: vehicleOf(vector.vehicle),
  });
  const state = result.transaction.state as SafetyState;
  return {
    kind: "flow",
    ok: result.ok,
    state,
    writeReached,
    verified: state === "verified",
    rolledBack: state === "rolled-back",
    failed: result.reasons.length,
    unproven: result.unproven?.length ?? 0,
  };
}

/**
 * Run one parsed safety vector against the production chain. The precheck
 * family is pure; flow and stages go through the async transaction machinery.
 */
export async function runSafetyVector(
  vector: ParsedSafetyVector,
): Promise<ParsedSafetyVector["expect"]> {
  switch (vector.vector.family) {
    case "precheck":
      return runPrecheck(vector.vector);
    case "flow":
      return runFlow(vector.vector);
    case "stages":
      return runStages(vector.vector);
  }
}
