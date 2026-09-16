/**
 * Physical state and calibration of the virtual vehicle (AGENTS 32).
 *
 * The vocabulary of the vehicle behaviour model, kept apart from the model itself for
 * the reason the repository has for every split: the *state* of a car and the *rules
 * that read it* change for different reasons. Nothing here decides anything — these
 * are numbers with units, plus the three arithmetic helpers physics and monitors use.
 */

import type { UdsServer } from "@vdp/protocols-uds";
import type { Logger } from "@vdp/shared";

export type IgnitionState = "lock" | "off" | "acc" | "on" | "start";

/** How a sensor is broken — each mode produces a *different signal*, not a DTC. */
export type SensorFaultMode =
  /** The wire is cut: the input hangs at its pull reference. */
  | "open-circuit"
  /** The signal sits at battery potential. */
  | "short-to-battery"
  /** The signal sits at ground potential. */
  | "short-to-ground"
  /** The sensor answers, but stops moving. */
  | "stuck"
  /** The sensor reports too much (false air in front of a MAF reads as too much air). */
  | "drift-high"
  /** The sensor reports too little. */
  | "drift-low";

export interface SensorFault {
  /** Signal id as the definition package names it (`engine.maf_airflow`). */
  signal: string;
  mode: SensorFaultMode;
  /** Explicit value for `stuck`; ignored by the other modes. */
  value?: number;
}

/** How a module's own wiring is broken. */
export type ModuleWiringMode =
  /** No supply: the module is dead and stops answering immediately. */
  | "power-cut"
  /** Added resistance in the feed: the pin sags as soon as the load rises. */
  | "supply-resistance"
  /** Making contact intermittently: supply and bus come and go together. */
  | "connector-loose"
  /** Supply is fine, the twisted pair is not — the module lives, nobody hears it. */
  | "bus-open";

export interface ModuleWiringFault {
  ecu: string;
  mode: ModuleWiringMode;
  /** Extra resistance in ohm for `supply-resistance` (default 0.6 Ω). */
  ohm?: number;
  /** Share of the time a `connector-loose` contact holds, for `pattern: "random"` (default 0.4). */
  duty?: number;
  /**
   * How often the contact is redrawn, in model ms (default 250).
   *
   * A per-step draw would flip a connector every 20 ms, which is not a loose plug but
   * white noise: the gap between two contacts is what a *timeout monitor* measures, so
   * the flapping needs a cadence of the same order as the timeout it has to defeat.
   */
  flapMs?: number;
  /**
   * Whether the contact is drawn at random or alternates on the clock (default random).
   *
   * `alternate` is not a convenience: a scenario that asserts "the code came and went"
   * must not depend on whose random source the caller happened to inject — and a crack
   * that opens when the bay warms and closes when it cools is periodic anyway.
   */
  pattern?: "random" | "alternate";
}

/** The calibration of one virtual vehicle. */
export interface VehicleThresholds {
  /** Supply below this makes a module's voltage monitor fail (B1001). */
  undervoltageV: number;
  /** …and it heals only above this (hysteresis). */
  recoveryVoltageV: number;
  /** Below this a module resets and answers nothing at all. */
  brownoutV: number;
  /** Supply above this is a load dump: the same monitor, the other end of the window. */
  overvoltageV: number;
  /** …and it heals only below this (hysteresis again). */
  overvoltageRecoveryV: number;
  /** Minimum supply that still spins a starter fast enough to fire the engine. */
  crankingStartV: number;
  /** Below this the combustion monitor sees misfires while running. */
  misfireVoltageV: number;
  /** The engine stops on its own below this speed. */
  stallRpm: number;
  /** Idle target the engine settles at. */
  idleRpm: number;
  /** Model time a condition must hold before a monitor latches. */
  debounceMs: number;
  /** Model time of healthy operation before `testFailed` drops again. */
  healMs: number;
  /** Operation cycles a healed code survives before the ECU ages it out. */
  removalCycles: number;
  /** Bus silence after which a supervised peer counts as lost. */
  busTimeoutMs: number;
  /** Long-term fuel trim above which the engine calls the mixture too lean. */
  leanTrimPct: number;
  /** Coolant temperature from which the mixture monitors are enabled. */
  closedLoopCoolantC: number;
  /** Wheel speed that must be exceeded before the other three are plausible. */
  plausibilityKph: number;
}

