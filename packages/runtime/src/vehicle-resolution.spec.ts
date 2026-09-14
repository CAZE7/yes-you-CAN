import assert from "node:assert/strict";
import type {
  EcuSummary,
  VehicleCandidateRef,
  VehicleResolutionRef,
  VehicleSummary,
} from "@vdp/domain";
import { unresolvedVehicleResolution } from "@vdp/domain";
import { describe, test } from "vitest";
import {
  declaredOf,
  dtcVehicleContextOf,
  resolveVehicleQuery,
  splitDefinitionEcuId,
  vehicleDeterminationOf,
} from "./vehicle-resolution.js";

/** An ECU summary with only the fields the mapping actually reads set. */
function ecu(
  fields: Partial<EcuSummary> & Pick<EcuSummary, "ecuId" | "txId" | "rxId">,
): EcuSummary {
  return {
    name: fields.ecuId,
    protocol: "uds",
    extended: false,
    reachable: true,
    sessionType: 3,
    p2Ms: 50,
    dtcCount: 0,
    supportedServices: [],
    capabilities: [],
    identification: [],
    ...fields,
  };
}

const ENGINE = ecu({
  ecuId: "ecu_1",
  definitionEcuId: "simulator:engine",
  txId: 0x7e0,
  rxId: 0x7e8,
  identification: [
    { label: "VIN", value: "1HGCM82633A004352", did: 0xf190 },
    { label: "Spare part number", value: "ENGINE-f187", did: 0xf187 },
    { label: "ECU serial number", value: "ENGINE-f18c", did: 0xf18c },
  ],
});

describe("splitDefinitionEcuId", () => {
  test("splits the namespaced reference the engine stores", () => {
    assert.deepEqual(splitDefinitionEcuId("generic:engine"), { oem: "generic", ecu: "engine" });
    assert.deepEqual(splitDefinitionEcuId("engine"), { ecu: "engine" });
    assert.equal(splitDefinitionEcuId(undefined), undefined);
    assert.equal(splitDefinitionEcuId(""), undefined, "an empty reference names no ECU");
  });

  test("the first colon separates the package from the ECU id", () => {
    assert.deepEqual(splitDefinitionEcuId("vag:gateway:1f"), { oem: "vag", ecu: "gateway:1f" });
  });
});

describe("declaredOf", () => {
  test("nothing known declares nothing", () => {
    assert.deepEqual(declaredOf(undefined, undefined), {});
    assert.deepEqual(declaredOf({ description: "unknown vehicle" }, undefined), {});
  });

  test("a brand is a claim, a raw manufacturer string only a fallback", () => {
    const identity: VehicleSummary = {
      manufacturer: "Honda of America Mfg.",
      brand: "Honda",
      description: "Honda",
    };
    assert.deepEqual(declaredOf(identity, undefined), { brand: "Honda" });
    assert.deepEqual(
      declaredOf({ manufacturer: "Honda of America Mfg.", description: "Honda" }, undefined),
      { brand: "Honda of America Mfg." },
      "without a brand the manufacturer is the only claim available",
    );
  });

  test("everything the identity knows about the car is declared", () => {
    const identity: VehicleSummary = {
      brand: "Honda",
      model: "Accord",
      platform: "SIM-1",
      modelYear: 2003,
      description: "Honda Accord",
    };
    assert.deepEqual(declaredOf(identity, undefined), {
      brand: "Honda",
      model: "Accord",
      platform: "SIM-1",
      modelYear: 2003,
    });
  });

  test("what the operator says overrides what the session believes", () => {
    const identity: VehicleSummary = {
      brand: "Honda",
      model: "Accord",
      platform: "SIM-1",
      modelYear: 2003,
      description: "Honda Accord",
    };
    assert.deepEqual(
      declaredOf(identity, { declared: { oem: "simulator", model: "Simulator vehicle" } }),
      {
        oem: "simulator",
        brand: "Honda",
        model: "Simulator vehicle",
        platform: "SIM-1",
        modelYear: 2003,
      },
      "fields the operator did not mention stay as the session reported them",
    );
  });
});

