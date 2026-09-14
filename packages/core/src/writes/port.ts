/**
 * The write port (AGENTS 25, 26; master backlog P0 #3 and #4).
 *
 * Reads and writes are not two flavours of the same call — they have different
 * failure models. A read that fails is information ("this ECU did not answer");
 * a write that fails may have changed the vehicle. While both lived on the
 * diagnostic engine, the read path knowingly carried methods that write, and
 * going through the safety chain was something a caller had to *remember*.
 *
 * This port is that separation: the read path (engine, sessions, scans,
 * measurements) exposes no write method at all, and the only way to change
 * anything is a {@link WriteOperation} executed here. The port owns what must
 * not be re-implemented per operation:
 *
 * - the staged flow via {@link DiagnosticTransaction} (prepare → confirm →
 *   execute → verify → rollback) including the order check,
 * - the permit: preconditions are evaluated before anything is written; a failed
 *   precondition aborts with reasons and a refused permit ends the transaction
 *   (fail-closed, §26). An operation may *add* warnings but can never remove a
 *   failed precondition — `SafetyManager.evaluate` has the last word,
 * - the audit trail: every finished transaction and every pre-check stays in
 *   {@link WritePort.history} with its stages and journal.
 *
 * Vocabulary: an operation declares `kind`, `title` and `risk`; the port never
 * knows which operations exist. Its `Input`, `Prepared` and `Value` types come
 * from the operation, which is why this module contains no kind list — the
 * runtime, which may import the domain vocabulary, is where operations are named.
 */

import { type Logger, createLogger, messageOf } from "@vdp/shared";
import type {
  RiskLevel,
  SafetyManager,
  VehicleState,
  WritePermit,
  WriteRequestContext,
} from "../safety/safety-manager.js";
import {
  DiagnosticTransaction,
  type StageOutcome,
  type StageReport,
  type TransactionBinding,
  type TransactionSnapshot,
} from "./transaction.js";

/** Preconditions of one operation, as data (AGENTS 26 pre-check). */
export interface PreconditionReport {
  ok: boolean;
  failed: readonly string[];
  warnings: readonly string[];
}

/**
 * One write operation (AGENTS 25/26; "Zielbild: `WriteOperation` als eigener
 * Port mit eigenem Vokabular").
 *
 * `Input` is what the caller asked for, `Prepared` what `prepare` captured from
 * the vehicle (the backup), `Value` what the operation finally returns. The
 * stages are hooks, not a script: an operation without `rollback` says so by not
 * defining one, and the port records the skipped stage with that reason instead
 * of inventing an undo that does not exist.
 */
