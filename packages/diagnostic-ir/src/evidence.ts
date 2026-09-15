/**
 * Evidence and hypotheses (master backlog P0 #39/#40; AGENTS 22, 24).
 *
 * The fault memory, the signal statistics and the definition package all hold
 * statements about the same car, and none of them says what the *combination*
 * means. That is what an analysis needs: not "P0420 exists" but "P0420 exists, the
 * trim was measured inside the documented window for the last four seconds, and the
 * pattern that explains it comes from a licensed workshop manual for this variant".
 *
 * So this module holds the three shapes that make the step auditable:
 *
 * - an {@link EvidenceItem}: one statement, with the IR's own {@link Evidence} on
 *   it, addressable by a stable id — so a finding can *cite* what it rests on,
 * - an {@link EvidenceSet}: everything a session can say at one moment, plus the
 *   {@link EvidenceConflict}s inside it (two items about one subject that disagree
 *   are a finding of their own; the item that loses quietly is lost knowledge),
 * - a {@link Hypothesis}: a documented failure pattern that has been *judged*
 *   against the measurements — with its outcome, the window it was judged on and
 *   the next test that would move it.
 *
 * Deliberately absent: any claim about *how* to repair (that is `repair`, the
 * package's word, not ours), any numeric confidence the input did not earn, and
 * any write-side concept at all. An evidence set is read-only by construction:
 * nothing in here names a request, a DID to write or a service to call (AGENTS 22,
 * master backlog P0 #16's rule that an action never bypasses the write chain).
 */

import type { Evidence } from "./provenance.js";
import type { MeasurementWindow } from "./window.js";

/** What kind of statement an item is. The set is grouped by this, not by prose. */
export type EvidenceKind =
  | "dtc"
  | "anomaly"
  | "freeze-frame"
  | "signal"
  | "vehicle"
  | "history"
  | "pattern"
  | "gap";

/**
 * One statement, with its own proof.
 *
 * `id` is stable for the same fact in the same session (`dtc:P0420@engine`), so a
 * finding can cite items and a replay can cite the same finding. It is a *key*, not
 * a sentence: never render it as the answer.
 */
export interface EvidenceItem {
  id: string;
  kind: EvidenceKind;
  /** What the statement is about: a code, a signal id, a vehicle id, an ECU name. */
  subject: string;
  /** One line a human can read without the source at hand. */
  statement: string;
  /** ISO-8601 timestamp of the observation this item reports. */
  at: string;
  ecuId?: string;
  /** The IR's own provenance: proven (with origin and version) or unproven (with a reason). */
  evidence: Evidence;
}

/** Two items about one subject that do not agree. Naming it beats picking a winner. */
export interface EvidenceConflict {
  subject: string;
  left: string;
  right: string;
  note: string;
}

export interface EvidenceSet {
  kind: "evidence";
  sessionId: string;
  /** When the set was collected — an evidence set describes a moment, not a truth. */
  collectedAt: string;
  items: EvidenceItem[];
  conflicts: EvidenceConflict[];
}

/** How a documented pattern fared against the measurements. */
export type HypothesisOutcome = "confirmed" | "refuted" | "untested";

/** One documented check, judged. `window` is absent when nothing decided it. */
export interface HypothesisCheck {
  test: HypothesisTest;
  outcome: HypothesisOutcome;
  window?: MeasurementWindow;
}

/** The measurement a pattern says to take, kept in the shape the package wrote. */
export interface HypothesisTest {
  signal: string;
  name?: string;
  expect: string;
  min?: number;
  max?: number;
  windowMs?: number;
  /** False when the package wrote prose only — then no window can decide it. */
  measurable: boolean;
}

/** A recommended test to distinguish between competing hypotheses. */
export interface DiscriminatingTest {
  hypothesisId: string;
  test: HypothesisTest;
  rationale: string;
  discriminatesAgainst?: readonly string[];
}

/** The state of an ongoing guided diagnostic session. */
export interface GuidedDiagnosisState {
  sessionId: string;
  status: "in-progress" | "resolved" | "inconclusive";
  leadingHypothesis?: Hypothesis;
  nextRecommendedTest?: DiscriminatingTest;
  hypotheses: readonly Hypothesis[];
  evidenceCount: number;
  stepsCompleted: number;
  summary: string;
}

/**
 * A failure pattern, judged.

 *
 * `confidence` is derived from what was measured and how the statement is sourced
 * (see the ranking rule in `@vdp/core`); it is never the pattern's own assertion,
 * and it is capped while the check stayed untested — an unmeasured pattern is not
 * refuted, it is open.
 */
export interface Hypothesis {
  id: string;
  /** The code this pattern was documented under. */
  code: string;
  ecuId?: string;
  /** What the package thinks the cause is. */
  claim: string;
  explanation?: string;
  /** The package's own prior — `common` | `plausible` | `rare`, or absent. */
  likelihood?: string;
  outcome: HypothesisOutcome;
  confidence: number;
  /** Item ids this hypothesis rests on. Empty means: nothing supports it yet. */
  evidence: string[];
  /**
   * Every documented check with its own verdict, in the package's order. The
   * hypothesis' `outcome` is derived from this list (refuted beats confirmed beats
   * untested), so a reader can see which check decided it instead of trusting a
   * single number.
   */
  checks: HypothesisCheck[];
  /** Why the outcome is what it is, in one line (never a hidden rule). */
  reason: string;
  /** The first check that has not been decided yet — the next test to run. */
  nextTest?: HypothesisTest;
}

/** The stable key of an item: subject and ECU, not wording or timestamp. */
export function evidenceItemId(kind: EvidenceKind, subject: string, ecuId?: string): string {
  const trimmed = subject.trim();
  return ecuId === undefined ? `${kind}:${trimmed}` : `${kind}:${trimmed}@${ecuId}`;
}

/** Items of one kind, in the order the set holds them. */
export function itemsOf(set: EvidenceSet, kind: EvidenceKind): EvidenceItem[] {
  return set.items.filter((item) => item.kind === kind);
}

/** The item behind a citation, or `undefined` when the id is unknown. */
export function itemById(set: EvidenceSet, id: string): EvidenceItem | undefined {
  return set.items.find((item) => item.id === id);
}

/** Items whose statement is not proven — the part of the set a reader must weigh. */
export function unprovenItems(set: EvidenceSet): EvidenceItem[] {
  return set.items.filter((item) => item.evidence.kind === "unproven");
}
