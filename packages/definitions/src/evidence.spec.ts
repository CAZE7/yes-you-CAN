/**
 * Evidence bookkeeping (AGENTS 11, 13, 31).
 *
 * Every number a vehicle candidate shows is produced here, so the rules are
 * tested on their own: how a criterion counts, what a partial criterion yields,
 * how far data of a given provenance may be trusted, and — the property the whole
 * ranking rests on — that ordering is total and deterministic.
 */

import assert from "node:assert/strict";
import { test } from "vitest";
import {
  EVIDENCE_WEIGHT,
  type Rankable,
  Tally,
  clamp01,
  compareByEvidence,
  provenanceTrust,
  round2,
  sameText,
  unique,
} from "./evidence.js";
import type { EvidenceKind } from "./evidence.js";

function rankable(overrides: Partial<Rankable> = {}): Rankable {
  return {
    score: 0.5,
    trust: 1,
    support: 5,
    matched: 2,
    conflicts: 0,
    packageKey: "acme@1.0.0",
    vehicleId: "a",
    ...overrides,
  };
}

test("every criterion has a positive weight", () => {
  const kinds = Object.keys(EVIDENCE_WEIGHT) as EvidenceKind[];
  assert.ok(kinds.length >= 16, `expected the full criterion list, found ${kinds.length}`);
  for (const kind of kinds) {
    assert.ok(EVIDENCE_WEIGHT[kind] > 0, `${kind} must carry weight`);
  }
});

test("hard evidence outweighs a claim a user typed in", () => {
  assert.ok(EVIDENCE_WEIGHT["part-number"] > EVIDENCE_WEIGHT["vin-wmi"]);
  assert.ok(EVIDENCE_WEIGHT["vin-wmi"] > EVIDENCE_WEIGHT["declared-model"]);
  assert.ok(EVIDENCE_WEIGHT["declared-model"] >= EVIDENCE_WEIGHT["declared-brand"]);
});

test("provenance decides trust, and placeholder data is trusted least", () => {
  assert.equal(provenanceTrust({ sourceType: "own", source: "x" }), 1);
  assert.equal(provenanceTrust({ sourceType: "standard", source: "x" }), 1);
  assert.equal(provenanceTrust({ sourceType: "licensed", source: "x", license: "MIT" }), 1);
  assert.equal(provenanceTrust({ sourceType: "community", source: "x" }), 0.8);
  assert.equal(provenanceTrust({ sourceType: "reverse-engineered", source: "x" }), 0.6);
  assert.equal(provenanceTrust({ sourceType: "example-placeholder", source: "x" }), 0.3);
});

test("weigh adds a supporting criterion with its full weight", () => {
  const tally = new Tally();
  tally.weigh("vin-wmi", "WVW", "WVW / WV1", "matches", true);
  assert.equal(tally.support, EVIDENCE_WEIGHT["vin-wmi"]);
  assert.equal(tally.conflict, 0);
  assert.equal(tally.evaluated, EVIDENCE_WEIGHT["vin-wmi"]);
  assert.deepEqual(tally.evidence, [
    {
      kind: "vin-wmi",
      observed: "WVW",
      expected: "WVW / WV1",
      weight: EVIDENCE_WEIGHT["vin-wmi"],
      reason: "matches",
    },
  ]);
  assert.deepEqual(tally.conflicts, []);
});

test("weigh adds a contradicting criterion to conflicts, not to evidence", () => {
  const tally = new Tally();
  tally.weigh("vin-wmi", "WDB", "WVW", "different manufacturer", false);
  assert.equal(tally.support, 0);
  assert.equal(tally.conflict, EVIDENCE_WEIGHT["vin-wmi"]);
  assert.equal(tally.evaluated, EVIDENCE_WEIGHT["vin-wmi"]);
  assert.equal(tally.conflicts.length, 1);
  assert.equal(tally.evidence.length, 0);
});

test("credit can only support — absence of a powertrain code proves nothing", () => {
  const tally = new Tally();
  tally.credit("powertrain-code", "EXA", "1.4 TSI", "engine code found");
  assert.equal(tally.support, EVIDENCE_WEIGHT["powertrain-code"]);
  assert.equal(tally.conflict, 0);
  assert.equal(tally.evaluated, EVIDENCE_WEIGHT["powertrain-code"]);
});

test("penalise reduces the score without pretending a criterion was evaluated", () => {
  const tally = new Tally();
  tally.weigh("vin-wmi", "WVW", "WVW", "matches", true);
  const evaluatedBefore = tally.evaluated;
  tally.penalise("unexpected-ecu", "2 ECU(s)", "only its own", "penalty");
  assert.equal(tally.evaluated, evaluatedBefore, "a penalty is not a declared criterion");
  assert.equal(tally.conflict, EVIDENCE_WEIGHT["unexpected-ecu"]);
  assert.equal(tally.conflicts[0]?.kind, "unexpected-ecu");
});

