/**
 * Vehicle behaviour model — causes, not states (AGENTS 32, master backlog P0 #16).
 *
 * The simulator this replaces could answer "is the ABS online?" because a test had
 * just said so. That is not a vehicle, it is a fixture: a fault list typed in from
 * outside, with no way to ask *why* the car has it. This module owns the physics and
 * the monitors, so a defect is derived:
 *
 * ```text
 * cause (a bench command)      →  physical state          →  module reaction          →  fault memory
 * battery dragged to 10.4 V      supply at every pin        BCM reads < 11.5 V           B1001 testFailed
 * a plug pulled on the ABS       that module browns out      gateway measures silence     U0121
 * a MAF shorted to battery       the engine fuels lean      long-term trim climbs        P0171
 * ```
 *
 * Four rules hold the model together:
 *
 * 1. **A monitor latches, it does not toggle.** A condition has to hold for
 *    `debounceMs` of *model* time before the code goes active, and has to be healthy
 *    for `healMs` before `testFailed` drops again — the debounce behaviour
 *    ISO 14229-1 describes for continuous monitors. A scenario that drags a voltage
 *    for 10 ms therefore proves nothing, which is the point of measuring it.
 * 2. **Hysteresis, not a threshold.** Undervoltage heals at a *higher* voltage than
 *    it fails at, so a value sitting on the line cannot make the fault chatter on
 *    every step.
 * 3. **A module only records what it documents.** A code is raised on an ECU only if
 *    that ECU's definition package declares it — otherwise a scan reports a number
 *    nobody can explain (AGENTS 20.1). Cross-module propagation follows the data:
 *    document `U0121` on the engine and it starts storing one, no simulator change.
 * 4. **Silence must have been preceded by speech.** "Lost communication with X" is
 *    raised only for a peer the bus *did* answer before. A module that never spoke is
 *    not lost, it is absent — and that is a discovery result, not a U-code.
 *
 * Time is the model's own: {@link VehicleBehaviourModel.advance} moves it in fixed
 * steps, so a scenario is reproducible without depending on wall-clock scheduling
 * (AGENTS 31). The wire below it keeps real timers — the model decides *state*, the
 * transport decides *when a byte arrives*, and neither pretends to be the other.
 */

import type { ServerDtc } from "@vdp/protocols-uds";
import { type Logger, createLogger } from "@vdp/shared";
import { STATUS_ACTIVE, STATUS_HEALED, standardMonitors } from "./vehicle-monitors.js";
import { readModelSignal } from "./vehicle-signals.js";
import type {
  IgnitionState,
  ModelEcuAttachment,
  ModuleWiringFault,
  Monitor,
  MonitorContext,
  MonitorReport,
  SensorFault,
  VehicleModelOptions,
  VehicleModelState,
  VehiclePhysics,
  VehicleThresholds,
} from "./vehicle-state.js";
import { VEHICLE_PHYSICS, VEHICLE_THRESHOLDS, approach, round } from "./vehicle-state.js";
import { ModuleWiring } from "./vehicle-wiring.js";
import { createRandom } from "./virtual-vehicle.js";

interface MonitorRuntime {
  monitor: Monitor;
  heldMs: number;
  healthyMs: number;
  active: boolean;
  recorded: boolean;
  healedCycles: number;
  raised: number;
}

/**
 * What one wheel-speed channel reads with this fault applied.
 *
 * Its own function with no `default` arm, for the reason `ignitionCode` has one: when
 * `SensorFaultMode` gains a mode, a switch that must return a value for every case
 * fails to compile until the new mode is thought about, while a catch-all files it under
 * whatever the last branch did. `open-circuit` and `short-to-ground` share a reading
 * because a dead channel is what both of them are — that is a decision, not a fallback.
 */
