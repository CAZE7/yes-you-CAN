import assert from "node:assert/strict";
import { describe, test } from "vitest";
import type { EcuView } from "../src/views.js";
import {
  adaptationResultViewOf,
  codingResultViewOf,
  ecuNameOf,
  writeBindingOf,
} from "../src/write-ops.js";

const ECU: EcuView = {
  id: "engine",
  name: "Engine",
  txId: "0x7E0",
  rxId: "0x7E8",
  extended: false,
  reachable: true,
  sessionType: 1,
  p2Ms: 50,
  dtcCount: 0,
  services: [],
  identification: [],
};

describe("writeBindingOf", () => {
  test("optional vehicle fields stay absent when the operator did not assert them", () => {
    const binding = writeBindingOf(0x7e8, "Engine", { stationary: true, ignitionOn: true });
    assert.equal(binding.ecuId, "0x7e8");
    assert.equal(binding.ecuName, "Engine");
    assert.equal(binding.vehicleState.stationary, true);
    assert.equal("parkingBrake" in binding.vehicleState, false);
    assert.equal("batteryVoltage" in binding.vehicleState, false);
  });

  test("asserted preconditions travel with the binding", () => {
    const binding = writeBindingOf(0x7e8, "Engine", {
      stationary: true,
      ignitionOn: true,
      parkingBrake: true,
      batteryVoltage: 12.4,
    });
    assert.equal(binding.vehicleState.parkingBrake, true);
    assert.equal(binding.vehicleState.batteryVoltage, 12.4);
  });
});

describe("ecuNameOf", () => {
  test("a known address keeps its name, an unknown one is labelled", () => {
    assert.equal(ecuNameOf([ECU], 0x7e8), "Engine");
    assert.match(ecuNameOf([ECU], 0x7e9), /^ECU_/);
  });
});

describe("result views", () => {
  const binding = writeBindingOf(0x7e8, "Engine", { stationary: true, ignitionOn: true });

  test("coding projects present hex and omits missing hex", () => {
    const full = codingResultViewOf(
      {
        ok: true,
        reasons: [],
        warnings: ["check voltage"],
        transaction: { id: "tx-1" },
        value: { originalHex: "00", writtenHex: "01", verified: true },
      },
      binding,
      0x0100,
    );
    assert.equal(full.verified, true);
    assert.equal(full.originalHex, "00");
    assert.equal(full.writtenHex, "01");
    assert.equal(full.transactionId, "tx-1");

    const empty = codingResultViewOf(
      { ok: false, reasons: ["refused"], warnings: [], transaction: { id: "tx-2" }, value: null },
      binding,
      0x0100,
    );
    assert.equal(empty.verified, false);
    assert.equal("originalHex" in empty, false);
    assert.deepEqual(empty.reasons, ["refused"]);
  });

  test("adaptation projects present numbers and omits missing ones", () => {
    const full = adaptationResultViewOf(
      {
        ok: true,
        reasons: [],
        warnings: [],
        transaction: { id: "tx-3" },
        value: { originalValue: 1, writtenValue: 2, unit: "km/h", verified: true },
      },
      binding,
      0x2100,
    );
    assert.equal(full.originalValue, 1);
    assert.equal(full.writtenValue, 2);
    assert.equal(full.unit, "km/h");

    const empty = adaptationResultViewOf(
      { ok: false, reasons: [], warnings: [], transaction: { id: "tx-4" }, value: 7 },
      binding,
      0x2100,
    );
    assert.equal(empty.verified, false);
    assert.equal("unit" in empty, false);
  });
});