export const VEHICLE_THRESHOLDS: VehicleThresholds = {
  undervoltageV: 11.5,
  recoveryVoltageV: 12,
  brownoutV: 8,
  overvoltageV: 16.5,
  overvoltageRecoveryV: 15.5,
  crankingStartV: 9.6,
  misfireVoltageV: 9.6,
  stallRpm: 340,
  idleRpm: 800,
  debounceMs: 240,
  healMs: 900,
  removalCycles: 2,
  busTimeoutMs: 400,
  leanTrimPct: 12,
  closedLoopCoolantC: 60,
  plausibilityKph: 5,
};

/**
 * The electrical constants of the model.
 *
 * These are **time-compressed** numbers, and saying so is the honest form: a battery
 * at 45 A of draw needs minutes to reach a supply monitor's threshold on a real car.
 * The model spends `dischargeVPerSecond` per second of *model* time — enough for a
 * scenario to run a charging-system failure through in tens of seconds instead of an
 * hour, with every intermediate state still in order.
 */
export interface VehiclePhysics {
  /** Current the starter draws while cranking, amperes. */
  crankingCurrentA: number;
  /** Volts the terminal loses per ampere of load (internal resistance plus cabling). */
  voltsPerAmpere: number;
  /** Volts per second of model time the battery loses when nothing charges it. */
  dischargeVPerSecond: number;
  /** Volts per second of model time the battery regains while the alternator works. */
  chargeVPerSecond: number;
  /** The model never discharges below this (an empty cell is not a negative one). */
  minimumBatteryV: number;
  /** The regulator target while charging, volts. */
  chargeTargetV: number;
}

export const VEHICLE_PHYSICS: VehiclePhysics = {
  crankingCurrentA: 90,
  voltsPerAmpere: 0.012,
  dischargeVPerSecond: 0.12,
  chargeVPerSecond: 0.02,
  minimumBatteryV: 6,
  chargeTargetV: 14.1,
};

/** Everything the model knows about the car at one moment. */
export interface VehicleModelState {
  /** Model time in ms since the model was built — the clock every rule uses. */
  timeMs: number;
  ignition: IgnitionState;
  /** Terminal voltage of the battery, as the cause states it (before any load). */
  batteryVoltage: number;
  /** 0…1 — how much of its rated output the alternator still delivers. */
  alternatorEfficiency: number;
  /** Extra consumers switched on (lights, rear-window heater), in amperes. */
  electricalLoadA: number;
  /** Voltage every module is fed with, after cranking sag and load. */
  supplyVoltage: number;
  alternatorCharging: boolean;
  starterCranking: boolean;
  engineRunning: boolean;
  rpm: number;
  /** Engine runtime in the current cycle, seconds. */
  runtimeS: number;
  coolantC: number;
  oilC: number;
  intakeAirC: number;
  throttlePct: number;
  loadPct: number;
  speedKph: number;
  /** Where the driver wants the car; the model relaxes towards it. */
  demandSpeedKph: number;
  brakePressed: boolean;
  gear: number;
  shortTermTrimPct: number;
  longTermTrimPct: number;
  /** Mass air flow in g/s — what the engine breathes *as the meter sees it*. */
  mafGramsPerS: number;
  mapKpa: number;
  timingAdvanceDeg: number;
  fuelRailKpa: number;
  wheelSpeedKph: {
    frontLeft: number;
    frontRight: number;
    rearLeft: number;
    rearRight: number;
  };
  /** Completed key-on/key-off cycles; a code's history is counted in these. */
  operationCycles: number;
  /** A monitor latched in this cycle, i.e. `testFailedThisOperationCycle`. */
  faultThisCycle: boolean;
}

