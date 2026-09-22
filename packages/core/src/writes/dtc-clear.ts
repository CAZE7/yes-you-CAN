/**
 * Clearing fault memory as a staged write operation (AGENTS 20 "Clear DTCs mit
 * expliziter Bestätigung", AGENTS 25/26 write path; master backlog P0 #3, #4).
 *
 * This is the operation the platform actually performs; it used to live inside
 * `DtcClearService.clear()` as one method that threw on every refusal. The stages
 * are the same — and they are the reason this file exists in this shape:
 *
 *   prepare  read the fault memory (the backup) and switch the session
 *   confirm  describe the write so the safety chain can evaluate it, get a permit
 *   execute  0x14 ClearDiagnosticInformation
 *   verify   read back and compare; "verified" means the re-read shows the effect
 *   rollback unavailable on purpose
 *
 * Three decisions worth naming:
 *
 * 1. **The backup is captured before anything else.** A clear that silently
 *    removed a code nobody recorded is data loss; the snapshot is stored in the
 *    session and is the recovery path (AGENTS 25).
 * 2. **Verification is a re-read, not a belief.** `verified` is derived from the
 *    comparison — no code kept its status unchanged and none appeared. A fault
 *    that is still present legitimately stays (with reset status bits); calling
 *    that a failed clear would be wrong.
 * 3. **There is no rollback, and the operation says so.** ISO 14229-1 has no
 *    service that restores cleared fault memory. Inventing one would be a lie in
 *    the audit log; the skipped stage with that reason is the truth.
 */

import type { DtcRecord } from "@vdp/protocols-uds";
import { DTC_GROUP_ALL, SESSION } from "@vdp/protocols-uds";
import { nowIso } from "@vdp/shared";
import type { EcuHandle } from "../diagnostics/ecu-registry.js";
import type { ClearableEcu, ClearDtcResult } from "../dtc/clear.js";
import type { DtcScanner } from "../dtc/scanner.js";
import type {
  WriteBinding,
  WriteOperation,
  WriteOperationResult,
  WritePort,
  WritePrecheckResult,
} from "./port.js";
import type { StageOutcome } from "./transaction.js";

/** What the caller asks for; the vehicle state travels in the write binding. */
export interface DtcClearInput {
  target: ClearableEcu;
  userConfirmed: boolean;
  /** DTC group to clear; defaults to all groups (ISO 14229-1 §11.3). */
  groupOfDtc?: number;
  /** Status mask used for the before/after reads. */
  statusMask?: number;
  /** Stores the backup in the session before the write (AGENTS 25). */
  recordSnapshot?: (records: readonly DtcRecord[], label: string) => void;
  /** Records the attempt in the session audit log (AGENTS 25). */
  recordAction?: (action: {
    kind: "clear-dtc";
    ecuId: string;
    description: string;
    result: "success" | "failed" | "aborted";
    detail?: string;
  }) => void;
}

/** What `prepare` captured from the vehicle: the backup and the session it left. */
export interface DtcClearPrepared {
  before: readonly DtcRecord[];
  sessionType: number;
}

export interface DtcClearOperationOptions {
  scanner: DtcScanner;
}

/** The kind this operation registers under — one literal, no second list. */
export const DTC_CLEAR_KIND = "clear-dtc";

/**
 * Typed entry points for the clear operation.
 *
 * `WritePort.run` is generic over the operation (it knows no kinds); these two
 * helpers bind the types of this one, so a caller does not have to repeat three
 * type arguments — and cannot pass the wrong ones. The runtime and the tests use
 * exactly the same pair.
 */
export function runDtcClear(
  port: WritePort,
  input: DtcClearInput,
  binding: WriteBinding,
): Promise<WriteOperationResult<ClearDtcResult>> {
  return port.run<DtcClearInput, DtcClearPrepared, ClearDtcResult>(DTC_CLEAR_KIND, input, binding);
}

export function precheckDtcClear(
  port: WritePort,
  input: DtcClearInput,
  binding: WriteBinding,
  options: { userConfirmed: boolean },
): WritePrecheckResult {
  return port.precheck<DtcClearInput, DtcClearPrepared, ClearDtcResult>(
    DTC_CLEAR_KIND,
    input,
    binding,
    options,
  );
}

