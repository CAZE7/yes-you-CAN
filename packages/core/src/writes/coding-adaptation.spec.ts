/**
 * Unit tests for virtual ECU Coding and Adaptation operations (AGENTS 25, 26; master backlog P2 #31, #32).
 *
 * Verifies the full write lifecycle:
 * Read -> Preview -> Precheck -> Permit -> Confirmation -> Write -> Readback -> Verify -> Rollback/Audit.
 */

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  type AdaptationTargetEcu,
  type CodingTargetEcu,
  SafetyManager,
  applyCodingChanges,
  createAdaptationOperation,
  createCodingOperation,
  runAdaptation,
  runCoding,
} from "../index.js";
import { type WriteBinding, WritePort } from "./port.js";

class FakeVirtualBcm implements CodingTargetEcu {
  id = "ecu-bcm";
  name = "Body Control Module";
  sessionType = 0x01;
  codingMemory: Uint8Array;
  writeAttempts = 0;
  failNextWrite = false;
  corruptReadback = false;

  constructor(initialCoding: Uint8Array) {
    this.codingMemory = new Uint8Array(initialCoding);
  }

  async prepareWrite(targetSession = 0x03) {
    this.sessionType = targetSession;
    return { sessionType: this.sessionType, switched: true };
  }

  async readCoding(_did = 0x0200): Promise<Uint8Array> {
    if (this.corruptReadback) {
      return new Uint8Array([0xff, 0xff, 0xff]);
    }
    return new Uint8Array(this.codingMemory);
  }

  async writeCoding(data: Uint8Array, _did = 0x0200): Promise<void> {
    this.writeAttempts++;
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error("EEPROM programming voltage failure");
    }
    this.codingMemory = new Uint8Array(data);
  }
}

class FakeVirtualEngine implements AdaptationTargetEcu {
  id = "ecu-engine";
  name = "Engine Control Unit";
  sessionType = 0x01;
  adaptationMemory = new Map<number, number>();
  writeAttempts = 0;
  failNextWrite = false;
  corruptReadback = false;

  constructor() {
    this.adaptationMemory.set(0x2100, 800); // Default idle_speed = 800 rpm
  }

  async prepareWrite(targetSession = 0x03) {
    this.sessionType = targetSession;
    return { sessionType: this.sessionType, switched: true };
  }

  async readAdaptation(channelDid: number): Promise<number> {
    if (this.corruptReadback) {
      return 9999;
    }
    return this.adaptationMemory.get(channelDid) ?? 0;
  }

  async writeAdaptation(channelDid: number, value: number): Promise<void> {
    this.writeAttempts++;
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error("ECU adaptation condition not met");
    }
    this.adaptationMemory.set(channelDid, value);
  }
}

const READY_STATE = {
  stationary: true,
  ignitionOn: true,
  batteryVoltage: 12.6,
  parkingBrake: true,
};

function bcmBinding(bcm: FakeVirtualBcm): WriteBinding {
  return {
    ecuId: bcm.id,
    ecuName: bcm.name,
    sessionId: "test-session",
    sessionType: bcm.sessionType,
    definitionVersion: "1.0.0",
    vehicleState: READY_STATE,
  };
}

function engineBinding(engine: FakeVirtualEngine): WriteBinding {
  return {
    ecuId: engine.id,
    ecuName: engine.name,
    sessionId: "test-session",
    sessionType: engine.sessionType,
    definitionVersion: "1.0.0",
    vehicleState: READY_STATE,
  };
}

