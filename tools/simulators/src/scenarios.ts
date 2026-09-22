/**
 * Scenario engine — a reproducible *cause script* for the vehicle model (AGENTS 32).
 *
 * A scenario is data, not code: a list of causes, when each is applied and when it is
 * lifted, and what the car must therefore show. That single choice buys three things
 * the repository needed and did not have:
 *
 * - **Tests and simulations run the same file.** A scenario is applied to a bare
 *   {@link VehicleBehaviourModel} (fast, deterministic) or to a running
 *   {@link HighFidelityVehicle} with the UDS wire attached (the end-to-end case),
 *   without a second copy of the story.
 * - **An expectation is part of the scenario.** `expectations` says which code has to
 *   be in which ECU's memory at which moment, and `because` says why in a sentence a
 *   reviewer can check against the monitor table. A scenario whose expectations nobody
 *   evaluates is a script, not a test.
 * - **Predicting is the point.** With `closedWorld` (default) a code the model raised
 *   that the scenario did not name is a *failure* — otherwise a scenario could drift
 *   into "some faults appear at some point" and keep passing.
 *
 * `runScenario()` never asserts. It returns {@link ScenarioRun} with one
 * {@link ScenarioCheck} per expectation, and the caller decides what a failed check
 * means — a unit test fails, a recording logs, the workbench shows a panel.
 */

import { formatMeasuredValue } from "@vdp/shared";
import type { VehicleBehaviourModel } from "./vehicle-model.js";
import type {
  IgnitionState,
  ModuleWiringMode,
  SensorFaultMode,
  VehicleModelState,
} from "./vehicle-state.js";

/** One cause, applied at a moment of model time and optionally lifted again. */
export type ScenarioCause =
  | { kind: "ignition"; state: IgnitionState }
  /** The battery is what it is: a lab supply turned down, or a cell that is worn. */
  | { kind: "battery"; volts: number }
  /** 0…1 of the rated output — 0 is a dead diode trio, and the car runs on the battery. */
  | { kind: "alternator"; efficiency: number }
  | { kind: "electrical-load"; amps: number }
  | {
      kind: "driver";
      throttlePct?: number;
      demandSpeedKph?: number;
      brakePressed?: boolean;
      gear?: number;
    }
  /** A broken sensor: the model then produces the value, and a monitor produces the code. */
  | { kind: "sensor"; signal: string; mode: SensorFaultMode; value?: number }
  /** A module's own wiring — the cause of "the ECU is offline", never a flag. */
  | {
      kind: "wiring";
      ecu: string;
      mode: ModuleWiringMode;
      ohm?: number;
      duty?: number;
      /** How often an intermittent contact is redrawn (model ms; default 250). */
      flapMs?: number;
      /** `alternate` makes the flap periodic, i.e. reproducible with any rng. */
      pattern?: "random" | "alternate";
    }
  /**
   * A defect on the bus itself. `ecu` limits it to one node's traffic; without it the
   * whole segment is affected. `stutter` loses frames at a rate, `open` swallows all.
   */
  | { kind: "bus"; ecu?: string; mode: "open" | "stutter"; dropRate?: number };

export interface ScenarioStep {
  /** Model time at which the cause is applied. */
  atMs: number;
  cause: ScenarioCause;
  /** Model time the cause then holds; omit to keep it until the run ends. */
  holdMs?: number;
}

/** What a code must look like in an ECU's memory at the moment of the check. */
export type ScenarioExpectationState =
  /** `testFailed` set: the condition is present right now. */
  | "active"
  /** In memory without `testFailed`: it happened, and it is not happening now. */
  | "stored"
  /** Not in memory at all (or status 0): this scenario must not produce it. */
  | "absent"
  /**
   * Latched and healed at least `minRaises` times over the whole run.
   *
   * A status byte says nothing about an intermittent fault — at any given instant a
   * flapping contact is either failed or not, and a check that lands on the wrong 20
   * ms proves nothing. "Intermittent" is a statement about the *history* of the
   * monitor, so that is what this verdict reads (AGENTS 20).
   */
  | "intermittent";

