/**
 * High-Fidelity 5-ECU Virtual Vehicle Definition Package (Task 2; AGENTS 11, 32).
 *
 * Full multi-ECU virtual vehicle topology:
 *
 * Virtual Vehicle
 * ├── Gateway (0x7E4/0x7EC)
 * ├── Engine ECU (0x7E0/0x7E8)
 * ├── ABS (0x713/0x77B)
 * ├── Gearbox (0x7E1/0x7E9)
 * └── BCM (0x7E2/0x7EA)
 *
 * With realistic physical states, sessions, DIDs, DTCs, coding blocks (0x0200),
 * adaptation channels (0x2100), and cross-module communications.
 */

import { genericPackage } from "../generic/generic-package.js";
import {
  CURRENT_SCHEMA_VERSION,
  type DefinitionPackage,
  type EcuDefinition,
  type Provenance,
  type SignalDefinition,
  type VehicleDefinition,
} from "../schema.js";

const HIGH_FIDELITY_PROVENANCE: Provenance = {
  sourceType: "own",
  source: "High-Fidelity Virtual Vehicle Simulator (5-ECU topology)",
  version: "1.0.0",
  notes:
    "Deterministic multi-ECU simulation: Gateway, Engine, Transmission, ABS, Body Control Module.",
};

export const highFidelityEcus: EcuDefinition[] = [
  ...genericPackage.ecus,
  {
    id: "gateway",
    name: "Central Gateway Control Unit",
    protocol: "uds",
    address: { txId: 0x7e4, rxId: 0x7ec, functionalId: 0x7df },
    timing: { p2Ms: 50, p2StarMs: 5000 },
    identification: [
      { label: "VIN", did: 0xf190, encoding: "ascii" },
      { label: "Spare part number", did: 0xf187, encoding: "ascii" },
      { label: "Application software", did: 0xf181, encoding: "ascii" },
    ],
    dtcs: [
      {
        code: "U0100",
        description: "Lost communication with Engine Control Module (EMS)",
        severity: "critical",
      },
      {
        code: "U0101",
        description: "Lost communication with Transmission Control Module (TCM)",
        severity: "critical",
      },
      {
        code: "U0121",
        description: "Lost communication with Anti-Lock Brake System (ABS)",
        severity: "critical",
      },
      {
        code: "U0140",
        description: "Lost communication with Body Control Module (BCM)",
        severity: "major",
      },
    ],
    description: "Central diagnostic gateway routing between CAN buses.",
  },
  {
    id: "bcm",
    name: "Body Control Module",
    protocol: "uds",
    address: { txId: 0x7e2, rxId: 0x7ea, functionalId: 0x7df },
    timing: { p2Ms: 50, p2StarMs: 5000 },
    identification: [
      { label: "VIN", did: 0xf190, encoding: "ascii" },
      { label: "Spare part number", did: 0xf187, encoding: "ascii" },
      { label: "Hardware version", did: 0xf193, encoding: "ascii" },
    ],
    dtcs: [
      {
        code: "B1000",
        description: "BCM internal control unit failure",
        severity: "critical",
      },
      {
        code: "B1001",
        description: "Battery supply voltage out of range / low voltage",
        severity: "major",
      },
      {
        code: "B1020",
        description: "Central locking circuit electrical fault",
        severity: "minor",
      },
    ],
    description: "Body Control Module managing lighting, ignition and electrical distribution.",
  },
];

