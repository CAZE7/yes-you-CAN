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

function mockDtc(patterns: DtcKnowledgePattern[]): EvidenceDtc {
  return {
    code: "P0420",
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

  test("starts in-progress with a discriminating next test recommended", () => {
    const evidence = mockEvidenceSet();
    const dtcs = [mockDtc([patternCatalyst, patternExhaustLeak])];

    const state = evaluateGuidedDiagnosis({ evidence, dtcs });

    assert.equal(state.status, "in-progress");
    assert.equal(state.hypotheses.length, 2);
    assert.ok(state.nextRecommendedTest);
    assert.equal(state.nextRecommendedTest?.test.signal, "engine.short_term_fuel_trim");
    assert.equal(state.nextRecommendedTest?.hypothesisId, "cat-efficiency");
    assert.match(
      state.nextRecommendedTest?.rationale ?? "",
      /Measuring engine\.short_term_fuel_trim/,
    );
  });

  test("addMeasurementEvidence updates the evidence set with proven observation", () => {
    const initialEvidence = mockEvidenceSet();
    assert.equal(initialEvidence.items.length, 1);

    const updated = addMeasurementEvidence(initialEvidence, {
      signalId: "engine.short_term_fuel_trim",
      value: 1.5,
      unit: "%",
      ecuId: "engine",
    });

    assert.equal(updated.items.length, 2);
    const added = updated.items.find((i) => i.subject === "engine.short_term_fuel_trim");
    assert.ok(added);
    assert.equal(added?.evidence.kind, "proven");
    assert.match(added?.statement ?? "", /Observed engine\.short_term_fuel_trim = 1\.5 %/);
  });

  test("advances diagnosis to resolved when leading hypothesis is confirmed", () => {
    const evidence = mockEvidenceSet();
    const dtcs = [mockDtc([patternCatalyst, patternExhaustLeak])];

    const now = Date.now();
    const samples = (signalId: string) => {
      if (signalId === "engine.short_term_fuel_trim") {
        // Samples inside bounds (-5..5): confirms catalyst pattern
        return [
          { at: new Date(now - 3000).toISOString(), value: 0.5 },
          { at: new Date(now - 1000).toISOString(), value: 1.2 },
        ];
      }
      if (signalId === "engine.coolant_temperature") {
        // Coolant is 60 C (outside 80..110 bounds): refutes exhaust leak
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
    // Fuel trim is -15% (outside -5..5): refutes catalyst
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
