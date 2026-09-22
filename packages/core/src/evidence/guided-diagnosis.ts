/**
 * Guided Diagnosis Loop (Task 6; AGENTS 22; Roadmap step 16).
 *
 * Implements the interactive diagnostic cycle:
 *
 * DTC → Evidence → Hypothesis → Next Test → Measurement → Evidence Update → Hypothesis Update
 *
 * Rather than only declaring "Possibility: Pattern X", the engine determines:
 * "To discriminate between Hypothesis A and Hypothesis B, execute Test Y now."
 *
 * The cycle continues until:
 * 1. Resolved: One hypothesis is confirmed with high confidence while alternatives are refuted.
 * 2. Inconclusive: All available measurable tests have run without confirming a root cause.
 * 3. In-Progress: Recommends the most discriminating next test.
 */

import {
  type DiagnosisStep,
  type DiagnosisTransition,
  type DiscriminatingTest,
  type EvidenceItem,
  type EvidenceSet,
  type GuidedDiagnosisState,
  type Hypothesis,
  type HypothesisCheck,
  evidenceItemId,
  proven,
} from "@vdp/diagnostic-ir";
import { nowIso } from "@vdp/shared";
import type { EvidenceDtc } from "./collect.js";
import { type SamplePoint, rankHypotheses } from "./hypotheses.js";

export interface GuidedDiagnosisInput {
  evidence: EvidenceSet;
  dtcs: readonly EvidenceDtc[];
  samplesOf?: (signalId: string) => readonly SamplePoint[];
  stepsCompleted?: number;
}

/** The ids of the set, in set order — what a step diff is taken over. */
function idsOf(evidence: EvidenceSet): string[] {
  return evidence.items.map((item) => item.id);
}

/**
 * Evaluates the current diagnostic state and determines whether the issue is
 * resolved, inconclusive, or requires another discriminating test.
 */
export function evaluateGuidedDiagnosis(input: GuidedDiagnosisInput): GuidedDiagnosisState {
  const { evidence, dtcs, samplesOf, stepsCompleted = 0 } = input;
  const hypotheses = rankHypotheses({
    evidence,
    dtcs,
    ...(samplesOf !== undefined ? { samplesOf } : {}),
  });

  if (hypotheses.length === 0) {
    return {
      sessionId: evidence.sessionId,
      status: "inconclusive",
      hypotheses: [],
      evidenceCount: evidence.items.length,
      evidenceIds: idsOf(evidence),
      stepsCompleted,
      summary: "No diagnostic hypotheses documented for the active DTCs",
    };
  }

  const leading = hypotheses[0];
  const confirmed = hypotheses.filter((h) => h.outcome === "confirmed");
  const allUntested = hypotheses.every((h) => h.outcome === "untested");

  // Check resolution: leading hypothesis is confirmed with confidence >= 0.65
  // and all competing hypotheses are either refuted or significantly lower confidence.
  if (
    leading &&
    leading.outcome === "confirmed" &&
    leading.confidence >= 0.65 &&
    (hypotheses.length === 1 || (hypotheses[1]?.confidence ?? 0) <= leading.confidence - 0.2)
  ) {
    return {
      sessionId: evidence.sessionId,
      status: "resolved",
      leadingHypothesis: leading,
      hypotheses,
      evidenceCount: evidence.items.length,
      evidenceIds: idsOf(evidence),
      stepsCompleted,
      summary: `Diagnosis resolved: root cause identified as "${leading.claim}" (${leading.code}) with confidence ${leading.confidence}`,
    };
  }

  // Find next discriminating test across hypotheses
  const nextTest = selectDiscriminatingTest(hypotheses);

  if (!nextTest) {
    // If no further tests are possible, report outcome
    const topConfirmed = confirmed[0];
    if (topConfirmed) {
      return {
        sessionId: evidence.sessionId,
        status: "resolved",
        leadingHypothesis: topConfirmed,
        hypotheses,
        evidenceCount: evidence.items.length,
        evidenceIds: idsOf(evidence),
        stepsCompleted,
        summary: `Diagnosis complete: leading cause "${topConfirmed.claim}" (${topConfirmed.code}) confirmed without further tests`,
      };
    }

    return {
      sessionId: evidence.sessionId,
      status: "inconclusive",
      ...(leading !== undefined ? { leadingHypothesis: leading } : {}),
      hypotheses,
      evidenceCount: evidence.items.length,
      evidenceIds: idsOf(evidence),
      stepsCompleted,
      summary: allUntested
        ? "Diagnosis inconclusive: no signal measurements available for documented checks"
        : "Diagnosis inconclusive: all available tests completed without a decisive conclusion",
    };
  }

  return {
    sessionId: evidence.sessionId,
    status: "in-progress",
    ...(leading !== undefined ? { leadingHypothesis: leading } : {}),
    nextRecommendedTest: nextTest,
    hypotheses,
    evidenceCount: evidence.items.length,
    evidenceIds: idsOf(evidence),
    stepsCompleted,
    summary: `In progress: recommended next test is ${nextTest.test.signal} to evaluate "${nextTest.rationale}"`,
  };
}

