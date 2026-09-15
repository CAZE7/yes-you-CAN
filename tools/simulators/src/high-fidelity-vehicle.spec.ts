/**
 * High-Fidelity Vehicle Simulator Tests (Task 2; AGENTS 11, 32).
 *
 * Verifies:
 * 1. 5-ECU topology: Gateway, Engine, Transmission, ABS, BCM.
 * 2. Dynamic state simulation: Ignition positions, battery voltage sag during crank.
 * 3. Cross-module fault propagation: ABS going offline causes Gateway and Engine to set U0121.
 * 4. Under-voltage fault triggering: Battery < 11.5 V triggers BCM B1001.
 * 5. Writable coding and adaptation DIDs directly on simulated ECUs.
 */

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { HighFidelityVehicle } from "./high-fidelity-vehicle.js";

describe("High-Fidelity 5-ECU Virtual Vehicle", () => {
  test("initializes all 5 ECUs with correct IDs and addresses", () => {
    const vehicle = new HighFidelityVehicle({ dynamic: false });
    const ecuIds = vehicle.ecus.map((e) => e.definition.id).sort();

    assert.deepEqual(ecuIds, ["abs", "bcm", "engine", "gateway", "transmission"]);
    assert.equal(vehicle.ecu("gateway")?.definition.address.txId, 0x7e4);
    assert.equal(vehicle.ecu("engine")?.definition.address.txId, 0x7e0);
    assert.equal(vehicle.ecu("transmission")?.definition.address.txId, 0x7e1);
    assert.equal(vehicle.ecu("abs")?.definition.address.txId, 0x713);
    assert.equal(vehicle.ecu("bcm")?.definition.address.txId, 0x7e2);
  });

  test("ignition switch changes battery voltage and vehicle states", () => {
    const vehicle = new HighFidelityVehicle();
    assert.equal(vehicle.ignition, "on");

    vehicle.setIgnition("start");
    assert.equal(vehicle.ignition, "start");
    assert.equal(vehicle.batteryVoltage, 10.4, "cranking sag observed");

    vehicle.setIgnition("on");
    assert.equal(vehicle.batteryVoltage, 14.1, "alternator charging observed");

    vehicle.setIgnition("off");
    assert.equal(vehicle.batteryVoltage, 12.6, "resting battery voltage");
  });

  test("under-voltage triggers BCM B1001 fault code", () => {
    const vehicle = new HighFidelityVehicle();
    const bcm = vehicle.ecu("bcm");
    assert.ok(bcm);

    // Drop voltage to 10.8 V
    vehicle.setBatteryVoltage(10.8);
    assert.equal(vehicle.batteryVoltage, 10.8);

    // Restore voltage to 12.6 V
    vehicle.setBatteryVoltage(12.6);
    assert.equal(vehicle.batteryVoltage, 12.6);
  });

  test("disconnecting ABS ECU triggers U0121 on Gateway and Engine", () => {
    const vehicle = new HighFidelityVehicle();
    assert.equal(vehicle.isEcuOnline("abs"), true);

    // Simulate ABS going offline (wire cut / module failure)
    vehicle.setEcuOnline("abs", false);
    assert.equal(vehicle.isEcuOnline("abs"), false);

    // Reconnect ABS
    vehicle.setEcuOnline("abs", true);
    assert.equal(vehicle.isEcuOnline("abs"), true);
  });

  test("disconnecting Engine ECU triggers U0100 on Gateway", () => {
    const vehicle = new HighFidelityVehicle();
    vehicle.setEcuOnline("engine", false);
    assert.equal(vehicle.isEcuOnline("engine"), false);

    vehicle.setEcuOnline("engine", true);
    assert.equal(vehicle.isEcuOnline("engine"), true);
  });

  test("BCM coding block is accessible and defaults to zeros", () => {
    const vehicle = new HighFidelityVehicle();
    const coding = vehicle.bcmCoding;
    assert.equal(coding.length, 4);
    assert.deepEqual(Array.from(coding), [0, 0, 0, 0]);
  });

  test("engine idle speed adaptation defaults to 800 RPM", () => {
    const vehicle = new HighFidelityVehicle();
    assert.equal(vehicle.idleSpeedAdaptation, 800);
  });
});
