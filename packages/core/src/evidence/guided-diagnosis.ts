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
  type DiscriminatingTest,
  type EvidenceItem,
  type EvidenceSet,
  evidenceItemId,
  type GuidedDiagnosisState,
  type Hypothesis,
  proven,
} from "@vdp/diagnostic-ir";
import { nowIso } from "@vdp/shared";
import type { EvidenceDtc } from "./collect.js";
import { rankHypotheses, type SamplePoint } from "./hypotheses.js";

export interface GuidedDiagnosisInput {
  evidence: EvidenceSet;
  dtcs: readonly EvidenceDtc[];
  samplesOf?: (signalId: string) => readonly SamplePoint[];
  stepsCompleted?: number;
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
    stepsCompleted,
    summary: `In progress: recommended next test is ${nextTest.test.signal} to evaluate "${nextTest.rationale}"`,
  };
}

/**
 * Selects the most discriminating test among hypotheses.
 * Prioritizes tests that confirm or refute the top-ranked hypothesis or
 * distinguish between competing top hypotheses.
 */
function selectDiscriminatingTest(
  hypotheses: readonly Hypothesis[],
): DiscriminatingTest | undefined {
  // Examine the top two hypotheses to find a discriminating test
  const top = hypotheses[0];
  const runnerUp = hypotheses[1];

  if (top?.nextTest) {
    const competitorsWithSameSignal = hypotheses
      .filter(
        (h) => h.id !== top.id && h.checks.some((c) => c.test.signal === top.nextTest?.signal),
      )
      .map((h) => h.id);

    const rationale =
      competitorsWithSameSignal.length > 0
        ? `Measuring ${top.nextTest.signal} directly tests "${top.claim}" and differentiates from competing hypotheses (${competitorsWithSameSignal.join(", ")})`
        : `Measuring ${top.nextTest.signal} verifies expected condition "${top.nextTest.expect}" for ${top.claim}`;

    return {
      hypothesisId: top.id,
      test: top.nextTest,
      rationale,
      ...(competitorsWithSameSignal.length > 0
        ? { discriminatesAgainst: competitorsWithSameSignal }
        : {}),
    };
  }

  if (runnerUp?.nextTest) {
    return {
      hypothesisId: runnerUp.id,
      test: runnerUp.nextTest,
      rationale: `Measuring ${runnerUp.nextTest.signal} evaluates runner-up hypothesis "${runnerUp.claim}"`,
    };
  }

  // Fallback to any hypothesis with a pending nextTest
  for (const h of hypotheses) {
    if (h.nextTest) {
      return {
        hypothesisId: h.id,
        test: h.nextTest,
        rationale: `Testing ${h.nextTest.signal} for "${h.claim}"`,
      };
    }
  }

  return undefined;
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
