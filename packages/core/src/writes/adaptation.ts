/**
 * ECU Parameter Adaptation operation (AGENTS 25, 26; master backlog P2 #32).
 *
 * Adaptation modifies calibrated parameters inside an ECU (e.g. idle speed
 * target, throttle valve basic setting, steering angle sensor zero-point,
 * fuel trim trim offsets).
 *
 * Unlike coding (which flips configuration bits), adaptation adjusts operational
 * setpoints within strictly bounded engineering ranges (e.g. idle_speed = 600..900 RPM).
 *
 * The full transactional safety chain is enforced:
 *
 * 1. Prepare: Verify target value is inside allowed range; read and backup previous setting.
 * 2. Preview: Show original value vs requested value.
 * 3. Precheck: Verify vehicle safety preconditions (engine stationary or running as required,
 *    battery voltage adequate, parking brake engaged).
 * 4. Permit: Request permit from SafetyManager.
 * 5. Confirm: Require operator confirmation.
 * 6. Write: Write parameter to ECU.
 * 7. Readback: Read back new value.
 * 8. Verify: Assert readback matches requested value within tolerance.
 * 9. Rollback: If verification fails, restore previous parameter from backup.
 * 10. Audit: Record permit, channel, before/after values, and verified status.
 */

import { createLogger, type Logger, messageOf } from "@vdp/shared";
import type { RiskLevel, WritePermit, WriteRequestContext } from "../safety/safety-manager.js";
import type { WriteBinding, WriteOperation, WriteOperationResult, WritePort } from "./port.js";

/** An ECU that supports parameter adaptation. */
export interface AdaptationTargetEcu {
  id: string;
  name: string;
  sessionType?: number;
  readAdaptation(channelDid: number): Promise<number>;
  writeAdaptation(channelDid: number, value: number): Promise<void>;
  prepareWrite?(sessionType?: number): Promise<{ sessionType: number; switched: boolean }>;
}

export interface AdaptationRange {
  min: number;
  max: number;
  unit?: string;
}

export interface AdaptationInput {
  target: AdaptationTargetEcu;
  channelDid: number;
  channelName: string;
  requestedValue: number;
  allowedRange: AdaptationRange;
  userConfirmed: boolean;
  tolerance?: number;
  recordAction?: (action: { kind: string; payload: unknown }) => void;
}

export interface AdaptationPrepared {
  target: AdaptationTargetEcu;
  channelDid: number;
  channelName: string;
  originalValue: number;
  requestedValue: number;
  allowedRange: AdaptationRange;
  tolerance: number;
  sessionType: number;
}

export interface AdaptationResult {
  channelDid: number;
  channelName: string;
  before: number;
  after: number;
  unit?: string;
  verified: boolean;
  permit: WritePermit;
}

