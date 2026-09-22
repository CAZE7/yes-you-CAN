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

import { ignitionCode, type VehicleModelState, type VehicleThresholds } from "./vehicle-state.js";

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

/** One signal's reader: the model in, the number out. */
export type ModelSignalReader = (source: ModelSignalSource) => number;

/**
 * Every signal id this vehicle answers from a physical state, with its reader.
 *
 * A table and not a switch, because the list of ids is itself a claim: the definition
 * package the vehicle runs on has to declare exactly these signals (plus the ones the
 * vehicle answers from its own registers), and `vehicle-definition.spec.ts` compares the
 * two. A switch cannot be enumerated, so the check would have to read this file's text —
 * and a rule the test extracts from source has its home in the wrong file.
 */
export const MODEL_SIGNAL_READERS: Readonly<Record<string, ModelSignalReader>> = {
  "engine.rpm": (source) => source.state.rpm,
  "engine.coolant_temperature": (source) => source.state.coolantC,
  "transmission.oil_temperature": (source) => source.state.oilC,
  "vehicle.speed": (source) => source.state.speedKph,
  "engine.load": (source) => source.state.loadPct,
  "engine.throttle_position": (source) => source.state.throttlePct,
  "engine.short_term_fuel_trim": (source) => source.state.shortTermTrimPct,
  "engine.long_term_fuel_trim": (source) => source.state.longTermTrimPct,
  "engine.intake_manifold_pressure": (source) => source.state.mapKpa,
  "engine.intake_air_temperature": (source) => source.state.intakeAirC,
  "engine.timing_advance": (source) => source.state.timingAdvanceDeg,
  "engine.maf_airflow": (source) => source.state.mafGramsPerS,
  "engine.runtime": (source) => source.state.runtimeS,
  "engine.fuel_rail_pressure": (source) => source.state.fuelRailKpa,
  // Closed loop is a decision about the mixture, not a sensor: it is only reached once
  // the coolant left warm-up behind, and the engine runs.
  "engine.fuel_system_status": (source) =>
    source.state.coolantC >= source.thresholds.closedLoopCoolantC && source.state.engineRunning
      ? 2
      : 1,
  "transmission.gear_position": (source) => source.state.gear,
  "abs.brake_pedal": (source) => (source.state.brakePressed ? 1 : 0),
  "abs.wheel_speed_front_left": (source) => source.state.wheelSpeedKph.frontLeft,
  "abs.wheel_speed_front_right": (source) => source.state.wheelSpeedKph.frontRight,
  "abs.wheel_speed_rear_left": (source) => source.state.wheelSpeedKph.rearLeft,
  "abs.wheel_speed_rear_right": (source) => source.state.wheelSpeedKph.rearRight,
  // The supply voltage a module reports is the one at *its* pins; the battery's label
  // would hide a corroded feed, which is the whole point of the B1001 monitor.
  "bcm.battery_voltage": (source) => source.supplyOf("bcm"),
  "bcm.ignition_state": (source) => ignitionCode(source.state.ignition),
  // Routing is reported as the gateway's own verdict about its supervised peers, so a
  // module that stops talking is visible here before any U-code is latched.
  "gateway.routing_state": (source) => (source.anyPeerSilent("gateway") ? 0 : 1),
  "gateway.bus_sleep_state": (source) =>
    source.state.ignition === "lock" || !source.state.engineRunning ? 0 : 1,
  "engine.idle_speed_adaptation": (source) => source.idleAdaptation,
};

/** The ids of {@link MODEL_SIGNAL_READERS} — the vehicle's signal vocabulary. */
export const MODEL_SIGNAL_IDS: readonly string[] = Object.keys(MODEL_SIGNAL_READERS);

/** The model's answer for one signal id, or `undefined` when the model is silent about it. */
export function readModelSignal(source: ModelSignalSource, signalId: string): number | undefined {
  return MODEL_SIGNAL_READERS[signalId]?.(source);
}