function faultedWheelSpeed(speedKph: number, fault: SensorFault): number {
  switch (fault.mode) {
    case "open-circuit":
    case "short-to-ground":
      return 0;
    case "short-to-battery":
      return 520;
    case "stuck":
      return fault.value ?? 0;
    case "drift-high":
      return Math.max(0, speedKph * 2.5);
    case "drift-low":
      return Math.max(0, speedKph * 0.3);
  }
}

/**
 * A small, deterministic vehicle: electrical supply, one petrol engine, four wheels,
 * five modules with monitors. Not a powertrain simulation — it is the smallest model
 * in which every fault of the scenario catalog *has to* happen for the reason the
 * scenario states, which is the property a simulation is worth having for.
 */
export class VehicleBehaviourModel implements MonitorContext {
  readonly thresholds: VehicleThresholds;
  /** The electrical constants: starter current, sag, charge and discharge rates. */
  readonly physics: VehiclePhysics;

  /** Integration step of the physics in model-time ms. */
  readonly stepMs: number;

  private readonly log: Logger;
  private readonly random: () => number;
  private readonly data: VehicleModelState;
  private readonly ecus = new Map<string, ModelEcuAttachment>();
  private readonly sensors = new Map<string, SensorFault>();
  private readonly wiring: ModuleWiring;
  /** ecuId -> model time at which a frame from it was last seen on the wire. */
  private readonly lastHeard = new Map<string, number>();
  /** ecuId -> the peers it supervises, wired from the vehicle's topology. */
  private readonly supervised = new Map<string, string[]>();
  private readonly monitors: MonitorRuntime[];
  private readonly onStep: ((state: Readonly<VehicleModelState>) => void) | undefined;

  constructor(options: VehicleModelOptions = {}) {
    this.thresholds = { ...VEHICLE_THRESHOLDS, ...(options.thresholds ?? {}) };
    this.physics = { ...VEHICLE_PHYSICS, ...(options.physics ?? {}) };
    this.onStep = options.onStep;
    this.stepMs = options.stepMs ?? 20;
    this.log = (options.logger ?? createLogger("simulator", { level: "WARN" })).child("model");
    this.random = options.random ?? createRandom(20260915);
    this.wiring = new ModuleWiring(() => ({
      supplyVoltage: this.data.supplyVoltage,
      timeMs: this.data.timeMs,
      stepMs: this.stepMs,
      brownoutV: this.thresholds.brownoutV,
      electricalLoadA: this.data.electricalLoadA,
      random: () => this.random(),
    }));
    const initial = options.initial ?? {};
    const ambient = initial.ambientC ?? 22;
    const battery = initial.batteryVoltage ?? 12.6;
    // A car whose key is on is a car whose engine runs, unless the caller says
    // otherwise. Starting "ignition on, engine stopped, battery draining" would make
    // every idle vehicle latch a supply code, and a model that cries wolf teaches
    // nothing about debouncing.
    const running =
      initial.engineRunning ?? ((initial.rpm ?? 0) > 0 || (initial.ignition ?? "on") === "on");
    this.data = {
      timeMs: 0,
      ignition: initial.ignition ?? "on",
      batteryVoltage: battery,
      alternatorEfficiency: 1,
      electricalLoadA: 0,
      supplyVoltage: battery,
      alternatorCharging: false,
      starterCranking: false,
      engineRunning: running,
      rpm: initial.rpm ?? (running ? this.idleAdapt : 0),
      runtimeS: 0,
      coolantC: ambient,
      oilC: ambient,
      intakeAirC: ambient,
      throttlePct: 0,
      loadPct: 18,
      speedKph: initial.speedKph ?? 0,
      demandSpeedKph: initial.speedKph ?? 0,
      brakePressed: false,
      gear: 3,
      shortTermTrimPct: 0,
      longTermTrimPct: 0,
      mafGramsPerS: 4,
      mapKpa: 32,
      timingAdvanceDeg: 10,
      fuelRailKpa: 300,
      wheelSpeedKph: {
        frontLeft: initial.speedKph ?? 0,
        frontRight: initial.speedKph ?? 0,
        rearLeft: initial.speedKph ?? 0,
        rearRight: initial.speedKph ?? 0,
      },
      operationCycles: 1,
      faultThisCycle: false,
    };
    if (running && (initial.ignition ?? "on") === "on") {
      this.data.alternatorCharging = this.data.alternatorEfficiency > 0;
    }
    this.monitors = standardMonitors().map((monitor) => ({
      monitor,
      heldMs: 0,
      healthyMs: 0,
      active: false,
      recorded: false,
      healedCycles: 0,
      raised: 0,
    }));
    // The initial numbers come out of the same rule as every later one, so a vehicle
    // that is read before its first step cannot show a supply the physics would never
    // have produced (that is how "charging, but 12.6 V on the wire" got into a test).
    this.updateElectrical(0);
    this.updatePowertrain(0);
  }