export function createAdaptationOperation(
  options: { logger?: Logger } = {},
): WriteOperation<AdaptationInput, AdaptationPrepared, AdaptationResult> {
  const log = options.logger ?? createLogger("writes", { level: "INFO" });

  return {
    kind: "adaptation",
    title: "ECU Parameter Adaptation",
    risk: "medium" as RiskLevel,

    async prepare(_transaction, input) {
      const { target, channelDid, channelName, requestedValue, allowedRange } = input;

      // Range validation: fail closed before touching the ECU
      if (requestedValue < allowedRange.min || requestedValue > allowedRange.max) {
        return {
          ok: false,
          reasons: [
            `requested value ${requestedValue} for ${channelName} is outside permitted range ${allowedRange.min}..${allowedRange.max}${allowedRange.unit ? ` ${allowedRange.unit}` : ""}`,
          ],
        };
      }

      let sessionType = target.sessionType ?? 0x01;
      if (target.prepareWrite) {
        try {
          const switched = await target.prepareWrite(0x03);
          sessionType = switched.sessionType;
        } catch (error) {
          return {
            ok: false,
            reasons: [`ECU session switch for adaptation failed: ${messageOf(error)}`],
          };
        }
      }

      let originalValue: number;
      try {
        originalValue = await target.readAdaptation(channelDid);
      } catch (error) {
        return {
          ok: false,
          reasons: [
            `failed to read current adaptation backup for ${channelName} (DID 0x${channelDid.toString(16)}): ${messageOf(error)}`,
          ],
        };
      }

      log.info("adaptation backup captured", {
        ecu: target.id,
        channel: channelName,
        did: `0x${channelDid.toString(16)}`,
        current: originalValue,
        requested: requestedValue,
      });

      return {
        ok: true,
        value: {
          target,
          channelDid,
          channelName,
          originalValue,
          requestedValue,
          allowedRange,
          tolerance: input.tolerance ?? 0.001,
          sessionType,
        },
      };
    },

    describe(transaction, input, prepared, sessionType) {
      const definitionVersion = transaction.snapshot.binding.definitionVersion;
      const context: WriteRequestContext = {
        ecuId: input.target?.id ?? transaction.snapshot.binding.ecuId,
        ecuName: input.target?.name ?? transaction.snapshot.binding.ecuName,
        newValue: `${input.channelName ?? "parameter"}=${input.requestedValue ?? 0}`,
        risk: "medium",
        userConfirmed: input.userConfirmed,
        backupAvailable: prepared !== undefined,
        activeSessionType: sessionType,
        ...(definitionVersion !== undefined ? { definitionVersion } : {}),
      };
      const warnings: string[] = [];
      if (sessionType === 0x01) {
        warnings.push("adaptation write attempted in default diagnostic session");
      }
      return { context, warnings };
    },

    async execute(_transaction, input, prepared, permit) {
      const { target, channelDid, channelName, requestedValue } = prepared;
      input.recordAction?.({
        kind: "adaptation-write",
        payload: {
          channelDid,
          channelName,
          value: requestedValue,
          permitId: permit.id,
        },
      });

      try {
        await target.writeAdaptation(channelDid, requestedValue);
      } catch (error) {
        return {
          ok: false,
          reasons: [`failed to write adaptation value for ${channelName}: ${messageOf(error)}`],
        };
      }

      return {
        ok: true,
        value: {
          channelDid,
          channelName,
          before: prepared.originalValue,
          after: requestedValue,
          ...(prepared.allowedRange.unit ? { unit: prepared.allowedRange.unit } : {}),
          verified: false,
          permit,
        },
      };
    },

    async verify(_transaction, _input, prepared, executed) {
      const { channelDid, channelName, requestedValue, tolerance } = prepared;
      let readBack: number;
      try {
        readBack = await prepared.target.readAdaptation(channelDid);
      } catch (error) {
        return {
          ok: false,
          reasons: [`verification readback for ${channelName} failed: ${messageOf(error)}`],
        };
      }

      const diff = Math.abs(readBack - requestedValue);
      if (diff > tolerance) {
        return {
          ok: false,
          reasons: [
            `read-back adaptation value (${readBack}) does not match requested target (${requestedValue}) within tolerance ${tolerance}`,
          ],
        };
      }

      return {
        ok: true,
        value: {
          ...executed,
          after: readBack,
          verified: true,
        },
      };
    },

    async rollback(transaction, _input, reason) {
      const prepared = transaction.value<AdaptationPrepared>("prepare");
      if (!prepared) {
        return {
          ok: false,
          reasons: ["cannot roll back adaptation: no backup was captured in prepare"],
        };
      }
      try {
        log.warn("rolling back adaptation to previous backup value", {
          channel: prepared.channelName,
          originalValue: prepared.originalValue,
          reason,
        });
        await prepared.target.writeAdaptation(prepared.channelDid, prepared.originalValue);
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          reasons: [
            `failed to roll back adaptation for ${prepared.channelName}: ${messageOf(error)}`,
          ],
        };
      }
    },

    outcomeOf(value) {
      return value.verified;
    },

    onAbort(_transaction, input, reason) {
      input.recordAction?.({
        kind: "adaptation-aborted",
        payload: { channel: input.channelName, reason },
      });
    },
  };
}

export function runAdaptation(
  port: WritePort,
  input: AdaptationInput,
  binding: WriteBinding,
): Promise<WriteOperationResult<AdaptationResult>> {
  return port.run<AdaptationInput, AdaptationPrepared, AdaptationResult>(
    "adaptation",
    input,
    binding,
  );
}
