/**
 * Definition package for the virtual vehicle (AGENTS 11, 32).
 *
 * The simulator is the platform's only vehicle that is available everywhere —
 * in CI, on a laptop without an adapter, in a demo. Giving it a real vehicle
 * definition is what makes the vehicle axis testable end to end: VIN, WMI,
 * descriptor section, identification values and the ECU set all come from
 * documented simulator behaviour instead of from an OEM database this project
 * has no rights to (AGENTS 24).
 *
 * **Where every value comes from** — and the tests that hold this file to it:
 *  - the VIN criteria mirror `DEFAULT_VIN` of `@vdp/simulators`
 *    ("1HGCM82633A004352"): WMI `1HG`, descriptor `CM826`, model-year character
 *    `3` (position 10, 49 CFR 565 — the 30-year cycle makes it 2003 or 1973, the
 *    simulator's own model-year guess decides which), plant character `A`.
 *  - the identification values are the simulator's documented answers for a
 *    non-VIN identification DID: `<ECU ID in upper case>-<DID in lower case hex>`,
 *    e.g. `ENGINE-f187`. They are declared exactly as they arrive on the wire —
 *    matching is case-insensitive, but a definition that mirrors the wire value
 *    documents it instead of paraphrasing it.
 *  - the ECU set and the signals are `genericPackage`'s, because that is the
 *    package the simulator runs on by default.
 *
 * `tools/simulators/src/simulator-package.test.ts` asserts the coupling against
 * the live simulator, so this file cannot drift away from it silently.
 *
 * The brand and model names are deliberately neutral: a WMI says who built a
 * car, not what this virtual one is, and inventing a real model here would be
 * exactly the kind of unsourced vehicle truth AGENTS 24 forbids.
 */

import { genericPackage } from "../generic/generic-package.js";
import type { DefinitionPackage, Provenance, VehicleDefinition } from "../schema.js";

/** The VIN the simulator reports unless a test overrides it. */
export const SIMULATOR_VIN = "1HGCM82633A004352";

const SIMULATOR_PROVENANCE: Provenance = {
  sourceType: "own",
  source:
    "derived from @vdp/simulators VirtualVehicle (DEFAULT_VIN and its identification answers)",
  notes:
    "Deterministic test vehicle. Not a real car and not OEM data; the ECU and signal set is genericPackage's (SAE J1979 / ISO 15031-5 semantics).",
};

export const simulatorVehicle: VehicleDefinition = {
  id: "virtual-vehicle",
  brand: "Virtual",
  model: "Simulator vehicle",
  platform: "SIM-1",
  generation: "1",
  bodyStyles: ["test-bench"],
  modelYears: { from: 2003, to: 2003 },
  vinMatch: {
    wmi: ["1HG"],
    vdsPattern: "CM8..",
    modelYearChars: ["3"],
    plantChars: ["A"],
  },
  engines: [
    {
      id: "sim-petrol",
      name: "Simulated petrol engine",
      fuel: "petrol",
      displacementCc: 2400,
      powerKw: 120,
      // The simulator reports "<ECU>-<DID>" for every non-VIN identification DID.
      codes: ["ENGINE-f18c"],
    },
  ],
  gearboxes: [
    {
      id: "sim-automatic",
      name: "Simulated automatic gearbox",
      type: "automatic",
      gears: 5,
      codes: ["TRANSMISSION-f18c"],
    },
  ],
  ecus: [
    {
      ecu: "engine",
      partNumbers: ["ENGINE-f187"],
      softwareVersions: ["ENGINE-f181"],
      engine: "sim-petrol",
    },
    { ecu: "transmission", gearbox: "sim-automatic" },
    { ecu: "abs", hardwareVersions: ["ABS-f193"] },
  ],
  provenance: SIMULATOR_PROVENANCE,
  description:
    "The virtual vehicle of @vdp/simulators: three ECUs on 11-bit CAN, identification answers of the form <ECU ID>-<DID>.",
};

/**
 * `genericPackage` plus the vehicle axis, for runs against the simulator.
 *
 * Register this *instead of* `genericPackage`, not next to it: both carry the
 * same ECU addresses, and discovery would probe every candidate twice.
 */
export const simulatorPackage: DefinitionPackage = {
  ...genericPackage,
  schemaVersion: genericPackage.schemaVersion,
  oem: "simulator",
  name: "Virtual vehicle (simulator)",
  version: "1.0.0",
  provenance: SIMULATOR_PROVENANCE,
  ecus: [...genericPackage.ecus],
  signals: [...genericPackage.signals],
  vehicles: [simulatorVehicle],
};