export interface WriteOperation<Input, Prepared, Value> {
  /** Stable kind, e.g. `"clear-dtc"` — the runtime's vocabulary, not the port's. */
  readonly kind: string;
  /** Human-readable title for audit and UI. */
  readonly title: string;
  /** Risk policy of this operation (mirrors the domain policy table). */
  readonly risk: RiskLevel;
  /**
   * Capture the previous state before anything is written (AGENTS 25 "Backup")
   * and put the ECU into the session the write needs. Read-only: it may switch
   * the diagnostic session, never the fault memory or a value.
   */
  prepare(transaction: DiagnosticTransaction, input: Input): Promise<StageOutcome<Prepared>>;
  /**
   * Describe the write for the safety chain — no I/O, no decision.
   *
   * `sessionType` is the session the write will actually run in, which is what
   * the permit has to record (ISO 14229-1 §9.2). `warnings` here can only add
   * to what the safety manager reports; the failed list stays the manager's.
   * `prepared` is absent for a pre-check, which must not touch the vehicle.
   */
  describe(
    transaction: DiagnosticTransaction,
    input: Input,
    prepared: Prepared | undefined,
    sessionType: number,
  ): { context: WriteRequestContext; warnings?: readonly string[] };
  /** Perform the write. Runs only with a valid permit (AGENTS 26). */
  execute(
    transaction: DiagnosticTransaction,
    input: Input,
    prepared: Prepared,
    permit: WritePermit,
  ): Promise<StageOutcome<Value>>;
  /**
   * Verify by reading back (AGENTS 25 "Verifikation"). When defined, its value is
   * the final result of the operation — it is the only stage that sees both the
   * backup and the effect.
   */
  verify?(
    transaction: DiagnosticTransaction,
    input: Input,
    prepared: Prepared,
    value: Value,
  ): Promise<StageOutcome<Value>>;
  /**
   * Undo what `execute` did, when that is possible at all. Operations whose
   * effect cannot be undone leave this out; the port then records the skipped
   * rollback with {@link WriteOperation.rollbackUnavailable}.
   */
  rollback?(
    transaction: DiagnosticTransaction,
    input: Input,
    reason: string,
  ): Promise<StageOutcome<unknown>>;
  /**
   * Did the operation reach its goal? Asked before the permit outcome is
   * journaled, because only the operation knows what "reached" means: a clear
   * whose re-read still shows the fault was *executed*, but it did not confirm
   * (AGENTS 25). Defaults to `true`.
   */
  outcomeOf?(value: Value): boolean;
  /** Why rollback is unavailable — required when `rollback` is not defined. */
  readonly rollbackUnavailable?: string;
  /**
   * Called once when the transaction ends without a verified result (aborted or
   * rolled back). The operation decides what that means for the audit log — it
   * may already have recorded the failure in `prepare`; it must not throw
   * (§34.25: report, never swallow).
   */
  onAbort?(transaction: DiagnosticTransaction, input: Input, reason: string): void;
}

/** What a caller learns from a pre-check: nothing was written (§26). */
export interface WritePrecheckResult {
  ok: boolean;
  /** Blocking reasons: violated preconditions and unproven ones (AGENTS 26). */
  failed: readonly string[];
  /** The subset of `failed` that is missing evidence, not a proven violation. */
  unproven: readonly string[];
  warnings: readonly string[];
  transactionId: string;
}

/** The result of a write: the effect, the reasons, and the whole transaction. */
export interface WriteOperationResult<Value> {
  ok: boolean;
  kind: string;
  risk: RiskLevel;
  value?: Value;
  reasons: readonly string[];
  /**
   * The blocking reasons that were not proven *wrong* but never proven right
   * (missing evidence). Present only when there is at least one, because an
   * empty list would suggest the question was answered (AGENTS 26, P0 #5).
   */
  unproven?: readonly string[];
  warnings: readonly string[];
  /** Every stage with its reasons — the part a caller can reason about. */
  stages: readonly StageReport[];
  transaction: TransactionSnapshot;
}

/** Where a write runs: which ECU, which session, which definition (AGENTS 25). */
export interface WriteBinding {
  ecuId: string;
  ecuName: string;
  sessionId?: string;
  /** Session type of the ECU record before any switch (ISO 14229-1 §9.2). */
  sessionType?: number;
  definitionVersion?: string;
  /** Vehicle state the preconditions are checked against. */
  vehicleState: VehicleState;
}

export interface WritePortOptions {
  safety: SafetyManager;
  logger?: Logger;
  clock?: () => number;
  /** Keeps completed transactions for audit; default 50. */
  historySize?: number;
}

export class WritePort {
  private readonly operations = new Map<string, WriteOperation<never, never, unknown>>();
  private readonly transactions: TransactionSnapshot[] = [];
  private readonly log: Logger;
  private readonly clock: () => number;
  private readonly historySize: number;

  constructor(private readonly options: WritePortOptions) {
    this.log = (options.logger ?? createLogger("writes", { level: "INFO" })).child("writes");
    this.clock = options.clock ?? (() => Date.now());
    this.historySize = options.historySize ?? 50;
  }

  /** Register an operation under its kind; a duplicate kind is a programming error. */
  register<Input, Prepared, Value>(operation: WriteOperation<Input, Prepared, Value>): void {
    if (this.operations.has(operation.kind)) {
      throw new Error(`write operation "${operation.kind}" is already registered`);
    }
    this.operations.set(
      operation.kind,
      operation as unknown as WriteOperation<never, never, unknown>,
    );
  }

