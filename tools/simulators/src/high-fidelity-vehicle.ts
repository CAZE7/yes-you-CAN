/**
 * High-fidelity virtual vehicle — a 5-ECU car with a behaviour model (AGENTS 32).
 *
 * `VirtualVehicle` builds ECUs that answer. This class adds the part a diagnosis
 * actually needs: a *car* they answer for. One {@link VehicleBehaviourModel} owns the
 * electrical supply, the engine, the wheels and the wiring of every module, and the
 * five ECUs react to it:
 *
 * ```text
 * scenario / bench command (a cause)
 *        ↓
 * VehicleBehaviourModel.step            ← physics: volts, rpm, temperature, contact
 *        ↓                              ← monitors: debounce, hysteresis, enable conditions
 *  ├─ module power ─→ UdsServer.start/stop   (a brown-out module stops answering)
 *  ├─ bus reachability                      (frames are only there when the wire carries them)
 *  └─ monitor verdicts ─→ server.setDtc()   (the fault memory, through the public UDS API)
 *        ↓
 * UDS 0x19 → DtcScanner → Diagnostic IR → Evidence
 * ```
 *
 * What that means for a caller: `setBatteryVoltage(11.0)` does not *set a DTC*, it
 * changes a voltage, and B1001 appears only if the supply stays there longer than the
 * BCM's debounce. `model.monitorStates()` is the answer to "why", and the same question
 * is what a scenario's `because` strings are checked against.
 *
 * The vehicle never reaches into a UDS server's internals: DIDs it needs for coding and
 * adaptation are registered through `registerWritableDid()`, and fault memories are
 * written through `setDtc()`/`removeDtc()` — the server's own API, so a rename of a
 * private field is a compile error instead of a silent `undefined`.
 */

import {
  type DefinitionPackage,
  type DtcDefinition,
  highFidelityPackage,
  type SignalDefinition,
} from "@vdp/definitions";
import { NRC } from "@vdp/protocols-uds";
import { createLogger, type Logger, messageOf } from "@vdp/shared";
import type { CanFrame } from "@vdp/transport-can";
import {
  applyCause,
  type RunScenarioOptions,
  runScenario,
  type ScenarioCause,
  type ScenarioRun,
  type ScenarioTarget,
  undoCause,
  type VehicleScenario,
} from "./scenarios.js";
import { VehicleBehaviourModel } from "./vehicle-model.js";
import type {
  IgnitionState,
  SensorFaultMode,
  VehicleModelOptions,
  VehicleModelState,
  VehiclePhysics,
  VehicleThresholds,
} from "./vehicle-state.js";
import type { VirtualEcu, VirtualVehicleOptions } from "./virtual-vehicle.js";
import { buildFreezeFrame, VirtualVehicle } from "./virtual-vehicle.js";

export type { IgnitionState } from "./vehicle-state.js";

/** CAN identifiers the modules broadcast on, so "alive" is a fact about the wire. */
export const HEARTBEAT_IDS: Readonly<Record<string, number>> = {
  engine: 0x18c,
  transmission: 0x18d,
  abs: 0x294,
  bcm: 0x4b0,
  gateway: 0x500,
};

/** The peers one module supervises — the gateway watches the diagnostic bus. */
export const SUPERVISED_PEERS: readonly string[] = ["engine", "transmission", "abs", "bcm"];

export interface HighFidelityVehicleOptions extends VirtualVehicleOptions {
  initialIgnition?: IgnitionState;
  initialBatteryVoltage?: number;
  initialIdleSpeed?: number;
  /** Where the car stands at rest: default 12.6 V, coolant at ambient, engine running. */
  initialSpeedKph?: number;
  /**
   * Physics overrides of the model (thresholds and electrical constants).
   * A test that needs a 12 V window to behave differently says so here, once.
   */
  thresholds?: Partial<VehicleThresholds>;
  physics?: Partial<VehiclePhysics>;
  /**
   * Start with the fault memory the definition package declares.
   *
   * Default `false`: with a behaviour model, a stored code that no monitor latched is
   * a fixture wearing a diagnosis. Turn it on to exercise "the car already had codes"
   * (replay-style comparisons, the freeze-frame path of a stored-only code).
   */
  startWithStoredFaults?: boolean;
  /**
   * Wall-clock step of the model in ms while the vehicle runs (default 50).
   * `0` keeps the model still until a caller advances it — what every deterministic
   * test and every scenario run wants (AGENTS 31).
   */
  modelTickMs?: number;
  /** Send a broadcast per online module (default true). */
  broadcasts?: boolean;
  /** Extra options handed to the behaviour model (randomness, step size). */
  model?: Omit<VehicleModelOptions, "onStep" | "initial" | "thresholds" | "physics">;
}

