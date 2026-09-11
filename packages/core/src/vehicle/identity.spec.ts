/**
 * Vehicle identity (AGENTS 11): VIN-derived identity, readable labels, VIN
 * masking for anything that leaves the machine (AGENTS 27).
 */

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { createIdentityFromVin, describeVehicle, maskVin } from "./identity.js";
import { analyseVin, guessModelYear } from "./vin.js";

const CLASSIC_VIN = "1M8GDM9AXKP042788";

describe("createIdentityFromVin", () => {
  test("a well-formed VIN is analysed and the model year derived", () => {
    const identity = createIdentityFromVin(CLASSIC_VIN);
    const analysis = analyseVin(CLASSIC_VIN);
    assert.equal(identity.vin, CLASSIC_VIN);
    assert.deepEqual(identity.vinAnalysis, analysis);
    assert.equal(identity.modelYear, guessModelYear(analysis.modelYearChar));
    assert.deepEqual(identity.ecus, []);
    assert.deepEqual(identity.attributes, {});
  });

  test("extra fields survive and explicit values are not overwritten", () => {
    const identity = createIdentityFromVin(CLASSIC_VIN, {
      brand: "Ford",
      model: "Mustang Piston",
      modelYear: 1999,
      ecus: ["ecu_1"],
      attributes: { paint: "black" },
    });
    assert.equal(identity.brand, "Ford");
    assert.equal(identity.model, "Mustang Piston");
    assert.equal(identity.modelYear, 1999, "an explicit year wins over the guess");
    assert.deepEqual(identity.ecus, ["ecu_1"]);
    assert.deepEqual(identity.attributes, { paint: "black" });
  });

  test("a malformed VIN still stores the raw evidence, but no guessed year", () => {
    const identity = createIdentityFromVin("TOOSHORT");
    assert.equal(identity.vinAnalysis?.wellFormed, false);
    assert.equal(identity.modelYear, undefined);
  });
});

describe("describeVehicle", () => {
  test("undefined input degrades to a readable label", () => {
    assert.equal(describeVehicle(undefined), "unknown vehicle");
  });

  test("brand, model and year join; the VIN is appended when known", () => {
    const identity = createIdentityFromVin(CLASSIC_VIN, {
      brand: "Ford",
      model: "Mustang",
      modelYear: 1999,
    });
    assert.equal(describeVehicle(identity), `Ford Mustang 1999 (${CLASSIC_VIN})`);
  });

  test("a vehicle without a VIN keeps the label but not the parentheses", () => {
    assert.equal(describeVehicle({ brand: "Ford" }), "Ford");
    assert.equal(describeVehicle({ brand: "Ford", model: "Mustang" }), "Ford Mustang");
  });

  test("a vehicle with only unknowns stays honest", () => {
    assert.equal(describeVehicle({ attributes: {} }), "unknown vehicle");
  });
});

describe("maskVin", () => {
  test("a missing VIN is an em dash, never an empty string", () => {
    assert.equal(maskVin(undefined), "—");
    assert.equal(maskVin(""), "—");
  });

  test("VINs too short to hide anything are fully masked", () => {
    assert.equal(maskVin("ABC1234"), "*******", "length 7 = prefix 3 + suffix 4 → nothing visible");
    assert.equal(maskVin("AB", 1, 1), "**");
  });

  test("default masking keeps 3 leading and 4 trailing characters", () => {
    assert.equal(maskVin(CLASSIC_VIN), "1M8**********2788");
    assert.equal(maskVin(CLASSIC_VIN).length, 17);
  });

  test("custom visibility windows are honoured", () => {
    assert.equal(maskVin(CLASSIC_VIN, 0, 0), "*".repeat(17));
    assert.equal(maskVin("ABCDEFGH", 1, 2), "A*****GH");
  });
});