export interface ScenarioExpectation {
  ecu: string;
  code: string;
  state: ScenarioExpectationState;
  /** Model time of the check; default: the end of the run. */
  atMs?: number;
  /** For `state: "intermittent"`: how often the monitor has to have latched (default 2). */
  minRaises?: number;
  /** The claim in one sentence — the reader must be able to check it against the monitor table. */
  because: string;
}

/**
 * A physical condition the model must have reached, independent of any fault memory.
 *
 * This is what keeps a scenario honest about the *cause*: a code alone can be
 * produced by a bug in a monitor, but "the supply at the BCM pins was below 11 V"
 * plus "the BCM then stored B1001" is a chain.
 */
export interface ScenarioCondition {
  /** A field of the model state, addressed by name so the check needs no eval. */
  field: keyof VehicleModelState;
  above?: number;
  below?: number;
  equals?: number | string | boolean;
  atMs?: number;
  because: string;
}

export interface VehicleScenario {
  id: string;
  title: string;
  /** What the scenario is for, in two sentences — it goes into test names and logs. */
  summary: string;
  /** Model time the run covers; the last step must be inside it. */
  durationMs: number;
  steps: readonly ScenarioStep[];
  expectations: readonly ScenarioExpectation[];
  conditions?: readonly ScenarioCondition[];
  /** Flag codes the scenario did not predict (default: yes). */
  closedWorld?: boolean;
}

export interface ScenarioCheck {
  kind: "dtc" | "condition";
  /** `ecu:code` for a DTC expectation, `field` for a physical condition. */
  subject: string;
  expected: string;
  actual: string;
  passed: boolean;
  because: string;
  atMs: number;
}

export interface ScenarioRun {
  scenarioId: string;
  checks: ScenarioCheck[];
  /** Codes a monitor latched that the scenario did not name (`closedWorld`). */
  unexpected: string[];
  passed: boolean;
  /** Model state at the end of the run. */
  finalState: Readonly<VehicleModelState>;
  /** One line per step, for a human reading a failing run. */
  timeline: string[];
}

export interface ScenarioTarget {
  readonly model: VehicleBehaviourModel;
  /** Put a cause onto the vehicle. A `bus` cause reaches the wire, everything else the model. */
  apply(cause: ScenarioCause): void;
  /** Take a cause away again, exactly as it was applied. */
  undo(cause: ScenarioCause): void;
  /** A moment between causes, where a target can read the ECUs over its own link. */
  betweenSteps?(step: ScenarioStep): void | Promise<void>;
}

/**
 * One moment of a run: the model time, and what the scenario did there.
 *
 * A hook gets the moment rather than the step, because a run has moments with nothing
 * but an expectation in them — and those are exactly the ones a caller watching from
 * the wire wants to look at.
 */
export interface ScenarioMomentView {
  atMs: number;
  applied: readonly ScenarioCause[];
  lifted: readonly ScenarioCause[];
  /** Expectations the scenario checks at this very moment. */
  due: readonly ScenarioExpectation[];
}

export interface RunScenarioOptions {
  /**
   * Awaited at every moment of the run, after its causes are applied and before the
   * next slice of model time — how an end-to-end run scans the wire *while* a cause is
   * on the car instead of only after the scenario is over.
   */
  onMoment?: (moment: ScenarioMomentView, target: ScenarioTarget) => void | Promise<void>;
  /** Override the scenario's `closedWorld` decision. */
  closedWorld?: boolean;
}

/** A target that drives only the model: no wire, no ECUs, pure behaviour. */
export function modelTarget(model: VehicleBehaviourModel): ScenarioTarget {
  return {
    model,
    apply: (cause) => applyCause(model, cause),
    undo: (cause) => undoCause(model, cause),
  };
}