  /** Operation kinds this port can run, in registration order. */
  get kinds(): readonly string[] {
    return Array.from(this.operations.keys());
  }

  /** Completed (and aborted) transactions, newest last — the audit trail. */
  get history(): readonly TransactionSnapshot[] {
    return this.transactions;
  }

  /**
   * Pre-check an operation without writing anything (AGENTS 26).
   *
   * Evaluates the preconditions the write would run into with the *requested*
   * confirmation: a pre-check that hides the confirmation itself would let an
   * operator believe a write is ready that is not. Nothing is written and no
   * permit is issued; only `prepare`'s read-only backup is skipped, so a
   * pre-check cannot switch a session either.
   */
  precheck<Input, Prepared, Value>(
    kind: string,
    input: Input,
    binding: WriteBinding,
    options: { userConfirmed: boolean },
  ): WritePrecheckResult {
    const operation = this.require(kind) as unknown as WriteOperation<Input, Prepared, Value>;
    const transaction = this.begin(operation, binding);
    const sessionType = binding.sessionType ?? 0x01;
    const described = operation.describe(transaction, input, undefined, sessionType);
    const checks = this.options.safety.evaluate(
      { ...described.context, userConfirmed: options.userConfirmed },
      binding.vehicleState,
    );
    const warnings = Array.from(new Set([...checks.warnings, ...(described.warnings ?? [])]));
    transaction.abort("pre-check only — nothing was written");
    this.remember(transaction);
    return {
      ok: checks.ok,
      failed: [...checks.failed],
      unproven: [...checks.unproven],
      warnings,
      transactionId: transaction.id,
    };
  }

  /**
   * Run an operation through the full staged flow.
   *
   * The only way this method throws is an unknown kind (a programming error):
   * every failure of the *write* comes back as a result with reasons.
   */
  async run<Input, Prepared, Value>(
    kind: string,
    input: Input,
    binding: WriteBinding,
  ): Promise<WriteOperationResult<Value>> {
    const operation = this.require(kind) as unknown as WriteOperation<Input, Prepared, Value>;
    const transaction = this.begin(operation, binding);

    const prepareReport = await transaction.stage("prepare", () =>
      operation.prepare(transaction, input),
    );
    if (prepareReport.state !== "ok") {
      // Fail-closed (AGENTS 26): a write whose preparation failed — no backup, or
      // a refused session switch — must not reach the permit stage. Asking for a
      // permit for a write that cannot start would be a second, misleading
      // decision, and would leave an audit entry for a write that never was one.
      const reason = prepareReport.reasons[0] ?? "prepare did not capture the previous state";
      transaction.abort(reason);
      operation.onAbort?.(transaction, input, reason);
      return this.result(
        operation,
        transaction,
        false,
        prepareReport.reasons,
        prepareReport.warnings,
      );
    }
    const prepared = transaction.value<Prepared>("prepare");

    // The permit stage: evaluate, then ask. A failed precondition aborts with the
    // reasons; a refused permit (fail-closed) ends the transaction as well,
    // because continuing without one is exactly what AGENTS 26 forbids.
    const confirmReport = await transaction.stage("confirm", () => {
      const sessionType = this.sessionTypeOf(transaction, binding);
      const described = operation.describe(transaction, input, prepared, sessionType);
      const checks = this.options.safety.evaluate(described.context, binding.vehicleState);
      const warnings = Array.from(new Set([...checks.warnings, ...(described.warnings ?? [])]));
      if (!checks.ok)
        return {
          ok: false,
          reasons: [...checks.failed],
          warnings,
          // The caller gets the distinction through the result: which of these
          // reasons is a missing proof rather than a violation? (P0 #5)
          unproven: [...checks.unproven],
        };
      try {
        const permit = this.options.safety.requestPermit(described.context, binding.vehicleState);
        transaction.confirm(permit, {
          ok: true,
          failed: [],
          warnings,
          at: new Date(this.clock()).toISOString(),
        });
        return { ok: true, reasons: [], warnings };
      } catch (error) {
        return { ok: false, reasons: [messageOf(error)], warnings };
      }
    });
    if (confirmReport.state !== "ok") {
      transaction.abort(confirmReport.reasons[0] ?? "preconditions not met");
      operation.onAbort?.(
        transaction,
        input,
        transaction.snapshot.reason ?? "preconditions not met",
      );
      return this.result(
        operation,
        transaction,
        false,
        confirmReport.reasons,
        confirmReport.warnings,
        "unproven" in confirmReport ? (confirmReport.unproven as readonly string[]) : [],
      );
    }

    const permit = transaction.snapshot.permit;
    if (!permit) {
      // Unreachable unless the confirm stage lied about its result; fail closed.
      transaction.abort("no permit recorded — write refused (AGENTS 26)");
      return this.result(operation, transaction, false, ["no write permit was issued"], []);
    }
    const executeReport = await transaction.stage("execute", () =>
      operation.execute(transaction, input, prepared as Prepared, permit),
    );
    if (executeReport.state !== "ok") {
      return this.rollbackAndFinish(
        operation,
        transaction,
        input,
        executeReport,
        executeReport.reasons,
      );
    }
    const executed = transaction.value<Value>("execute") as Value;

    const verifyResult = await this.verifyStage(operation, transaction, input, prepared, executed);
    const value = verifyResult.value ?? executed;
    this.recordPermitOutcome(
      transaction,
      verifyResult.ok && (operation.outcomeOf?.(value) ?? true) ? "success" : "failed",
    );
    return this.finish(operation, transaction, verifyResult, value);
  }

