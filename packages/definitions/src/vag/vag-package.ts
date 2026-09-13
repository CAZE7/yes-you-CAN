/**
 * VAG (Volkswagen group) example package — STRUCTURE DEMONSTRATION ONLY.
 *
 * AGENTS 24 forbids taking manufacturer data from commercial products without
 * rights. This package therefore contains invented placeholder DIDs/DTCs whose
 * only purpose is to prove the multi-OEM architecture: 29-bit addressing,
 * per-ECU timing, OEM specific DTC descriptions and OEM DID layouts.
 *
 * `provenance.sourceType` is `example-placeholder` on purpose, and the validator
 * turns that into a warning so such a package can never be shipped silently as
 * if it were real OEM data.
 */

import type { DefinitionPackage } from "../schema.js";

export const vagExamplePackage: DefinitionPackage = {
  schemaVersion: 2,
  oem: "vag",
  name: "VAG example (placeholder data)",
  version: "0.1.0",
  provenance: {
    sourceType: "example-placeholder",
    source: "invented example values — no OEM documentation, no third-party database",
    notes:
      "Replace with licensed OEM data before use on a real vehicle. Demonstrates 29-bit addressing and OEM DID layout only.",
  },
  ecus: [
    {
      id: "engine",
      name: "Engine Control Unit (example)",
      protocol: "uds",
      // 29-bit physical addressing as used by many modern OEM diagnostic buses.
      address: { txId: 0x18daf100, rxId: 0x18da00f1, extended: true, functionalId: 0x18db33f1 },
      timing: { p2Ms: 50, p2StarMs: 5000 },
      identification: [
        { label: "VIN", did: 0xf190, encoding: "ascii" },
        { label: "Part number", did: 0xf187, encoding: "ascii" },
      ],
      dtcs: [
        {
          code: "P0420",
          description: "Example: catalyst efficiency below threshold",
          severity: "major",
        },
        {
          code: "P1234",
          description: "Example: OEM specific boost pressure control deviation",
          severity: "minor",
        },
      ],
    },
  ],
  /**
   * The vehicle axis (schema version 2, AGENTS 11): one invented variant that
   * shows how a package narrows its ECUs to a car.
   *
   * What is *not* invented here, and why: the WMI list is public reference data
   * (ISO 3780, see `reference/wmi.ts`) and the model-year characters are the
   * standard 49 CFR 565 assignment for 2013–2020 — both are the kind of data a
   * resolver may legitimately know. Everything vehicle-specific (part numbers,
   * software versions, engine and gearbox codes) is invented and marked as such,
   * because that is OEM knowledge this repository has no rights to (AGENTS 24).
   */
  vehicles: [
    {
      id: "vag-example-variant",
      brand: "Example brand",
      model: "Example variant (invented)",
      platform: "EXAMPLE-PLATFORM",
      generation: "1",
      bodyStyles: ["hatchback"],
      modelYears: { from: 2013, to: 2020 },
      vinMatch: {
        wmi: ["WVW", "WV1"],
        // The filler pattern European VINs of this era commonly carry in 4–8.
        vdsPattern: "ZZZ..",
        modelYearChars: ["D", "E", "F", "G", "H", "J", "K", "L"],
        plantChars: ["W", "Z"],
      },
      engines: [
        {
          id: "example-1-4-tsi",
          name: "Example 1.4 petrol turbo (invented)",
          fuel: "petrol",
          displacementCc: 1395,
          powerKw: 110,
          codes: ["EXA", "EXB"],
        },
      ],
      gearboxes: [
        {
          id: "example-dsg7",
          name: "Example 7-speed dual clutch (invented)",
          type: "dual-clutch",
          gears: 7,
          codes: ["EXG"],
        },
      ],
      ecus: [
        {
          ecu: "engine",
          partNumbers: ["EXAMPLE-000-000-AB"],
          softwareVersions: ["EXSW0001"],
          engine: "example-1-4-tsi",
          gearbox: "example-dsg7",
        },
      ],
      description:
        "Demonstrates the vehicle axis only. Does not describe a real car: replace every invented value with sourced data before use (AGENTS 24).",
    },
  ],
  signals: [
    {
      id: "engine.vin",
      name: "Vehicle Identification Number",
      ecu: "engine",
      did: 0xf190,
      byteOffset: 0,
      length: 17,
      encoding: "ascii",
    },
    {
      id: "engine.example_boost_pressure",
      name: "Example boost pressure (placeholder)",
      ecu: "engine",
      did: 0x2001,
      byteOffset: 0,
      length: 2,
      encoding: "uint16",
      endianness: "little",
      scale: 0.01,
      unit: "bar",
      description: "Placeholder showing little-endian OEM encoding and per-signal scaling.",
    },
    {
      id: "engine.example_coding_word",
      name: "Example coding word (placeholder, bit packed)",
      ecu: "engine",
      did: 0x2002,
      byteOffset: 0,
      length: 2,
      bitOffset: 4,
      bitLength: 4,
      encoding: "bitmask",
      description: "Placeholder demonstrating bit-level extraction inside a coding word.",
    },
  ],
};
