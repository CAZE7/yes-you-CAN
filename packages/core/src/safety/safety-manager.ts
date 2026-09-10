/**
 * Safety layer (AGENTS 26).
 *
 * Every write operation goes through the SafetyManager. It is deliberately dumb
 * and conservative: preconditions must be *checked*, not assumed, and a failed
 * precondition aborts the operation instead of degrading it.
 *
 * This module never performs the write itself — it produces a permit that the
 * caller (coding framework, AGENTS 25) has to present. That keeps the write path
 * auditable in one place.
 */

import { SafetyViolationError, createId, createLogger, nowIso, type Logger } from '@vdp/shared';

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
  risk: 'low' | 'medium' | 'high';
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
  failed: string[];
  warnings: string[];
}

export interface WritePermit {
  id: string;
  issuedAt: string;
  ecuId: string;
  risk: WriteRequestContext['risk'];
  checks: SafetyCheckResult;
  /** Expires so a stale permit cannot be replayed much later. */
  expiresAt: string;
}

export interface SafetyManagerOptions {
  /** Minimum battery voltage for writes. */
  minBatteryVoltage?: number;
  /** Permit lifetime in ms. */
  permitTtlMs?: number;
  logger?: Logger;
}

export const DEFAULT_MIN_BATTERY_VOLTAGE = 12.0;

export class SafetyManager {
  private readonly log: Logger;
  private readonly minBatteryVoltage: number;
  private readonly permitTtlMs: number;
  private readonly auditLog: Array<{ timestamp: string; action: string; ecuId: string; detail: string }> = [];

  constructor(private readonly options: SafetyManagerOptions = {}) {
    this.log = (options.logger ?? createLogger('safety', { level: 'INFO' })).child('safety');
    this.minBatteryVoltage = options.minBatteryVoltage ?? DEFAULT_MIN_BATTERY_VOLTAGE;
    this.permitTtlMs = options.permitTtlMs ?? 60_000;
  }

  get audit(): ReadonlyArray<{ timestamp: string; action: string; ecuId: string; detail: string }> {
    return this.auditLog;
  }

  /** Evaluate preconditions without issuing a permit (UI pre-check). */
  evaluate(context: WriteRequestContext, state: VehicleState): SafetyCheckResult {
    const failed: string[] = [];
    const warnings: string[] = [];

    if (!state.stationary) failed.push('vehicle is not stationary');
    if (state.batteryVoltage !== undefined && state.batteryVoltage < this.minBatteryVoltage) {
      failed.push(`battery voltage ${state.batteryVoltage.toFixed(2)} V is below the required ${this.minBatteryVoltage.toFixed(2)} V`);
    }
    if (state.batteryVoltage === undefined) warnings.push('battery voltage unknown — precondition not verifiable');
    if (state.ignitionOn === false) failed.push('ignition is off');
    if (context.risk !== 'low' && !state.parkingBrake) failed.push('parking brake not engaged');
    if (context.expectedEcuType && context.actualEcuType && context.expectedEcuType !== context.actualEcuType) {
      failed.push(`ECU type mismatch: expected ${context.expectedEcuType}, found ${context.actualEcuType}`);
    }
    if (context.expectedSoftwareVariant && context.actualSoftwareVariant && context.expectedSoftwareVariant !== context.actualSoftwareVariant) {
      failed.push(`software variant mismatch: expected ${context.expectedSoftwareVariant}, found ${context.actualSoftwareVariant}`);
    }
    if (!context.definitionVersion) failed.push('no definition version — cannot verify the write is defined for this ECU');
    if (!context.backupAvailable) failed.push('no backup available — rollback would be impossible');
    if (!context.userConfirmed) failed.push('user confirmation missing');
    if (context.activeSessionType === 0x01) failed.push('write attempted in the default diagnostic session');
    if (context.risk === 'high') warnings.push('high risk operation — consider a workshop-grade power supply');

    if (context.network) {
      if (context.network.tlsActive === false) failed.push('DoIP transport is not using TLS');
      if (context.network.routingActivationOk === false) failed.push('DoIP routing activation failed');
      if (context.network.unauthorizedDevicesInSegment) failed.push('unauthorized devices detected in the diagnostic network segment');
    }

    const result: SafetyCheckResult = { ok: failed.length === 0, failed, warnings };
    this.log.debug('safety evaluation', { ecu: context.ecuId, risk: context.risk, ok: result.ok, failed, warnings });
    return result;
  }

  /**
   * Evaluate and, if everything passes, issue a permit.
   * Throws SafetyViolationError otherwise — callers must not swallow it.
   */
  requestPermit(context: WriteRequestContext, state: VehicleState): WritePermit {
    const checks = this.evaluate(context, state);
    if (!checks.ok) {
      this.recordAudit('permit-denied', context.ecuId, checks.failed.join('; '));
      throw new SafetyViolationError(`write to ${context.ecuName} refused`, checks.failed, { ecuId: context.ecuId, risk: context.risk });
    }
    const issuedAt = Date.now();
    const permit: WritePermit = {
      id: createId('permit'),
      issuedAt: new Date(issuedAt).toISOString(),
      ecuId: context.ecuId,
      risk: context.risk,
      checks,
      expiresAt: new Date(issuedAt + this.permitTtlMs).toISOString(),
    };
    this.recordAudit('permit-issued', context.ecuId, `risk=${context.risk} permit=${permit.id}`);
    this.log.info('write permit issued', { ecu: context.ecuName, permit: permit.id, risk: context.risk });
    return permit;
  }

  /** Verify a permit is still valid for this ECU (checked again at write time). */
  verifyPermit(permit: WritePermit, ecuId: string): void {
    if (permit.ecuId !== ecuId) throw new SafetyViolationError('permit was issued for a different ECU', ['ecu mismatch'], { permit: permit.id });
    if (Date.parse(permit.expiresAt) < Date.now()) throw new SafetyViolationError('write permit expired', ['permit expired'], { permit: permit.id });
  }

  recordAudit(action: string, ecuId: string, detail: string): void {
    this.auditLog.push({ timestamp: nowIso(), action, ecuId, detail });
    this.log.info('audit', { action, ecuId, detail });
  }

  /** Record the outcome of a write, including rollback availability (AGENTS 25). */
  recordResult(permit: WritePermit, result: 'success' | 'failed' | 'rolled-back', detail?: string): void {
    this.recordAudit(`write-${result}`, permit.ecuId, detail ?? permit.id);
  }
}