/** One module's view of the vehicle, as the model reports it. */
export interface ModuleStatus {
  ecuId: string;
  powered: boolean;
  onBus: boolean;
  /** Voltage at this module's pins, which is not always the same number as the battery's. */
  supplyVoltage: number;
}

export class HighFidelityVehicle extends VirtualVehicle implements ScenarioTarget {
  /** The vehicle's physics and monitors. Public: reading it is how a caller asks "why". */
  readonly model: VehicleBehaviourModel;

  private readonly modelTickMs: number;
  private readonly broadcasts: boolean;
  private readonly hifiLog: Logger;
  private readonly startedAtMs: number;
  /** ecuId -> whether its UDS server is listening, as the model last decided. */
  private readonly powered = new Map<string, boolean>();
  private readonly heartbeatFrames = new Map<string, number>();
  private readonly wireFaults = new Map<string, () => void>();
  /** ecuId:code -> the status the module's memory carried when it was attached. */
  private readonly bornDtcStatuses = new Map<string, number>();
  private readonly removeGatewayListening: Array<() => void> = [];
  private modelTimer: ReturnType<typeof setInterval> | undefined;
  private started = false;

  constructor(options: HighFidelityVehicleOptions = {}) {
    const pkg: DefinitionPackage = options.definitions ?? highFidelityPackage;
    const initial: NonNullable<VehicleModelOptions["initial"]> = {
      ignition: options.initialIgnition ?? "on",
      batteryVoltage: options.initialBatteryVoltage ?? 12.6,
      idleAdaptationRpm: options.initialIdleSpeed ?? 800,
      speedKph: options.initialSpeedKph ?? 0,
    };
    super({
      ...options,
      definitions: pkg,
    });
    this.startedAtMs = Date.now();
    this.hifiLog = (options.logger ?? createLogger("simulator", { level: "WARN" })).child("hifi");
    this.modelTickMs = options.modelTickMs ?? 50;
    this.broadcasts = options.broadcasts ?? true;
    this.model = new VehicleBehaviourModel({
      ...(options.model ?? {}),
      ...(options.thresholds === undefined ? {} : { thresholds: options.thresholds }),
      ...(options.physics === undefined ? {} : { physics: options.physics }),
      ...(Object.keys(initial).length === 0 ? {} : { initial }),
      onStep: (state) => this.reactToStep(state),
    });
    this.attachModules(options.startWithStoredFaults === true);
    this.wireGatewaySupervision();
  }

  /** Ignition position, as the model holds it — a read, never a stored flag. */
  get ignition(): NonNullable<VehicleModelState["ignition"]> {
    return this.model.state.ignition;
  }

  /** Battery terminal voltage as the *cause* stated it (before load). */
  get batteryVoltage(): number {
    return this.model.state.batteryVoltage;
  }

  /** Voltage every module is fed with right now, after cranking sag and consumers. */
  get supplyVoltage(): number {
    return this.model.state.supplyVoltage;
  }

  /** BCM coding memory (DID 0x0200), as the module holds it. */
  get bcmCoding(): Uint8Array {
    return this.model.coding;
  }

  /** Engine idle speed target adaptation (DID 0x2100), as the module learned it. */
  get idleSpeedAdaptation(): number {
    return this.model.idleAdaptation;
  }

  /** Per-module power and reachability, derived from the model — nothing else sets it. */
  moduleStatus(ecuId: string): ModuleStatus | undefined {
    if (this.ecu(ecuId) === undefined) return undefined;
    return {
      ecuId,
      powered: this.model.isModulePowered(ecuId),
      onBus: this.model.isBusConnected(ecuId),
      supplyVoltage: this.model.supplyOf(ecuId),
    };
  }