/**
 * The uncertainty a candidate test removes, on the loop's published rule.
 *
 * A test is worth what its answer decides. Two honest components only — no
 * prior pretending to be a posterior:
 *
 *  1. the **owner's confidence** — a check that can move a leading hypothesis
 *     is worth more than one that can only move a trailing one, because it is
 *     the ranking a workshop would act on that is at stake;
 *  2. **+0.1 per competing hypothesis that carries a check on the same
 *     signal** — one measurement then speaks to several hypotheses at once,
 *     and that is precisely what makes a test *discriminating* instead of
 *     merely informative.
 *
 * Ties are broken in the order a technician experiences them: the cheaper
 * window first (a 5 s read before a 30 s drive cycle), then the higher-ranked
 * owner, then the package's check order. The order is stable, so a rerun with
 * unchanged evidence recommends the same test.
 */
function uncertaintyValue(
  owner: Hypothesis,
  check: HypothesisCheck,
  hypotheses: readonly Hypothesis[],
): { value: number; shared: string[] } {
  const shared = hypotheses
    .filter((h) => h.id !== owner.id && h.checks.some((c) => c.test.signal === check.test.signal))
    .map((h) => h.id);
  return { value: owner.confidence + 0.1 * shared.length, shared };
}

/**
 * Selects the test that reduces uncertainty the most.
 *
 * Every *undecided* documented check of every hypothesis is a candidate — not
 * just the leading hypothesis' first one (the old rule): a runner-up's check
 * on a signal several hypotheses share can out-score the leader's, because
 * that is where one measurement moves the most. The value and the rationale
 * travel with the recommendation, machine-readable, so an answer can say
 * *why* this test and not another instead of only *which*.
 */
function selectDiscriminatingTest(
  hypotheses: readonly Hypothesis[],
): DiscriminatingTest | undefined {
  let best:
    | {
        owner: Hypothesis;
        check: HypothesisCheck;
        value: number;
        shared: string[];
        rank: number;
        order: number;
      }
    | undefined;

  hypotheses.forEach((owner, rank) => {
    owner.checks.forEach((check, order) => {
      if (check.outcome !== "untested") return;
      const { value, shared } = uncertaintyValue(owner, check, hypotheses);
      const windowMs = check.test.windowMs ?? Number.MAX_SAFE_INTEGER;
      const better =
        best === undefined ||
        value > best.value ||
        (value === best.value &&
          (windowMs < (best.check.test.windowMs ?? Number.MAX_SAFE_INTEGER) ||
            (windowMs === (best.check.test.windowMs ?? Number.MAX_SAFE_INTEGER) &&
              (rank < best.rank || (rank === best.rank && order < best.order)))));
      if (better) best = { owner, check, value, shared, rank, order };
    });
  });

  const chosen = best;
  if (chosen === undefined) return undefined;
  const { owner, check, value, shared } = chosen;
  const rationale =
    `measuring ${check.test.signal} can decide "${owner.claim}" ` +
    `(confidence ${owner.confidence})` +
    (shared.length > 0
      ? ` and ${shared.length} competing hypothesis(es) on the same signal (${shared.join(", ")})`
      : "") +
    ` — uncertainty reduction ${value.toFixed(3)}`;
  return {
    hypothesisId: owner.id,
    test: check.test,
    rationale,
    discriminatesAgainst: shared,
    uncertaintyReduction: Number(value.toFixed(3)),
  };
}