describe("resolveVehicleQuery", () => {
  test("identification values are attributed to the package that defined the ECU", () => {
    const unmatched = ecu({
      ecuId: "ecu_9",
      txId: 0x7e4,
      rxId: 0x7ec,
      identification: [{ label: "Spare part number", value: "UNKNOWN-1", did: 0xf187 }],
    });
    assert.deepEqual(
      resolveVehicleQuery({ ecus: [ENGINE, unmatched] }).identifications,
      [
        { oem: "simulator", ecu: "engine", did: 0xf187, value: "ENGINE-f187" },
        { oem: "simulator", ecu: "engine", did: 0xf18c, value: "ENGINE-f18c" },
      ],
      "an ECU no definition matched cannot be evidence for any package",
    );
  });

  test("the VIN travels as the VIN, never as an identification value", () => {
    const labels = ecu({
      ecuId: "ecu_1",
      definitionEcuId: "simulator:engine",
      txId: 0x7e0,
      rxId: 0x7e8,
      identification: [
        { label: "vin", value: "1HGCM82633A004352" },
        { label: "Vehicle Identification Number", value: "1HGCM82633A004352" },
      ],
    });
    assert.deepEqual(resolveVehicleQuery({ ecus: [labels] }).identifications, []);
    assert.equal(
      resolveVehicleQuery({ ecus: [ENGINE] }).identifications?.[0]?.value,
      "ENGINE-f187",
      "the DID travels with the value, so the resolver can attribute it",
    );
  });

  test("only ECUs that answered count as discovered", () => {
    const silent = ecu({
      ecuId: "ecu_2",
      definitionEcuId: "simulator:abs",
      txId: 0x7e3,
      rxId: 0x7eb,
      reachable: false,
    });
    assert.deepEqual(resolveVehicleQuery({ ecus: [ENGINE, silent] }).discoveredAddresses, [
      { txId: 0x7e0, rxId: 0x7e8, extended: false },
    ]);
  });

  test("extended addressing travels with the observed address", () => {
    const extended = ecu({
      ecuId: "ecu_1",
      definitionEcuId: "vag:gateway",
      txId: 0x18db33f1,
      rxId: 0x18daf1,
      extended: true,
    });
    assert.deepEqual(resolveVehicleQuery({ ecus: [extended] }).discoveredAddresses, [
      { txId: 0x18db33f1, rxId: 0x18daf1, extended: true },
    ]);
  });

  test("the VIN comes from the identity unless the caller overrides it", () => {
    const identity: VehicleSummary = { vin: "1HGCM82633A004352", description: "Honda" };
    assert.equal(resolveVehicleQuery({ identity, ecus: [] }).vin, "1HGCM82633A004352");
    assert.equal(
      resolveVehicleQuery({ identity, ecus: [], hints: { vin: "WVWZZZ1JZHW000001" } }).vin,
      "WVWZZZ1JZHW000001",
    );
    assert.equal(resolveVehicleQuery({ ecus: [] }).vin, undefined);
  });

  test("a session with no facts at all still yields a well-formed query", () => {
    assert.deepEqual(resolveVehicleQuery({ ecus: [] }), {
      identifications: [],
      discoveredAddresses: [],
      declared: {},
    });
  });
});

describe("dtcVehicleContextOf", () => {
  /** A resolution candidate with only the fields the DTC binding reads. */
  function candidate(overrides: Partial<VehicleCandidateRef> = {}): VehicleCandidateRef {
    return {
      oem: "simulator",
      packageVersion: "1.0.0",
      vehicleId: "virtual-vehicle",
      brand: "Virtual",
      model: "Simulator vehicle",
      engineIds: [],
      gearboxIds: [],
      score: 1,
      trust: 1,
      evidence: [],
      conflicts: [],
      expectedEcus: 3,
      matchedEcus: 3,
      missingEcus: [],
      ...overrides,
    };
  }

  test("an unresolved car binds nothing", () => {
    assert.equal(dtcVehicleContextOf(undefined), undefined);
  });

  test("passes on the vehicle and only the narrowing the evidence produced", () => {
    assert.deepEqual(dtcVehicleContextOf(candidate()), {
      oem: "simulator",
      vehicleId: "virtual-vehicle",
    });
    assert.deepEqual(
      dtcVehicleContextOf(candidate({ engineIds: ["sim-petrol"], gearboxIds: ["sim-automatic"] })),
      {
        oem: "simulator",
        vehicleId: "virtual-vehicle",
        engineIds: ["sim-petrol"],
        gearboxIds: ["sim-automatic"],
      },
    );
  });

  test("copies the narrowing, so a later resolution cannot rewrite a bound one", () => {
    const engines = ["sim-petrol"];
    const context = dtcVehicleContextOf(candidate({ engineIds: engines }));
    engines.push("sim-diesel");
    assert.deepEqual(context?.engineIds, ["sim-petrol"]);
  });
});

