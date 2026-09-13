/**
 * The analysis input the workbench builds (AGENTS 22, ADR 0026).
 *
 * The provider contract is deliberately blunt about two things: which car the session
 * was determined to be, and where each code's wording came from. Both are assembled
 * here, from the read models the backend already holds — so the rules worth testing are
 * the *omissions*: nothing invented when nothing was determined, no `measure` when no
 * check is documented, and never the VIN (the HTTP provider forwards this object).
 */

import assert from "node:assert/strict";
import type { VehicleSummary } from "@vdp/domain";
import type { VehicleSessionData } from "@vdp/storage";
import { describe, test } from "vitest";
import { type AnalysisDtcSource, analysisDtcOf, analysisVehicleOf } from "../src/analysis-input.js";

type Determination = VehicleSessionData["determination"];

function determination(overrides: Partial<NonNullable<Determination>> = {}): Determination {
  const match = {
    oem: "simulator",
    packageVersion: "1.0.0",
    vehicleId: "virtual-vehicle",
    brand: "Virtual",
    model: "Simulator vehicle",
    score: 1,
    trust: 1,
    provenanceType: "own",
    engineIds: ["sim-petrol"],
    gearboxIds: [],
    ecus: { expected: 3, matched: 3, missing: [] },
    evidence: [],
    conflicts: [],
  };
  return {
    resolvedAt: "2026-09-14T00:00:00.000Z",
    match,
    notes: [],
    unexplained: [],
    alternatives: [],
    ...overrides,
  };
}

const MATCH_WEAK = {
  oem: "simulator",
  packageVersion: "1.0.0",
  vehicleId: "virtual-vehicle",
  brand: "Virtual",
  model: "Simulator vehicle",
  score: 0.5,
  trust: 0.6,
  provenanceType: "own",
  engineIds: ["sim-petrol"],
  gearboxIds: [],
  ecus: { expected: 3, matched: 3, missing: [] },
  evidence: [],
  conflicts: [],
};

const identity: VehicleSummary = {
  vehicleId: "virtual-vehicle",
  brand: "Virtual",
  model: "Simulator vehicle",
  modelYear: 2003,
  description: "Virtual Simulator vehicle 2003",
};

describe("analysisVehicleOf", () => {
  test("nothing measured and nothing concluded means no vehicle block at all", () => {
    assert.equal(analysisVehicleOf(undefined, undefined), undefined);
  });

  test("the VIN stays out of the object a provider may send off the box", () => {
    const vehicle = analysisVehicleOf({ ...identity, vin: "1HGCM82633A004352" }, determination());
    assert.equal(vehicle?.vin, undefined);
    assert.equal(vehicle?.brand, "Virtual");
    assert.equal(vehicle?.modelYear, 2003);
  });

  test("the strength of the determination travels with the car", () => {
    const vehicle = analysisVehicleOf(identity, determination({ match: { ...MATCH_WEAK } }));
    assert.equal(vehicle?.vehicleId, "virtual-vehicle");
    assert.equal(vehicle?.score, 0.5);
    assert.equal(vehicle?.trust, 0.6);
    assert.equal(vehicle?.provenanceType, "own");
  });

  test("an unresolved determination contributes its reason and nothing else", () => {
    const unresolved = determination({
      match: undefined,
      reason: "no package declares vehicle definitions",
    });
    const vehicle = analysisVehicleOf(undefined, unresolved);
    assert.deepEqual(vehicle, { unresolvedReason: "no package declares vehicle definitions" });
  });

  test("an empty determination object is not turned into an empty vehicle block", () => {
    // A session that never resolved has `determination === undefined`; a determination
    // without a match has a reason. Either way the block is absent rather than a
    // present-but-empty object, which a provider could misread as "known, said nothing".
    assert.equal(analysisVehicleOf({ description: "" } as VehicleSummary, undefined), undefined);
  });
});

describe("analysisDtcOf", () => {
  const bare: AnalysisDtcSource = {
    code: "P0420",
    description: "Catalyst efficiency below threshold",
    severity: "major",
    ecu: "Engine",
  };

  test("a code without knowledge stays without scope or measure", () => {
    const dtc = analysisDtcOf(bare);
    assert.deepEqual(dtc, {
      code: "P0420",
      description: "Catalyst efficiency below threshold",
      severity: "major",
      ecu: "Engine",
    });
    assert.equal("scope" in dtc, false, "absent, not empty");
    assert.equal("measure" in dtc, false);
  });

  test("the evaluable check is preferred over the first one listed", () => {
    const dtc = analysisDtcOf({
      ...bare,
      hint: "Rule out leaks first.",
      knowledge: {
        scope: "vehicle-engine",
        conditions: "closed loop, above 80 °C",
        patterns: [
          {
            checks: [
              { signalId: "engine.load", name: "Engine load", expect: "steady", measurable: false },
              {
                signalId: "cat.temp",
                name: "Catalyst temperature",
                expect: "above 600",
                min: 600,
                windowMs: 5000,
                measurable: true,
              },
            ],
          },
        ],
      },
    });
    assert.equal(dtc.scope, "vehicle-engine");
    assert.equal(dtc.conditions, "closed loop, above 80 °C");
    assert.equal(dtc.hint, "Rule out leaks first.");
    assert.deepEqual(dtc.measure, {
      signal: "cat.temp",
      name: "Catalyst temperature",
      expect: "above 600",
      min: 600,
      windowMs: 5000,
      measurable: true,
    });
  });

  test("a judgement check is still handed over, marked as not measurable", () => {
    const dtc = analysisDtcOf({
      ...bare,
      knowledge: {
        scope: "package",
        patterns: [
          {
            checks: [
              {
                signalId: "abs.speed_left",
                name: "Wheel speed front left",
                expect: "plausible",
                min: 45,
                max: 55,
                measurable: false,
              },
            ],
          },
        ],
      },
    });
    assert.equal(dtc.measure?.measurable, false);
    assert.equal(dtc.measure?.max, 55);
  });

  test("a name equal to the signal id is not repeated", () => {
    const dtc = analysisDtcOf({
      ...bare,
      knowledge: {
        scope: "vehicle",
        patterns: [
          { checks: [{ signalId: "oil.t", name: "oil.t", expect: "warm", measurable: true }] },
        ],
      },
    });
    assert.equal("name" in (dtc.measure ?? {}), false);
    assert.equal(dtc.measure?.signal, "oil.t");
  });

  test("a pattern list without checks yields scope but no measure", () => {
    const dtc = analysisDtcOf({
      ...bare,
      knowledge: { scope: "vehicle", patterns: [{ checks: [] }] },
    });
    assert.equal(dtc.scope, "vehicle");
    assert.equal(dtc.measure, undefined);
  });
});