/**
 * One loop step, made explicit: the state before, the state after the new
 * evidence, and the named diff between them.
 *
 * This is what turns "run another measurement" into a loop a machine can
 * audit — the caller records a measurement, feeds the re-collected evidence,
 * and receives *which* hypothesis moved from which verdict to which, and
 * which evidence items appeared or consolidated. A step that changed nothing
 * says so with an empty `changes` list instead of pretending to progress.
 *
 * `previous` is the state the caller holds (usually the last
 * {@link GuidedDiagnosisState}); `input` is what to evaluate now. `after` is
 * computed from `input` — the function does not re-read the world, it
 * explains the step between the two states.
 */
export function advanceGuidedDiagnosis(
  previous: GuidedDiagnosisState,
  input: GuidedDiagnosisInput,
): DiagnosisStep {
  const after = evaluateGuidedDiagnosis(input);
  const changes: DiagnosisTransition[] = [];

  const beforeById = new Map(previous.hypotheses.map((h) => [h.id, h]));
  for (const hypothesis of after.hypotheses) {
    const before = beforeById.get(hypothesis.id);
    if (before === undefined) {
      changes.push({
        kind: "outcome",
        hypothesisId: hypothesis.id,
        from: "absent",
        to: hypothesis.outcome,
      });
      continue;
    }
    if (before.outcome !== hypothesis.outcome) {
      changes.push({
        kind: "outcome",
        hypothesisId: hypothesis.id,
        from: before.outcome,
        to: hypothesis.outcome,
      });
    }
    // Confidences are rounded to three decimals at the rule's edge; compare
    // with the same tolerance the rounding promises instead of floating dust.
    if (Math.abs(before.confidence - hypothesis.confidence) > 1e-9) {
      changes.push({
        kind: "confidence",
        hypothesisId: hypothesis.id,
        from: before.confidence,
        to: hypothesis.confidence,
      });
    }
  }
  for (const hypothesis of previous.hypotheses) {
    if (!after.hypotheses.some((h) => h.id === hypothesis.id)) {
      changes.push({
        kind: "outcome",
        hypothesisId: hypothesis.id,
        from: hypothesis.outcome,
        to: "absent",
      });
    }
  }

  const afterIds = new Set(after.evidenceIds);
  const beforeIds = new Set(previous.evidenceIds);
  for (const id of previous.evidenceIds) {
    if (!afterIds.has(id)) changes.push({ kind: "evidence", itemId: id, change: "removed" });
  }
  for (const id of after.evidenceIds) {
    if (!beforeIds.has(id)) changes.push({ kind: "evidence", itemId: id, change: "added" });
  }

  return { before: previous, after, changes };
}

/**
 * Keep for call sites that only need the selection itself (tests, the
 * runtime's loop step) — the same rule the evaluation uses, named.
 */
export function nextDiscriminatingTest(
  hypotheses: readonly Hypothesis[],
): DiscriminatingTest | undefined {
  return selectDiscriminatingTest(hypotheses);
}

/**
 * Updates an EvidenceSet with a newly observed measurement, advancing the diagnosis loop.
 */
export function addMeasurementEvidence(
  evidence: EvidenceSet,
  measurement: {
    signalId: string;
    value: number;
    unit?: string;
    at?: string;
    ecuId?: string;
  },
): EvidenceSet {
  const at = measurement.at ?? nowIso();
  const unitStr = measurement.unit ? ` ${measurement.unit}` : "";
  const item: EvidenceItem = {
    id: evidenceItemId("signal", measurement.signalId, measurement.ecuId),
    kind: "signal",
    subject: measurement.signalId,
    statement: `Observed ${measurement.signalId} = ${measurement.value}${unitStr}`,
    at,
    ...(measurement.ecuId !== undefined ? { ecuId: measurement.ecuId } : {}),
    evidence: proven({
      origin: "ecu-response",
      at,
      ...(measurement.ecuId !== undefined ? { ecuId: measurement.ecuId } : {}),
    }),
  };

  // Replace existing observation for same signal or append
  const updatedItems = evidence.items.filter((i) => i.id !== item.id);
  updatedItems.push(item);

  return {
    ...evidence,
    items: updatedItems,
  };
}
