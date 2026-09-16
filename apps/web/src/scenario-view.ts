/**
 * Scenario views: the workbench's side of the scenario engine (AGENTS 28, 32).
 *
 * A scenario lives in `@vdp/simulators` as data; a browser needs a *projection* of it —
 * the same rule `ecu-view.ts` and `dtc-view.ts` follow, and the reason this is a module
 * instead of four more methods in `backend.ts`: the mapping is the part that can be wrong
 * silently (a check dropped from the list, an "unexpected latch" that never reaches the
 * screen), and a pure function next to a spec is where that stays visible.
 *
 * The run view deliberately reports both verdicts: the *model's* (what its monitors
 * latched, straight from the vehicle) and the *scan's* (what a UDS read saw). A panel
 * that showed only one of them could not tell "the fault is in the car" apart from "the
 * platform can read it" — which is the distinction the whole chain exists for.
 */

import type { ScenarioRun, VehicleScenario } from "@vdp/simulators";

/** One entry of the scenario catalog, as the picker shows it. */
export interface ScenarioSummary {
  id: string;
  title: string;
  summary: string;
  /** Model time the run covers, ms — the number a "this takes a moment" hint needs. */
  durationMs: number;
  steps: number;
  /** One line per expectation, in the scenario's own words. */
  expectations: string[];
}

/** One check of a run, as a row. */
export interface ScenarioCheckView {
  subject: string;
  expected: string;
  actual: string;
  passed: boolean;
  because: string;
  atMs: number;
}

/** What one module's fault memory held, as the scan read it. */
export interface ScenarioMemoryView {
  ecu: string;
  code: string;
  status: number;
  /** `testFailed` of that status byte — the difference between "now" and "once". */
  active: boolean;
}

export interface ScenarioRunView {
  scenarioId: string;
  /** The scenario's own verdict: every check plus no unpredicted latch. */
  passed: boolean;
  checks: ScenarioCheckView[];
  /** Codes a monitor latched that the scenario did not predict. */
  unexpected: string[];
  /** One line per cause the run applied or lifted, in model time. */
  timeline: string[];
  /** The physical state the run ended in — the numbers the codes were derived from. */
  model: Record<string, number | string | boolean>;
  /** What the modules hold, read straight off their fault memories. */
  memory: ScenarioMemoryView[];
}

/** The catalog, as a picker needs it. */
export function summariseScenarios(catalog: readonly VehicleScenario[]): ScenarioSummary[] {
  return catalog.map((scenario) => ({
    id: scenario.id,
    title: scenario.title,
    summary: scenario.summary,
    durationMs: scenario.durationMs,
    steps: scenario.steps.length,
    expectations: scenario.expectations.map(
      (expectation) => `${expectation.ecu}:${expectation.code} → ${expectation.state}`,
    ),
  }));
}

/**
 * A run, projected for the screen.
 *
 * `memory` is handed in rather than read here: the caller owns the vehicle, and a mapper
 * that reached for the simulator itself would put a second path to the fault memory on
 * the wire contract (AGENTS 2: the app speaks to the vehicle through one layer).
 */
export function toScenarioRunView(
  run: ScenarioRun,
  memory: readonly ScenarioMemoryView[],
): ScenarioRunView {
  return {
    scenarioId: run.scenarioId,
    passed: run.passed,
    checks: run.checks.map((check) => ({
      subject: check.subject,
      expected: check.expected,
      actual: check.actual,
      passed: check.passed,
      because: check.because,
      atMs: check.atMs,
    })),
    unexpected: [...run.unexpected],
    timeline: [...run.timeline],
    model: {
      timeMs: run.finalState.timeMs,
      ignition: run.finalState.ignition,
      supplyVoltage: run.finalState.supplyVoltage,
      rpm: run.finalState.rpm,
      engineRunning: run.finalState.engineRunning,
      speedKph: run.finalState.speedKph,
      coolantC: run.finalState.coolantC,
      longTermTrimPct: run.finalState.longTermTrimPct,
      operationCycles: run.finalState.operationCycles,
    },
    // Rows are copied, not passed through: a run's view is handed to a response *and*
    // kept in the panel's state, and the vehicle's memory keeps moving underneath it.
    memory: memory.map((entry) => ({
      ecu: entry.ecu,
      code: entry.code,
      status: entry.status,
      active: entry.active,
    })),
  };
}
