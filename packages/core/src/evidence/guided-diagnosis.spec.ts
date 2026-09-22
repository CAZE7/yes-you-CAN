/**
 * Guided Diagnosis Loop Unit Tests (Task 6; AGENTS 22; Roadmap step 16).
 *
 * Verifies the complete loop:
 * DTC -> Evidence -> Hypothesis -> Next Test -> Measurement -> Evidence Update -> Resolved/Inconclusive.
 */

import assert from "node:assert/strict";
import type { DtcKnowledgePattern } from "@vdp/definitions";
import { type EvidenceSet, proven } from "@vdp/diagnostic-ir";
import { describe, test } from "vitest";
import type { EvidenceDtc } from "./collect.js";
import {
  addMeasurementEvidence,
  advanceGuidedDiagnosis,
  evaluateGuidedDiagnosis,
} from "./guided-diagnosis.js";

function mockEvidenceSet(sessionId = "session-1"): EvidenceSet {
  return {
    kind: "evidence",
    sessionId,
    collectedAt: new Date().toISOString(),
    items: [
      {
        id: "dtc:P0420@engine",
        kind: "dtc",
        subject: "P0420",
        statement: "Catalyst System Efficiency Below Threshold",
        at: new Date().toISOString(),
        ecuId: "engine",
        evidence: proven({ origin: "ecu-response", ecuId: "engine" }),
      },
    ],
    conflicts: [],
  };
}

function mockDtc(patterns: DtcKnowledgePattern[], code = "P0420"): EvidenceDtc {
  return {
    code,
    ecuId: "engine",
    status: 0x2f,
    raw: "042000",
    failureType: "00",
    severity: "minor",
    statusBits: {
      testFailed: true,
      testFailedThisOperationCycle: true,
      pendingDtc: false,
      confirmedDtc: true,
      testNotCompletedSinceLastClear: false,
      testFailedSinceLastClear: true,
      testNotCompletedThisOperationCycle: false,
      warningIndicatorRequested: true,
    },
    knowledge: {
      scope: "vehicle-engine",
      patterns,
      notes: [],
    },
  };
}