describe("vehicleDeterminationOf", () => {
  function evidence(kind: string, observed: string) {
    return { kind, observed, expected: observed, weight: 3, reason: `${kind} matched` };
  }
  function candidate(overrides: Partial<VehicleCandidateRef> = {}): VehicleCandidateRef {
    return {
      oem: "simulator",
      packageVersion: "1.0.0",
      vehicleId: "virtual-vehicle",
      brand: "Virtual",
      model: "Simulator vehicle",
      platform: "SIM-1",
      provenanceType: "own",
      engineIds: ["sim-petrol"],
      gearboxIds: [],
      score: 0.8,
      trust: 1,
      evidence: [evidence("vin-wmi", "1HG")],
      conflicts: [evidence("vin-plant", "A")],
      expectedEcus: 3,
      matchedEcus: 2,
      missingEcus: ["gearbox"],
      ...overrides,
    };
  }
  function resolution(fields: Partial<VehicleResolutionRef> = {}): VehicleResolutionRef {
    const best = fields.best;
    return {
      candidates: fields.candidates ?? (best ? [best] : []),
      ...(best ? { best } : {}),
      unresolved: best === undefined,
      notes: [],
      unexplained: [],
      ...fields,
    };
  }

  test("carries the winner and its evidence, copied rather than aliased", () => {
    const engineIds = ["sim-petrol"];
    const best = candidate({ engineIds });
    const determination = vehicleDeterminationOf(resolution({ best }));
    assert.ok(determination.match);
    assert.equal(determination.match.vehicleId, "virtual-vehicle");
    assert.equal(determination.match.brand, "Virtual");
    assert.equal(determination.match.platform, "SIM-1");
    assert.equal(determination.match.score, 0.8);
    assert.equal(determination.match.trust, 1);
    assert.equal(determination.match.provenanceType, "own");
    assert.deepEqual(determination.match.ecus, { expected: 3, matched: 2, missing: ["gearbox"] });
    assert.deepEqual(
      determination.match.evidence.map((entry) => entry.kind),
      ["vin-wmi"],
    );
    assert.deepEqual(
      determination.match.conflicts.map((entry) => entry.kind),
      ["vin-plant"],
      "contradictions travel with the record instead of being netted into the score",
    );
    engineIds.push("late-addition");
    assert.deepEqual(
      determination.match.engineIds,
      ["sim-petrol"],
      "a later change to the resolution must not change a stored record",
    );
  });

  test("an unresolved answer keeps the provider's reason and invents no match", () => {
    const determination = vehicleDeterminationOf(
      unresolvedVehicleResolution("no package declares vehicle definitions"),
    );
    assert.equal(determination.match, undefined);
    assert.equal(determination.reason, "no package declares vehicle definitions");
    assert.deepEqual(determination.alternatives, []);
  });

  test("an unresolved answer without a reason stays without one", () => {
    // No filler text here on purpose: "unknown vehicle" is already what the reader
    // sees, and inventing a reason would be a claim about the definitions.
    const determination = vehicleDeterminationOf(resolution());
    assert.equal(determination.match, undefined);
    assert.equal(determination.reason, undefined);
  });

  test("runner-ups are reduced to what a reader can weigh", () => {
    const winner = candidate();
    const second = candidate({ vehicleId: "other-vehicle", score: 0.3 });
    const third = candidate({ vehicleId: "third-vehicle", score: 0.1 });
    const determination = vehicleDeterminationOf(
      resolution({ best: winner, candidates: [winner, second, third] }),
    );
    assert.deepEqual(determination.alternatives, [
      { vehicleId: "other-vehicle", oem: "simulator", score: 0.3 },
      { vehicleId: "third-vehicle", oem: "simulator", score: 0.1 },
    ]);
  });

  test("notes and unexplained observations are carried over", () => {
    const determination = vehicleDeterminationOf({
      ...resolution({ best: candidate() }),
      notes: ["the winning match rests on placeholder data"],
      unexplained: ["ecu 0x77b answered no definition"],
    });
    assert.deepEqual(determination.notes, ["the winning match rests on placeholder data"]);
    assert.deepEqual(determination.unexplained, ["ecu 0x77b answered no definition"]);
  });
});
