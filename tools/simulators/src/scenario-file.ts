/**
 * Scenario files — the portable, reviewable form of a {@link VehicleScenario}
 * (ADR 0040, master prompt §7).
 *
 * A file is a *script*, and this module is its only reader: it turns the
 * compact bench vocabulary (`ignition: on`, `alternator: fail`, `wait: 5000`)
 * into the causal {@link ScenarioStep}s of the engine, with model time derived
 * from the sequence, and every expectation into a check the runner can
 * evaluate. The grammar is validated strictly — unknown keys, unknown step
 * names and malformed comparisons are errors with the step index, because a
 * scenario that silently reads as a no-op is the one failure mode a
 * reproducibility artifact must not have.
 *
 * `determinism` is mandatory: `clock: "model-time"` and an integer seed.
 * Nothing runs here; parsing is pure, and a caller decides what a file means
 * (a model run, the wire-attached vehicle, the workbench).
 */

import type {
  ScenarioCause,
  ScenarioCondition,
  ScenarioExpectation,
  ScenarioExpectationState,
  ScenarioStep,
  VehicleScenario,
} from "./scenarios.js";
import type { IgnitionState, ModuleWiringMode, SensorFaultMode } from "./vehicle-state.js";

export interface ScenarioDeterminism {
  readonly seed: number;
  readonly clock: "model-time";
}

export interface ParsedScenarioFile {
  readonly scenario: VehicleScenario;
  readonly determinism: ScenarioDeterminism;
  /** The vehicle kind the file asks to run on; the loader does not build it. */
  readonly vehicle: string;
}

export type ScenarioFileParseResult =
  | { readonly ok: true; readonly file: ParsedScenarioFile }
  | { readonly ok: false; readonly errors: readonly string[] };

/** Model time every file step lands on ends with this observation tail. */
const OBSERVATION_TAIL_MS = 1_000;

const IGNITION_STATES: readonly IgnitionState[] = ["lock", "off", "acc", "on", "start"];
const SENSOR_MODES: readonly SensorFaultMode[] = [
  "open-circuit",
  "short-to-battery",
  "short-to-ground",
  "stuck",
  "drift-high",
  "drift-low",
];
const WIRING_MODES: readonly ModuleWiringMode[] = [
  "power-cut",
  "supply-resistance",
  "connector-loose",
  "bus-open",
];
const DTC_STATES: readonly ScenarioExpectationState[] = [
  "active",
  "stored",
  "absent",
  "intermittent",
];

/** How much current each named load level draws (the catalog’s numbers). */
const LOAD_AMPS: Readonly<Record<string, number>> = { low: 10, medium: 25, high: 45 };

/** One parsed step: time passing, or a cause (at the time it is reached). */
export type FileStep =
  | { readonly kind: "wait"; readonly waitMs: number }
  | { readonly kind: "cause"; readonly cause: ScenarioCause; readonly holdMs?: number };

class Errors {
  readonly list: string[] = [];
  add(path: string, message: string): void {
    this.list.push(`${path}: ${message}`);
  }
  get failed(): boolean {
    return this.list.length > 0;
  }
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectExtras(obj: Json, allowed: readonly string[], path: string, errors: Errors): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) errors.add(path, `unknown key "${key}"`);
  }
}

function asString(value: unknown, path: string, errors: Errors): string | undefined {
  if (typeof value !== "string" || value.length === 0) {
    errors.add(path, "expected a non-empty string");
    return undefined;
  }
  return value;
}

function asNumber(
  value: unknown,
  path: string,
  errors: Errors,
  min: number,
  max: number,
): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    errors.add(path, `expected a number ${min}..${max}`);
    return undefined;
  }
  return value;
}

function oneOf<T extends string>(
  value: unknown,
  path: string,
  errors: Errors,
  allowed: readonly T[],
): T | undefined {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    errors.add(path, `expected one of ${allowed.map((a) => JSON.stringify(a)).join(", ")}`);
    return undefined;
  }
  return value as T;
}

/** A step object carries exactly one cause key, plus an optional `holdMs`. */
const CAUSE_KEYS = [
  "ignition",
  "battery",
  "alternator",
  "load",
  "wait",
  "sensor",
  "ecu",
  "bus",
] as const;

