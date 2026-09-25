/**
 * Safety layer (AGENTS 26).
 *
 * Every write operation goes through the SafetyManager. It is deliberately dumb
 * and conservative: preconditions must be *checked*, not assumed, and a failed
 * precondition aborts the operation instead of degrading it.
 *
 * **Missing evidence is a failure, not a warning** (master backlog P0 #5). A
 * precondition that cannot be proven — an unreported battery voltage, an ECU
 * type nobody read, a network state nobody asked for — is *blocked*, and it is
 * named as `unproven` so the caller can tell "the vehicle violates this" from
 * "nobody looked". The default used to be the opposite: an unverifiable
 * precondition was skipped (or warned about) and the write went ahead with an
 * assumption. This module never assumes.
 *
 * This module never performs the write itself — it produces a permit that the
 * caller (coding framework, AGENTS 25) has to present. That keeps the write path
 * auditable in one place.
 */

import { createId, createLogger, type Logger, nowIso, SafetyViolationError } from "@vdp/shared";

export interface VehicleState {
  /** Vehicle standing still. */
  stationary: boolean;
  /** Battery voltage in volts. */
  batteryVoltage?: number;
  engineRunning?: boolean;
  /** Ignition on. */
  ignitionOn?: boolean;
  /** Selected transmission position, e.g. "park". */
  gearPosition?: string;
  /** Parking brake engaged. */
  parkingBrake?: boolean;
}

export interface NetworkPreconditions {
  /** Required once DoIP is used productively (AGENTS 8/26). */
  tlsActive?: boolean;
  routingActivationOk?: boolean;
  unauthorizedDevicesInSegment?: boolean;
}

/** Risk of a write operation — the vocabulary the safety chain reasons about. */
export type RiskLevel = "low" | "medium" | "high";

export interface WriteRequestContext {
  ecuId: string;
  ecuName: string;
  /** ECU type the definition expects, if the definition declares one. */
  expectedEcuType?: string;
  actualEcuType?: string;
  expectedSoftwareVariant?: string;
  actualSoftwareVariant?: string;
  definitionVersion?: string;
  /** Current value before the change (AGENTS 25 audit log). */
  previousValue?: string;
  newValue: string;
  /** Risk classification drives the confirmation requirements. */
  risk: RiskLevel;
  /** Explicit user confirmation token from the UI (AGENTS 25). */
  userConfirmed: boolean;
  /** Backup must exist before a write is allowed (AGENTS 25/26). */
  backupAvailable: boolean;
  /** Session must be a non-default diagnostic session. */
  activeSessionType: number;
  network?: NetworkPreconditions;
}

export interface SafetyCheckResult {
  ok: boolean;
  /** Every blocking reason — violated preconditions *and* unproven ones. */
  failed: string[];
  /**
   * The subset of `failed` that is not a proven violation but a missing proof.
   * Kept separate so a UI can say "spannung unbekannt, bitte messen" instead of
   * "spannung zu niedrig" (AGENTS 26, P0 #5).
   */
  unproven: string[];
  warnings: string[];
}

export interface WritePermit {
  id: string;
  issuedAt: string;
  ecuId: string;
  risk: RiskLevel;
  checks: SafetyCheckResult;
  /** Expires so a stale permit cannot be replayed much later. */
  expiresAt: string;
}

export interface SafetyManagerOptions {
  /** Minimum battery voltage for writes. */
  minBatteryVoltage?: number;
  /** Permit lifetime in ms. */
  permitTtlMs?: number;
  /**
   * Time source for permit issuance and expiry checks. Defaults to the wall
   * clock; tests and the write port inject a fake clock so permit expiry is
   * deterministic instead of a Date.now() mock or a real wait (ADR 0019: no
   * test may wait for the wall clock).
   */
  now?: () => number;
  logger?: Logger;
}

export const DEFAULT_MIN_BATTERY_VOLTAGE = 12.0;

export class SafetyManager {
  private readonly log: Logger;
  private readonly minBatteryVoltage: number;
  private readonly permitTtlMs: number;
  private readonly now: () => number;
  private readonly auditLog: Array<{
    timestamp: string;
    action: string;
    ecuId: string;
    detail: string;
  }> = [];

  constructor(options: SafetyManagerOptions = {}) {
    this.log = (options.logger ?? createLogger("safety", { level: "INFO" })).child("safety");
    this.minBatteryVoltage = options.minBatteryVoltage ?? DEFAULT_MIN_BATTERY_VOLTAGE;
    this.permitTtlMs = options.permitTtlMs ?? 60_000;
    this.now = options.now ?? Date.now;
  }

  get audit(): ReadonlyArray<{ timestamp: string; action: string; ecuId: string; detail: string }> {
    return this.auditLog;
  }

