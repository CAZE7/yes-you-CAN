/**
 * Mercedes-Benz example package — STRUCTURE DEMONSTRATION ONLY.
 *
 * Same rules as the VAG example package: invented placeholder data, provenance
 * `example-placeholder`, no OEM documentation and no third-party database used
 * (AGENTS 24). It exists so the definition-driven engine is exercised against a
 * second OEM shape (different addressing, different DTC families).
 */

import type { DefinitionPackage } from "../schema.js";

export const mercedesExamplePackage: DefinitionPackage = {
  schemaVersion: 1,
  oem: "mercedes",
  name: "Mercedes example (placeholder data)",
  version: "0.1.0",
  provenance: {
    sourceType: "example-placeholder",
    source: "invented example values — no OEM documentation, no third-party database",
    notes: "Replace with licensed OEM data before use on a real vehicle.",
  },
  ecus: [
    {
      id: "sam_front",
      name: "Front Signal Acquisition Module (example)",
      protocol: "uds",
      address: { txId: 0x18daf107, rxId: 0x18da07f1, extended: true, functionalId: 0x18db33f1 },
      timing: { p2Ms: 60, p2StarMs: 5000 },
      identification: [
        { label: "VIN", did: 0xf190, encoding: "ascii" },
        { label: "Hardware version", did: 0xf193, encoding: "ascii" },
      ],
      dtcs: [
        {
          code: "B1000",
          description: "Example: body network communication fault",
          severity: "minor",
        },
        {
          code: "U0100",
          description: "Example: lost communication with engine control module",
          severity: "critical",
        },
      ],
    },
  ],
  signals: [
    {
      id: "sam_front.vin",
      name: "Vehicle Identification Number",
      ecu: "sam_front",
      did: 0xf190,
      byteOffset: 0,
      length: 17,
      encoding: "ascii",
    },
    {
      id: "sam_front.example_battery_voltage",
      name: "Example battery voltage (placeholder)",
      ecu: "sam_front",
      did: 0x3001,
      byteOffset: 0,
      length: 2,
      encoding: "uint16",
      scale: 0.01,
      unit: "V",
      min: 0,
      max: 20,
      critical: true,
      description: "Placeholder demonstrating a safety relevant precondition signal (AGENTS 26).",
    },
  ],
};