function parseStepFileEntry(raw: unknown, index: number, errors: Errors): FileStep | null {
  const path = `steps[${index}]`;
  if (!isRecord(raw)) {
    errors.add(path, "expected an object naming one cause");
    return null;
  }
  const named = Object.keys(raw).filter((key) => key !== "holdMs");
  if (named.length !== 1) {
    errors.add(
      path,
      `exactly one of ${CAUSE_KEYS.join(", ")} expected, got ${named.length > 0 ? named.join(", ") : "nothing"}`,
    );
    return null;
  }
  for (const key of Object.keys(raw)) {
    if (key !== "holdMs" && !CAUSE_KEYS.includes(key as (typeof CAUSE_KEYS)[number])) {
      errors.add(path, `unknown key "${key}"`);
      return null;
    }
  }
  const holdMs =
    raw.holdMs === undefined
      ? undefined
      : asNumber(raw.holdMs, `${path}.holdMs`, errors, 0, 10 * 60 * 1000);
  if (raw.holdMs !== undefined && holdMs === undefined) return null;
  const withHold = (cause: ScenarioCause): FileStep => ({
    kind: "cause",
    cause,
    ...(holdMs !== undefined ? { holdMs } : {}),
  });
  const key = named[0] as (typeof CAUSE_KEYS)[number];
  const value = raw[key];
  switch (key) {
    case "wait": {
      const ms = asNumber(value, `${path}.wait`, errors, 1, 10 * 60 * 1000);
      return ms === undefined ? null : { kind: "wait", waitMs: ms };
    }
    case "ignition": {
      const state = oneOf(value, `${path}.ignition`, errors, IGNITION_STATES);
      return state === undefined ? null : withHold({ kind: "ignition", state });
    }
    case "battery": {
      if (isRecord(value)) {
        rejectExtras(value, ["volts"], `${path}.battery`, errors);
        const volts = asNumber(value.volts, `${path}.battery.volts`, errors, 0, 30);
        return volts === undefined ? null : withHold({ kind: "battery", volts });
      }
      const volts = asNumber(value, `${path}.battery`, errors, 0, 30);
      return volts === undefined ? null : withHold({ kind: "battery", volts });
    }
    case "alternator": {
      if (value === "fail") return withHold({ kind: "alternator", efficiency: 0 });
      const efficiency = asNumber(value, `${path}.alternator`, errors, 0, 1);
      return efficiency === undefined ? null : withHold({ kind: "alternator", efficiency });
    }
    case "load": {
      if (isRecord(value)) {
        rejectExtras(value, ["amps"], `${path}.load`, errors);
        const amps = asNumber(value.amps, `${path}.load.amps`, errors, 0, 300);
        return amps === undefined ? null : withHold({ kind: "electrical-load", amps });
      }
      if (typeof value === "string") {
        const amps = Object.hasOwn(LOAD_AMPS, value) ? LOAD_AMPS[value] : undefined;
        if (amps === undefined) {
          errors.add(`${path}.load`, "expected low, medium, high, a number or { amps }");
          return null;
        }
        return withHold({ kind: "electrical-load", amps });
      }
      const amps = asNumber(value, `${path}.load`, errors, 0, 300);
      return amps === undefined ? null : withHold({ kind: "electrical-load", amps });
    }
    case "sensor": {
      if (!isRecord(value)) {
        errors.add(`${path}.sensor`, "expected { signal, mode, value? }");
        return null;
      }
      rejectExtras(value, ["signal", "mode", "value"], `${path}.sensor`, errors);
      const signal = asString(value.signal, `${path}.sensor.signal`, errors);
      const mode = oneOf(value.mode, `${path}.sensor.mode`, errors, SENSOR_MODES);
      if (signal === undefined || mode === undefined) return null;
      if (
        value.value !== undefined &&
        asNumber(value.value, `${path}.sensor.value`, errors, -1000, 100000) === undefined
      ) {
        return null;
      }
      return withHold({
        kind: "sensor",
        signal,
        mode,
        ...(value.value !== undefined ? { value: value.value as number } : {}),
      });
    }
    case "ecu": {
      if (!isRecord(value)) {
        errors.add(`${path}.ecu`, 'expected { name, mode } or { name, state: "offline" }');
        return null;
      }
      rejectExtras(value, ["name", "mode", "state", "ohm", "duty"], `${path}.ecu`, errors);
      const name = asString(value.name, `${path}.ecu.name`, errors);
      if (name === undefined) return null;
      if (value.mode !== undefined) {
        const mode = oneOf(value.mode, `${path}.ecu.mode`, errors, WIRING_MODES);
        if (mode === undefined) return null;
        return withHold({ kind: "wiring", ecu: name, mode });
      }
      if (value.state === "offline") {
        // “offline” is a consequence with a cause: on a real bench the module
        // either lost its supply or lost the wire — say which by naming a
        // `mode`. `bus-open` (supply fine, nobody hears it) is the default
        // reading; ending the episode is the step’s holdMs, never a step
        // “online”, because that would be a setter pretending to be time.
        return withHold({ kind: "wiring", ecu: name, mode: "bus-open" });
      }
      errors.add(
        `${path}.ecu.state`,
        'only "offline" ends a module conversation; recovery is expressed by the offline step’s holdMs',
      );
      return null;
    }
    case "bus": {
      if (!isRecord(value)) {
        errors.add(`${path}.bus`, "expected { mode, ecu?, dropRate? }");
        return null;
      }
      rejectExtras(value, ["mode", "ecu", "dropRate"], `${path}.bus`, errors);
      const mode = oneOf(value.mode, `${path}.bus.mode`, errors, ["open", "stutter"] as const);
      if (mode === undefined) return null;
      const dropRate =
        value.dropRate === undefined
          ? undefined
          : asNumber(value.dropRate, `${path}.bus.dropRate`, errors, 0, 1);
      if (value.dropRate !== undefined && dropRate === undefined) return null;
      const ecu =
        value.ecu === undefined ? undefined : asString(value.ecu, `${path}.bus.ecu`, errors);
      if (value.ecu !== undefined && ecu === undefined) return null;
      return withHold({
        kind: "bus",
        mode,
        ...(dropRate !== undefined ? { dropRate } : {}),
        ...(ecu !== undefined ? { ecu } : {}),
      });
    }
    default:
      return null;
  }
}