  /**
   * Evaluate preconditions without issuing a permit (UI pre-check).
   *
   * Three outcomes per precondition: proven (nothing to report), violated
   * (`failed`) or unproven (`unproven`, which is *also* a failure). Only
   * genuine cautions stay in `warnings` — an option that is allowed but not
   * recommended.
   */
  evaluate(context: WriteRequestContext, state: VehicleState): SafetyCheckResult {
    const failed: string[] = [];
    const unproven: string[] = [];
    const warnings: string[] = [];
    const needsBrake = context.risk !== "low";

    /** No evidence: the precondition may hold, but nobody showed it. Blocks. */
    const notProven = (reason: string): void => {
      unproven.push(reason);
      failed.push(reason);
    };

    if (state.stationary === undefined) {
      notProven("vehicle state unknown — 'stationary' was never reported");
    } else if (!state.stationary) {
      failed.push("vehicle is not stationary");
    }

    if (state.batteryVoltage === undefined) {
      notProven("battery voltage unknown — cannot prove the supply is stable");
    } else if (state.batteryVoltage < this.minBatteryVoltage) {
      failed.push(
        `battery voltage ${state.batteryVoltage.toFixed(2)} V is below the required ${this.minBatteryVoltage.toFixed(2)} V`,
      );
    }

    if (state.ignitionOn === undefined) {
      notProven("ignition state unknown — cannot prove the ignition is on");
    } else if (!state.ignitionOn) {
      failed.push("ignition is off");
    }

    if (needsBrake) {
      if (state.parkingBrake === undefined) {
        notProven("parking brake state unknown — cannot prove the vehicle is held");
      } else if (!state.parkingBrake) {
        failed.push("parking brake not engaged");
      }
    }

    if (context.expectedEcuType !== undefined && context.actualEcuType === undefined) {
      notProven(
        `ECU type was never read — cannot prove it matches the definition (expected ${context.expectedEcuType})`,
      );
    } else if (
      context.expectedEcuType !== undefined &&
      context.actualEcuType !== undefined &&
      context.expectedEcuType !== context.actualEcuType
    ) {
      failed.push(
        `ECU type mismatch: expected ${context.expectedEcuType}, found ${context.actualEcuType}`,
      );
    }

    if (
      context.expectedSoftwareVariant !== undefined &&
      context.actualSoftwareVariant === undefined
    ) {
      notProven(
        `software variant was never read — cannot prove it matches the definition (expected ${context.expectedSoftwareVariant})`,
      );
    } else if (
      context.expectedSoftwareVariant !== undefined &&
      context.actualSoftwareVariant !== undefined &&
      context.expectedSoftwareVariant !== context.actualSoftwareVariant
    ) {
      failed.push(
        `software variant mismatch: expected ${context.expectedSoftwareVariant}, found ${context.actualSoftwareVariant}`,
      );
    }

    if (!context.definitionVersion)
      failed.push("no definition version — cannot verify the write is defined for this ECU");
    if (!context.backupAvailable) failed.push("no backup available — rollback would be impossible");
    if (!context.userConfirmed) failed.push("user confirmation missing");
    if (context.activeSessionType === undefined) {
      notProven("diagnostic session unknown — cannot prove the write runs in a writable session");
    } else if (context.activeSessionType === 0x01) {
      failed.push("write attempted in the default diagnostic session");
    }
    if (context.risk === "high")
      warnings.push("high risk operation — consider a workshop-grade power supply");

    if (context.network) {
      // Once the network preconditions are in play (DoIP), an unasked question
      // is as blocking as a wrong answer (AGENTS 8/26).
      if (context.network.tlsActive === undefined) {
        notProven("DoIP TLS state unknown — cannot prove the transport is encrypted");
      } else if (!context.network.tlsActive) {
        failed.push("DoIP transport is not using TLS");
      }
      if (context.network.routingActivationOk === undefined) {
        notProven("DoIP routing activation state unknown — cannot prove the route is established");
      } else if (!context.network.routingActivationOk) {
        failed.push("DoIP routing activation failed");
      }
      if (context.network.unauthorizedDevicesInSegment === true) {
        failed.push("unauthorized devices detected in the diagnostic network segment");
      }
    }

    const result: SafetyCheckResult = { ok: failed.length === 0, failed, unproven, warnings };
    this.log.debug("safety evaluation", {
      ecu: context.ecuId,
      risk: context.risk,
      ok: result.ok,
      failed,
      unproven,
      warnings,
    });
    return result;
  }

  /**
   * Evaluate and, if everything passes, issue a permit.
   * Throws SafetyViolationError otherwise — callers must not swallow it.
   */
  requestPermit(context: WriteRequestContext, state: VehicleState): WritePermit {
    const checks = this.evaluate(context, state);
    if (!checks.ok) {
      const detail = [
        ...checks.failed,
        ...(checks.unproven.length > 0
          ? [`(${checks.unproven.length} of ${checks.failed.length} reasons are missing evidence)`]
          : []),
      ].join("; ");
      this.recordAudit("permit-denied", context.ecuId, detail);
      throw new SafetyViolationError(`write to ${context.ecuName} refused`, checks.failed, {
        ecuId: context.ecuId,
        risk: context.risk,
      });
    }
    const issuedAt = this.now();
    const permit: WritePermit = {
      id: createId("permit"),
      issuedAt: new Date(issuedAt).toISOString(),
      ecuId: context.ecuId,
      risk: context.risk,
      checks,
      expiresAt: new Date(issuedAt + this.permitTtlMs).toISOString(),
    };
    this.recordAudit("permit-issued", context.ecuId, `risk=${context.risk} permit=${permit.id}`);
    this.log.info("write permit issued", {
      ecu: context.ecuName,
      permit: permit.id,
      risk: context.risk,
    });
    return permit;
  }

  /** Verify a permit is still valid for this ECU (checked again at write time). */
  verifyPermit(permit: WritePermit, ecuId: string): void {
    if (permit.ecuId !== ecuId)
      throw new SafetyViolationError("permit was issued for a different ECU", ["ecu mismatch"], {
        permit: permit.id,
      });
    if (Date.parse(permit.expiresAt) < this.now())
      throw new SafetyViolationError("write permit expired", ["permit expired"], {
        permit: permit.id,
      });
  }

  recordAudit(action: string, ecuId: string, detail: string): void {
    this.auditLog.push({ timestamp: nowIso(this.now), action, ecuId, detail });
    this.log.info("audit", { action, ecuId, detail });
  }

  /** Record the outcome of a write, including rollback availability (AGENTS 25). */
  recordResult(
    permit: WritePermit,
    result: "success" | "failed" | "rolled-back",
    detail?: string,
  ): void {
    this.recordAudit(`write-${result}`, permit.ecuId, detail ?? permit.id);
  }
}
