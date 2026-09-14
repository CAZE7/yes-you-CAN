/**
 * SafetyManager (AGENTS 26, master backlog P0 #5): the write gate. Every
 * precondition must be *proven*; missing evidence is a failure like a violated
 * precondition — it is only reported separately (`unproven`), so a caller can
 * tell "the vehicle is not stationary" from "nobody measured the battery". A
 * permit is never issued on a failed check.
 */

import assert from "node:assert/strict";
import { SafetyViolationError } from "@vdp/shared";
import { describe, test } from "vitest";
import { type FixturePatch, patched } from "../../../../tests/helpers/fixture.js";
import {
  DEFAULT_MIN_BATTERY_VOLTAGE,
  SafetyManager,
  type VehicleState,
  type WriteRequestContext,
} from "./safety-manager.js";

const OK_STATE: VehicleState = {
  stationary: true,
  batteryVoltage: 12.5,
  ignitionOn: true,
  parkingBrake: true,
};

const OK_CONTEXT: WriteRequestContext = {
  ecuId: "ecu_1",
  ecuName: "Motorsteuerung",
  definitionVersion: "1.0.0",
  newValue: "01",
  previousValue: "00",
  risk: "medium",
  userConfirmed: true,
  backupAvailable: true,
  activeSessionType: 0x03,
};

describe("evaluate — precondition catalogue", () => {
  test("a complete, clean request passes with no failures, no unproven checks and no warnings", () => {
    const result = new SafetyManager().evaluate(OK_CONTEXT, OK_STATE);
    assert.deepEqual(result, { ok: true, failed: [], unproven: [], warnings: [] });
  });

  test("vehicle state: moving, ignition off, and low battery each block independently", () => {
    const manager = new SafetyManager();
    const result = manager.evaluate(OK_CONTEXT, {
      ...OK_STATE,
      stationary: false,
      ignitionOn: false,
      batteryVoltage: 11.4,
    });
    assert.equal(result.ok, false);
    assert.deepEqual(result.failed, [
      "vehicle is not stationary",
      "battery voltage 11.40 V is below the required 12.00 V",
      "ignition is off",
    ]);
    const brakeOnly = new SafetyManager().evaluate(OK_CONTEXT, {
      ...OK_STATE,
      parkingBrake: false,
    });
    assert.deepEqual(brakeOnly.failed, ["parking brake not engaged"]);
  });

  test("missing evidence blocks the write and is named as unproven", () => {
    // Only "the vehicle is standing" is known. Everything a medium-risk write
    // needs beyond that is unproven — and unproven is not "probably fine".
    const result = new SafetyManager().evaluate(OK_CONTEXT, { stationary: true });
    assert.equal(result.ok, false);
    assert.deepEqual(result.unproven, [
      "battery voltage unknown — cannot prove the supply is stable",
      "ignition state unknown — cannot prove the ignition is on",
      "parking brake state unknown — cannot prove the vehicle is held",
    ]);
    assert.deepEqual(
      result.failed,
      result.unproven,
      "the unproven reasons are part of the blocking reasons, not a footnote",
    );
    assert.deepEqual(result.warnings, [], "a missing proof is not a warning");
  });

  test("an unread value is treated like a wrong value — never as 'no objection'", () => {
    const result = new SafetyManager().evaluate(
      { ...OK_CONTEXT, expectedEcuType: "BCM", expectedSoftwareVariant: "EU" },
      OK_STATE,
    );
    assert.equal(result.ok, false, "the definition expects BCM/EU, nobody read them");
    assert.deepEqual(result.unproven, [
      "ECU type was never read — cannot prove it matches the definition (expected BCM)",
      "software variant was never read — cannot prove it matches the definition (expected EU)",
    ]);
  });

  test("an unknown diagnostic session is unproven, the default session is a violation", () => {
    const { activeSessionType: _neverRead, ...withoutSession } = OK_CONTEXT;
    const unproven = new SafetyManager().evaluate(withoutSession as WriteRequestContext, OK_STATE);
    assert.equal(unproven.ok, false);
    assert.deepEqual(unproven.unproven, [
      "diagnostic session unknown — cannot prove the write runs in a writable session",
    ]);
    const inDefault = new SafetyManager().evaluate(
      { ...OK_CONTEXT, activeSessionType: 0x01 },
      OK_STATE,
    );
    assert.deepEqual(inDefault.failed, ["write attempted in the default diagnostic session"]);
    assert.deepEqual(inDefault.unproven, [], "a known default session is a violation, not a gap");
  });

  test("DoIP preconditions must be answered, not just present", () => {
    const result = new SafetyManager().evaluate({ ...OK_CONTEXT, network: {} }, OK_STATE);
    assert.equal(result.ok, false);
    assert.deepEqual(result.unproven, [
      "DoIP TLS state unknown — cannot prove the transport is encrypted",
      "DoIP routing activation state unknown — cannot prove the route is established",
    ]);
  });

  test("the configured minimum voltage wins over the default", () => {
    const result = new SafetyManager({ minBatteryVoltage: 13.2 }).evaluate(OK_CONTEXT, {
      ...OK_STATE,
      batteryVoltage: 12.5,
    });
    assert.equal(
      result.failed.some((f) => f.includes("13.20 V")),
      true,
    );
    assert.equal(DEFAULT_MIN_BATTERY_VOLTAGE, 12.0);
  });

  test("low risk does not demand the parking brake; medium and high do", () => {
    const state = { ...OK_STATE, parkingBrake: false };
    assert.equal(new SafetyManager().evaluate({ ...OK_CONTEXT, risk: "low" }, state).ok, true);
    assert.equal(new SafetyManager().evaluate({ ...OK_CONTEXT, risk: "medium" }, state).ok, false);
    const high = new SafetyManager().evaluate({ ...OK_CONTEXT, risk: "high" }, OK_STATE);
    assert.deepEqual(high.warnings, [
      "high risk operation — consider a workshop-grade power supply",
    ]);
    assert.equal(high.ok, true, "warnings never fail a check by themselves");
  });

  test("definition/ECU mismatches and missing evidence block the write", () => {
    const manager = new SafetyManager();
    const cases: Array<FixturePatch<WriteRequestContext>> = [
      { expectedEcuType: "BCM", actualEcuType: "Gateway" },
      { expectedSoftwareVariant: "EU", actualSoftwareVariant: "US" },
      { definitionVersion: undefined },
      { backupAvailable: false },
      { userConfirmed: false },
      { activeSessionType: 0x01 },
    ];
    for (const patch of cases) {
      // `undefined` in a patch means "this evidence was never gathered", so the
      // key is removed from the base context rather than blanked (E18).
      const result = manager.evaluate(patched(OK_CONTEXT, patch), OK_STATE);
      assert.equal(result.ok, false, `expected a failure for ${JSON.stringify(patch)}`);
      assert.ok(result.failed.length >= 1);
    }
  });

  test("a definition that expects nothing does not require a reading", () => {
    // The reverse case: without an expected ECU type there is nothing to compare,
    // so a reading is not required — and a value nobody declared is not a
    // mismatch either (AGENTS 24: no invented claims).
    const result = new SafetyManager().evaluate(
      { ...OK_CONTEXT, actualEcuType: "Gateway" },
      OK_STATE,
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.failed, []);
  });

  test("DoIP network preconditions are checked when provided", () => {
    const manager = new SafetyManager();
    const result = manager.evaluate(
      {
        ...OK_CONTEXT,
        network: {
          tlsActive: false,
          routingActivationOk: false,
          unauthorizedDevicesInSegment: true,
        },
      },
      OK_STATE,
    );
    assert.deepEqual(result.failed, [
      "DoIP transport is not using TLS",
      "DoIP routing activation failed",
      "unauthorized devices detected in the diagnostic network segment",
    ]);
    const answered = manager.evaluate(
      { ...OK_CONTEXT, network: { tlsActive: true, routingActivationOk: true } },
      OK_STATE,
    );
    assert.equal(answered.ok, true);
    assert.deepEqual(answered.failed, []);
    assert.deepEqual(answered.unproven, [], "an answered network state proves the hop");
  });
});

