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
import type { DiscoveredAddress } from "../resolve.js";
import { VehicleResolver } from "../resolve.js";
import { validateDefinitionPackage } from "../validate.js";
import { matchesPattern, vinPositions } from "../vehicles.js";
import {
  highFidelityEcus,
  highFidelityPackage,
  highFidelitySignals,
  highFidelityVehicle,
} from "./high-fidelity-package.js";
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

const DISCOVERED: DiscoveredAddress[] = simulatorPackage.ecus.map((ecu) => ({
  txId: ecu.address.txId,
  rxId: ecu.address.rxId,
  // Standard 11-bit addressing is Discovery's default; an absent key states that
  // instead of a key holding `undefined` (E18).
  ...(ecu.address.extended !== undefined ? { extended: ecu.address.extended } : {}),
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

test("the knowledge covers what this variant can justify — and names what it leaves out", () => {
  const documented = (simulatorVehicle.dtcKnowledge ?? []).map((entry) => entry.code);
  assert.deepEqual(documented, ["P0420", "P0300", "P0171", "P0700", "P0715", "C0035"]);

  // Every code this package describes either has variant knowledge or is left out
  // on purpose. U0121 is left out because a lost-communication code means the same
  // thing for every engine, gearbox and equipment line — variant wording for it
  // would be padding dressed up as knowledge (AGENTS 24). The answer then says
  // that it is package-wide instead of borrowing the variant's appearance.
  const described = simulatorPackage.ecus.flatMap((ecu) => (ecu.dtcs ?? []).map((dtc) => dtc.code));
  assert.deepEqual(
    described.filter((code) => !documented.includes(code)),
    ["U0121"],
  );
});

test("a fault this package cannot observe says so instead of using a proxy signal", () => {
  // The gearbox answers oil temperature and gear position only — there is no
  // input/turbine speed signal, so an intermittent speed-sensor dropout cannot be
  // watched here. An earlier version of this data "checked" the oil temperature
  // for 30 s and called it a dropout watch: a step that observes the wrong signal
  // and can never fail. The honest shape names the gap and checks only the
  // condition the fault needs (AGENTS 24).
  const gearbox = (simulatorVehicle.dtcKnowledge ?? []).find((entry) => entry.code === "P0715");
  const intermittent = gearbox?.patterns?.find(
    (pattern) => pattern.id === "input-sensor-intermittent",
  );
  assert.ok(intermittent, "the intermittent pattern is documented");
  assert.match(
    intermittent.explanation ?? "",
    /no input\/turbine speed signal/,
    "the pattern must say which measurement this package cannot make",
  );
  assert.deepEqual(
    (intermittent.checks ?? []).map((check) => [
      check.signal,
      check.min,
      check.max,
      check.windowMs,
    ]),
    [["transmission.oil_temperature", 60, undefined, undefined]],
    "one bounded measuring condition, no invented observation window",
  );
});

test("every measuring point exists and every check can be judged", () => {
  const signals = new Set(simulatorPackage.signals.map((signal) => signal.id));
  for (const entry of simulatorVehicle.dtcKnowledge ?? []) {
    for (const signal of entry.relatedSignals ?? []) {
      assert.ok(signals.has(signal), `${entry.code} relates to an undeclared signal ${signal}`);
    }
    for (const pattern of entry.patterns ?? []) {
      for (const check of pattern.checks ?? []) {
        assert.ok(
          signals.has(check.signal),
          `${entry.code}/${pattern.id}: ${check.signal} is not in this package — a check against ` +
            "a signal nobody defines can never run",
        );
        // This file's rule: a check either carries a bound, or it carries the
        // window it has to be watched over and is therefore honest about being
        // judged by a human. A check with neither is a sentence, not a step.
        const bounded = check.min !== undefined || check.max !== undefined;
        assert.ok(
          bounded || check.windowMs !== undefined,
          `${entry.code}/${pattern.id}: "${check.expect}" has neither a bound nor a window`,
        );
      }
    }
  }
});

test("a different VIN does not resolve to the virtual vehicle", () => {
  const result = new VehicleResolver([simulatorPackage]).resolve({
    vin: "WVWZZZ1JZHW000001",
  });
  assert.equal(result.unresolved, true);
  assert.deepEqual(result.candidates, []);
  assert.equal(result.vinLookup?.brand, "Volkswagen");
});

test("highFidelityPackage validates cleanly and declares all 5 ECUs", () => {
  const result = validateDefinitionPackage(highFidelityPackage);
  assert.deepEqual(result.errors, []);
  assert.equal(highFidelityEcus.length, 5);
  assert.equal(highFidelityPackage.ecus.length, 5);
  assert.equal(highFidelityPackage.vehicles?.length, 1);
  assert.equal(highFidelityVehicle.ecus?.length, 5);
  assert.ok(highFidelitySignals.some((s) => s.id === "bcm.battery_voltage"));
  assert.ok(highFidelitySignals.some((s) => s.id === "bcm.coding_block"));
  assert.ok(highFidelitySignals.some((s) => s.id === "engine.idle_speed_adaptation"));
});