  /** Idle-speed adaptation the engine ECU has learned (DID 0x2100 is writable). */
  get idleAdaptation(): number {
    return this.idleAdapt;
  }

  /** What a tester wrote into 0x2100, clamped to the package's documented window. */
  setIdleAdaptation(rpm: number): void {
    const value = Math.round(rpm);
    this.idleAdapt = Math.max(600, Math.min(900, value));
    this.log.debug("idle adaptation written", { rpm: this.idleAdapt, requested: value });
  }

  private idleAdapt = 800;

  /** The live state — readable everywhere, changeable only through a cause. */
  get state(): Readonly<VehicleModelState> {
    return this.data;
  }

  // --- causes ----------------------------------------------------------------
  //
  // Every setter below states a cause. None of them touches a fault memory: that is
  // the monitors' job, and the difference is the reason this module exists.

  setIgnition(state: IgnitionState): void {
    if ((state === "off" || state === "lock") && this.data.ignition !== state) {
      this.endOperationCycle();
      this.data.engineRunning = false;
    }
    this.data.ignition = state;
    this.log.debug("ignition changed", { state, timeMs: this.data.timeMs });
  }

  /** The state of the *battery*: what a lab supply is set to, or what a worn cell gives. */
  setBatteryVoltage(volts: number): void {
    this.data.batteryVoltage = volts;
  }

  /** How much of its rated output the alternator still delivers (0 = diode trio shot). */
  setAlternatorEfficiency(fraction: number): void {
    this.data.alternatorEfficiency = Math.max(0, Math.min(1, fraction));
  }

  /** More consumers on the same circuit — the load that pulls a weak supply down. */
  setElectricalLoad(amps: number): void {
    this.baseLoadA = Math.max(0, amps);
    this.applyElectricalLoad();
  }

  setDriverDemand(demand: {
    throttlePct?: number;
    demandSpeedKph?: number;
    brakePressed?: boolean;
    gear?: number;
  }): void {
    if (demand.throttlePct !== undefined) {
      this.data.throttlePct = Math.max(0, Math.min(100, demand.throttlePct));
    }
    if (demand.demandSpeedKph !== undefined) {
      this.data.demandSpeedKph = Math.max(0, demand.demandSpeedKph);
    }
    if (demand.brakePressed !== undefined) this.data.brakePressed = demand.brakePressed;
    if (demand.gear !== undefined) this.data.gear = demand.gear;
  }

  setSensorFault(fault: SensorFault): void {
    this.sensors.set(fault.signal, fault);
    this.log.debug("sensor fault applied", { signal: fault.signal, mode: fault.mode });
  }

  clearSensorFault(signal: string): void {
    this.sensors.delete(signal);
  }

  clearSensorFaults(): void {
    this.sensors.clear();
  }

  setWiringFault(fault: ModuleWiringFault): void {
    this.wiring.set(fault);
    this.log.debug("wiring fault applied", { ecu: fault.ecu, mode: fault.mode });
  }

  clearWiringFault(ecuId: string): void {
    this.wiring.clear(ecuId);
  }

