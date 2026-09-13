import assert from "node:assert/strict";
import type { EcuSummary, VehicleSummary } from "@vdp/domain";
import { describe, test } from "vitest";
import { declaredOf, resolveVehicleQuery, splitDefinitionEcuId } from "./vehicle-resolution.js";

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
