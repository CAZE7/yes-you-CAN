/**
 * The four readers in `vehicle-signals.ts` that decide instead of relaying (AGENTS 32).
 *
 * Twenty-one of the table's entries are `state.something` — a field, nothing to test
 * beyond "the mapping names the right field", which the model's own specs read out
 * through real runs. The four below are conditions, and a condition has arms: run through
 * one side only, and the file stays at 66 % branches while every scenario in the catalog
 * passes. A probe source is enough for that, so this file builds one instead of heating
 * a car.
 */

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { VehicleBehaviourModel } from "./vehicle-model.js";
import type { ModelSignalSource } from "./vehicle-signals.js";
import { MODEL_SIGNAL_IDS, readModelSignal } from "./vehicle-signals.js";
import type { VehicleModelState, VehicleThresholds } from "./vehicle-state.js";

/**
 * A complete state from a real model with the few fields a reader looks at overridden,
 * so an expectation says *the condition* rather than a fixture that also has to be right.
 */
function probe(
  options: {
    state?: Partial<VehicleModelState>;
    thresholds?: Partial<VehicleThresholds>;
    supply?: number;
    peerSilent?: boolean;
    idleAdaptation?: number;
  } = {},
): ModelSignalSource {
  const model = new VehicleBehaviourModel();
  const supply = options.supply ?? 12.4;
  const peerSilent = options.peerSilent ?? false;
  return {
    state: { ...model.state, ...(options.state ?? {}) },
    thresholds: { ...model.thresholds, ...(options.thresholds ?? {}) },
    supplyOf: () => supply,
    anyPeerSilent: () => peerSilent,
    idleAdaptation: options.idleAdaptation ?? model.idleAdaptation,
  };
}

describe("the conditional readers", () => {
  test("fuel system status is closed loop only when the engine runs *and* the coolant is warm", () => {
    // Both arms of both conditions, because "and" is where an enable condition goes wrong:
    // a warm engine that is off is open loop, and a running cold one is too.
    const running = { engineRunning: true };
    assert.equal(
      readModelSignal(probe({ state: { ...running, coolantC: 90 } }), "engine.fuel_system_status"),
      2,
      "warm and running — the ECU trims from the oxygen sensor",
    );
    assert.equal(
      readModelSignal(
        probe({ state: { ...running, coolantC: 90 }, thresholds: { closedLoopCoolantC: 200 } }),
        "engine.fuel_system_status",
      ),
      1,
      "warm, but the enable threshold has not been reached",
    );
    assert.equal(
      readModelSignal(
        probe({ state: { engineRunning: false, coolantC: 90 } }),
        "engine.fuel_system_status",
      ),
      1,
      "warm and stopped — an idling decision is not a running one",
    );
  });

  test("routing state is the gateway's own verdict about its peers", () => {
    assert.equal(readModelSignal(probe(), "gateway.routing_state"), 1, "everybody answers");
    assert.equal(
      readModelSignal(probe({ peerSilent: true }), "gateway.routing_state"),
      0,
      "one silent peer is a degraded route, before any U-code is latched",
    );
  });

  test("bus sleep follows the key and the engine, not the clock", () => {
    assert.equal(
      readModelSignal(
        probe({ state: { ignition: "lock", engineRunning: true } }),
        "gateway.bus_sleep_state",
      ),
      0,
      "key off",
    );
    assert.equal(
      readModelSignal(
        probe({ state: { ignition: "on", engineRunning: false } }),
        "gateway.bus_sleep_state",
      ),
      0,
      "key on, engine stopped — the bus is awake but the car is not",
    );
    assert.equal(
      readModelSignal(
        probe({ state: { ignition: "on", engineRunning: true } }),
        "gateway.bus_sleep_state",
      ),
      1,
      "running",
    );
  });

  test("a reported supply voltage is the one at the module's pins", () => {
    // The label on the battery and the voltage at the BCM are different numbers when a
    // feed is corroded, and the BCM's DTC rests on the second one. A mapping that
    // relayed the battery would hide exactly the fault the monitor looks for.
    const source = probe({ state: { batteryVoltage: 13.9 }, supply: 9.1 });
    assert.equal(readModelSignal(source, "bcm.battery_voltage"), 9.1);
  });

  test("brake pedal and gear are relayed as they are", () => {
    assert.equal(readModelSignal(probe({ state: { brakePressed: true } }), "abs.brake_pedal"), 1);
    assert.equal(readModelSignal(probe({ state: { brakePressed: false } }), "abs.brake_pedal"), 0);
    assert.equal(readModelSignal(probe({ state: { gear: 4 } }), "transmission.gear_position"), 4);
    assert.equal(
      readModelSignal(probe({ idleAdaptation: 812 }), "engine.idle_speed_adaptation"),
      812,
    );
  });
});

describe("the boundary of the table", () => {
  test("a signal the model has no rule for stays unanswered", () => {
    // Not a zero: the caller answers from its own default, and the distinction is what
    // keeps an undocumented signal from looking like a measurement.
    for (const id of ["engine.vin", "engine.spare_part_number", "abs.wheel_speed_center"]) {
      assert.equal(readModelSignal(probe(), id), undefined, `${id} is not a measurement`);
    }
  });

  test("every id of the table answers something on a default vehicle", () => {
    // The table is the vehicle's signal vocabulary, so an entry that returns undefined
    // for a well-formed state is a bug in the mapping, not a signal the model skips.
    const silent = MODEL_SIGNAL_IDS.filter((id) => readModelSignal(probe(), id) === undefined);
    assert.deepEqual(
      silent,
      [],
      `these ids are declared as answers but produce nothing: ${silent.join(", ")}`,
    );
  });
});