  /** Which peers an ECU supervises; the vehicle wires this from its own topology. */
  supervise(ecuId: string, peers: readonly string[]): void {
    this.supervised.set(ecuId, [...peers]);
  }

  /**
   * Store what a tester wrote into the BCM coding block and let the car react to it.
   *
   * The simulated coding vocabulary has one bit with an electrical consequence:
   * daytime running lights. Coding therefore *changes the load*, and a weak supply
   * under a new load is exactly how a "the fault appeared after coding" case looks —
   * a write on the diagnostic wire that a fault memory then explains.
   */
  setCoding(block: Uint8Array): void {
    this.coding_ = block.slice(0, 4);
    while (this.coding_.length < 4) {
      this.coding_ = new Uint8Array([...this.coding_, 0]);
    }
    this.applyElectricalLoad();
  }

  /** The coding block as the BCM holds it. */
  get coding(): Uint8Array {
    return this.coding_.slice();
  }

  private coding_ = new Uint8Array(4);
  private baseLoadA = 0;

  private applyElectricalLoad(): void {
    const drlOn = ((this.coding_[0] ?? 0) & 0x08) !== 0;
    this.data.electricalLoadA = this.baseLoadA + (drlOn ? 12 : 0);
  }

  /**
   * Move model time forward.
   *
   * A long span is integrated in bounded steps, so advancing a whole minute and
   * advancing it in thirty ticks produce the same sequence of states — a scenario's
   * outcome may not depend on how the caller chose to slice it.
   */
  advance(ms = this.stepMs): void {
    let remaining = Math.max(0, ms);
    while (remaining > 0) {
      const dt = Math.min(remaining, this.stepMs);
      this.stepOnce(dt);
      remaining -= dt;
    }
  }

  // --- integration with the ECUs ---------------------------------------------

  attach(attachment: ModelEcuAttachment): void {
    this.ecus.set(attachment.ecuId, attachment);
    // Deliberately *not* primed as "heard": a supervisor may only conclude "lost"
    // after the wire proved the peer was there (rule 4). The vehicle reports frames
    // through heardFrom(), so a model without a wire has no bus opinion at all.
  }

  /** The vehicle saw a frame from `ecuId` — a broadcast or an answer, either counts. */
  heardFrom(ecuId: string): void {
    this.lastHeard.set(ecuId, this.data.timeMs);
  }

  isModulePowered(ecuId: string): boolean {
    return this.wiring.isPowered(ecuId);
  }

  /** Whether a module's frames reach the wire. Supply fine, pair broken: it lives unheard. */
  isBusConnected(ecuId: string): boolean {
    return this.wiring.isBusConnected(ecuId);
  }

  /** Voltage at one module's pins, after whatever its own wiring does to it. */
  supplyOf(ecuId: string): number {
    return this.wiring.supplyOf(ecuId);
  }

  sensorFault(signal: string): SensorFault | undefined {
    return this.sensors.get(signal);
  }

  silentPeersOf(ecuId: string): readonly string[] {
    const peers = this.supervised.get(ecuId) ?? [];
    const now = this.data.timeMs;
    const timeout = this.thresholds.busTimeoutMs;
    // Rule 4: a peer that was never heard is not *lost* — it is absent, and that
    // belongs to discovery, not to a communication DTC.
    return peers.filter((peer) => {
      const heard = this.lastHeard.get(peer);
      return heard !== undefined && now - heard > timeout;
    });
  }

  monitorActive(id: string): boolean {
    return this.monitors.some((runtime) => runtime.monitor.id === id && runtime.active);
  }

  /** Monitor verdicts, for tests, the workbench and a scenario's own expectations. */
  monitorStates(): MonitorReport[] {
    return this.monitors.map((runtime) => ({
      id: runtime.monitor.id,
      ecu: runtime.monitor.ecu,
      code: runtime.monitor.code,
      condition: runtime.heldMs > 0,
      active: runtime.active,
      recorded: runtime.recorded,
      heldMs: runtime.heldMs,
      raised: runtime.raised,
    }));
  }