  /** Every module's status, in definition order — the panel a technician reads. */
  modules(): ModuleStatus[] {
    return this.ecus.map((ecu) => this.moduleStatus(ecu.definition.id) as ModuleStatus);
  }

  /**
   * Whether a module answers on the bus.
   *
   * *Derived*, and deliberately narrow: a module is online when its own supply says it
   * is and the wire carries it. There is no setter for this any more — `setEcuOnline()`
   * was a state to set, and a state that nobody caused cannot be diagnosed. Use the
   * causes instead: {@link cutPower}, {@link loosenConnector}, {@link openBus}.
   */
  isEcuOnline(ecuId: string): boolean {
    const status = this.moduleStatus(ecuId);
    if (status === undefined) return false;
    return status.powered && status.onBus;
  }

  // --- causes ----------------------------------------------------------------
  //
  // These are the only ways into the vehicle's state, and every one of them states a
  // cause. Each delegates to the model, so a bench command and a scenario step apply
  // the same physics — no second path that a test could use to fake a fault.

  /** Turn the key. `start` draws the starter; releasing it is `on`. */
  setIgnition(state: NonNullable<VehicleModelState["ignition"]>): void {
    this.model.setIgnition(state);
  }

  /** The battery's own voltage: what a lab supply is set to, or what a worn cell gives. */
  setBatteryVoltage(volts: number): void {
    this.model.setBatteryVoltage(volts);
  }

  /** More consumers on the same circuit (lights, heater) — the load that sags a supply. */
  setElectricalLoad(amps: number): void {
    this.model.setElectricalLoad(amps);
  }

  /**
   * How much of its rated output the alternator still delivers.
   * `0` is a dead diode trio: from then on the battery is the supply, and the car
   * runs out of it in tens of seconds of model time.
   */
  setAlternator(fraction: number): void {
    this.model.setAlternatorEfficiency(fraction);
  }

  /** A module with no supply: dead until it is restored, and silent on the wire. */
  cutPower(ecuId: string): void {
    this.model.setWiringFault({ ecu: idOrThrow(ecuId), mode: "power-cut" });
  }

  restorePower(ecuId: string): void {
    this.model.clearWiringFault(ecuId);
    this.syncPowerStates();
  }

  /** A connector that makes contact now and then: the intermittent everyone chases. */
  loosenConnector(ecuId: string, duty = 0.35): void {
    this.model.setWiringFault({ ecu: idOrThrow(ecuId), mode: "connector-loose", duty });
  }

  /** Supply fine, twisted pair broken: the module lives, and nobody hears it. */
  openBus(ecuId: string): void {
    this.model.setWiringFault({ ecu: idOrThrow(ecuId), mode: "bus-open" });
  }

  /** What the driver does: the load and the speed every plausibility rule reads. */
  drive(demand: {
    throttlePct?: number;
    demandSpeedKph?: number;
    brakePressed?: boolean;
    gear?: number;
  }): void {
    this.model.setDriverDemand(demand);
  }

  /**
   * A sensor that lies. The ECU then decides something wrong for a good reason.
   *
   * The full {@link SensorFaultMode} vocabulary, because that is what the model
   * implements: `short-to-ground` reads zero for a reason of its own, and a cause script
   * (`scenarios.ts`) already accepts it. A setter narrower than the thing it sets turns
   * a documented failure mode into one nobody can reach from the vehicle.
   */
  breakSensor(signal: string, mode: SensorFaultMode, value?: number): void {
    this.model.setSensorFault({ signal, mode, ...(value === undefined ? {} : { value }) });
  }

  clearSensorFaults(): void {
    this.model.clearSensorFaults();
  }

  // --- time -------------------------------------------------------------------