interface ComparisonMeta {
  field: ScenarioCondition["field"];
  unit: string;
}

const COMPARISONS: Readonly<Record<string, ComparisonMeta>> = {
  battery_voltage: { field: "batteryVoltage", unit: "V" },
  supply_voltage: { field: "supplyVoltage", unit: "V" },
  coolant_temperature: { field: "coolantC", unit: "degC" },
  engine_rpm: { field: "rpm", unit: "rpm" },
};

/** `"< 12.0"` (the prompt’s shape) or `{ operator, value, unit? }`. */
function parseComparison(
  value: unknown,
  path: string,
  errors: Errors,
  meta: ComparisonMeta,
): { operator: string; value: number } | null {
  if (typeof value === "string") {
    const match = /^\s*(<=?|>=?)\s*(-?\d+(?:\.\d+)?)\s*$/.exec(value);
    if (match === null) {
      errors.add(path, 'expected a comparison like "< 12.0" or { operator, value }');
      return null;
    }
    return { operator: match[1] as string, value: Number(match[2]) };
  }
  if (isRecord(value)) {
    rejectExtras(value, ["operator", "value", "unit"], path, errors);
    const operator = oneOf(value.operator, `${path}.operator`, errors, [
      "<",
      "<=",
      ">",
      ">=",
    ] as const);
    const number = asNumber(value.value, `${path}.value`, errors, -273, 20000);
    const unit =
      value.unit === undefined ? undefined : asString(value.unit, `${path}.unit`, errors);
    if (operator === undefined || number === undefined) return null;
    if (unit !== undefined && unit !== meta.unit) {
      errors.add(
        `${path}.unit`,
        `expected the unit of the signal (${meta.unit}), got ${JSON.stringify(unit)}`,
      );
      return null;
    }
    return { operator, value: number };
  }
  errors.add(path, "expected a comparison string or { operator, value, unit? }");
  return null;
}