  /** Fault memory of one attached ECU, as the model last wrote it. */
  dtcMemoryOf(ecuId: string): readonly ServerDtc[] {
    return this.ecus.get(ecuId)?.server.dtcMemory ?? [];
  }

  /** Physical values and the codes they produced, for a run's log line. */
  summary(): Record<string, number | string | boolean> {
    const state = this.data;
    return {
      timeMs: state.timeMs,
      ignition: state.ignition,
      supplyVoltage: state.supplyVoltage,
      rpm: state.rpm,
      engineRunning: state.engineRunning,
      speedKph: state.speedKph,
      coolantC: state.coolantC,
      longTermTrimPct: state.longTermTrimPct,
      operationCycles: state.operationCycles,
      activeCodes: this.monitors.filter((runtime) => runtime.active).length,
    };
  }

  /** Same object, no history: every monitor un-latched, every cause removed. */
  reset(): void {
    for (const runtime of this.monitors) {
      runtime.heldMs = 0;
      runtime.healthyMs = 0;
      runtime.active = false;
      runtime.recorded = false;
      runtime.healedCycles = 0;
      runtime.raised = 0;
    }
    this.sensors.clear();
    this.wiring.reset();
    // Back to "nothing has been said on the wire yet" — the same state a fresh
    // vehicle is in, so a reset cannot inherit a peer's presence from the run before.
    this.lastHeard.clear();
    this.log.debug("model reset", { timeMs: this.data.timeMs });
  }

  // --- the physics ------------------------------------------------------------

  private stepOnce(dtMs: number): void {
    const dt = dtMs / 1000;
    this.data.timeMs += dtMs;
    this.redrawContacts();
    this.updateElectrical(dt);
    this.updatePowertrain(dt);
    this.updateBodyAndWheels(dt);
    // The vehicle reacts *inside* the step: a heartbeat that was sent after the run
    // would arrive too late to keep a timeout monitor from latching.
    this.onStep?.(this.data);
    this.evaluateMonitors(dtMs);
  }

  private updateElectrical(dt: number): void {
    const state = this.data;
    const p = this.physics;
    state.starterCranking = state.ignition === "start";
    // The alternator only charges what the engine turns: key-on with a stopped engine
    // drains, running charges, and a regulator at half its duty gives half the volts.
    state.alternatorCharging = state.engineRunning && state.alternatorEfficiency > 0;

    const currentA = state.electricalLoadA + (state.starterCranking ? p.crankingCurrentA : 0);
    // A battery's terminals sag under the current it has to deliver. 90 A of starter
    // is what turns "12.3 V at rest" into "11.2 V while cranking" — and the cranking
    // number is the one a supply monitor reacts to, not the one at the multimeter.
    const sag = currentA * p.voltsPerAmpere;
    // A regulator holds the rail *at* its target and never below what the battery side
    // pushes it to: that is why a load dump reaches the ECUs instead of being
    // absorbed, and it is why a scenario can state the event as a voltage.
    const source = state.alternatorCharging
      ? Math.max(p.chargeTargetV - (1 - state.alternatorEfficiency) * 1.6, state.batteryVoltage)
      : state.batteryVoltage;
    // A charging system regulates: its output sags far less under load than a
    // battery's terminals do. That difference is why a weak battery is diagnosed by
    // cranking voltage and not by resting voltage.
    state.supplyVoltage = round(
      Math.max(0, source - (state.alternatorCharging ? sag * 0.25 : sag)),
      0.01,
    );

    // Charging restores the battery; with nothing charging it, the drawn current is
    // what spends it — the drain that turns "the lamp is a bit dim" into a no-start.
    if (state.alternatorCharging) {
      if (state.batteryVoltage < p.chargeTargetV - 0.05) {
        state.batteryVoltage = Math.min(
          p.chargeTargetV,
          state.batteryVoltage + dt * p.chargeVPerSecond,
        );
      }
    } else {
      // No rounding here, on purpose: an accumulated quantity that is rounded to a
      // step coarser than its own increment never moves. (That is how a draining
      // battery sat at 12.6 V for 40 s of model time during development of this file.)
      state.batteryVoltage = Math.max(
        p.minimumBatteryV,
        state.batteryVoltage - dt * p.dischargeVPerSecond * (0.4 + currentA / 40),
      );
    }
  }