describe("permits", () => {
  test("a passing request issues a TTL-bounded permit and writes the audit log", () => {
    const manager = new SafetyManager({ permitTtlMs: 5_000 });
    const before = Date.now();
    const permit = manager.requestPermit(OK_CONTEXT, OK_STATE);
    assert.match(permit.id, /^permit_/);
    assert.equal(permit.ecuId, "ecu_1");
    assert.equal(permit.risk, "medium");
    assert.ok(Date.parse(permit.issuedAt) >= before - 1_000);
    assert.equal(Date.parse(permit.expiresAt) - Date.parse(permit.issuedAt), 5_000);
    assert.deepEqual(
      manager.audit.map((entry) => entry.action),
      ["permit-issued"],
    );
  });

  test("a failing request throws SafetyViolationError with every reason and audits the denial", () => {
    const manager = new SafetyManager();
    assert.throws(
      () =>
        manager.requestPermit(
          { ...OK_CONTEXT, backupAvailable: false, userConfirmed: false },
          OK_STATE,
        ),
      (error: unknown) => {
        assert.ok(error instanceof SafetyViolationError);
        assert.match((error as SafetyViolationError).message, /write to Motorsteuerung refused/);
        assert.deepEqual(
          (error as SafetyViolationError & { failedPreconditions: string[] }).failedPreconditions,
          ["no backup available — rollback would be impossible", "user confirmation missing"],
        );
        return true;
      },
    );
    assert.deepEqual(
      manager.audit.map((entry) => entry.action),
      ["permit-denied"],
    );
  });

  test("verifyPermit accepts only unexpired permits for the same ECU", () => {
    const manager = new SafetyManager({ permitTtlMs: 5_000 });
    const permit = manager.requestPermit(OK_CONTEXT, OK_STATE);
    manager.verifyPermit(permit, "ecu_1");
    assert.throws(() => manager.verifyPermit(permit, "ecu_other"), /different ECU/);
    const expired: typeof permit = { ...permit, expiresAt: new Date(Date.now() - 1).toISOString() };
    assert.throws(() => manager.verifyPermit(expired, "ecu_1"), /expired/);
  });

  test("recordResult lands in the audit log with the outcome and detail", () => {
    const manager = new SafetyManager();
    const permit = manager.requestPermit(OK_CONTEXT, OK_STATE);
    manager.recordResult(permit, "success", "DID 0x0c00 geschrieben");
    manager.recordResult(permit, "rolled-back");
    assert.deepEqual(
      manager.audit.slice(1).map((entry) => ({ action: entry.action, detail: entry.detail })),
      [
        { action: "write-success", detail: "DID 0x0c00 geschrieben" },
        { action: "write-rolled-back", detail: permit.id },
      ],
    );
  });
});