/** Apply one cause to a model. Exported so a workbench can do it step by step. */
export function applyCause(model: VehicleBehaviourModel, cause: ScenarioCause): void {
  switch (cause.kind) {
    case "ignition":
      model.setIgnition(cause.state);
      return;
    case "battery":
      model.setBatteryVoltage(cause.volts);
      return;
    case "alternator":
      model.setAlternatorEfficiency(cause.efficiency);
      return;
    case "electrical-load":
      model.setElectricalLoad(cause.amps);
      return;
    case "driver":
      model.setDriverDemand({
        ...(cause.throttlePct === undefined ? {} : { throttlePct: cause.throttlePct }),
        ...(cause.demandSpeedKph === undefined ? {} : { demandSpeedKph: cause.demandSpeedKph }),
        ...(cause.brakePressed === undefined ? {} : { brakePressed: cause.brakePressed }),
        ...(cause.gear === undefined ? {} : { gear: cause.gear }),
      });
      return;
    case "sensor":
      model.setSensorFault({
        signal: cause.signal,
        mode: cause.mode,
        ...(cause.value === undefined ? {} : { value: cause.value }),
      });
      return;
    case "wiring":
      model.setWiringFault({
        ecu: cause.ecu,
        mode: cause.mode,
        ...(cause.ohm === undefined ? {} : { ohm: cause.ohm }),
        ...(cause.duty === undefined ? {} : { duty: cause.duty }),
        ...(cause.flapMs === undefined ? {} : { flapMs: cause.flapMs }),
        ...(cause.pattern === undefined ? {} : { pattern: cause.pattern }),
      });
      return;
    case "bus":
      // A bare model has no wire; `silentPeersOf` is driven by what the vehicle
      // reports, so a bus cause on a model without a vehicle is a no-op by design
      // rather than a fake. A HighFidelityVehicle overrides this.
      return;
  }
}

/** Lift one cause again — the same switch, so the two can never drift apart. */
export function undoCause(model: VehicleBehaviourModel, cause: ScenarioCause): void {
  switch (cause.kind) {
    case "ignition":
      model.setIgnition("on");
      return;
    case "battery":
      model.setBatteryVoltage(12.6);
      return;
    case "alternator":
      model.setAlternatorEfficiency(1);
      return;
    case "electrical-load":
      model.setElectricalLoad(0);
      return;
    case "driver":
      model.setDriverDemand({ throttlePct: 0, demandSpeedKph: 0, brakePressed: false });
      return;
    case "sensor":
      model.clearSensorFault(cause.signal);
      return;
    case "wiring":
      model.clearWiringFault(cause.ecu);
      return;
    case "bus":
      return;
  }
}

/**
 * Run a scenario against a target: apply its causes in time order, advance the model,
 * and evaluate the expectations at the moments the scenario names.
 *
 * The order is the whole contract: a step at `atMs: 4000` is applied *after* the model
 * has been advanced to 4000 ms, and expectations whose `atMs` falls before it are
 * evaluated before the step. Nothing here waits on a wall clock (AGENTS 31).
 */
