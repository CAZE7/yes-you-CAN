import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  type IgnitionState,
  VEHICLE_PHYSICS,
  VEHICLE_THRESHOLDS,
  approach,
  ignitionCode,
  round,
} from "./vehicle-state.js";

/**
 * Unit tests for the vocabulary of the behaviour model (AGENTS 32). The model itself
 * is tested by `vehicle-model.spec.ts`; these three helpers and the calibration table
 * are what that model reads, and a wrong number here is a bug no model test can
 * localise — it would just look like physics.
 */

describe("round", () => {
  test("rounds to the decimals the scale implies", () => {
    assert.equal(round(10.765, 0.1), 10.8);
    assert.equal(round(0.25, 0.01), 0.25);
    assert.equal(round(799.6, 1), 800);
  });

  test("never resolves finer than four decimals", () => {
    // A wire value scaled below 1e-4 would start reporting binary float noise as a
    // measurement, so the helper clamps. The clamp is the contract, not an accident.
    assert.equal(round(1.23456789, 1e-7), 1.2346);
    assert.equal(round(1.23456789, 0.0000000001), 1.2346);
  });
});

describe("approach", () => {
  test("moves at most the rate over the elapsed model time", () => {
    // 100 units/s over 20 ms of model time is 2 units, whatever the gap is.
    assert.equal(approach(10, 20, 100, 0.02), 12);
    assert.equal(approach(20, 10, 100, 0.02), 18);
  });

  test("stops on the target instead of overshooting it", () => {
    assert.equal(approach(19.5, 20, 100, 0.02), 20);
    assert.equal(approach(20.5, 20, 100, 0.02), 20);
  });

  test("is stable at the target", () => {
    assert.equal(approach(20, 20, 100, 0.02), 20);
    // The step is a no-op, so a settled value does not accumulate float drift across
    // thousands of slices — the reason the snap-to-target branch exists.
    let value = 0.1;
    for (let i = 0; i < 1000; i++) value = approach(value, 0.1 + 1e-12, 1, 0.02);
    assert.equal(value, 0.1 + 1e-12);
  });
});

describe("ignitionCode", () => {
  test("orders the key positions the way the barrel does", () => {
    const positions: IgnitionState[] = ["lock", "off", "acc", "on", "start"];
    assert.deepEqual(positions.map(ignitionCode), [0, 1, 2, 3, 4]);
  });

  test("codes are distinct, so no signal reads one position as another", () => {
    const positions: IgnitionState[] = ["lock", "off", "acc", "on", "start"];
    const codes = new Set(positions.map(ignitionCode));
    assert.equal(codes.size, 5);
  });
});

describe("VEHICLE_THRESHOLDS", () => {
  test("the voltage windows are ordered, or the supply monitor could never heal", () => {
    // vehicle-monitors.ts heals between recoveryVoltageV and overvoltageRecoveryV, and
    // fails below undervoltageV or above overvoltageV, with brownout killing the module
    // outright. One interval has to nest in the next or a latch is unreachable.
    const t = VEHICLE_THRESHOLDS;
    assert.ok(t.brownoutV < t.undervoltageV, "a module must fail its monitor before it dies");
    assert.ok(
      t.undervoltageV < t.recoveryVoltageV && t.recoveryVoltageV < t.overvoltageRecoveryV,
      "the heal window has to be a real interval",
    );
    assert.ok(t.overvoltageRecoveryV < t.overvoltageV, "hysteresis on the high side too");
  });

  test("an engine that can fire is an engine whose modules can report it", () => {
    // vehicle-model.ts fires on supplyVoltage >= crankingStartV and drops out below
    // brownoutV + 1; inverted, the car runs while nobody on the bus can see it.
    assert.ok(VEHICLE_THRESHOLDS.crankingStartV > VEHICLE_THRESHOLDS.brownoutV);
  });

  test("idle sits above the stall speed", () => {
    // The engine relaxes towards idleRpm and stops below stallRpm; if the two crossed,
    // a settled idle would be a stall.
    assert.ok(VEHICLE_THRESHOLDS.idleRpm > VEHICLE_THRESHOLDS.stallRpm);
  });

  test("the timeout and plausibility windows are positive", () => {
    // busTimeoutMs of 0 makes every gap a lost peer; plausibilityKph of 0 lets the wheel
    // monitor run at standstill, where its comparisons have nothing to compare against.
    assert.ok(VEHICLE_THRESHOLDS.busTimeoutMs > 0);
    assert.ok(VEHICLE_THRESHOLDS.plausibilityKph > 0);
    assert.ok(VEHICLE_THRESHOLDS.debounceMs > 0 && VEHICLE_THRESHOLDS.healMs > 0);
  });
});

describe("VEHICLE_PHYSICS", () => {
  test("the discharge floor is below every threshold that reads a sagging battery", () => {
    // The model clamps the battery at minimumBatteryV; if that floor were above
    // brownoutV, an undervoltage scenario could never brown a module out at all.
    assert.ok(VEHICLE_PHYSICS.minimumBatteryV < VEHICLE_THRESHOLDS.brownoutV);
  });

  test("cranking alone sags the terminal by a whole no-fire margin", () => {
    // 90 A * 0.012 V/A is the sag a starter pulls: about a volt, which is why a weak
    // battery is a no-fire condition in this model rather than a story.
    const sag = VEHICLE_PHYSICS.crankingCurrentA * VEHICLE_PHYSICS.voltsPerAmpere;
    assert.ok(sag > 0.5 && sag < 2, `cranking sag was ${sag} V`);
  });

  test("a charging alternator heals a low-voltage code without faking a load dump", () => {
    // The regulator target has to sit inside the heal window: below it, charging would
    // never clear B1001; above the overvoltage window, every healthy charge would look
    // like a load dump.
    const target = VEHICLE_PHYSICS.chargeTargetV;
    assert.ok(
      target > VEHICLE_THRESHOLDS.recoveryVoltageV && target < VEHICLE_THRESHOLDS.overvoltageV,
      `charge target ${target} V is outside the heal window`,
    );
  });
});