export const highFidelitySignals: SignalDefinition[] = [
  ...genericPackage.signals,
  // --- Gateway DIDs ----------------------------------------------------
  {
    id: "gateway.routing_state",
    name: "Gateway routing state",
    ecu: "gateway",
    did: 0x0100,
    byteOffset: 0,
    length: 1,
    encoding: "uint8",
    enumMapping: { 0: "normal", 1: "degraded", 2: "offline" },
  },
  {
    id: "gateway.bus_sleep_state",
    name: "Bus sleep state",
    ecu: "gateway",
    did: 0x0101,
    byteOffset: 0,
    length: 1,
    encoding: "uint8",
    enumMapping: { 0: "sleep", 1: "active" },
  },
  // --- BCM DIDs --------------------------------------------------------
  {
    id: "bcm.battery_voltage",
    name: "Battery voltage",
    ecu: "bcm",
    did: 0x2001,
    byteOffset: 0,
    length: 2,
    encoding: "uint16",
    scale: 0.01,
    unit: "V",
    min: 0,
    max: 20,
    critical: true,
  },
  {
    id: "bcm.ignition_state",
    name: "Ignition switch state",
    ecu: "bcm",
    did: 0x2002,
    byteOffset: 0,
    length: 1,
    encoding: "uint8",
    enumMapping: { 0: "lock", 1: "off", 2: "acc", 3: "on", 4: "start" },
    critical: true,
  },
  {
    id: "bcm.coding_block",
    name: "BCM variant coding block",
    ecu: "bcm",
    did: 0x0200,
    byteOffset: 0,
    length: 4,
    encoding: "bitmask",
    description: "Byte 0 Bit 3: Daytime Running Lights (DRL). Bit 4: Auto-Lock on Speed.",
  },
  // --- Engine adaptation channel ---------------------------------------
  {
    id: "engine.idle_speed_adaptation",
    name: "Engine idle speed target adaptation",
    ecu: "engine",
    did: 0x2100,
    byteOffset: 0,
    length: 2,
    encoding: "uint16",
    scale: 1,
    unit: "rpm",
    min: 600,
    max: 900,
  },
];

export const highFidelityVehicle: VehicleDefinition = {
  id: "high-fidelity-virtual-vehicle",
  brand: "Virtual",
  model: "High-Fidelity Virtual Vehicle (5-ECU)",
  platform: "SIM-5",
  generation: "2",
  bodyStyles: ["test-bench"],
  modelYears: { from: 2026, to: 2026 },
  vinMatch: {
    wmi: ["1HG"],
    vdsPattern: "CM8..",
    modelYearChars: ["3"],
    plantChars: ["A"],
  },
  engines: [
    {
      id: "sim-v6",
      name: "High-Fidelity 3.0L V6 Turbo Engine",
      fuel: "petrol",
      displacementCc: 2995,
      powerKw: 250,
      codes: ["ENGINE-f18c"],
    },
  ],
  gearboxes: [
    {
      id: "sim-8at",
      name: "8-Speed Automatic Transmission",
      type: "automatic",
      gears: 8,
      codes: ["TRANSMISSION-f18c"],
    },
  ],
  ecus: [
    { ecu: "gateway", partNumbers: ["GATEWAY-f187"], softwareVersions: ["GATEWAY-f181"] },
    {
      ecu: "engine",
      partNumbers: ["ENGINE-f187"],
      softwareVersions: ["ENGINE-f181"],
      engine: "sim-v6",
    },
    { ecu: "transmission", gearbox: "sim-8at" },
    { ecu: "abs", hardwareVersions: ["ABS-f193"] },
    { ecu: "bcm", partNumbers: ["BCM-f187"], hardwareVersions: ["BCM-f193"] },
  ],
  provenance: HIGH_FIDELITY_PROVENANCE,
  description:
    "High-fidelity virtual vehicle simulation with 5 ECUs (Gateway, Engine, Transmission, ABS, BCM) on 11-bit CAN.",
};

export const highFidelityPackage: DefinitionPackage = {
  schemaVersion: CURRENT_SCHEMA_VERSION,
  oem: "simulator-hifi",
  name: "High-Fidelity Virtual Vehicle (5-ECU)",
  version: "1.0.0",
  provenance: HIGH_FIDELITY_PROVENANCE,
  ecus: highFidelityEcus,
  signals: highFidelitySignals,
  vehicles: [highFidelityVehicle],
};
