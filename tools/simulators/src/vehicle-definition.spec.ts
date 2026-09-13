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
  SIMULATOR_VIN,
  genericPackage,
  identificationKindForLabel,
  simulatorPackage,
  simulatorVehicle,
} from "@vdp/definitions";
import { test } from "vitest";
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
