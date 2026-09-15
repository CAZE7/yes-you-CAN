/**
 * The diagnostic transaction (AGENTS 25, 26; master backlog P0 #4 and #7).
 *
 * A write to a vehicle is not a function call that either returns or throws: it
 * is a sequence with preconditions, a backup, a permit, an effect, a
 * verification and — when something fails halfway — an attempt to undo. Two
 * rules follow from that and are enforced here instead of being remembered:
 *
 * 1. **Every stage produces a result with reasons.** A refused precondition, a
 *    refused session switch, an ECU that stops answering: all of them are data
 *    (`StageReport`) that travels with the outcome. Nothing about a *write* is
 *    communicated by throwing — an exception is what happens when nobody decided
 *    what the failure means. `SafetyManager` still throws when a permit is
 *    requested against a failed precondition (fail-closed, AGENTS 26); the
 *    transaction is the layer that translates that into a reported stage.
 * 2. **Aborts and resumptions are states, not `try`/`catch` blocks.** The state
 *    machine below is the only place allowed to say "this write is over"; a
 *    caller can read `snapshot.state` at any time, and an interrupted write keeps
 *    the stage it reached (a suspended transaction can be inspected, resumed or
 *    aborted — it can never silently continue).
 *
 * The journal is append-only and part of the snapshot: what happened, when, and
 * why. That is the audit trail AGENTS 25 asks for, produced by the mechanism
 * rather than by every caller separately.
 */

import { type Logger, createId, messageOf, nowIso } from "@vdp/shared";
import type { RiskLevel, WritePermit } from "../safety/safety-manager.js";

/** The stages a write can pass through, in the order they are allowed. */
export type WriteStageName = "prepare" | "confirm" | "execute" | "verify" | "rollback";

/** Where a transaction stands. Exactly one of these is true at any time. */
export type TransactionState =
  | "open"
  | "prepared"
  | "confirmed"
  | "executed"
  | "verified"
  | "suspended"
  | "aborted"
  | "rolled-back";

/** Terminal states: a transaction here never changes again. */
const TERMINAL: readonly TransactionState[] = ["verified", "aborted", "rolled-back"];

/** Which state a stage moves the transaction into when it succeeds. */
const NEXT_STATE: Readonly<Record<WriteStageName, TransactionState>> = {
  prepare: "prepared",
  confirm: "confirmed",
  execute: "executed",
  verify: "verified",
  rollback: "rolled-back",
};

/**
 * Which state a stage may start from.
 *
 * A stage is not just a step in a script — it is a claim about the world: you
 * cannot verify a write that never happened, and you cannot roll back a
 * transaction that is already finished. Encoding that here means the order is
 * checked by the mechanism, not by reviewers.
 */
const ALLOWED_FROM: Readonly<Record<WriteStageName, readonly TransactionState[]>> = {
  prepare: ["open"],
  confirm: ["prepared"],
  execute: ["confirmed", "suspended"],
  verify: ["executed", "suspended"],
  rollback: ["confirmed", "executed", "suspended"],
};

/** What one stage did, with the reasons why. */
export interface StageReport {
  stage: WriteStageName;
  state: "ok" | "failed" | "skipped";
  /** Human-readable reasons; empty for a success without qualifications. */
  reasons: readonly string[];
  warnings: readonly string[];
  at: string;
  /** Free-form detail for the audit log (never parsed). */
  detail?: string;
}

/** One entry of the append-only journal. */
export interface JournalEntry {
  at: string;
  state: TransactionState;
  reason?: string;
}

/** What a stage body returns; throwing is converted into a failed report. */
export interface StageOutcome<T> {
  ok: boolean;
  value?: T;
  reasons?: readonly string[];
  warnings?: readonly string[];
  detail?: string;
}

/** The preconditions a write was evaluated against (AGENTS 25 audit fields). */
export interface PreconditionSnapshot {
  ok: boolean;
  failed: readonly string[];
  warnings: readonly string[];
  at: string;
}