export async function runScenario(
  target: ScenarioTarget,
  scenario: VehicleScenario,
  options: RunScenarioOptions = {},
): Promise<ScenarioRun> {
  const model = target.model;
  const closedWorld = options.closedWorld ?? scenario.closedWorld ?? true;
  const checks: ScenarioCheck[] = [];
  const timeline: string[] = [];
  const moments = scenarioMoments(scenario);
  let clock = 0;

  for (const moment of moments) {
    model.advance(Math.max(0, moment.atMs - clock));
    clock = moment.atMs;
    // Lift first, then apply: a cause that ends and a cause that starts at the same
    // instant must not leave the earlier one in place just because of the order the
    // arrays happen to be built in.
    for (const step of moment.lift) {
      target.undo(step.cause);
      timeline.push(`${moment.atMs} ms: lifted ${describeCause(step.cause)}`);
    }
    for (const step of moment.apply) {
      target.apply(step.cause);
      timeline.push(`${moment.atMs} ms: ${describeCause(step.cause)}`);
    }
    for (const expectation of moment.dtcChecks) {
      checks.push(checkDtc(model, expectation, moment.atMs));
    }
    for (const condition of moment.conditionChecks) {
      checks.push(checkCondition(model.state, condition, moment.atMs));
    }
    if (options.onMoment !== undefined) {
      await options.onMoment(
        {
          atMs: moment.atMs,
          applied: moment.apply.map((step) => step.cause),
          lifted: moment.lift.map((step) => step.cause),
          due: moment.dtcChecks,
        },
        target,
      );
    }
    const stepForHooks = moment.apply[0] ?? moment.lift[0];
    if (stepForHooks !== undefined) await target.betweenSteps?.(stepForHooks);
  }

  const unexpected = closedWorld ? unpredictedCodes(model, scenario) : [];
  const passed = checks.every((check) => check.passed) && unexpected.length === 0;
  return {
    scenarioId: scenario.id,
    checks,
    unexpected,
    passed,
    finalState: model.state,
    timeline,
  };
}

/**
 * One moment per model time anything has to happen at.
 *
 * Causes and expectations share the timeline deliberately: an expectation at 1 500 ms
 * is a moment of its own even when no cause fires there. Evaluating only at cause times
 * would silently drop half the checks of a scenario — which is exactly what an
 * "expectation nobody ran" would look like: green.
 */
interface ScenarioMoment {
  atMs: number;
  apply: ScenarioStep[];
  lift: ScenarioStep[];
  dtcChecks: ScenarioExpectation[];
  conditionChecks: ScenarioCondition[];
}

function scenarioMoments(scenario: VehicleScenario): ScenarioMoment[] {
  const byTime = new Map<number, ScenarioMoment>();
  const at = (atMs: number): ScenarioMoment => {
    const existing = byTime.get(atMs);
    if (existing !== undefined) return existing;
    const created: ScenarioMoment = {
      atMs,
      apply: [],
      lift: [],
      dtcChecks: [],
      conditionChecks: [],
    };
    byTime.set(atMs, created);
    return created;
  };
  for (const step of scenario.steps) {
    at(step.atMs).apply.push(step);
    if (step.holdMs !== undefined) at(step.atMs + step.holdMs).lift.push(step);
  }
  for (const expectation of scenario.expectations) {
    at(expectation.atMs ?? scenario.durationMs).dtcChecks.push(expectation);
  }
  for (const condition of scenario.conditions ?? []) {
    at(condition.atMs ?? scenario.durationMs).conditionChecks.push(condition);
  }
  if (scenario.durationMs > 0) at(scenario.durationMs);
  return [...byTime.values()].sort((a, b) => a.atMs - b.atMs);
}

/** Text for a timeline line and a failing assertion message. */
export function describeCause(cause: ScenarioCause): string {
  switch (cause.kind) {
    case "ignition":
      return `ignition → ${cause.state}`;
    case "battery":
      return `battery → ${cause.volts} V`;
    case "alternator":
      return `alternator → ${Math.round(cause.efficiency * 100)} % of rated output`;
    case "electrical-load":
      return `load → ${cause.amps} A`;
    case "driver":
      return `driver → ${[
        cause.throttlePct !== undefined ? `${cause.throttlePct} % throttle` : undefined,
        cause.demandSpeedKph !== undefined ? `${cause.demandSpeedKph} km/h` : undefined,
        cause.brakePressed === undefined ? undefined : cause.brakePressed ? "braking" : "free",
        cause.gear === undefined ? undefined : `gear ${cause.gear}`,
      ]
        .filter((part): part is string => part !== undefined)
        .join(", ")}`;
    case "sensor":
      return `sensor ${cause.signal} → ${cause.mode}`;
    case "wiring":
      return `wiring at ${cause.ecu} → ${cause.mode}`;
    case "bus":
      return `bus ${cause.ecu ?? "segment"} → ${cause.mode}${
        cause.dropRate === undefined ? "" : ` (${Math.round(cause.dropRate * 100)} % lost)`
      }`;
  }
}

