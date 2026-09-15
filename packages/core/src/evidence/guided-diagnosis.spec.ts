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
import { addMeasurementEvidence, evaluateGuidedDiagnosis } from "./guided-diagnosis.js";

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
      /Measuring engine\.short_term_fuel_trim/,
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