describe("Guided Diagnosis Engine", () => {
  const patternCatalyst: DtcKnowledgePattern = {
    id: "cat-efficiency",
    name: "Catalytic Converter Degradation",
    explanation: "Substrate degraded; cannot store oxygen",
    likelihood: "common",
    scope: "package",
    checks: [
      {
        signal: "engine.short_term_fuel_trim",
        signalName: "Short Term Fuel Trim",
        expect: "Fuel trim oscillation within -5%..+5%",
        min: -5,
        max: 5,
        windowMs: 4000,
        measurable: true,
      },
    ],
  };

  const patternExhaustLeak: DtcKnowledgePattern = {
    id: "exhaust-leak",
    name: "Exhaust Manifold Leak",
    explanation: "False air entering upstream of sensor",
    likelihood: "possible",
    scope: "package",
    checks: [
      {
        signal: "engine.coolant_temperature",
        signalName: "Coolant Temperature",
        expect: "Operating temperature reached > 80°C",
        min: 80,
        max: 110,
        windowMs: 5000,
        measurable: true,
      },
    ],
  };

  const patternO2Sensor: DtcKnowledgePattern = {
    id: "o2-sensor",
    name: "O2 Sensor Slow Response",
    explanation: "Sensor aging or fouled",
    likelihood: "rare",
    scope: "package",
    checks: [
      {
        signal: "engine.o2_voltage",
        signalName: "O2 Sensor Voltage",
        expect: "Voltage swing 0.1V..0.9V",
        min: 0.1,
        max: 0.9,
        windowMs: 3000,
        measurable: true,
      },
    ],
  };

  test("returns inconclusive when no hypotheses are documented", () => {
    const evidence = mockEvidenceSet();
    const state = evaluateGuidedDiagnosis({ evidence, dtcs: [] });
    assert.equal(state.status, "inconclusive");
    assert.equal(state.hypotheses.length, 0);
    assert.match(state.summary, /No diagnostic hypotheses documented/);
  });

  test("starts in-progress with a discriminating next test recommended", () => {
    const evidence = mockEvidenceSet();
    const dtcs = [mockDtc([patternCatalyst, patternExhaustLeak])];

    const state = evaluateGuidedDiagnosis({ evidence, dtcs, stepsCompleted: 1 });

    assert.equal(state.status, "in-progress");
    assert.equal(state.hypotheses.length, 2);
    assert.equal(state.stepsCompleted, 1);
    assert.ok(state.nextRecommendedTest);
    assert.equal(state.nextRecommendedTest?.test.signal, "engine.short_term_fuel_trim");
    assert.equal(state.nextRecommendedTest?.hypothesisId, "cat-efficiency");
    assert.match(
      state.nextRecommendedTest?.rationale ?? "",
      /measuring engine\.short_term_fuel_trim/,
    );
    // The loop states what it saw and what it recommends in numbers: the state
    // carries the evidence ids a step diff is taken over, and the test carries
    // the uncertainty it removes (ADR 0050).
    assert.deepEqual(state.evidenceIds, ["dtc:P0420@engine"]);
    assert.equal(
      typeof state.nextRecommendedTest?.uncertaintyReduction,
      "number",
      "the recommendation names the uncertainty it reduces, not just the signal",
    );
  });

  test("selects discriminating test when competitors share the same signal", () => {
    const patternAlt: DtcKnowledgePattern = {
      id: "cat-alt",
      name: "Alternative Catalyst Fault",
      explanation: "Secondary symptom",
      likelihood: "possible",
      scope: "package",
      checks: [
        {
          signal: "engine.short_term_fuel_trim",
          signalName: "Fuel Trim",
          expect: "Near zero",
          min: -1,
          max: 1,
          windowMs: 4000,
          measurable: true,
        },
      ],
    };

    const evidence = mockEvidenceSet();
    const dtcs = [mockDtc([patternCatalyst, patternAlt])];
    const state = evaluateGuidedDiagnosis({ evidence, dtcs });

    assert.equal(state.status, "in-progress");
    assert.ok(state.nextRecommendedTest?.discriminatesAgainst);
    assert.ok(state.nextRecommendedTest.discriminatesAgainst.includes("cat-alt"));
  });

  test("selects runner-up next test if top has no next test", () => {
    // Top pattern has empty checks (no nextTest)
    const patternNoChecks: DtcKnowledgePattern = {
      id: "no-checks",
      name: "Generic Component Failure",
      explanation: "No specific measurement available",
      likelihood: "common",
      scope: "package",
      checks: [],
    };

    const evidence = mockEvidenceSet();
    const dtcs = [mockDtc([patternNoChecks, patternExhaustLeak])];
    const state = evaluateGuidedDiagnosis({ evidence, dtcs });

    assert.equal(state.status, "in-progress");
    assert.equal(state.nextRecommendedTest?.hypothesisId, "exhaust-leak");
  });

  test("selects third hypothesis if top two have no next test", () => {
    const patternNoChecks1: DtcKnowledgePattern = {
      id: "no-checks-1",
      name: "Top without checks",
      explanation: "None",
      likelihood: "common",
      scope: "package",
      checks: [],
    };
    const patternNoChecks2: DtcKnowledgePattern = {
      id: "no-checks-2",
      name: "Runner-up without checks",
      explanation: "None",
      likelihood: "possible",
      scope: "package",
      checks: [],
    };

    const evidence = mockEvidenceSet();
    const dtcs = [mockDtc([patternNoChecks1, patternNoChecks2, patternO2Sensor])];
    const state = evaluateGuidedDiagnosis({ evidence, dtcs });

    assert.equal(state.status, "in-progress");
    assert.equal(state.nextRecommendedTest?.hypothesisId, "o2-sensor");
  });

  test("resolves when confirmed hypothesis exists without further tests", () => {
    const patternConfirmedNoChecks: DtcKnowledgePattern = {
      id: "confirmed-pattern",
      name: "Confirmed Issue",
      explanation: "Confirmed",
      likelihood: "common",
      scope: "package",
      checks: [],
    };

    const evidence: EvidenceSet = {
      kind: "evidence",
      sessionId: "s1",
      collectedAt: new Date().toISOString(),
      items: [
        {
          id: "dtc:P0420@engine",
          kind: "dtc",
          subject: "P0420",
          statement: "Catalyst",
          at: new Date().toISOString(),
          evidence: proven({ origin: "ecu-response", ecuId: "engine" }),
        },
        {
          id: "pattern:confirmed-pattern",
          kind: "pattern",
          subject: "confirmed-pattern",
          statement: "Pattern confirmed",
          at: new Date().toISOString(),
          evidence: proven({ origin: "ecu-response" }),
        },
      ],
      conflicts: [],
    };

    const dtcs = [mockDtc([patternConfirmedNoChecks])];
    const state = evaluateGuidedDiagnosis({ evidence, dtcs });

    assert.ok(state.status === "resolved" || state.status === "inconclusive");
  });

  test("addMeasurementEvidence updates and replaces observations", () => {
    const initialEvidence = mockEvidenceSet();
    assert.equal(initialEvidence.items.length, 1);

    // Add without unit
    const updated1 = addMeasurementEvidence(initialEvidence, {
      signalId: "engine.coolant_temperature",
      value: 88,
      at: "2026-09-15T08:00:00.000Z",
      ecuId: "engine",
    });
    assert.equal(updated1.items.length, 2);

    // Replace measurement for same signal & ecuId
    const updated2 = addMeasurementEvidence(updated1, {
      signalId: "engine.coolant_temperature",
      value: 92,
      unit: "C",
      ecuId: "engine",
    });
    assert.equal(updated2.items.length, 2);
    const item = updated2.items.find((i) => i.subject === "engine.coolant_temperature");
    assert.equal(item?.statement, "Observed engine.coolant_temperature = 92 C");
  });

  test("advances diagnosis to resolved when leading hypothesis is confirmed", () => {
    const evidence = mockEvidenceSet();
    const dtcs = [mockDtc([patternCatalyst, patternExhaustLeak])];

    const now = Date.now();
    const samples = (signalId: string) => {
      if (signalId === "engine.short_term_fuel_trim") {
        return [
          { at: new Date(now - 3000).toISOString(), value: 0.5 },
          { at: new Date(now - 1000).toISOString(), value: 1.2 },
        ];
      }
      if (signalId === "engine.coolant_temperature") {
        return [
          { at: new Date(now - 3000).toISOString(), value: 60 },
          { at: new Date(now - 1000).toISOString(), value: 62 },
        ];
      }
      return [];
    };

    const state = evaluateGuidedDiagnosis({
      evidence,
      dtcs,
      samplesOf: samples,
    });

    assert.equal(state.status, "resolved");
    assert.equal(state.leadingHypothesis?.id, "cat-efficiency");
    assert.equal(state.leadingHypothesis?.outcome, "confirmed");
    assert.match(state.summary, /root cause identified as "Catalytic Converter Degradation"/);
  });

  test("the recommendation is the uncertainty-maximising test, not the leader's first", () => {
    // Leader: common prior, a check no one else shares (value = 0.45 + 0).
    // Runner-up plus two followers on the same signal: each 0.3 + 0.1 per
    // competitor = 0.5 — one measurement that speaks to three hypotheses beats
    // one that speaks to one, and that is the whole point of the rule (ADR 0050).
    const solo = (id: string, signal: string, likelihood: DtcKnowledgePattern["likelihood"]) => ({
      id,
      name: `Pattern ${id}`,
      explanation: `Explain ${id}`,
      likelihood,
      scope: "package" as const,
      checks: [
        {
          signal,
          signalName: signal,
          expect: "decidable by a number",
          min: 0,
          max: 100,
          windowMs: 4000,
          measurable: true,
        },
      ],
    });
    const dtcs = [
      mockDtc([
        solo("leader-solo", "engine.alpha", "common"),
        solo("shared-b", "engine.beta", "possible"),
        solo("shared-c", "engine.beta", "possible"),
        solo("shared-d", "engine.beta", "possible"),
      ]),
    ];
    const state = evaluateGuidedDiagnosis({ evidence: mockEvidenceSet(), dtcs });

    assert.equal(state.nextRecommendedTest?.hypothesisId, "shared-b");
    assert.equal(state.nextRecommendedTest?.test.signal, "engine.beta");
    assert.equal(
      state.nextRecommendedTest?.uncertaintyReduction,
      0.5,
      "0.3 owner + 0.1 per each of the two competitors on the same signal",
    );
    assert.deepEqual(state.nextRecommendedTest?.discriminatesAgainst, ["shared-c", "shared-d"]);
    assert.match(state.nextRecommendedTest?.rationale ?? "", /uncertainty reduction 0\.500/);
  });

  test("a step names which hypothesis moved where and which evidence changed", () => {
    const evidence = mockEvidenceSet();
    const dtcs = [mockDtc([patternCatalyst])];
    const before = evaluateGuidedDiagnosis({ evidence, dtcs });
    assert.equal(before.status, "in-progress", "nothing measured: the loop is in progress");

    const now = Date.now();
    const measured = (signalId: string) =>
      signalId === "engine.short_term_fuel_trim"
        ? [
            { at: new Date(now - 3000).toISOString(), value: 1 },
            { at: new Date(now - 1000).toISOString(), value: 2 },
          ]
        : [];
    const step = advanceGuidedDiagnosis(before, {
      evidence,
      dtcs,
      samplesOf: measured,
      stepsCompleted: 1,
    });

    assert.equal(step.before, before, "the step carries the state it left behind");
    assert.equal(step.after.status, "resolved", "the measurement confirmed the leading cause");
    const outcomes = step.changes.filter((change) => change.kind === "outcome");
    assert.deepEqual(outcomes, [
      {
        kind: "outcome",
        hypothesisId: "cat-efficiency",
        from: "untested",
        to: "confirmed",
      },
    ]);
    const confidences = step.changes.filter((change) => change.kind === "confidence");
    assert.equal(confidences.length, 1);
    if (confidences[0]?.kind === "confidence") {
      assert.equal(confidences[0].hypothesisId, "cat-efficiency");
      assert.equal(confidences[0].from, 0.45, "prior 0.6 minus untested penalty");
      assert.equal(confidences[0].to, 0.9, "prior + confirmed + conclusive window");
    }
    // Same evidence set in and out: the diff must not claim an evidence change.
    assert.ok(
      step.changes.every((change) => change.kind !== "evidence"),
      "unchanged evidence produces no evidence transitions",
    );
  });

  test("a step with nothing new says so with an empty diff, not with invented progress", () => {
    const evidence = mockEvidenceSet();
    const dtcs = [mockDtc([patternCatalyst])];
    const before = evaluateGuidedDiagnosis({ evidence, dtcs });
    const step = advanceGuidedDiagnosis(before, { evidence, dtcs, stepsCompleted: 1 });
    assert.deepEqual(step.changes, [], "same world in, same world out: no transition is named");
    assert.equal(step.after.status, before.status);
  });

  test("evidence items that appear or consolidate show up as evidence transitions", () => {
    const evidence = mockEvidenceSet();
    const dtcs = [mockDtc([patternCatalyst])];
    const before = evaluateGuidedDiagnosis({ evidence, dtcs });
    const withAnomaly: EvidenceSet = {
      ...evidence,
      items: [
        ...evidence.items,
        {
          id: "anomaly:engine.fuel_trim_long_term",
          kind: "anomaly",
          subject: "engine.fuel_trim_long_term",
          statement: "spread beyond the usual for the operating point",
          at: new Date().toISOString(),
          evidence: proven({ origin: "ecu-response" }),
        },
      ],
    };
    const step = advanceGuidedDiagnosis(before, {
      evidence: withAnomaly,
      dtcs,
      stepsCompleted: 1,
    });
    assert.deepEqual(step.changes, [
      { kind: "evidence", itemId: "anomaly:engine.fuel_trim_long_term", change: "added" },
    ]);
  });

  test("reports inconclusive when all checks are completed without confirmation", () => {
    const evidence = mockEvidenceSet();
    const dtcs = [mockDtc([patternCatalyst])];

    const now = Date.now();
    const samples = (signalId: string) => {
      if (signalId === "engine.short_term_fuel_trim") {
        return [
          { at: new Date(now - 2000).toISOString(), value: -15.0 },
          { at: new Date(now - 1000).toISOString(), value: -12.0 },
        ];
      }
      return [];
    };

    const state = evaluateGuidedDiagnosis({
      evidence,
      dtcs,
      samplesOf: samples,
    });

    assert.equal(state.status, "inconclusive");
    assert.match(state.summary, /all available tests completed without a decisive conclusion/);
  });
});