export function createDtcClearOperation(
  options: DtcClearOperationOptions,
): WriteOperation<DtcClearInput, DtcClearPrepared, ClearDtcResult> {
  const { scanner } = options;
  return {
    kind: DTC_CLEAR_KIND,
    title: "Fehlerspeicher löschen",
    // Clearing destroys diagnostic history: medium risk, confirmation plus a
    // backup, verification by re-read (mirrors the domain policy table).
    risk: "medium",
    outcomeOf: (value) => value.verified,
    rollbackUnavailable:
      "ISO 14229-1 kennt keinen Dienst, der eine gelöschte Fehlerspeicher-Eintragung wiederherstellt — der Snapshot vor dem Löschen ist der Rückweg (AGENTS 25)",

    async prepare(_transaction, input): Promise<StageOutcome<DtcClearPrepared>> {
      const { target } = input;
      const statusMask = input.statusMask ?? 0xff;
      // 1. Backup first: without the previous state there is nothing to compare
      //    against and nothing to fall back on.
      let before: DtcRecord[];
      try {
        before = await target.readDtcs(statusMask);
      } catch (error) {
        return { ok: false, reasons: [`Fehlerspeicher nicht lesbar: ${messageOf(error)}`] };
      }
      input.recordSnapshot?.(before, `before clear (${target.name})`);

      // 2. The session the write will run in. A refused switch aborts here —
      //    recordAction carries the reason, so the audit log knows why nothing
      //    was written (AGENTS 25).
      let sessionType = target.sessionType;
      if (sessionType === SESSION.DEFAULT && target.prepareWrite) {
        try {
          const prepared = await target.prepareWrite();
          sessionType = prepared.sessionType;
        } catch (error) {
          const detail = messageOf(error);
          input.recordAction?.({
            kind: "clear-dtc",
            ecuId: target.id,
            description: `Fehlerspeicher ${target.name} nicht gelöscht: Sitzung nicht umschaltbar`,
            result: "aborted",
            detail,
          });
          return { ok: false, reasons: [`Sitzung nicht umschaltbar: ${detail}`] };
        }
      }
      return { ok: true, value: { before, sessionType } };
    },

    describe(transaction, input, prepared, sessionType) {
      const { target } = input;
      const group = input.groupOfDtc ?? DTC_GROUP_ALL;
      const warnings: string[] = [];
      if (target.sessionType === SESSION.DEFAULT && target.prepareWrite) {
        warnings.push(
          "ECU is in the default session — an extended session is requested before the write",
        );
      }
      return {
        context: {
          ecuId: target.id,
          ecuName: target.name,
          newValue: `clearDiagnosticInformation(group=0x${group.toString(16).toUpperCase()})`,
          previousValue: "fault memory snapshot taken before clearing",
          risk: "medium",
          userConfirmed: input.userConfirmed,
          // Fail-closed: without a captured backup there is no permit (AGENTS 26).
          backupAvailable: prepared !== undefined,
          activeSessionType: sessionType,
          // Which definition the write was validated against travels in the
          // binding — one source for "the definition that applies here", so a
          // caller cannot describe the write with a different version than the
          // transaction records (AGENTS 25).
          ...(transaction.snapshot.binding.definitionVersion
            ? { definitionVersion: transaction.snapshot.binding.definitionVersion }
            : {}),
        },
        warnings,
      };
    },

    async execute(_transaction, input, _prepared, _permit): Promise<StageOutcome<ClearDtcResult>> {
      const group = input.groupOfDtc ?? DTC_GROUP_ALL;
      await input.target.clearDiagnosticInformation(group);
      // The final value is produced by `verify`; this stage reports the effect.
      return {
        ok: true,
        detail: `clearDiagnosticInformation(0x${group.toString(16).toUpperCase()})`,
      };
    },

    async verify(transaction, input, prepared, _value): Promise<StageOutcome<ClearDtcResult>> {
      const { target } = input;
      const statusMask = input.statusMask ?? 0xff;
      const after = await target.readDtcs(statusMask);
      const beforeEnriched = scanner.enrich([...prepared.before], target.name, target.id);
      const afterEnriched = scanner.enrich(after, target.name, target.id);
      const comparison = scanner.compare(beforeEnriched, afterEnriched);
      const verified = comparison.unchanged.length === 0 && comparison.added.length === 0;
      const permit = transaction.snapshot.permit;
      if (!permit) return { ok: false, reasons: ["kein Write-Permit protokolliert (AGENTS 26)"] };

      input.recordAction?.({
        kind: "clear-dtc",
        ecuId: target.id,
        description: `Fehlerspeicher ${target.name} gelöscht${verified ? "" : " (nicht vollständig bestätigt)"}`,
        result: "success",
        detail: `${beforeEnriched.length} vorher, ${afterEnriched.length} nachher, ${comparison.unchanged.length} unverändert`,
      });

      const result: ClearDtcResult = {
        cleared: true,
        ecuId: target.id,
        ecuName: target.name,
        before: beforeEnriched,
        after: afterEnriched,
        comparison,
        verified,
        permit,
        clearedAt: nowIso(),
        stages: transaction.snapshot.stages,
        transactionId: transaction.id,
      };
      return {
        ok: true,
        value: result,
        reasons: [],
        warnings: verified
          ? []
          : [
              `${comparison.unchanged.length} Code(s) unverändert, ${comparison.added.length} neu — der Fehler liegt weiterhin an`,
            ],
      };
    },

    onAbort(transaction, input, reason) {
      // Prepare already recorded a refused session switch; every other abort is
      // reported here so "nothing was written" is traceable.
      const alreadyRecorded = transaction.snapshot.stages.some(
        (stage) => stage.stage === "prepare" && stage.state === "failed",
      );
      if (alreadyRecorded) return;
      input.recordAction?.({
        kind: "clear-dtc",
        ecuId: input.target.id,
        description: `Fehlerspeicher ${input.target.name} nicht gelöscht`,
        result: "aborted",
        detail: reason,
      });
    },
  };
}

/**
 * Adapt an attached ECU to the write contract.
 *
 * One place, so the pre-check and the write can never drift apart — a pre-check
 * that validates different conditions than the write is worse than none
 * (AGENTS 26). The read side of the session (`readDtcs`) and the write side
 * (`clearDiagnosticInformation`, `ensureWritableSession`) are both used here;
 * that is the whole point of the write port: writes need both, reads need only
 * the first.
 */
export function clearableEcuOf(handle: EcuHandle): ClearableEcu {
  const { session } = handle;
  return {
    id: session.record.id,
    name: session.record.name,
    sessionType: session.record.sessionType,
    readDtcs: (mask) => session.readDtcs(mask),
    clearDiagnosticInformation: (group) => session.clearDiagnosticInformation(group),
    prepareWrite: () => session.ensureWritableSession(),
  };
}

/** Message of an unknown thrown value — the stage report keeps the wording. */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "unbekannter Fehler";
}