  /**
   * The model answers for every signal it has a rule for.
   *
   * This is the seam `VirtualVehicle` leaves open on purpose: the payload a DID read
   * returns, the freeze frames a monitor records and the values a live stream shows all
   * come from here, so one physical state is the source of all three. A signal the
   * model has no rule for falls back to the base vehicle's generator — a package with
   * more signals than the model has opinions about keeps working instead of reporting
   * zeros nobody explained.
   */
  protected override signalValue(
    ecuId: string,
    signal: SignalDefinition,
  ): number | string | boolean {
    const value = this.model.signalValue(signal.id);
    if (value !== undefined) return value;
    return super.signalValue(ecuId, signal);
  }

  /**
   * Move model time forward and let the vehicle react.
   *
   * Reactions (power gating, broadcasts) happen inside the model's step, so the
   * caller never has to know about them: one call, one deterministic slice of driving.
   */
  advance(ms: number): void {
    this.model.advance(ms);
    this.syncPowerStates();
  }

  /**
   * Step the model on a wall clock, so a demo drives itself.
   *
   * Only {@link modelTickMs} `> 0` starts it. A test and a scenario run advance the
   * model by hand, because a real timer in front of a deterministic expectation is how
   * a suite starts to depend on load (AGENTS 31).
   */
  private startModelLoop(): void {
    if (this.modelTickMs <= 0 || this.modelTimer !== undefined) return;
    // The loop is the *demo*'s clock: it makes the car alive on screen. A scenario run
    // replaces it for its duration — see `runScenario`.

    this.modelTimer = setInterval(() => {
      this.model.advance(this.modelTickMs);
      this.syncPowerStates();
    }, this.modelTickMs);
    // An interval that keeps a Node process alive is a leaked handle, not a demo.
    this.modelTimer.unref?.();
  }

  /** Stops the wall-clock stepping and says whether one was running. */
  private stopModelLoop(): boolean {
    if (this.modelTimer === undefined) return false;
    clearInterval(this.modelTimer);
    this.modelTimer = undefined;
    return true;
  }

  // --- lifecycle ---------------------------------------------------------------

  override async start(): Promise<void> {
    await super.start();
    this.started = true;
    this.syncPowerStates();
    this.startModelLoop();
  }

  override async stop(): Promise<void> {
    this.started = false;
    this.stopModelLoop();
    for (const remove of this.removeGatewayListening) remove();
    this.removeGatewayListening.length = 0;
    await super.stop();
  }

  // --- scenario target ---------------------------------------------------------

  /**
   * Apply a cause. A `bus` cause is put on the wire (frames are really lost, both
   * directions), everything else goes to the model — see {@link applyCause}.
   */
  apply(cause: ScenarioCause): void {
    if (cause.kind === "bus") {
      this.impairWire(cause);
      return;
    }
    applyCause(this.model, cause);
    this.syncPowerStates();
  }

  undo(cause: ScenarioCause): void {
    if (cause.kind === "bus") {
      this.liftWireImpairment(cause);
      return;
    }
    undoCause(this.model, cause);
    this.syncPowerStates();
  }

  /**
   * Run a scenario against this vehicle: causes, model time, and the reactions of five
   * real UDS servers on a real virtual wire.
   *
   * `options.onMoment` is awaited at every moment of the run, which is what makes the
   * end-to-end question answerable at all — a caller can scan the fault memory over UDS
   * *while* the cause is on the car, instead of only after the run.
   *
   * The demo's wall-clock loop is paused for the duration. A scenario advances model time
   * itself; a second clock stepping the same car in parallel would make every expectation
   * in the scenario a race, and a flaky simulator is worse than a slow one (AGENTS 31).
   */
  async runScenario(
    scenario: VehicleScenario,
    options: RunScenarioOptions & { seed?: number } = {},
  ): Promise<ScenarioRun> {
    const resume = this.stopModelLoop();
    try {
      // A scenario run is an experiment with a fixed starting line (ADR 0046/0048):
      // the vehicle as it was born — clock at 0, fresh supply, memories as attach left
      // them — exactly the world the regression suites run the same file in. Without
      // this, a run inherited whatever the wall clock and the run before it had left
      // on the car (measured on the workbench: alternator_failure read 8.2 V where the
      // file's suite run reads 10.8 V, with P0300/P0700 latched from earlier drift) —
      // same seed, different bench, AGENTS 31 broken. The *aftermath* of a run stays
      // on the car until the next run or a reconnect: a bench that hid what its
      // scenario did would be lying in exactly the moment someone looks under it.
      this.prepareScenarioRun();
      if (options.seed !== undefined) this.model.reseed(options.seed);
      return await runScenario(this, scenario, options);
    } finally {
      if (resume) this.startModelLoop();
    }
  }

