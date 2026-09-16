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

import { decodeDtcStatus } from "@vdp/protocols-uds";
import type { ScenarioRun, VehicleScenario } from "@vdp/simulators";
import { formatValue } from "./trace-view.js";

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

/* ------------------------------------------------------------------ panel views */

/**
 * One entry of the picker.
 *
 * `hint` carries the three numbers that decide whether a run is worth starting: how long
 * it models, how many steps it applies, how many expectations it will judge. A panel that
 * shows only the title invites a click on a 60 s scenario during a demo.
 */
export interface ScenarioOptionView {
  value: string;
  label: string;
  hint: string;
}

/** The catalog as the picker needs it — order is the catalog's own. */
export function toScenarioOptions(summaries: readonly ScenarioSummary[]): ScenarioOptionView[] {
  return summaries.map((scenario) => ({
    value: scenario.id,
    label: scenario.title,
    hint:
      `${scenario.steps} Schritte · ~${(scenario.durationMs / 1000).toFixed(1)} s Modellzeit · ` +
      `${scenario.expectations.length} Erwartungen`,
  }));
}

/**
 * Everything `GET /api/simulator/scenarios` answers.
 *
 * `scenarios` stays the raw projection (a client that wants ids, not labels, reads it);
 * `options` and `note` are the panel's own words. Both are produced here rather than in
 * `public/scenario.js`, because the front end has no test runner: a mapping that can be
 * silently wrong belongs on the side that has specs (ADR 0030 §2, ADR 0014).
 */
export interface ScenarioCatalogView {
  scenarios: ScenarioSummary[];
  options: ScenarioOptionView[];
  /** What the picker's emptiness means — a fact about the adapter, not a bug in the page. */
  note: string;
}

export function toScenarioCatalogView(catalog: readonly VehicleScenario[]): ScenarioCatalogView {
  const scenarios = summariseScenarios(catalog);
  return {
    scenarios,
    options: toScenarioOptions(scenarios),
    note:
      scenarios.length === 0
        ? "kein Szenario-Katalog auf dieser Verbindung — der Hochfidelen Simulator ist der einzige mit Verhaltensmodell"
        : `${scenarios.length} Szenarien aus dem Katalog des Fahrzeugs — jede Ursache wird gesetzt, bevor eine Erwartung gilt`,
  };
}

/**
 * What the panel currently knows, as one discriminated union.
 *
 * The four states are the whole panel: no run yet, a run in flight, a refused run, a
 * finished run. A boolean pair (`busy` + `error`) would allow the state that cannot exist
 * — busy *and* errored — and the headline would have to pick one of two answers.
 */
export type ScenarioPanelState =
  | { kind: "idle" }
  | { kind: "running"; scenarioId: string }
  | { kind: "error"; message: string }
  | { kind: "done"; run: ScenarioRunView };

/** The verdict line, with the class the pill is styled by. */
export interface ScenarioVerdictView {
  tone: "idle" | "busy" | "error" | "ok" | "bad";
  headline: string;
  detail: string;
}

/** How many unpredicted latches read like a sentence instead of a count with a suffix. */
const surprisePhrase = (count: number): string =>
  count === 0
    ? "keine unvorhergesehenen Latches"
    : count === 1
      ? "1 unvorhergesehener Latch"
      : `${count} unvorhergesehene Latches`;

/**
 * The run's verdict in one sentence, with the numbers behind it.
 *
 * `detail` counts the unpredicted latches beside the checks on purpose: `passed` is the
 * conjunction of both (`closedWorld`), so a headline that counted only checks would call a
 * run with 8/8 checks and one unexpected latch "bestanden" — the mistake this projection
 * exists to make impossible rather than unlikely.
 */
export function toScenarioVerdict(state: ScenarioPanelState): ScenarioVerdictView {
  switch (state.kind) {
    case "idle":
      return { tone: "idle", headline: "kein Lauf", detail: "Szenario wählen und ausführen" };
    case "running":
      return {
        tone: "busy",
        headline: "Läuft",
        detail: `${state.scenarioId} — Modellzeit läuft, ein Lauf pro Verbindung`,
      };
    case "error":
      return { tone: "error", headline: "Abgelehnt", detail: state.message };
    case "done": {
      const { run } = state;
      const ok = run.checks.filter((check) => check.passed).length;
      const total = run.checks.length;
      const surprises = run.unexpected.length;
      if (total === 0) {
        return {
          tone: "bad",
          headline: "ohne Aussage",
          detail:
            "der Lauf hat keine Checks gemeldet — ein Szenario ohne Erwartungen gewinnt nicht",
        };
      }
      const passed = run.passed && surprises === 0;
      return {
        tone: passed ? "ok" : "bad",
        headline: passed ? "bestanden" : "fehlgeschlagen",
        detail:
          `${ok}/${total} Checks · ${surprisePhrase(surprises)}` +
          (run.passed && surprises > 0
            ? " — das Modell meldet bestanden, aber es latchte Unvorhergesehenes"
            : ""),
      };
    }
  }
}

/** Expectation and actual states, in the words an operator reads (AGENTS 18). */
const STATE_WORDS: Readonly<Record<string, string>> = {
  active: "aktiv",
  stored: "gespeichert",
  absent: "nicht im Speicher",
  intermittent: "intermittierend",
};

/** An undocumented state reads as itself, never as a blank (AGENTS 24). */
export function stateWord(value: string): string {
  return STATE_WORDS[value] ?? value;
}

/**
 * One check as a list item, in the `check-list` vocabulary the workbench already uses
 * (`li.ok` / `li.fail`, `styles.css`) — the panel does not invent a second success idiom.
 */