/** Connection/session/ECU a transaction is bound to (AGENTS 10, §7). */
export interface TransactionBinding {
  kind: string;
  risk: RiskLevel;
  ecuId: string;
  ecuName: string;
  /** Session the write belongs to, when one is open. */
  sessionId?: string;
  /** Transport/session type the write will run in (ISO 14229-1 §9.2). */
  sessionType?: number;
  /** Definition version the write was validated against (AGENTS 25). */
  definitionVersion?: string;
}

export interface TransactionSnapshot {
  id: string;
  binding: TransactionBinding;
  state: TransactionState;
  stages: readonly StageReport[];
  journal: readonly JournalEntry[];
  preconditions?: PreconditionSnapshot;
  /** The permit this write ran under (AGENTS 25 audit). */
  permit?: WritePermit;
  startedAt: string;
  endedAt?: string;
  /** Why the transaction is suspended or was aborted/rolled back. */
  reason?: string;
}

export interface DiagnosticTransactionOptions {
  binding: TransactionBinding;
  logger?: Logger;
  clock?: () => number;
}

export class DiagnosticTransaction {
  private readonly log: Logger | undefined;
  private readonly clock: () => number;
  private readonly stageReports: StageReport[] = [];
  private readonly journalEntries: JournalEntry[] = [];
  private readonly startedAt: string;
  private currentState: TransactionState = "open";
  private preconditions: PreconditionSnapshot | undefined;
  private permit: WritePermit | undefined;
  private reason: string | undefined;
  private endedAt: string | undefined;
  /** Results of the stages, so a later stage can use what an earlier one found. */
  private readonly values = new Map<WriteStageName, unknown>();

  constructor(private readonly options: DiagnosticTransactionOptions) {
    this.log = options.logger;
    this.clock = options.clock ?? (() => Date.now());
    this.startedAt = nowIso(this.clock);
    this.id = createId("tx");
    this.journal("open");
  }

  readonly id: string;

  get state(): TransactionState {
    return this.currentState;
  }

  get isFinished(): boolean {
    return TERMINAL.includes(this.currentState);
  }

  get snapshot(): TransactionSnapshot {
    return {
      id: this.id,
      binding: { ...this.options.binding },
      state: this.currentState,
      stages: [...this.stageReports],
      journal: [...this.journalEntries],
      startedAt: this.startedAt,
      ...(this.preconditions
        ? {
            preconditions: {
              ...this.preconditions,
              failed: [...this.preconditions.failed],
              warnings: [...this.preconditions.warnings],
            },
          }
        : {}),
      ...(this.permit ? { permit: this.permit } : {}),
      ...(this.endedAt ? { endedAt: this.endedAt } : {}),
      ...(this.reason ? { reason: this.reason } : {}),
    };
  }

  /** Value an earlier successful stage produced (`prepare`/`execute`/`verify`). */
  value<T>(stage: WriteStageName): T | undefined {
    return this.values.get(stage) as T | undefined;
  }

  /**
   * Run one stage.
   *
   * The body's result — or the failure it throws — becomes a {@link StageReport}.
   * A failure ends this stage but not necessarily the transaction: the caller
   * decides whether it aborts (see {@link abort}) or continues into a rollback.
   * An out-of-order stage is itself a failure (fail-closed, §26), because a
   * "verify" without an "execute" would otherwise look like a verified write.
   */
  async stage<T>(
    stage: WriteStageName,
    body: () => Promise<StageOutcome<T>> | StageOutcome<T>,
  ): Promise<StageReport> {
    const allowed = ALLOWED_FROM[stage];
    if (!allowed.includes(this.currentState)) {
      const reasons = [
        `stage "${stage}" is not allowed in state "${this.currentState}" (allowed from: ${allowed.join(", ")})`,
      ];
      const report = this.report(stage, "failed", reasons);
      this.abort(reasons[0] ?? `stage ${stage} not allowed`);
      return report;
    }
    if (stage === "execute" && this.permit === undefined) {
      const reasons = ['stage "execute" requires a valid confirmed permit (AGENTS 26)'];
      const report = this.report(stage, "failed", reasons);
      this.abort(reasons[0] ?? "stage execute without permit");
      return report;
    }
    let outcome: StageOutcome<T>;
    try {
      outcome = await body();
    } catch (error) {
      const reasons = [messageOf(error)];
      this.log?.warn("write stage failed", { transaction: this.id, stage, error: reasons[0] });
      return this.report(stage, "failed", reasons);
    }
    if (!outcome.ok) {
      return this.report(
        stage,
        "failed",
        outcome.reasons ?? [],
        outcome.warnings ?? [],
        outcome.detail,
      );
    }
    if (outcome.value !== undefined) this.values.set(stage, outcome.value);
    const report = this.report(
      stage,
      "ok",
      outcome.reasons ?? [],
      outcome.warnings ?? [],
      outcome.detail,
    );
    this.transition(NEXT_STATE[stage]);
    return report;
  }

