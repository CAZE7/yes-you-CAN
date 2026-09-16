/**
 * How the vehicle state becomes the signals a definition package names (AGENTS 13, 32).
 *
 * A projection, deliberately its own module: the physics in `vehicle-model.ts` decides
 * what the car does, and this file decides which of those numbers a given signal id
 * answers with. Keeping them apart is what lets a vehicle, a freeze frame and a live DID
 * read one source — three consumers, one mapping, no third copy of "what is
 * `engine.rpm`?".
 *
 * `undefined` is part of the contract and not a miss: it says "the model has no rule for
 * this signal", and the caller then answers from its own default. Inventing a zero for an
 * undocumented signal is how a simulator starts reporting values nobody measured.
 */

import { type VehicleModelState, type VehicleThresholds, ignitionCode } from "./vehicle-state.js";

/** What the mapping may ask the model about. */
export interface ModelSignalSource {
  readonly state: Readonly<VehicleModelState>;
  readonly thresholds: VehicleThresholds;
  /** Voltage at one module's pins — a measured value, not the battery's label. */
  supplyOf(ecuId: string): number;
  /** Whether any supervised peer is currently silent on the bus. */
  anyPeerSilent(ecuId: string): boolean;
  /** The adaptation value the module learned, not the one it started with. */
  readonly idleAdaptation: number;
}

/** The model's answer for one signal id, or `undefined` when the model is silent about it. */
export function readModelSignal(source: ModelSignalSource, signalId: string): number | undefined {
  const state = source.state;
  switch (signalId) {
    case "engine.rpm":
      return state.rpm;
    case "engine.coolant_temperature":
      return state.coolantC;
    case "transmission.oil_temperature":
      return state.oilC;
    case "vehicle.speed":
      return state.speedKph;
    case "engine.load":
      return state.loadPct;
    case "engine.throttle_position":
      return state.throttlePct;
    case "engine.short_term_fuel_trim":
      return state.shortTermTrimPct;
    case "engine.long_term_fuel_trim":
      return state.longTermTrimPct;
    case "engine.intake_manifold_pressure":
      return state.mapKpa;
    case "engine.intake_air_temperature":
      return state.intakeAirC;
    case "engine.timing_advance":
      return state.timingAdvanceDeg;
    case "engine.maf_airflow":
      return state.mafGramsPerS;
    case "engine.runtime":
      return state.runtimeS;
    case "engine.fuel_rail_pressure":
      return state.fuelRailKpa;
    case "engine.fuel_system_status":
      return state.coolantC >= source.thresholds.closedLoopCoolantC && state.engineRunning ? 2 : 1;
    case "transmission.gear_position":
      return state.gear;
    case "abs.brake_pedal":
      return state.brakePressed ? 1 : 0;
    case "abs.wheel_speed_front_left":
      return state.wheelSpeedKph.frontLeft;
    case "abs.wheel_speed_front_right":
      return state.wheelSpeedKph.frontRight;
    case "abs.wheel_speed_rear_left":
      return state.wheelSpeedKph.rearLeft;
    case "abs.wheel_speed_rear_right":
      return state.wheelSpeedKph.rearRight;
    case "bcm.battery_voltage":
      return source.supplyOf("bcm");
    case "bcm.ignition_state":
      return ignitionCode(state.ignition);
    case "gateway.routing_state":
      return source.anyPeerSilent("gateway") ? 0 : 1;
    case "gateway.bus_sleep_state":
      return state.ignition === "lock" || !state.engineRunning ? 0 : 1;
    case "engine.idle_speed_adaptation":
      return source.idleAdaptation;
    default:
      return undefined;
  }
}