describe("Virtual Coding System", () => {
  test("applyCodingChanges correctly modifies bit and byte levels with diff", () => {
    const original = new Uint8Array([0x00, 0x12, 0x34]);
    // Byte 0, Bit 3 (0x08) -> 1 (e.g. Daytime Running Lights)
    const result = applyCodingChanges(original, [
      { byteIndex: 0, bitIndex: 3, value: 1, description: "DRL enabled" },
      { byteIndex: 1, value: 0xaa, description: "Country code" },
    ]);

    assert.equal(result.modified[0], 0x08);
    assert.equal(result.modified[1], 0xaa);
    assert.equal(result.modified[2], 0x34);
    assert.equal(result.diffSummary.length, 2);
    assert.match(result.diffSummary[0] ?? "", /Byte 0 Bit 3: 0 -> 1/);
    assert.match(result.diffSummary[1] ?? "", /Byte 1: 0x12 -> 0xAA/);
  });

  test("full successful coding write with readback verification and audit", async () => {
    const safety = new SafetyManager();
    const port = new WritePort({ safety });
    port.register(createCodingOperation());

    const bcm = new FakeVirtualBcm(new Uint8Array([0x00, 0x00, 0x00, 0x00]));
    const actions: string[] = [];

    const result = await runCoding(
      port,
      {
        target: bcm,
        did: 0x0200,
        changes: [{ byteIndex: 0, bitIndex: 3, value: 1, description: "Enable DRL" }],
        userConfirmed: true,
        recordAction: (a) => actions.push(a.kind),
      },
      bcmBinding(bcm),
    );

    assert.equal(result.ok, true);
    assert.equal(result.transaction.state, "verified");
    assert.equal(result.value?.verified, true);
    assert.equal(result.value?.before[0], 0x00);
    assert.equal(result.value?.after[0], 0x08);
    assert.equal(bcm.codingMemory[0], 0x08);
    assert.equal(bcm.sessionType, 0x03, "switched to extended diagnostic session");
    assert.deepEqual(actions, ["coding-write"]);

    // Audit log records write-success
    assert.ok(safety.audit.some((entry) => entry.action === "write-success"));
  });

  test("coding is refused if operator does not confirm", async () => {
    const safety = new SafetyManager();
    const port = new WritePort({ safety });
    port.register(createCodingOperation());

    const bcm = new FakeVirtualBcm(new Uint8Array([0x00]));
    const result = await runCoding(
      port,
      {
        target: bcm,
        changes: [{ byteIndex: 0, bitIndex: 3, value: 1 }],
        userConfirmed: false,
      },
      bcmBinding(bcm),
    );

    assert.equal(result.ok, false);
    assert.equal(bcm.writeAttempts, 0, "nothing was written to ECU");
    assert.equal(result.transaction.state, "aborted");
    assert.match(result.reasons.join("; "), /confirmation/);
  });

  test("coding write failure rolls back to original backup", async () => {
    const safety = new SafetyManager();
    const port = new WritePort({ safety });
    port.register(createCodingOperation());

    const initial = new Uint8Array([0x42]);
    const bcm = new FakeVirtualBcm(initial);
    bcm.failNextWrite = true; // Fails execute, but rollback write succeeds

    const result = await runCoding(
      port,
      {
        target: bcm,
        changes: [{ byteIndex: 0, value: 0x99 }],
        userConfirmed: true,
      },
      bcmBinding(bcm),
    );

    assert.equal(result.ok, false);
    assert.match(result.reasons.join("; "), /EEPROM programming voltage/);
    assert.equal(bcm.codingMemory[0], 0x42, "original backup maintained");
    assert.equal(result.transaction.state, "rolled-back");
  });

  test("coding readback mismatch fails verification and reports reasons", async () => {
    const safety = new SafetyManager();
    const port = new WritePort({ safety });
    port.register(createCodingOperation());

    const initial = new Uint8Array([0x10]);
    const bcm = new FakeVirtualBcm(initial);
    bcm.corruptReadback = true;

    const result = await runCoding(
      port,
      {
        target: bcm,
        changes: [{ byteIndex: 0, value: 0x20 }],
        userConfirmed: true,
      },
      bcmBinding(bcm),
    );

    assert.equal(result.ok, false);
    assert.match(result.reasons.join("; "), /does not match written configuration/);
    assert.equal(result.transaction.state, "executed");
    assert.equal(result.value?.verified, false);
  });
});

describe("Virtual Adaptation System", () => {
  test("full successful parameter adaptation write with readback verify", async () => {
    const safety = new SafetyManager();
    const port = new WritePort({ safety });
    port.register(createAdaptationOperation());

    const engine = new FakeVirtualEngine();
    const actions: string[] = [];

    const result = await runAdaptation(
      port,
      {
        target: engine,
        channelDid: 0x2100,
        channelName: "idle_speed",
        requestedValue: 750,
        allowedRange: { min: 600, max: 900, unit: "rpm" },
        userConfirmed: true,
        recordAction: (a) => actions.push(a.kind),
      },
      engineBinding(engine),
    );

    assert.equal(result.ok, true);
    assert.equal(result.transaction.state, "verified");
    assert.equal(result.value?.verified, true);
    assert.equal(result.value?.before, 800);
    assert.equal(result.value?.after, 750);
    assert.equal(engine.adaptationMemory.get(0x2100), 750);
    assert.deepEqual(actions, ["adaptation-write"]);
    assert.ok(safety.audit.some((entry) => entry.action === "write-success"));
  });

  test("adaptation out of allowed range is rejected before touching ECU", async () => {
    const safety = new SafetyManager();
    const port = new WritePort({ safety });
    port.register(createAdaptationOperation());

    const engine = new FakeVirtualEngine();

    const result = await runAdaptation(
      port,
      {
        target: engine,
        channelDid: 0x2100,
        channelName: "idle_speed",
        requestedValue: 1200, // Dangerously high idle speed outside 600..900 range
        allowedRange: { min: 600, max: 900, unit: "rpm" },
        userConfirmed: true,
      },
      engineBinding(engine),
    );

    assert.equal(result.ok, false);
    assert.equal(engine.writeAttempts, 0, "ECU was never written to");
    assert.match(result.reasons.join("; "), /outside permitted range 600..900/);
    assert.equal(result.transaction.state, "aborted");
  });

  test("adaptation write failure restores original backup value via rollback", async () => {
    const safety = new SafetyManager();
    const port = new WritePort({ safety });
    port.register(createAdaptationOperation());

    const engine = new FakeVirtualEngine();
    engine.failNextWrite = true; // Fails execute, rollback succeeds

    const result = await runAdaptation(
      port,
      {
        target: engine,
        channelDid: 0x2100,
        channelName: "idle_speed",
        requestedValue: 700,
        allowedRange: { min: 600, max: 900, unit: "rpm" },
        userConfirmed: true,
      },
      engineBinding(engine),
    );

    assert.equal(result.ok, false);
    assert.match(result.reasons.join("; "), /adaptation condition not met/);
    assert.equal(engine.adaptationMemory.get(0x2100), 800, "original 800 RPM backup intact");
    assert.equal(result.transaction.state, "rolled-back");
  });
});
