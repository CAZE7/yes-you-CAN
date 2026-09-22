/**
 * The fault-memory service (target architecture §14/§32 Phase 2).
 *
 * Its own module because it is the one service with a rule the others do not have:
 * the read path may not write, and what a scan could *not* read is part of its
 * answer. Both rules are the subject of ADR 0049, and a 260-line service that carries
 * them deserves to be read on its own — `services.ts` had grown past the reviewable
 * size the hygiene gate asks for, and this was the seam that was already there.
 *
 * The public API is unchanged: `@vdp/runtime` exports `DtcService` exactly as before
 * (ADR 0014), now from this module. Deliberately no re-export from `services.ts` —
 * that would make the two modules import each other, and a cycle kept alive only by
 * hoisted function declarations is a defect waiting for the next refactor.
 */

import type {
  ClearDtcResult,
  DiagnosticEngine,
  EcuHandle,
  WriteBinding,
  WriteOperationResult,
  WritePort,
} from "@vdp/core";
import { clearableEcuOf, precheckDtcClear, runDtcClear } from "@vdp/core";
import type {
  ClearDtcOutcome,
  DtcClearPrecheckInfo,
  DtcInfo,
  EventBus,
  FreezeFrameInfo,
  IdGenerator,
  UnreadEcuInfo,
  VehicleStateReading,
} from "@vdp/domain";
import { policyForWriteOperation } from "@vdp/domain";
import type { Logger } from "@vdp/shared";
import { messageOf } from "@vdp/shared";
import {
  deniedClearOutcome,
  toClearDtcOutcome,
  toDtcInfo,
  toFreezeFrameInfo,
  toUnreadEcuInfo,
  toWriteStageInfo,
} from "./mappers.js";
import type { EcuService } from "./services.js";
import { unknownEcu } from "./services.js";

/**
 * Fault memory: scan (all or one ECU) and clear.
 *
 * Clearing goes through the {@link WritePort} (master backlog P0 #3): this
 * service decides *when* a write is offered and what the domain event trail
 * says about it, while preconditions, permit, stages and audit stay where they
 * belong — in the write path. The read methods here cannot write: the scan path
 * hands out fault memory, not a way to erase it.
 */
export class DtcService {
  private lastScan: DtcInfo[] = [];
  private lastUnread: UnreadEcuInfo[] = [];

  constructor(
    private readonly engine: DiagnosticEngine,
    private readonly ecus: EcuService,
    private readonly writes: WritePort,
    private readonly events: EventBus,
    private readonly log: Logger,
    private readonly ids: IdGenerator,
  ) {}

  /** Read model: the DTCs of the most recent scan. */
  get lastScanResult(): readonly DtcInfo[] {
    return this.lastScan;
  }

  /**
   * Read model: the modules the most recent full scan could not read (ADR 0049).
   *
   * Empty when every module answered. It belongs next to {@link lastScanResult}
   * and not inside it: the codes answer "what is stored", this answers "over which
   * modules that statement was made" — and an empty code list is only the first
   * half of the truth about a bus where nobody answered.
   */
  get lastScanGaps(): readonly UnreadEcuInfo[] {
    return this.lastUnread;
  }

  /**
   * Scan every reachable ECU (no `ecuId`) or exactly one. A full scan
   * replaces the read model; a single-ECU scan updates that ECU's entries.
   */
  async scan(ecuId?: string, statusMask?: number): Promise<DtcInfo[]> {
    const session = this.engine.vehicleSession;
    if (!session) throw new Error("no session — call vehicle.connect() first");
    const mask = statusMask ?? 0xff;

    if (ecuId === undefined) {
      const { scanned, unread } = await this.engine.scanDtcs(mask);
      const infos = scanned.flatMap((result) => result.dtcs.map(toDtcInfo));
      this.lastScan = infos;
      this.lastUnread = unread.map(toUnreadEcuInfo);
      this.events.publish("dtcs-read", {
        sessionId: session.id,
        ecuCount: scanned.length,
        dtcCount: infos.length,
        unreadCount: this.lastUnread.length,
      });
      return infos;
    }

    const handle = this.ecus.resolveHandle(ecuId);
    if (!handle) throw unknownEcu(ecuId);
    const { dtcs } = await this.engine.scanEcu(handle.discovered.rxId, mask);
    const infos = dtcs.map(toDtcInfo);
    const targetId = handle.session.record.id;
    this.lastScan = [...this.lastScan.filter((dtc) => dtc.ecuId !== targetId), ...infos];
    // Reaching the module at all retires its gap: a scan that answers is proof the
    // earlier silence was not a permanent property of the car (ADR 0049).
    this.lastUnread = this.lastUnread.filter((entry) => entry.ecuId !== targetId);
    this.events.publish("dtcs-read", {
      sessionId: session.id,
      ecuId: targetId,
      ecuCount: 1,
      dtcCount: infos.length,
      unreadCount: 0,
    });
    return infos;
  }

  /**
   * Read one documented freeze frame of one fault code (AGENTS 20 "Snapshot").
   *
   * The decoded values travel together with their raw bytes: a record whose
   * layout no definition documents stays visible as evidence. Throws when the
   * ECU has no snapshot for the code — callers surface that as "not available".
   */
  async freezeFrame(ecuId: string, code: string, recordNumber = 0xff): Promise<FreezeFrameInfo> {
    if (!this.engine.vehicleSession) throw new Error("no session — call vehicle.connect() first");
    const handle = this.ecus.resolveHandle(ecuId);
    if (!handle) throw unknownEcu(ecuId);
    const frame = await this.engine.readDtcSnapshot(handle.discovered.rxId, code, recordNumber);
    if (!frame) {
      throw new Error(`ECU ${handle.session.record.name} has no freeze frame for ${code}`);
    }
    return toFreezeFrameInfo(frame);
  }