  private updatePowertrain(dt: number): void {
    const state = this.data;
    const t = this.thresholds;
    const canFire = state.supplyVoltage >= t.crankingStartV;

    // Cranking only while the engine has not caught: once it runs, the starter is
    // disengaging and the engine holds itself — pulling the rpm back to starter speed
    // because the key is still in `start` is how a model invents a stall at every start.
    if (state.starterCranking && !state.engineRunning) {
      // Cranking: the starter pulls the engine up to about 260 rpm, and that takes a
      // second — a real one, not a detail: it is what separates "cranks slowly, no
      // start and a misfire for the monitors below, which is why a scenario has to
      // hold a bad supply for longer than a debounce to prove anything.
      state.rpm = approach(state.rpm, canFire ? 260 : 130, 250, dt);
      if (!state.engineRunning && canFire && state.rpm > 230) {
        state.engineRunning = true;
        state.runtimeS = 0;
        // Catching is a jump, not a ramp: an engine that fires is dragged up to a
        // speed it can stay at. Without this the first combustion lands *below* the
        // stall threshold, and every start in this model would be a stall.
        state.rpm = Math.max(state.rpm, 480);
      }
    } else if (state.engineRunning) {
      const demand = 1 + state.throttlePct / 45 + (state.speedKph > 0 ? 0.1 : 0);
      const target = Math.max(this.idleAdapt, this.idleAdapt * demand);
      // Combustion needs a working coil: a supply too weak to fire makes the engine
      // stumble, and the stumble is what the misfire monitor then measures.
      const unstable = state.supplyVoltage < t.misfireVoltageV;
      const wobble = unstable ? 0.45 + 0.55 * this.random() : 1;
      state.rpm = approach(state.rpm, target * wobble, 1400, dt);
      // Below the point where a coil has nothing to fire with, the engine does not
      // "run badly" any more — it stops. A model that let it idle at 5 V would make
      // the misfire code the *last* thing a scenario could observe.
      if (state.supplyVoltage < t.brownoutV + 1) {
        state.engineRunning = false;
      }
      if (state.rpm < t.stallRpm) {
        state.engineRunning = false;
        state.rpm = 0;
      }
    } else {
      state.rpm = approach(state.rpm, 0, 1200, dt);
    }

    // Coolant warms while burning fuel and cools towards ambient when not; oil lags.
    state.coolantC = approach(
      state.coolantC,
      state.engineRunning ? 93 : state.intakeAirC,
      state.engineRunning ? 6 : 1.5,
      dt,
    );
    state.oilC = approach(state.oilC, state.engineRunning ? 100 : state.intakeAirC, 3, dt);
    if (state.engineRunning) state.runtimeS = state.runtimeS + dt;

    // Mixture: the ECU fuels from what the air meter *says*, so a meter that lies
    // moves the trim, and the trim is what the lean monitor reads. One cause, three
    // observable stages.
    const air = this.airMassAndReading();
    state.mafGramsPerS = air.reading;
    const error = air.truth > 0 ? (air.truth - air.reading) / Math.max(1, air.truth) : 0;
    const closedLoop = state.coolantC >= t.closedLoopCoolantC && state.engineRunning;
    if (closedLoop) {
      state.shortTermTrimPct = approach(state.shortTermTrimPct, error * 60, 40, dt);
      state.longTermTrimPct = approach(
        state.longTermTrimPct,
        error * 55 + state.shortTermTrimPct * 0.2,
        2.5,
        dt,
      );
    } else {
      state.shortTermTrimPct = approach(state.shortTermTrimPct, 0, 20, dt);
    }
    state.loadPct = Math.min(
      100,
      18 + (state.rpm / Math.max(1, this.idleAdapt)) * 8 + state.throttlePct * 0.5,
    );
    state.mapKpa = Math.round(28 + state.throttlePct * 1.4 + (state.engineRunning ? 0 : -8));
    state.timingAdvanceDeg = 8 + (state.coolantC - 20) * 0.08 + state.throttlePct * 0.06;
    state.fuelRailKpa = Math.round(state.engineRunning ? 300 + state.loadPct * 1.2 : 0);
  }