  /** Record a stage that was deliberately not run (e.g. no rollback available). */
  skip(stage: WriteStageName, reason: string): StageReport {
    return this.report(stage, "skipped", [reason]);
  }

  /** Attach the evaluated preconditions and the permit they produced. */
  confirm(permit: WritePermit, preconditions: PreconditionSnapshot): void {
    this.permit = permit;
    this.preconditions = {
      ...preconditions,
      failed: [...preconditions.failed],
      warnings: [...preconditions.warnings],
    };
  }

  /**
   * Pause a transaction that is waiting for something outside its control —
   * an operator, a power supply, a second ECU in a multi-ECU write. Suspension is
   * a state, so an interrupted write is visible instead of being a half-finished
   * call stack somebody gave up on.
   */
  suspend(reason: string): void {
    if (this.isFinished) return;
    this.reason = reason;
    this.transition("suspended", reason);
  }

  /** Continue a suspended transaction; a finished one stays finished. */
  resume(): boolean {
    if (this.currentState !== "suspended") return false;
    this.reason = undefined;
    this.log?.info("write transaction resumed", { transaction: this.id });
    // Back to the state the last successful stage produced.
    this.rewindToLastStage();
    return true;
  }

  /** End this transaction as aborted — nothing was written or nothing can be undone. */
  abort(reason: string): void {
    if (this.isFinished) return;
    this.reason = reason;
    this.transition("aborted", reason);
    this.log?.warn("write transaction aborted", { transaction: this.id, reason });
  }

  /** End this transaction as rolled back — the rollback stage ran. */
  rolledBack(reason: string): void {
    this.reason = reason;
    this.transition("rolled-back", reason);
    this.log?.warn("write transaction rolled back", { transaction: this.id, reason });
  }

  /** Values of every successful stage, in execution order (for the caller's report). */
  get stageValues(): ReadonlyMap<WriteStageName, unknown> {
    return this.values;
  }

  private report(
    stage: WriteStageName,
    state: StageReport["state"],
    reasons: readonly string[],
    warnings: readonly string[] = [],
    detail?: string,
  ): StageReport {
    const report: StageReport = {
      stage,
      state,
      reasons: [...reasons],
      warnings: [...warnings],
      at: nowIso(this.clock),
      ...(detail !== undefined ? { detail } : {}),
    };
    this.stageReports.push(report);
    return report;
  }

  private transition(next: TransactionState, reason?: string): void {
    this.currentState = next;
    if (TERMINAL.includes(next)) this.endedAt = nowIso(this.clock);
    this.journal(next, reason);
  }

  private journal(state: TransactionState, reason?: string): void {
    this.journalEntries.push({
      at: nowIso(this.clock),
      state,
      ...(reason !== undefined ? { reason } : {}),
    });
  }

  /** The state the stages so far justify (used by {@link resume}). */
  private rewindToLastStage(): void {
    let state: TransactionState = "open";
    for (const stage of ["prepare", "confirm", "execute", "verify"] as const) {
      if (this.stageReports.some((report) => report.stage === stage && report.state === "ok")) {
        state = NEXT_STATE[stage];
      }
    }
    this.currentState = state;
  }
}
