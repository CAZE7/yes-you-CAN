/**
 * Clearing fault memory (AGENTS 20 "Clear DTCs mit expliziter Bestätigung",
 * AGENTS 25/26 write path).
 *
 * Clearing is the first *write* operation the platform performs, so it goes
 * through the whole safety chain instead of calling 0x14 directly:
 *
 *   validate → backup → explicit confirmation → write → verification → audit
 *
 * Two properties matter more than convenience:
 *
 * 1. **The previous state is captured first.** Without a snapshot of the fault
 *    memory there is nothing to compare the result against, and a clear that
 *    silently removed a code nobody recorded is a data loss. The snapshot is the
 *    backup, and it is stored in the session (AGENTS 25: backup, AGENTS 10).
 * 2. **Verification is a re-read, not a belief.** The result contains the codes
 *    that survived; a code that came back immediately (not cleared, or re-set by
 *    a still-present fault) is visible instead of assumed away.
 */

import type { DtcRecord } from "@vdp/protocols-uds";
import { DTC_GROUP_ALL, SESSION } from "@vdp/protocols-uds";
import { type Logger, createLogger, nowIso } from "@vdp/shared";
import type { SafetyManager, VehicleState, WritePermit } from "../safety/safety-manager.js";
import type { DtcComparison, DtcScanner, EnrichedDtc } from "./scanner.js";

/** Minimal ECU contract the service needs — keeps it unit testable without a bus. */
export interface ClearableEcu {
  id: string;
  name: string;
  /** Active diagnostic session type; a clear in the default session is refused (AGENTS 26). */
  sessionType: number;
  /**
   * Put the ECU into a session that allows writes (ISO 14229-1 §9.2).
   *
   * Optional: an ECU without it can only be written while it already is in a
   * non-default session, which is the fail-safe behaviour for implementations
   * that must not switch sessions on their own.
   */
  prepareWrite?: (sessionType?: number) => Promise<{ sessionType: number; switched: boolean }>;
  readDtcs(statusMask?: number): Promise<DtcRecord[]>;
  clearDiagnosticInformation(groupOfDtc?: number): Promise<void>;
}

export interface ClearDtcOptions {
  /** The operator's confirmation. Without it the clear is refused. */
  userConfirmed: boolean;
  /** Vehicle preconditions asserted (and recorded) by the operator or a reader. */
  vehicleState: VehicleState;
  /** Definition version the clear was validated against (AGENTS 25 audit log). */
  definitionVersion?: string;
  /** DTC group to clear; defaults to all groups (0xFFFFFF, ISO 14229-1 §11.3). */
  groupOfDtc?: number;
  /** Status mask used for the before/after reads. */
  statusMask?: number;
  /** Marks the snapshot taken as backup (AGENTS 25). */
  recordSnapshot?: (records: readonly DtcRecord[], label: string) => void;
  /** Records the action in the session (AGENTS 25 audit log). */
  recordAction?: (action: {
    kind: "clear-dtc";
    ecuId: string;
    description: string;
    result: "success" | "failed" | "aborted";
    detail?: string;
  }) => void;
}

export interface ClearDtcResult {
  cleared: boolean;
  ecuId: string;
  ecuName: string;
  /** Fault memory before the clear (also the backup). */
  before: EnrichedDtc[];
  /** Fault memory after the clear, read back from the ECU. */
  after: EnrichedDtc[];
  comparison: DtcComparison;
  /** True when the re-read confirms the codes are gone. */
  verified: boolean;
  permit: WritePermit;
  clearedAt: string;
}

export interface DtcClearServiceOptions {
  safety: SafetyManager;
  scanner: DtcScanner;
  logger?: Logger;
}

export class DtcClearService {
  private readonly log: Logger;

  constructor(private readonly options: DtcClearServiceOptions) {
    this.log = (options.logger ?? createLogger("dtc", { level: "INFO" })).child("dtc");
  }

  /**
   * Pre-check without issuing a permit, so a UI can show what is missing before
   * the operator confirms anything (AGENTS 26: preconditions).
   */
  evaluate(
    ecu: ClearableEcu,
    options: Pick<ClearDtcOptions, "userConfirmed" | "vehicleState" | "definitionVersion">,
  ): {
    ok: boolean;
    failed: string[];
    warnings: string[];
  } {
    const canSwitch = ecu.sessionType === SESSION.DEFAULT && typeof ecu.prepareWrite === "function";
    const checks = this.options.safety.evaluate(
      // The pre-check evaluates the state the write will actually run in, so a
      // pending session switch does not show up as an unmet precondition.
      this.writeContext(ecu, {
        ...options,
        sessionType: canSwitch ? SESSION.EXTENDED : ecu.sessionType,
      }),
      options.vehicleState,
    );
    const warnings = [...checks.warnings];
    if (canSwitch)
      warnings.push(
        "ECU is in the default session — an extended session is requested before the write",
      );
    return { ok: checks.ok, failed: checks.failed, warnings };
  }