  /** `verify` when the operation has one, an explicit skip when it has not. */
  private async verifyStage<Input, Prepared, Value>(
    operation: WriteOperation<Input, Prepared, Value>,
    transaction: DiagnosticTransaction,
    input: Input,
    prepared: Prepared | undefined,
    executed: Value,
  ): Promise<{
    ok: boolean;
    reasons: readonly string[];
    warnings: readonly string[];
    value?: Value;
  }> {
    if (!operation.verify) {
      transaction.skip("verify", `${operation.title} has no read-back verification`);
      return { ok: true, reasons: [], warnings: [] };
    }
    const report = await transaction.stage(
      "verify",
      () =>
        operation.verify?.(transaction, input, prepared as Prepared, executed) ??
        ({ ok: false, reasons: ["no verification implemented"] } as StageOutcome<Value>),
    );
    const value = report.state === "ok" ? transaction.value<Value>("verify") : undefined;
    return {
      ok: report.state === "ok",
      reasons: report.reasons,
      warnings: report.warnings,
      ...(value !== undefined ? { value } : {}),
    };
  }

  /** Roll back a failed operation, when it says it can. */
  private async rollbackAndFinish<Input, Prepared, Value>(
    operation: WriteOperation<Input, Prepared, Value>,
    transaction: DiagnosticTransaction,
    input: Input,
    executeReport: StageReport,
    reasons: readonly string[],
  ): Promise<WriteOperationResult<Value>> {
    const reason = reasons[0] ?? `${operation.kind} failed`;
    if (operation.rollback) {
      const rollbackReport = await transaction.stage(
        "rollback",
        () =>
          operation.rollback?.(transaction, input, reason) ??
          ({ ok: false, reasons: ["no rollback implemented"] } as StageOutcome<unknown>),
      );
      if (rollbackReport.state === "ok") transaction.rolledBack(reason);
      else transaction.abort(`${reason} (rollback failed: ${rollbackReport.reasons.join("; ")})`);
    } else {
      transaction.skip(
        "rollback",
        operation.rollbackUnavailable ??
          `${operation.kind} provides no rollback — the backup is the recovery path`,
      );
      transaction.abort(reason);
    }
    operation.onAbort?.(transaction, input, transaction.snapshot.reason ?? reason);
    // A permit was issued — the audit log has to know how it ended, including
    // "the write failed after the permit" (AGENTS 25).
    this.recordPermitOutcome(transaction, "failed");
    const snapshot = this.remember(transaction);
    return {
      ok: false,
      kind: operation.kind,
      risk: operation.risk,
      reasons: Array.from(new Set([...reasons, ...executeReport.reasons])),
      warnings: [...executeReport.warnings],
      stages: snapshot.stages,
      transaction: snapshot,
    };
  }