  /**
   * What the safety chain still requires before a clear is permitted
   * (AGENTS 26). Read-only: evaluates with `userConfirmed: false`, so the
   * list contains everything that still has to happen — including the
   * confirmation itself. Nothing is written and no permit is issued (§15).
   */
  precheckClear(ecuId: string, vehicleState: VehicleStateReading): DtcClearPrecheckInfo {
    const handle = this.ecus.resolveHandle(ecuId);
    if (!handle) throw unknownEcu(ecuId);
    const checks = precheckDtcClear(
      this.writes,
      { target: clearableEcuOf(handle), userConfirmed: false },
      this.bindingOf(handle, vehicleState),
      { userConfirmed: false },
    );
    return {
      ecuId: handle.session.record.id,
      ecuName: handle.session.record.name,
      ok: checks.ok,
      failed: [...checks.failed],
      unproven: [...checks.unproven],
      warnings: [...checks.warnings],
    };
  }

  /**
   * Clear one ECU's fault memory.
   *
   * The safety chain is not re-implemented here: the {@link WritePort} evaluates
   * the preconditions, issues the permit, runs the stages and keeps the audit
   * trail (AGENTS 25/26; master backlog P0 #3/#4). This method decides what the
   * domain event trail says about it and maps the result to the domain shape —
   * including the stages, so a refusal can be explained instead of asserted.
   */
  async clear(
    ecuId: string,
    input: {
      userConfirmed: boolean;
      vehicleState: VehicleStateReading;
      definitionVersion?: string;
    },
  ): Promise<ClearDtcOutcome> {
    const session = this.engine.vehicleSession;
    if (!session) throw new Error("no session — call vehicle.connect() first");
    const handle = this.ecus.resolveHandle(ecuId);
    if (!handle) throw unknownEcu(ecuId);
    const record = handle.session.record;
    const definitionVersion = input.definitionVersion ?? this.engine.activePackage?.version;

    const actionId = this.ids.next("act");
    const policy = policyForWriteOperation("clear-dtc");
    this.events.publish("safety-approval-requested", {
      actionId,
      operation: "clear-dtc",
      risk: policy.risk,
      ecuId: record.id,
    });

    let result: WriteOperationResult<ClearDtcResult>;
    try {
      result = await runDtcClear(
        this.writes,
        {
          target: clearableEcuOf(handle),
          userConfirmed: input.userConfirmed,
          recordSnapshot: (records, label) => {
            session.addDtcSnapshot([...records], label);
          },
          recordAction: (action) => {
            session.recordAction(action);
          },
        },
        {
          ecuId: record.id,
          ecuName: record.name,
          sessionId: session.id,
          sessionType: record.sessionType,
          ...(definitionVersion !== undefined ? { definitionVersion } : {}),
          vehicleState: input.vehicleState,
        },
      );
    } catch (error) {
      // Unknown kind or a programming error in the port — a write that cannot
      // even be attempted must still leave a trail (AGENTS 25).
      const message = messageOf(error);
      this.events.publish("action-executed", {
        actionId,
        operation: "clear-dtc",
        ecuId: record.id,
        ok: false,
        detail: message,
      });
      this.events.publish("diagnostic-error", {
        sessionId: session.id,
        ecuId: record.id,
        phase: "dtc.clear",
        message,
      });
      throw error;
    }

    const cleared = result.value;
    if (!result.ok || !cleared) {
      this.events.publish("safety-approval-denied", {
        actionId,
        ecuId: record.id,
        reasons: [...result.reasons],
      });
      this.log.warn("DTC clear not executed", { ecu: record.name, reasons: result.reasons });
      this.events.publish("action-executed", {
        actionId,
        operation: "clear-dtc",
        ecuId: record.id,
        ok: false,
        ...(result.reasons[0] !== undefined ? { detail: result.reasons[0] } : {}),
      });
      return {
        ...deniedClearOutcome(record.id, record.name, result.reasons),
        stages: result.stages.map(toWriteStageInfo),
        transactionId: result.transaction.id,
      };
    }

    const outcome = toClearDtcOutcome(cleared, [...result.warnings]);
    this.events.publish("safety-approval-granted", {
      actionId,
      permitId: cleared.permit.id,
      ecuId: record.id,
    });
    this.events.publish("dtcs-cleared", {
      sessionId: session.id,
      ecuId: record.id,
      clearedCount: cleared.comparison.removed.length,
      remainingCount: cleared.after.length,
      verified: cleared.verified,
    });
    this.events.publish("action-executed", {
      actionId,
      operation: "clear-dtc",
      ecuId: record.id,
      ok: true,
      ...(cleared.verified ? {} : { detail: "verification re-read found remaining codes" }),
    });
    this.log.info("DTC clear finished", {
      ecu: record.name,
      cleared: cleared.cleared,
      verified: cleared.verified,
    });
    return {
      ...outcome,
      actionId,
      stages: result.stages.map(toWriteStageInfo),
      transactionId: result.transaction.id,
    };
  }

  /** Binding a write runs under: the ECU record plus the session reference. */
  private bindingOf(handle: EcuHandle, vehicleState: VehicleStateReading): WriteBinding {
    const session = this.engine.vehicleSession;
    const version = this.engine.activePackage?.version;
    return {
      ecuId: handle.session.record.id,
      ecuName: handle.session.record.name,
      ...(session ? { sessionId: session.id } : {}),
      sessionType: handle.session.record.sessionType,
      ...(version !== undefined ? { definitionVersion: version } : {}),
      vehicleState,
    };
  }
}