  /**
   * The starting line of every scenario run: the model at birth, every module's
   * memory at its attached baseline, no bus impairment of a previous run still on
   * the wire, and the power states in step with the fresh model.
   */
  private prepareScenarioRun(): void {
    this.model.restart();
    for (const ecu of this.ecus) {
      for (const dtc of ecu.definition.dtcs ?? []) {
        const born = this.bornDtcStatuses.get(`${ecu.definition.id}:${dtc.code}`);
        if (born !== undefined) ecu.server.setDtcStatus(dtc.code, born);
      }
    }
    for (const remove of this.wireFaults.values()) remove();
    this.wireFaults.clear();
    this.syncPowerStates();
  }

  // --- wiring ------------------------------------------------------------------

  /** Hand every module to the model, with the codes it documents and its layout. */
  private attachModules(startWithStoredFaults: boolean): void {
    for (const ecu of this.ecus) {
      const definition = ecu.definition;
      const codes = new Set((definition.dtcs ?? []).map((dtc) => dtc.code));
      this.model.attach({
        ecuId: definition.id,
        server: ecu.server,
        documentedCodes: codes,
        freezeFrame: (code, state) => this.freezeFrameFor(ecu, code, state),
      });
      this.heartbeatFrames.set(definition.id, HEARTBEAT_IDS[definition.id] ?? 0);
      if (codes.size > 0 && !startWithStoredFaults) this.clearFaultMemory(ecu);
      // The baseline a scenario run restores: the memory exactly as attach left it —
      // empty unless the caller deliberately started from stored faults.
      for (const dtc of ecu.server.dtcMemory) {
        this.bornDtcStatuses.set(`${definition.id}:${dtc.code}`, dtc.status);
      }
    }
    this.model.supervise("gateway", SUPERVISED_PEERS);
    this.registerVehicleDids();
  }

  /**
   * Empty this ECU's declared fault memory, without touching what a test injected.
   *
   * `status: 0` and not removal: a scan with a status mask must not see the code, while
   * the entry (and its freeze frame) stays available for the cases that deliberately
   * start from a stored fault.
   */
  private clearFaultMemory(ecu: VirtualEcu): void {
    for (const dtc of ecu.definition.dtcs ?? []) ecu.server.setDtcStatus(dtc.code, 0x00);
  }

  /**
   * The two identifiers a tester may write, registered the official way.
   *
   * Both are *computed* DIDs: the value lives in the vehicle (a coding block, a learned
   * adaptation), so a write goes through a hook that stores it there instead of replacing
   * the read closure — which is what {@link import("@vdp/protocols-uds").UdsServer}'s
   * `registerWritableDid()` exists for.
   */
  private registerVehicleDids(): void {
    const bcm = this.ecu("bcm");
    if (bcm) {
      bcm.server.registerWritableDid({
        did: 0x0200,
        value: () => this.model.coding,
        write: (payload) => {
          // The NRC numbers are the server's vocabulary: 0x13 is a wrong length, 0x31
          // a value the documented window refuses. Both are answers, not exceptions.
          if (payload.length !== 4) return NRC.INCORRECT_MESSAGE_LENGTH_OR_INVALID_FORMAT;
          this.model.setCoding(payload);
          return undefined;
        },
      });
      // The measurement DIDs of this vehicle are readings, not memory: a tester that
      // wrote 0x2001 would otherwise freeze the very value the diagnosis rests on.
      for (const did of [0x2001, 0x2002]) {
        bcm.server.registerDid({ did, value: () => this.payloadFor(bcm, did) });
      }
    }
    const engine = this.ecu("engine");
    if (engine) {
      engine.server.registerWritableDid({
        did: 0x2100,
        value: () => {
          const rpm = this.model.idleAdaptation;
          return new Uint8Array([(rpm >> 8) & 0xff, rpm & 0xff]);
        },
        write: (payload) => {
          if (payload.length !== 2) return NRC.INCORRECT_MESSAGE_LENGTH_OR_INVALID_FORMAT;
          const requested = ((payload[0] ?? 0) << 8) | (payload[1] ?? 0);
          // 600…900 rpm is the window the package declares for this DID; outside it the
          // ECU refuses, because an adaptation the car cannot run on is not stored.
          if (requested < 600 || requested > 900) return NRC.REQUEST_OUT_OF_RANGE;
          this.model.setIdleAdaptation(requested);
          return undefined;
        },
      });
    }
    const gateway = this.ecu("gateway");
    if (gateway) {
      for (const did of [0x0100, 0x0101]) {
        gateway.server.registerDid({ did, value: () => this.payloadFor(gateway, did) });
      }
    }
  }