function checkDtc(
  model: VehicleBehaviourModel,
  expectation: ScenarioExpectation,
  atMs: number,
): ScenarioCheck {
  if (expectation.state === "intermittent") {
    const raises = model
      .monitorStates()
      .filter((monitor) => monitor.ecu === expectation.ecu && monitor.code === expectation.code)
      .reduce((total, monitor) => total + monitor.raised, 0);
    const needed = expectation.minRaises ?? 2;
    return {
      kind: "dtc",
      subject: `${expectation.ecu}:${expectation.code}`,
      expected: `intermittent (≥ ${needed} latch${needed === 1 ? "" : "es"})`,
      actual: `${raises} latch${raises === 1 ? "" : "es"}`,
      passed: raises >= needed,
      because: expectation.because,
      atMs,
    };
  }
  const memory = model.dtcMemoryOf(expectation.ecu);
  const entry = memory.find((dtc) => dtc.code === expectation.code);
  const status = entry?.status ?? 0;
  const actual =
    entry === undefined
      ? "absent"
      : status === 0
        ? "absent"
        : (status & 0x01) !== 0
          ? "active"
          : "stored";
  return {
    kind: "dtc",
    subject: `${expectation.ecu}:${expectation.code}`,
    expected: expectation.state,
    actual,
    passed: actual === expectation.state,
    because: expectation.because,
    atMs,
  };
}

/**
 * A physical condition against the model state.
 *
 * Numbers compare against `above`/`below`, booleans and strings against `equals`; a
 * field of a kind the condition does not fit is a failed check, never a skipped one —
 * a check that silently cannot fail is the thing this repository refuses most (34.21).
 */
function checkCondition(
  state: Readonly<VehicleModelState>,
  condition: ScenarioCondition,
  atMs: number,
): ScenarioCheck {
  const value = state[condition.field];
  let passed = false;
  const wanted = condition.equals;
  if (typeof value === "number") {
    passed =
      (condition.above === undefined || value > condition.above) &&
      (condition.below === undefined || value < condition.below);
  } else if (typeof value === "boolean") {
    passed = wanted !== undefined && value === wanted;
  } else if (typeof value === "string") {
    passed = wanted !== undefined && value === wanted;
  }
  const bounds = [
    condition.above === undefined ? undefined : `> ${condition.above}`,
    condition.below === undefined ? undefined : `< ${condition.below}`,
    wanted === undefined ? undefined : `= ${String(wanted)}`,
  ].filter((part): part is string => part !== undefined);
  return {
    kind: "condition",
    subject: String(condition.field),
    expected: bounds.join(" and ") || "no comparison given",
    // Not `String(value)`: the model computed 10.770000000000001 V, and the sentence
    // an operator reads has to say 10.77. `passed` was decided numerically above, so
    // nothing about the verdict moves.
    actual: typeof value === "number" ? formatMeasuredValue(value) : String(value),
    passed,
    because: condition.because,
    atMs,
  };
}

/** Monitor verdicts the scenario did not name — a scenario must predict its own faults. */
function unpredictedCodes(model: VehicleBehaviourModel, scenario: VehicleScenario): string[] {
  const named = new Set(scenario.expectations.map((entry) => `${entry.ecu}:${entry.code}`));
  return model
    .monitorStates()
    .filter((monitor) => monitor.raised > 0 && !named.has(`${monitor.ecu}:${monitor.code}`))
    .map((monitor) => `${monitor.ecu}:${monitor.code} from ${monitor.id}`);
}

/** A scenario with its steps removed — the negative control every run is measured against. */
export function withoutCauses(scenario: VehicleScenario): VehicleScenario {
  return { ...scenario, steps: [] };
}
