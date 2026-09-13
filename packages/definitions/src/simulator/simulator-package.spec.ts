/**
 * The simulator's vehicle definition (AGENTS 11, 32).
 *
 * This package exists so the vehicle axis has a vehicle that is available
 * everywhere — CI, a laptop without an adapter, the demo. These tests pin the
 * two properties that make it useful: it is a *drop-in* for `genericPackage`
 * (same ECUs, same signals, so the simulator behaves identically) and it really
 * resolves against the values the simulator reports.
 */

import assert from "node:assert/strict";
import { test } from "vitest";
import { genericPackage } from "../generic/generic-package.js";
import { VehicleResolver } from "../resolve.js";
import { validateDefinitionPackage } from "../validate.js";
import { matchesPattern, vinPositions } from "../vehicles.js";
import { SIMULATOR_VIN, simulatorPackage, simulatorVehicle } from "./simulator-package.js";

/** The identification answers the simulator gives for a non-VIN DID. */
function simulatorAnswer(ecuId: string, did: number): string {
  return `${ecuId.toUpperCase()}-${did.toString(16)}`;
}

test("declared tokens mirror the simulator answers exactly", () => {
  const declared = (simulatorVehicle.ecus ?? []).flatMap((ref) => [
    ...(ref.partNumbers ?? []),
    ...(ref.softwareVersions ?? []),
    ...(ref.hardwareVersions ?? []),
  ]);
  assert.deepEqual(declared, [
    simulatorAnswer("engine", 0xf187),
    simulatorAnswer("engine", 0xf181),
    simulatorAnswer("abs", 0xf193),
  ]);
});

const DISCOVERED = simulatorPackage.ecus.map((ecu) => ({
  txId: ecu.address.txId,
  rxId: ecu.address.rxId,
  extended: ecu.address.extended,
}));

test("the package is valid and states where it comes from", () => {
  const result = validateDefinitionPackage(simulatorPackage);
  assert.deepEqual(result.errors, [], result.errors.join(", "));
  assert.equal(simulatorPackage.provenance.sourceType, "own");
  assert.match(simulatorPackage.provenance.source, /simulators/);
  assert.ok(
    !result.warnings.some((warning) => warning.includes("placeholder")),
    "this is derived from our own simulator, not invented OEM data",
  );
});

test("it is a drop-in for genericPackage: same ECUs, same signals, plus vehicles", () => {
  assert.deepEqual(simulatorPackage.ecus, genericPackage.ecus);
  assert.deepEqual(simulatorPackage.signals, genericPackage.signals);
  assert.equal(simulatorPackage.oem, "simulator", "but a distinct package key");
  assert.equal(simulatorPackage.vehicles?.length, 1);
});

test("the VIN criteria describe the simulator's VIN", () => {
  const facts = vinPositions(SIMULATOR_VIN);
  const matcher = simulatorVehicle.vinMatch;
  assert.ok(matcher?.wmi?.includes(facts.wmi ?? ""));
  assert.ok(matchesPattern(facts.vds ?? "", matcher?.vdsPattern ?? ""));
  assert.ok(matcher?.modelYearChars?.includes(facts.modelYearChar ?? ""));
  assert.ok(matcher?.plantChars?.includes(facts.plantChar ?? ""));
  assert.deepEqual(simulatorVehicle.modelYears, { from: 2003, to: 2003 });
});

test("the simulator's VIN alone resolves to the virtual vehicle", () => {
  const result = new VehicleResolver([simulatorPackage]).resolve({ vin: SIMULATOR_VIN });
  assert.equal(result.best?.vehicleId, "virtual-vehicle");
  assert.equal(result.best?.brand, "Virtual");
  assert.equal(result.best?.platform, "SIM-1");
  assert.equal(result.vinLookup?.manufacturer, "Honda of America Mfg.");
  assert.equal(result.unresolved, false);
});

test("the whole live picture resolves with every criterion confirmed", () => {
  const result = new VehicleResolver([simulatorPackage]).resolve({
    vin: SIMULATOR_VIN,
    discoveredAddresses: DISCOVERED,
    identifications: [
      { ecu: "engine", did: 0xf187, value: simulatorAnswer("engine", 0xf187) },
      { ecu: "engine", did: 0xf181, value: simulatorAnswer("engine", 0xf181) },
      { ecu: "engine", did: 0xf18c, value: simulatorAnswer("engine", 0xf18c) },
      { ecu: "transmission", did: 0xf18c, value: simulatorAnswer("transmission", 0xf18c) },
      { ecu: "abs", did: 0xf193, value: simulatorAnswer("abs", 0xf193) },
    ],
  });
  const best = result.best;
  assert.ok(best);
  assert.equal(best.score, 1, "everything the definition declares is confirmed");
  assert.deepEqual(best.conflicts, []);
  assert.deepEqual(best.coverage.missing, []);
  assert.equal(best.coverage.matched, 3);
  assert.deepEqual(best.engineIds, ["sim-petrol"], "the serial number narrows the engine");
  assert.deepEqual(best.gearboxIds, ["sim-automatic"]);
});

test("an identification DID nobody documented stays neutral", () => {
  const result = new VehicleResolver([simulatorPackage]).resolve({
    vin: SIMULATOR_VIN,
    identifications: [{ ecu: "engine", did: 0xf18c, value: "SOMETHING-ELSE" }],
  });
  assert.equal(result.best?.vehicleId, "virtual-vehicle");
  assert.deepEqual(result.best?.conflicts, []);
});

test("a wrong part number contradicts the virtual vehicle", () => {
  const result = new VehicleResolver([simulatorPackage]).resolve({
    vin: SIMULATOR_VIN,
    identifications: [{ ecu: "engine", did: 0xf187, value: "NOT-THE-RIGHT-PART" }],
  });
  const conflict = result.best?.conflicts.find((entry) => entry.kind === "part-number");
  assert.ok(conflict, "the documented part number DID must be able to contradict");
  assert.equal(conflict.expected, simulatorAnswer("engine", 0xf187));
});

test("a different VIN does not resolve to the virtual vehicle", () => {
  const result = new VehicleResolver([simulatorPackage]).resolve({
    vin: "WVWZZZ1JZHW000001",
  });
  assert.equal(result.unresolved, true);
  assert.deepEqual(result.candidates, []);
  assert.equal(result.vinLookup?.brand, "Volkswagen");
});