function parseExpectationFileEntry(
  raw: unknown,
  index: number,
  errors: Errors,
): { dtc?: ScenarioExpectation; condition?: ScenarioCondition } | null {
  const path = `expect[${index}]`;
  if (!isRecord(raw)) {
    errors.add(path, "expected an object naming one expectation");
    return null;
  }
  const keys = Object.keys(raw);
  if (keys.length !== 1 && !(keys.includes("dtc") && typeof raw.dtc === "string")) {
    errors.add(
      path,
      "exactly one expectation key expected (or the flat dtc form: dtc plus its fields)",
    );
    return null;
  }
  const key = keys[0] as string;
  if (key === "dtc") {
    // Two accepted spellings: `{"dtc": {"code":…,"ecu":…}}` and the flat
    // `{"dtc": "P0562", "ecu": "bcm", …}` that the example file uses.
    const entry: Json = typeof raw.dtc === "string" ? raw : isRecord(raw.dtc) ? raw.dtc : {};
    const allowed = ["dtc", "code", "ecu", "state", "atMs", "minRaises", "because"];
    rejectExtras(entry, allowed, path, errors);
    // Flat form carries the code as the value of `dtc` itself; nested under `code`.
    const code =
      typeof raw.dtc === "string"
        ? asString(raw.dtc, `${path}.dtc`, errors)
        : asString(entry.code, `${path}.dtc.code`, errors);
    if (code === undefined) return null;
    const ecu = asString(entry.ecu, `${path}.dtc.ecu ?? ecu`, errors);
    if (ecu === undefined) return null;
    const state =
      entry.state === undefined
        ? "active"
        : oneOf(entry.state, `${path}.dtc.state ?? state`, errors, DTC_STATES);
    if (state === undefined) return null;
    const atMs =
      entry.atMs === undefined
        ? undefined
        : asNumber(entry.atMs, `${path}.dtc.atMs ?? atMs`, errors, 0, 10 * 60 * 1000);
    if (entry.atMs !== undefined && atMs === undefined) return null;
    const minRaises =
      entry.minRaises === undefined
        ? undefined
        : asNumber(entry.minRaises, `${path}.dtc.minRaises ?? minRaises`, errors, 1, 999);
    if (entry.minRaises !== undefined && minRaises === undefined) return null;
    const because =
      entry.because === undefined
        ? `the scenario file expects ${code} on ${ecu} to be ${state}`
        : (asString(entry.because, `${path}.dtc.because ?? because`, errors) ?? "");
    return {
      dtc: {
        ecu,
        code,
        state,
        because,
        ...(atMs !== undefined ? { atMs } : {}),
        ...(minRaises !== undefined ? { minRaises } : {}),
      },
    };
  }
  const meta = COMPARISONS[key];
  if (meta === undefined) {
    errors.add(
      path,
      `unknown expectation "${key}" (known: dtc, ${Object.keys(COMPARISONS).join(", ")})`,
    );
    return null;
  }
  const comparison = parseComparison(raw[key], `${path}.${key}`, errors, meta);
  if (comparison === null) return null;
  const condition: ScenarioCondition = {
    field: meta.field,
    ...(comparison.operator === "<" || comparison.operator === "<="
      ? { below: comparison.value }
      : { above: comparison.value }),
    because: `${key} ${comparison.operator} ${comparison.value} ${meta.unit} after the script`,
  };
  return { condition };
}

/**
 * Parse a scenario file. On success the {@link VehicleScenario} is ready for
 * `runScenario` — on the bare model, on a running vehicle, or in the
 * workbench; on failure every problem is a line with its path.
 */
