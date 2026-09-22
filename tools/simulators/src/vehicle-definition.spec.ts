/**
 * Coupling test: the simulator and its vehicle definition must not drift apart.
 *
 * `@vdp/definitions` cannot import the simulator (dependency direction), so the
 * simulator package states what the simulator does instead of reading it. This
 * spec is the contract that keeps the statement true: it recomputes the
 * simulator's documented answers from the same package the simulator runs on and
 * checks that the vehicle definition accounts for every one of them.
 */

import assert from "node:assert/strict";
import {
  genericPackage,
  highFidelityPackage,
  identificationKindForLabel,
  SIMULATOR_VIN,
  simulatorPackage,
  simulatorVehicle,
} from "@vdp/definitions";
import { test } from "vitest";
import { MODEL_SIGNAL_IDS } from "./vehicle-signals.js";
import { DEFAULT_VIN, VirtualVehicle } from "./virtual-vehicle.js";

/** How the simulator answers an identification DID that is not the VIN. */
function simulatorAnswer(ecuId: string, did: number): string {
  return `${ecuId.toUpperCase()}-${did.toString(16)}`;
}

function declaredTokens(ecuId: string): { kind: string; token: string }[] {
  const ref = simulatorVehicle.ecus?.find((entry) => entry.ecu === ecuId);
  return [
    ...(ref?.partNumbers ?? []).map((token) => ({ kind: "part-number", token })),
    ...(ref?.softwareVersions ?? []).map((token) => ({ kind: "software-version", token })),
    ...(ref?.hardwareVersions ?? []).map((token) => ({ kind: "hardware-version", token })),
  ];
}

function powertrainCodes(): string[] {
  return [
    ...(simulatorVehicle.engines ?? []).flatMap((engine) => engine.codes ?? []),
    ...(simulatorVehicle.gearboxes ?? []).flatMap((gearbox) => gearbox.codes ?? []),
  ];
}

test("the definition describes the VIN the simulator reports", () => {
  assert.equal(SIMULATOR_VIN, DEFAULT_VIN, "the definition mirrors DEFAULT_VIN");
  const matcher = simulatorVehicle.vinMatch;
  assert.ok(matcher?.wmi?.includes(DEFAULT_VIN.slice(0, 3)));
  assert.ok(matcher?.plantChars?.includes(DEFAULT_VIN.charAt(10)));
});

test("the simulator runs on the ECUs the vehicle definition lists", () => {
  const virtual = new VirtualVehicle({ definitions: simulatorPackage });
  const simulated = virtual.ecus.map((ecu) => ecu.definition.id).sort();
  const declared = (simulatorVehicle.ecus ?? []).map((entry) => entry.ecu).sort();
  assert.deepEqual(simulated, declared);
  assert.deepEqual(
    simulated,
    genericPackage.ecus.map((ecu) => ecu.id).sort(),
    "the simulator package is a drop-in for the generic one",
  );
});

test("every identification answer is either declared or deliberately neutral", () => {
  for (const ecu of genericPackage.ecus) {
    for (const entry of ecu.identification ?? []) {
      if (entry.did === 0xf190) continue; // the VIN resolves through vinMatch
      const answer = simulatorAnswer(ecu.id, entry.did);
      const kind = identificationKindForLabel(entry.label);
      const tokens = declaredTokens(ecu.id);
      const codes = powertrainCodes();

      if (kind === undefined) {
        // A label that names no identification kind can never contradict; if the
        // value is still declared as a powertrain code, that is intentional.
        assert.ok(
          codes.includes(answer) || tokens.every((token) => token.token !== answer),
          `${ecu.id} 0x${entry.did.toString(16)} ("${entry.label}") is neutral by label`,
        );
        continue;
      }
      assert.ok(
        tokens.some((token) => token.kind === kind && token.token === answer),
        `${ecu.id} answers 0x${entry.did.toString(16)} ("${entry.label}") with "${answer}" — ` +
          `the vehicle definition must declare it as ${kind}, or the answer contradicts it`,
      );
    }
  }
});

test("the simulator package keeps the generic signal and DTC set", () => {
  assert.equal(simulatorPackage.signals.length, genericPackage.signals.length);
  const dtcs = (pkg: typeof genericPackage): number =>
    pkg.ecus.reduce((total, ecu) => total + (ecu.dtcs?.length ?? 0), 0);
  assert.equal(dtcs(simulatorPackage), dtcs(genericPackage));
});

/**
 * The signals the high-fidelity vehicle answers from one of its own registers instead of
 * from a measured state — the coding block lives in the module, not in the physics.
 */
const VEHICLE_OWN_REGISTERS = ["bcm.coding_block"];

test("the model answers no signal the vehicle does not declare", () => {
  // The other half of the coupling: an id the mapping knows but no ECU declares is a
  // reading nothing can ask for. It looks like a feature and is dead weight — and it
  // hides the case where the *definition* renamed the id, which would silently drop a
  // measurement off the wire while every test kept passing.
  const declared = new Set(highFidelityPackage.signals.map((signal) => signal.id));
  const undeclared = MODEL_SIGNAL_IDS.filter((id) => !declared.has(id));
  assert.deepEqual(
    undeclared,
    [],
    `the model maps signals ${highFidelityPackage.name} does not declare: ${undeclared.join(", ")}`,
  );
});

test("every declared measurement is answered by the model, not by a default", () => {
  // An ascii signal is an identification answer and comes from the vehicle's identity
  // (the VIN, the part number). Anything numeric is a *measurement*, and a measurement
  // the model has no rule for is served by the base simulator's synthetic value: the DID
  // reads, and nobody measured it. That is the failure this vehicle exists to avoid.
  const measurements = highFidelityPackage.signals.filter((signal) => signal.encoding !== "ascii");
  const unanswered = measurements
    .filter((signal) => !MODEL_SIGNAL_IDS.includes(signal.id))
    .map((signal) => signal.id)
    .filter((id) => !VEHICLE_OWN_REGISTERS.includes(id));
  assert.deepEqual(
    unanswered,
    [],
    `no rule reads these signals — add a reader or document the register: ${unanswered.join(", ")}`,
  );
});

test("an exemption is a register, or it is not an exemption", () => {
  // The list above has to stay small and honest: only a bitfield a module stores is
  // allowed to answer itself. A numeric signal hiding here is the bug the test prevents.
  for (const id of VEHICLE_OWN_REGISTERS) {
    const signal = highFidelityPackage.signals.find((entry) => entry.id === id);
    assert.ok(signal, `${id} has to be declared by the package to be exempt at all`);
    assert.equal(
      signal?.encoding,
      "bitmask",
      `${id} is exempted as a register of the vehicle, so it must be one (encoding was "${signal?.encoding}")`,
    );
  }
});