  private finish<Input, Prepared, Value>(
    operation: WriteOperation<Input, Prepared, Value>,
    transaction: DiagnosticTransaction,
    latest: { ok: boolean; reasons: readonly string[]; warnings: readonly string[] },
    value: Value | undefined,
  ): WriteOperationResult<Value> {
    const snapshot = this.remember(transaction);
    const failed = snapshot.stages
      .filter((stage) => stage.state === "failed")
      .flatMap((stage) => stage.reasons);
    const reasons = Array.from(new Set([...failed, ...latest.reasons]));
    const warnings = Array.from(
      new Set([...snapshot.stages.flatMap((stage) => stage.warnings), ...latest.warnings]),
    );
    return {
      ok: reasons.length === 0 && (snapshot.state === "verified" || snapshot.state === "executed"),
      kind: operation.kind,
      risk: operation.risk,
      ...(value !== undefined ? { value } : {}),
      reasons,
      warnings,
      stages: snapshot.stages,
      transaction: snapshot,
    };
  }

  private result<Input, Prepared, Value>(
    operation: WriteOperation<Input, Prepared, Value>,
    transaction: DiagnosticTransaction,
    ok: boolean,
    reasons: readonly string[],
    warnings: readonly string[],
    unproven: readonly string[] = [],
  ): WriteOperationResult<Value> {
    const snapshot = this.remember(transaction);
    return {
      ok,
      kind: operation.kind,
      risk: operation.risk,
      reasons: [...reasons],
      ...(unproven.length > 0 ? { unproven: [...unproven] } : {}),
      warnings: [...warnings],
      stages: snapshot.stages,
      transaction: snapshot,
    };
  }

  /** Start a transaction bound to the write's ECU, session and definition. */
  private begin<Input, Prepared, Value>(
    operation: WriteOperation<Input, Prepared, Value>,
    binding: WriteBinding,
  ): DiagnosticTransaction {
    const transactionBinding: TransactionBinding = {
      kind: operation.kind,
      risk: operation.risk,
      ecuId: binding.ecuId,
      ecuName: binding.ecuName,
      ...(binding.sessionId !== undefined ? { sessionId: binding.sessionId } : {}),
      ...(binding.sessionType !== undefined ? { sessionType: binding.sessionType } : {}),
      ...(binding.definitionVersion !== undefined
        ? { definitionVersion: binding.definitionVersion }
        : {}),
    };
    return new DiagnosticTransaction({
      binding: transactionBinding,
      logger: this.log,
      clock: this.clock,
    });
  }

  private remember(transaction: DiagnosticTransaction): TransactionSnapshot {
    const snapshot = transaction.snapshot;
    this.transactions.push(snapshot);
    if (this.transactions.length > this.historySize) this.transactions.shift();
    return snapshot;
  }

  private require(kind: string): WriteOperation<never, never, unknown> {
    const operation = this.operations.get(kind);
    if (!operation) {
      throw new Error(
        `unknown write operation "${kind}" — registered: ${this.kinds.join(", ") || "(none)"}`,
      );
    }
    return operation;
  }

  /** Session the permit has to record: the one `prepare` left the ECU in. */
  private sessionTypeOf(transaction: DiagnosticTransaction, binding: WriteBinding): number {
    const prepared = transaction.value<{ sessionType?: number }>("prepare");
    return prepared?.sessionType ?? binding.sessionType ?? 0x01;
  }

  /** Journal the permit outcome on the audit log (AGENTS 25). */
  private recordPermitOutcome(
    transaction: DiagnosticTransaction,
    outcome: "success" | "failed",
  ): void {
    const permit = transaction.snapshot.permit;
    if (!permit) return;
    this.options.safety.recordResult(
      permit,
      outcome,
      outcome === "success" ? `${permit.id} verified` : `${permit.id} not confirmed`,
    );
  }
}