export function parseScenarioFile(text: string): ScenarioFileParseResult {
  const errors = new Errors();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, errors: [`invalid JSON: ${error instanceof Error ? error.message : "?"}`] };
  }
  if (!isRecord(parsed)) {
    return { ok: false, errors: ["scenario file must be a JSON object"] };
  }
  const file = parsed;
  rejectExtras(
    file,
    [
      "$schema",
      "scenario",
      "title",
      "vehicle",
      "steps",
      "expect",
      "determinism",
      "uses",
      "summary",
      "closedWorld",
    ],
    "file",
    errors,
  );

  const id = asString(file.scenario, "file.scenario", errors);
  if (id !== undefined && !/^[a-z0-9][a-z0-9_-]*$/.test(id)) {
    errors.add("file.scenario", "expected an id of letters, digits, dashes and underscores");
  }
  const title =
    file.title === undefined
      ? (asString(file.scenario, "file.scenario", errors) ?? "")
      : (asString(file.title, "file.title", errors) ?? "");
  const summary =
    file.summary === undefined ? title : (asString(file.summary, "file.summary", errors) ?? title);
  const vehicle =
    file.vehicle === undefined
      ? "high-fidelity-simulator"
      : (asString(file.vehicle, "file.vehicle", errors) ?? "");
  if (file.vehicle !== undefined && vehicle !== "high-fidelity-simulator") {
    errors.add(
      "file.vehicle",
      `unsupported vehicle ${JSON.stringify(vehicle)} — the file grammar names the simulator vehicle`,
    );
  }
  if (file.uses !== undefined && !Array.isArray(file.uses)) {
    errors.add("file.uses", "expected an array of strings");
  }
  let closedWorld = true;
  if (file.closedWorld !== undefined) {
    if (typeof file.closedWorld !== "boolean") {
      errors.add("file.closedWorld", "expected true or false");
    } else {
      closedWorld = file.closedWorld;
    }
  }

  let determinism: ScenarioDeterminism | null = null;
  if (!isRecord(file.determinism)) {
    errors.add(
      "file.determinism",
      'required — { clock: "model-time", seed } is what makes a file reproducible',
    );
  } else {
    rejectExtras(file.determinism, ["clock", "seed"], "file.determinism", errors);
    const clock = oneOf(file.determinism.clock, "file.determinism.clock", errors, [
      "model-time",
    ] as const);
    const seed = file.determinism.seed;
    if (
      typeof seed !== "number" ||
      !Number.isInteger(seed) ||
      seed < 0 ||
      seed > Number.MAX_SAFE_INTEGER
    ) {
      errors.add("file.determinism.seed", "expected an integer seed");
    } else if (clock !== undefined) {
      determinism = { clock: "model-time", seed };
    }
  }

  if (!Array.isArray(file.steps) || file.steps.length === 0) {
    errors.add("file.steps", "expected a non-empty array of steps");
  }
  if (!Array.isArray(file.expect) || file.expect.length === 0) {
    errors.add("file.expect", "expected a non-empty array of expectations");
  }

  const steps: ScenarioStep[] = [];
  const expectations: ScenarioExpectation[] = [];
  const conditions: ScenarioCondition[] = [];
  let now = 0;
  if (Array.isArray(file.steps)) {
    file.steps.forEach((raw, index) => {
      const step = parseStepFileEntry(raw, index, errors);
      if (step === null) return;
      if (step.kind === "wait") {
        now += step.waitMs;
        return;
      }
      steps.push({
        atMs: now,
        cause: step.cause,
        ...(step.holdMs !== undefined ? { holdMs: step.holdMs } : {}),
      });
    });
  }
  if (Array.isArray(file.expect)) {
    file.expect.forEach((raw, index) => {
      const entry = parseExpectationFileEntry(raw, index, errors);
      if (entry === null) return;
      if (entry.dtc !== undefined) expectations.push(entry.dtc);
      if (entry.condition !== undefined) conditions.push(entry.condition);
    });
  }

  const lastMoment = steps.reduce(
    (max, step) => Math.max(max, step.atMs + (step.holdMs ?? 0)),
    now,
  );
  const durationMs = lastMoment + OBSERVATION_TAIL_MS;

  if (errors.failed || id === undefined || determinism === null) {
    return { ok: false, errors: errors.list };
  }
  const scenario: VehicleScenario = {
    id,
    title,
    summary,
    durationMs,
    steps,
    expectations,
    ...(conditions.length > 0 ? { conditions } : {}),
    closedWorld,
  };
  return { ok: true, file: { scenario, determinism, vehicle } };
}