/** One attached ECU: the fault memory to write, and the codes it may write. */
export interface ModelEcuAttachment {
  ecuId: string;
  server: UdsServer;
  /** Codes this ECU's definition declares; anything else is not recorded (rule 3). */
  documentedCodes: ReadonlySet<string>;
  /**
   * Freeze-frame bytes for a code at a moment in time, encoded with the layout the
   * definition declares. The vehicle supplies it, because only the vehicle knows the
   * signal definitions; a monitor then records *where the car was* when it fired.
   */
  freezeFrame?: (code: string, state: VehicleModelState) => Uint8Array | undefined;
}

/** What a monitor did — the report a test or a scenario asserts on. */
export interface MonitorReport {
  id: string;
  ecu: string;
  code: string;
  /** The condition holds right now. */
  condition: boolean;
  /** The code is active in the fault memory (`testFailed` set). */
  active: boolean;
  /** The code is in memory, active or healed. */
  recorded: boolean;
  /** ms the condition has held (0 when it does not). */
  heldMs: number;
  /** How often this monitor latched during the run. */
  raised: number;
}

export interface VehicleModelOptions {
  thresholds?: Partial<VehicleThresholds>;
  /** Override the electrical constants, e.g. to model a battery with less capacity. */
  physics?: Partial<VehiclePhysics>;
  /** Injectable randomness for intermittent contact — never `Math.random` (AGENTS 31). */
  random?: () => number;
  logger?: Logger;
  /** Integration step of the physics in ms (default 20 ms of model time). */
  stepMs?: number;
  initial?: {
    ignition?: IgnitionState;
    batteryVoltage?: number;
    ambientC?: number;
    speedKph?: number;
    rpm?: number;
    /** Default: running whenever the key is in `on` — see the model's constructor. */
    engineRunning?: boolean;
    idleAdaptationRpm?: number;
  };
  /**
   * Called after every integration step, before the monitors run.
   *
   * This is the seam a vehicle hangs its own reactions on — power states, bus
   * broadcasts, anything that has to happen *inside* the model's time rather than
   * after it. A caller that reacted after `advance()` would see one step of lag in
   * every measurement, and a scenario that measures silence would miss the frame
   * that was supposed to break the silence.
   */
  onStep?: (state: Readonly<VehicleModelState>) => void;
}

/** The narrow view a monitor is given; the model satisfies it. */
export interface MonitorContext {
  readonly state: Readonly<VehicleModelState>;
  readonly thresholds: VehicleThresholds;
  /** Voltage at one module's pins, after whatever its own wiring does to it. */
  supplyOf(ecuId: string): number;
  /** Supervised peers that have been silent longer than the bus timeout. */
  silentPeersOf(ecuId: string): readonly string[];
  /** Whether another monitor is latched right now (propagation, not copies). */
  monitorActive(id: string): boolean;
  /** A sensor that is currently broken. */
  sensorFault(signal: string): SensorFault | undefined;
}

export interface Monitor {
  id: string;
  ecu: string;
  code: string;
  /** Overrides the default debounce when the monitor needs a different window. */
  debounceMs?: number;
  /** While this says no, the monitor reports "no fault" and heals what it latched. */
  enabled(ctx: MonitorContext): boolean;
  /** The fault condition itself — a measurement, not an opinion. */
  failing(ctx: MonitorContext): boolean;
  /**
   * When the condition is *clearly over*, so a latched code can heal.
   *
   * Default: the negation of `failing`. A monitor with hysteresis says so here, and
   * then the two windows are two numbers instead of one threshold the model walks
   * back and forth across.
   */
  clear?(ctx: MonitorContext): boolean;
  /** What the code means here; it lands in the log, never on the wire. */
  note: string;
}

export function round(value: number, scale: number): number {
  const decimals = Math.max(0, Math.min(4, Math.ceil(-Math.log10(scale))));
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Move `from` towards `to`, at most `ratePerSecond` per second of model time. */
export function approach(from: number, to: number, ratePerSecond: number, dt: number): number {
  const delta = to - from;
  if (Math.abs(delta) < 1e-9) return to;
  return from + Math.sign(delta) * Math.min(Math.abs(delta), ratePerSecond * dt);
}

export function ignitionCode(state: IgnitionState): number {
  switch (state) {
    case "lock":
      return 0;
    case "off":
      return 1;
    case "acc":
      return 2;
    case "on":
      return 3;
    case "start":
      return 4;
  }
}