  /**
   * The air the engine really breathes, and what the meter reports about it.
   *
   * A fault on `engine.maf_airflow` fakes the *measurement the ECU fuels from* — the
   * ECU then does the wrong thing for good reasons, which is the only honest way to
   * arrive at a mixture code.
   */
  private airMassAndReading(): { truth: number; reading: number } {
    const state = this.data;
    const truth = Math.max(
      0.5,
      4 + (state.rpm / Math.max(1, this.idleAdapt)) * 3.2 + state.throttlePct * 0.22,
    );
    const fault = this.sensors.get("engine.maf_airflow");
    if (fault === undefined) return { truth, reading: truth };
    switch (fault.mode) {
      case "open-circuit":
      case "short-to-ground":
        return { truth, reading: 0 };
      case "short-to-battery":
        return { truth, reading: truth * 2.4 };
      case "drift-low":
        return { truth, reading: truth * 0.55 };
      case "drift-high":
        return { truth, reading: truth * 1.6 };
      case "stuck":
        return { truth, reading: fault.value ?? truth };
    }
  }

  private updateBodyAndWheels(dt: number): void {
    const state = this.data;
    const target = state.brakePressed ? 0 : state.demandSpeedKph;
    state.speedKph = approach(state.speedKph, target, state.brakePressed ? 60 : 12, dt);
    const wheels = state.wheelSpeedKph;
    wheels.frontLeft = state.speedKph;
    wheels.frontRight = state.speedKph;
    wheels.rearLeft = state.speedKph;
    wheels.rearRight = state.speedKph;
    // A dead channel reads zero while the car moves, and a sensor shorted to the
    // rail reads absurd speed: both are implausible against the other three wheels,
    // and both are visible to a decoder as a value outside the declared range.
    for (const [signal, key] of [
      ["abs.wheel_speed_front_left", "frontLeft"],
      ["abs.wheel_speed_front_right", "frontRight"],
      ["abs.wheel_speed_rear_left", "rearLeft"],
      ["abs.wheel_speed_rear_right", "rearRight"],
    ] as const) {
      const fault = this.sensors.get(signal);
      if (fault === undefined) continue;
      wheels[key] = faultedWheelSpeed(state.speedKph, fault);
    }
  }

  /**
   * Model value of one signal, with every sensor fault applied.
   *
   * The mapping itself lives in `vehicle-signals.ts`, so a freeze frame, a live DID and
   * a scenario read exactly one table.
   */
  signalValue(signalId: string): number | undefined {
    return readModelSignal(this, signalId);
  }

  /** Whether any supervised peer of this module is currently over its bus timeout. */
  anyPeerSilent(ecuId: string): boolean {
    return this.silentPeersOf(ecuId).length > 0;
  }

  // --- monitors ---------------------------------------------------------------