  /** Encode the live signal values of one DID, through the vehicle's own layout. */
  private payloadFor(ecu: VirtualEcu, did: number): Uint8Array {
    const signals = ecu.signals.filter((signal) => signal.did === did);
    return this.buildPayload(ecu.definition, did, signals);
  }

  /**
   * The freeze frame a monitor records: the declared layout, filled with where the car
   * actually was. A snapshot that merely repeats the fixture's documented operating
   * point would prove nothing about the moment the fault latched.
   */
  private freezeFrameFor(
    ecu: VirtualEcu,
    code: string,
    _state: Readonly<VehicleModelState>,
  ): Uint8Array | undefined {
    const dtc: DtcDefinition | undefined = (ecu.definition.dtcs ?? []).find(
      (entry) => entry.code === code,
    );
    if (dtc === undefined || (dtc.freezeFrame ?? []).length === 0) return undefined;
    const byId = new Map<string, SignalDefinition>(
      ecu.signals.map((signal) => [signal.id, signal]),
    );
    // The declared fields of the *code*, encoded field by field, so a decoder that works
    // on live DIDs works on the snapshot too.
    const parts: number[] = [];
    for (const field of dtc.freezeFrame ?? []) {
      const encoded = buildFreezeFrame({ ...dtc, freezeFrame: [field] }, byId, (signal) =>
        this.modelSignal(signal),
      );
      if (encoded === undefined) continue;
      for (const byte of encoded.snapshot) parts.push(byte);
    }
    return new Uint8Array(parts);
  }

  /** A signal's model value, with the base vehicle's generator behind it. */
  private modelSignal(signal: SignalDefinition): number {
    const value = this.model.signalValue(signal.id);
    if (typeof value === "number") return value;
    const fallback = signal.min ?? 0;
    return typeof fallback === "number" ? fallback : 0;
  }

  /**
   * A broadcast per online module, and the gateway's ear for it.
   *
   * This is what turns "the ABS is offline" from a flag into something a peer can
   * *observe*: frames on a wire, lost when the module has no supply or its pair is cut.
   */
  private wireGatewaySupervision(): void {
    if (!this.broadcasts) return;
    const gateway = this.ecu("gateway");
    if (gateway === undefined) return;
    const byFrameId = new Map<number, string>();
    for (const ecu of this.ecus) {
      const heartbeat = this.heartbeatFrames.get(ecu.definition.id);
      if (heartbeat !== undefined && heartbeat > 0) byFrameId.set(heartbeat, ecu.definition.id);
      byFrameId.set(ecu.definition.address.txId, ecu.definition.id);
    }
    // The gateway sits on the same wire and hears every frame on it — diagnostic answers
    // included. `heardFrom` is the model's only source of "this peer spoke".
    this.removeGatewayListening.push(
      gateway.bus.subscribe((frame: CanFrame) => {
        const speaker = byFrameId.get(frame.id);
        if (speaker !== undefined && speaker !== "gateway") this.model.heardFrom(speaker);
      }),
    );
  }