  /**
   * Clear the fault memory of one ECU.
   *
   * Throws a `SafetyViolationError` when a precondition fails — the caller must
   * not be able to "retry harder" past a refused precondition (AGENTS 26).
   */
  async clear(ecu: ClearableEcu, options: ClearDtcOptions): Promise<ClearDtcResult> {
    const statusMask = options.statusMask ?? 0xff;
    const definitionVersion = options.definitionVersion ?? "unknown";

    // 1. Backup: the previous state has to exist before anything is written.
    const before = await ecu.readDtcs(statusMask);
    options.recordSnapshot?.(before, `before clear (${ecu.name})`);
    this.log.info("fault memory read for backup", { ecu: ecu.name, count: before.length });

    // 2. Session: diagnostic writes are only allowed outside the default session
    //    (ISO 14229-1 §9.2). The switch happens before the permit so the permit
    //    records the session the write really runs in; a refused switch aborts
    //    here and is never worked around (AGENTS 29/34.12).
    const sessionType = await this.prepareSession(ecu, options);

    // 3. Permit: every precondition is checked, not assumed.
    const permit = this.options.safety.requestPermit(
      this.writeContext(ecu, { ...options, definitionVersion, sessionType }),
      options.vehicleState,
    );

    const beforeEnriched = this.options.scanner.enrich(before, ecu.name, ecu.id);
    try {
      // 4. Write.
      await ecu.clearDiagnosticInformation(options.groupOfDtc ?? DTC_GROUP_ALL);

      // 5. Verification: read back instead of trusting the positive response.
      const after = await ecu.readDtcs(statusMask);
      const afterEnriched = this.options.scanner.enrich(after, ecu.name, ecu.id);
      const comparison = this.options.scanner.compare(beforeEnriched, afterEnriched);
      // "Verified" means the re-read shows the effect: no code kept its status
      // unchanged and none appeared. It deliberately does *not* require an empty
      // fault memory — a fault that is still present legitimately stays (with
      // reset status bits), and calling that a failed clear would be wrong.
      const verified = comparison.unchanged.length === 0 && comparison.added.length === 0;

      this.options.safety.recordResult(
        permit,
        "success",
        `${ecu.name}: ${comparison.removed.length} removed, ${comparison.unchanged.length} kept`,
      );
      options.recordAction?.({
        kind: "clear-dtc",
        ecuId: ecu.id,
        description: `Fehlerspeicher ${ecu.name} gelöscht${verified ? "" : " (nicht vollständig bestätigt)"}`,
        result: "success",
        detail: `${beforeEnriched.length} vorher, ${afterEnriched.length} nachher, ${comparison.unchanged.length} unverändert`,
      });
      this.log.info("fault memory cleared", {
        ecu: ecu.name,
        before: beforeEnriched.length,
        after: afterEnriched.length,
        verified,
      });
      return {
        cleared: true,
        ecuId: ecu.id,
        ecuName: ecu.name,
        before: beforeEnriched,
        after: afterEnriched,
        comparison,
        verified,
        permit,
        clearedAt: nowIso(),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.safety.recordResult(permit, "failed", message);
      options.recordAction?.({
        kind: "clear-dtc",
        ecuId: ecu.id,
        description: `Fehlerspeicher ${ecu.name} löschen fehlgeschlagen`,
        result: "failed",
        detail: message,
      });
      this.log.error("clearing fault memory failed", { ecu: ecu.name, error: message });
      throw error;
    }
  }

  /**
   * Move the ECU into a writable session when it is still in the default one.
   *
   * The failure is recorded as an aborted action before it is rethrown, because
   * "the ECU refused the session" is exactly the kind of event the audit log has
   * to contain (AGENTS 25).
   */
  private async prepareSession(
    ecu: ClearableEcu,
    options: Pick<ClearDtcOptions, "recordAction">,
  ): Promise<number> {
    if (ecu.sessionType !== SESSION.DEFAULT || !ecu.prepareWrite) return ecu.sessionType;
    try {
      const prepared = await ecu.prepareWrite();
      this.log.info("extended session active for the write", {
        ecu: ecu.name,
        session: prepared.sessionType,
      });
      return prepared.sessionType;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.recordAction?.({
        kind: "clear-dtc",
        ecuId: ecu.id,
        description: `Fehlerspeicher ${ecu.name} nicht gelöscht: Sitzung nicht umschaltbar`,
        result: "aborted",
        detail: message,
      });
      this.log.warn("session switch refused — write aborted", { ecu: ecu.name, error: message });
      throw error;
    }
  }

  /** Context handed to the SafetyManager (AGENTS 25 audit fields). */
  private writeContext(
    ecu: ClearableEcu,
    options: {
      userConfirmed: boolean;
      definitionVersion?: string;
      groupOfDtc?: number;
      sessionType?: number;
    },
  ): Parameters<SafetyManager["requestPermit"]>[0] {
    return {
      ecuId: ecu.id,
      ecuName: ecu.name,
      newValue: `clearDiagnosticInformation(group=0x${(options.groupOfDtc ?? DTC_GROUP_ALL).toString(16).toUpperCase()})`,
      previousValue: "fault memory snapshot taken before clearing",
      // Clearing fault memory is reversible in the sense that the codes return
      // when the fault is still present, but it destroys diagnostic history —
      // hence "medium" and therefore confirmation plus a backup.
      risk: "medium",
      userConfirmed: options.userConfirmed,
      backupAvailable: true,
      activeSessionType: options.sessionType ?? ecu.sessionType,
      ...(options.definitionVersion ? { definitionVersion: options.definitionVersion } : {}),
    };
  }
}