test("creditFraction grants the share of the criterion that was met", () => {
  const tally = new Tally();
  tally.creditFraction("ecu-coverage", 0.5, "1 of 2", "2 of 2", "half answered");
  assert.equal(tally.support, EVIDENCE_WEIGHT["ecu-coverage"] * 0.5);
  assert.equal(tally.evaluated, EVIDENCE_WEIGHT["ecu-coverage"]);
  assert.equal(tally.evidence[0]?.weight, 1.5);
});

test("creditFraction clamps an impossible ratio", () => {
  const over = new Tally();
  over.creditFraction("ecu-coverage", 2, "4 of 2", "2 of 2", "more answered than expected");
  assert.equal(over.support, EVIDENCE_WEIGHT["ecu-coverage"]);
  const under = new Tally();
  under.creditFraction("ecu-coverage", -1, "0 of 2", "2 of 2", "none answered");
  assert.equal(under.support, 0);
  assert.equal(under.evaluated, EVIDENCE_WEIGHT["ecu-coverage"]);
});

test("score is the share of evaluated criteria that supports, clamped to 0…1", () => {
  const all = new Tally();
  all.weigh("vin-wmi", "WVW", "WVW", "ok", true);
  all.weigh("part-number", "PN-1", "PN-1", "ok", true);
  assert.equal(all.score(), 1);

  const mixed = new Tally();
  mixed.weigh("vin-wmi", "WVW", "WVW", "ok", true);
  mixed.weigh("vin-vds", "ZZA1J", "ZZZ..", "no", false);
  assert.equal(mixed.score(), 0.2, "(3 − 2) of 5 evaluated");

  const cancelled = new Tally();
  cancelled.weigh("vin-wmi", "WVW", "WVW", "ok", true);
  cancelled.weigh("vin-wmi", "WDB", "WVW", "no", false);
  assert.equal(cancelled.score(), 0, "the same criterion for and against cancels out");

  const nothing = new Tally();
  assert.equal(nothing.score(), 0, "no observation, no score");

  const penalised = new Tally();
  penalised.weigh("declared-brand", "X", "Y", "no", false);
  penalised.penalise("unexpected-ecu", "1", "0", "penalty");
  assert.equal(penalised.score(), 0, "a negative share clamps to zero, never below");
});

test("weights are rounded to two decimals so a report cannot show float noise", () => {
  const tally = new Tally();
  tally.creditFraction("ecu-coverage", 1 / 3, "1 of 3", "3 of 3", "one answered");
  const weights = tally.weights();
  assert.equal(weights.support, 1);
  assert.equal(weights.evaluated, 3);
  assert.equal(tally.score(), 0.33);
});

test("ordering follows evidence, then trust, then strength, then coverage, then conflicts", () => {
  const base = rankable();
  assert.ok(compareByEvidence(rankable({ score: 0.9 }), base) < 0, "higher score first");
  assert.ok(compareByEvidence(rankable({ trust: 0.3 }), base) > 0, "lower trust last");
  assert.ok(compareByEvidence(rankable({ support: 9 }), base) < 0, "more evidence first");
  assert.ok(compareByEvidence(rankable({ matched: 5 }), base) < 0, "better coverage first");
  assert.ok(compareByEvidence(rankable({ conflicts: 2 }), base) > 0, "fewer conflicts first");
  assert.ok(
    compareByEvidence(rankable({ packageKey: "aaa@1.0.0" }), base) < 0,
    "package key breaks the remaining tie",
  );
  assert.ok(
    compareByEvidence(rankable({ vehicleId: "zzz" }), base) > 0,
    "the vehicle id is the last tie-break, lower first",
  );
});

test("identical candidates compare equal, so a sort cannot reorder them at random", () => {
  assert.equal(compareByEvidence(rankable(), rankable()), 0);
  assert.equal(compareByEvidence(rankable({ vehicleId: "z" }), rankable({ vehicleId: "z" })), 0);
});

test("text helpers behave the way the resolver relies on", () => {
  assert.ok(sameText(" VwW ", "vww"));
  assert.ok(!sameText("VW", "VWV"));
  assert.equal(clamp01(-0.5), 0);
  assert.equal(clamp01(0.5), 0.5);
  assert.equal(clamp01(1.5), 1);
  assert.equal(round2(1.005), 1);
  assert.equal(round2(1.2345), 1.23);
  assert.deepEqual(unique(["a", "a", "b"]), ["a", "b"]);
  assert.deepEqual(unique([]), []);
});