  /** Called by the model inside every step: gate power, then put the broadcasts on the wire. */
  private reactToStep(_state: Readonly<VehicleModelState>): void {
    this.syncPowerStates();
    if (!this.broadcasts || !this.started) return;
    for (const ecu of this.ecus) {
      const id = ecu.definition.id;
      if (!this.model.isBusConnected(id)) continue;
      const heartbeat = this.heartbeatFrames.get(id);
      if (heartbeat === undefined || heartbeat === 0) continue;
      if (!ecu.bus.isOpen()) continue;
      // Not awaited on purpose: a broadcast is a fire-and-forget frame, and a rejected
      // send (a bus that closed under the model) is logged instead of stalling the step.
      void ecu.bus.send(this.heartbeatFrame(heartbeat, ecu)).catch((error: unknown) => {
        // A bus that closed under the model is worth one line and no more: the next
        // step tries again, and a broadcast is nothing a diagnosis depends on.
        this.hifiLog.debug("heartbeat send failed", { ecu: id, error: messageOf(error) });
      });
    }
  }

  /** A short status frame: sequence, supply at this module, engine rpm. */
  private heartbeatFrame(id: number, ecu: VirtualEcu): CanFrame {
    const state = this.model.state;
    const volts = Math.round(this.model.supplyOf(ecu.definition.id) * 10);
    const payload = new Uint8Array([
      Math.floor(state.timeMs / this.model.stepMs) % 16,
      (volts >> 8) & 0xff,
      volts & 0xff,
      (Math.round(state.rpm) >> 8) & 0xff,
      Math.round(state.rpm) & 0xff,
      state.engineRunning ? 1 : 0,
      state.speedKph > 0 ? 1 : 0,
      0,
    ]);
    return {
      // Model-relative, so a recorded trace of a scenario run stays reproducible
      // byte for byte while still being on the epoch axis everything else uses.
      timestamp: this.startedAtMs + state.timeMs,
      id,
      extended: false,
      fd: false,
      dlc: payload.length,
      channel: ecu.bus.info.channels[0] ?? "vcan0",
      payload,
    };
  }

  /** Match a module's own traffic, so a fault on its pair is a fault in both directions. */
  private impairWire(cause: Extract<ScenarioCause, { kind: "bus" }>): void {
    const key = `bus:${cause.ecu ?? "segment"}`;
    if (this.wireFaults.has(key)) return;
    const ids = new Set<number>();
    for (const ecu of this.ecus) {
      if (cause.ecu !== undefined && ecu.definition.id !== cause.ecu) continue;
      ids.add(ecu.definition.address.txId);
      ids.add(ecu.definition.address.rxId);
      const heartbeat = this.heartbeatFrames.get(ecu.definition.id);
      if (heartbeat !== undefined && heartbeat > 0) ids.add(heartbeat);
    }
    if (ids.size === 0) {
      this.hifiLog.warn("bus cause named an ECU this vehicle does not have", { ecu: cause.ecu });
      return;
    }
    const rate = cause.mode === "open" ? 1 : (cause.dropRate ?? 0.4);
    const remove = this.network.impair({
      id: key,
      match: (frame: CanFrame) => ids.has(frame.id),
      lossRate: rate,
    });
    this.wireFaults.set(key, remove);
  }

  private liftWireImpairment(cause: Extract<ScenarioCause, { kind: "bus" }>): void {
    const key = `bus:${cause.ecu ?? "segment"}`;
    const remove = this.wireFaults.get(key);
    if (remove === undefined) return;
    this.wireFaults.delete(key);
    remove();
  }

  /**
   * Bring each module's UDS server in line with what the model says about its supply.
   *
   * The one place that touches `start()`/`stop()`, and it never decides anything: it
   * reads `isModulePowered()`. A module in a brown-out stops answering — that is the
   * *consequence* the wire then shows, not a state a test set.
   */
  private syncPowerStates(): void {
    for (const ecu of this.ecus) {
      const id = ecu.definition.id;
      const powered = this.model.isModulePowered(id);
      if (this.powered.get(id) === powered) continue;
      this.powered.set(id, powered);
      if (powered) ecu.server.start();
      else ecu.server.stop();
    }
  }
}

function idOrThrow(ecuId: string): string {
  if (ecuId.trim().length === 0) throw new Error("a wiring fault names the module it acts on");
  return ecuId;
}