  private evaluateMonitors(dtMs: number): void {
    for (const runtime of this.monitors) {
      const monitor = runtime.monitor;
      const attachment = this.ecus.get(monitor.ecu);
      const watching =
        attachment !== undefined && this.isModulePowered(monitor.ecu) && monitor.enabled(this);
      if (!watching) {
        // A dead module does not store codes and does not heal them either: the
        // statement it last wrote stays in its memory untouched until it is powered.
        continue;
      }
      // A latched monitor is asked the *other* question ("is it clearly over?"), which
      // is what hysteresis means in code: two windows instead of one threshold the
      // vehicle walks back and forth across.
      const failing = runtime.active
        ? !(monitor.clear ? monitor.clear(this) : !monitor.failing(this))
        : monitor.failing(this);
      if (failing) {
        runtime.heldMs += dtMs;
        runtime.healthyMs = 0;
        const window = monitor.debounceMs ?? this.thresholds.debounceMs;
        if (!runtime.active && runtime.heldMs >= window) this.raise(runtime, attachment);
      } else {
        runtime.healthyMs += dtMs;
        runtime.heldMs = 0;
        if (runtime.active && runtime.healthyMs >= this.thresholds.healMs) this.heal(runtime);
      }
    }
    if (this.monitors.some((runtime) => runtime.active)) this.data.faultThisCycle = true;
  }

  private raise(runtime: MonitorRuntime, attachment: ModelEcuAttachment): void {
    const monitor = runtime.monitor;
    // Rule 3: never record a code this ECU does not document — including for a
    // definition that documents nothing at all, which is the same answer for every code.
    if (!attachment.documentedCodes.has(monitor.code)) {
      this.log.debug("monitor latched, but the ECU does not document this code", {
        ecu: monitor.ecu,
        code: monitor.code,
        monitor: monitor.id,
      });
      return;
    }
    runtime.active = true;
    runtime.recorded = true;
    runtime.raised += 1;
    runtime.healedCycles = 0;
    this.data.faultThisCycle = true;
    const dtc: ServerDtc = { code: monitor.code, status: STATUS_ACTIVE };
    const snapshot = attachment.freezeFrame?.(monitor.code, this.state);
    if (snapshot !== undefined && snapshot.length > 0) dtc.snapshot = snapshot;
    attachment.server.setDtc(dtc);
    this.log.info("monitor latched a fault", {
      ecu: monitor.ecu,
      code: monitor.code,
      monitor: monitor.id,
      reason: monitor.note,
      timeMs: this.data.timeMs,
    });
  }

  private heal(runtime: MonitorRuntime): void {
    runtime.active = false;
    runtime.healthyMs = 0;
    const attachment = this.ecus.get(runtime.monitor.ecu);
    if (attachment === undefined) return;
    // The condition is gone, so `testFailed` leaves; the code stays as "failed this
    // operation cycle" — the state a technician finds when the defect *was* there and
    // is not now, which a plain 0x00 would erase (AGENTS 20).
    attachment.server.setDtcStatus(runtime.monitor.code, STATUS_HEALED);
    this.log.info("monitor healed a fault", {
      ecu: runtime.monitor.ecu,
      code: runtime.monitor.code,
      timeMs: this.data.timeMs,
    });
  }

  /** Key-off: the cycle ends, and every healed code ages by one. */
  private endOperationCycle(): void {
    this.data.operationCycles += 1;
    this.data.faultThisCycle = false;
    for (const runtime of this.monitors) {
      if (runtime.active || !runtime.recorded) continue;
      runtime.healedCycles += 1;
      if (runtime.healedCycles >= this.thresholds.removalCycles) {
        runtime.recorded = false;
        runtime.healedCycles = 0;
        // An aged-out code leaves the memory entirely. That is not a clear: no `0x14`
        // happened, and a scan before and after shows the difference.
        this.ecus.get(runtime.monitor.ecu)?.server.removeDtc(runtime.monitor.code);
        this.log.info("fault aged out of memory", {
          ecu: runtime.monitor.ecu,
          code: runtime.monitor.code,
          cycles: this.thresholds.removalCycles,
        });
      }
    }
  }

  /**
   * The wiring's own cadence, once per step.
   *
   * `ModuleWiring` holds the contacts, the flap windows and the fault table; the model
   * stays the only place where time advances and randomness is drawn, so an intermittent
   * defect cannot have two clocks (AGENTS 31).
   */
  private redrawContacts(): void {
    this.wiring.step();
  }
}