export interface ScenarioCheckRow {
  state: "ok" | "fail";
  text: string;
}

export function toCheckRows(checks: readonly ScenarioCheckView[]): ScenarioCheckRow[] {
  return checks.map((check) => ({
    state: check.passed ? "ok" : "fail",
    text:
      `${check.atMs} ms · ${check.subject} — erwartet ${stateWord(check.expected)}, ` +
      `gelesen ${stateWord(check.actual)} · ${check.because}`,
  }));
}

/**
 * The module memories after a run — code, raw status, and the *Lesart* the status byte
 * actually carries.
 *
 * The word is derived, not assumed. `ScenarioMemoryView` lists every code the module
 * documents, and on the simulator that is a much longer list than the codes that were
 * reported: the live run of `under-voltage-at-start` answers 14 rows, 13 of them with
 * status `0x00`. Rendering that as "gespeichert" tells the operator the fault memory holds
 * thirteen codes, and the whole point of this panel is to be the thing they can trust
 * about a fault memory (AGENTS 13, 24).
 */
export interface ScenarioMemoryRow {
  active: boolean;
  /** `true` when a `0x19 0x02` read would answer this code (confirmed or currently failing). */
  stored: boolean;
  cells: string[];
}

/** What a status byte says, in the words the DTC table uses. */
function lesart(status: number): string {
  const bits = decodeDtcStatus(status);
  if (bits.testFailed) return "jetzt fehlgeschlagen";
  if (bits.confirmedDtc) return "bestätigt";
  if (bits.pendingDtc) return "pending";
  return "nicht gespeichert";
}

export function toMemoryRows(memory: readonly ScenarioMemoryView[]): ScenarioMemoryRow[] {
  return memory.map((entry) => {
    const bits = decodeDtcStatus(entry.status);
    return {
      active: entry.active,
      stored: bits.testFailed || bits.confirmedDtc,
      cells: [
        entry.ecu,
        entry.code,
        `0x${entry.status.toString(16).toUpperCase().padStart(2, "0")}`,
        lesart(entry.status),
      ],
    };
  });
}

/**
 * One sentence under the memory table: how many of the listed codes are in the memory at
 * all. The count belongs in the view because a reader who trusts the table needs the
 * denominator beside it — the table is "what the module knows", not "what it reports".
 */
export function toMemoryNote(rows: readonly ScenarioMemoryRow[]): string {
  if (rows.length === 0) return "der Lauf hat keine Speicherabfrage beantwortet";
  const stored = rows.filter((row) => row.stored).length;
  return stored === 0
    ? `${rows.length} dokumentierte Codes, keiner gemeldet — die Urteile des Laufs stehen oben`
    : `${stored} von ${rows.length} dokumentierten Codes sind im Fehlerspeicher gemeldet`;
}

export interface ScenarioModelRow {
  label: string;
  value: string;
}

/**
 * The state the run ended in, in reading order: supply and ignition first (a model that
 * never powered up explains everything below it), then the engine, then the numbers a code
 * was derived from. A label is stored beside its unit so a value cannot be shown in the
 * wrong one — a unit mistake is a mapping mistake, not a model mistake.
 */
const MODEL_FIELDS: ReadonlyArray<{ key: string; label: string; unit: string }> = [
  { key: "timeMs", label: "Modellzeit", unit: " ms" },
  { key: "ignition", label: "Klemme", unit: "" },
  { key: "supplyVoltage", label: "Versorgung", unit: " V" },
  { key: "rpm", label: "Drehzahl", unit: " min⁻¹" },
  { key: "engineRunning", label: "Motor läuft", unit: "" },
  { key: "speedKph", label: "Geschwindigkeit", unit: " km/h" },
  { key: "coolantC", label: "Kühlwasser", unit: " °C" },
  { key: "longTermTrimPct", label: "Langzeitkorrektur", unit: " %" },
  { key: "operationCycles", label: "Schaltspiele", unit: "" },
];

/**
 * Rows for the end state.
 *
 * Keys not in `MODEL_FIELDS` are appended, sorted, with the raw key as label: the model may
 * gain a number and the panel must not drop it — a list that filters is a decision, and
 * hiding a measured value needs a reason (AGENTS 24). `formatValue` is the workbench's one
 * number formatter (ADR 0015), so a voltage reads like every other voltage on the page.
 */
export function toModelRows(model: ScenarioRunView["model"]): ScenarioModelRow[] {
  const listed = new Set(MODEL_FIELDS.map((field) => field.key));
  const rows = MODEL_FIELDS.filter((field) => field.key in model).map((field) => ({
    label: field.label,
    value: `${formatValue(model[field.key] ?? "")}${field.unit}`,
  }));
  for (const key of Object.keys(model).sort()) {
    if (listed.has(key)) continue;
    rows.push({ label: key, value: formatValue(model[key] ?? "") });
  }
  return rows;
}

/**
 * The panel's whole answer to one run — the verdict and the four lists, all projected
 * server-side so the browser only lays out (`public/scenario.js` holds no mapping table).
 */
export interface ScenarioPanelView {
  verdict: ScenarioVerdictView;
  checks: ScenarioCheckRow[];
  memory: ScenarioMemoryRow[];
  memoryNote: string;
  model: ScenarioModelRow[];
  timeline: string[];
}

export function toScenarioPanelView(run: ScenarioRunView): ScenarioPanelView {
  return {
    verdict: toScenarioVerdict({ kind: "done", run }),
    checks: toCheckRows(run.checks),
    memory: toMemoryRows(run.memory),
    memoryNote: toMemoryNote(toMemoryRows(run.memory)),
    model: toModelRows(run.model),
    timeline: [...run.timeline],
  };
}
