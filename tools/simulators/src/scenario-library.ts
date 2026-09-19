/**
 * The scenario library — many scenario *files*, one loader (ADR 0048).
 *
 * A file is the portable, reviewable form of a {@link VehicleScenario}; `scenarios/*.json`
 * is the one place the built-in scripts live. This module is the pure half of the way a
 * *set* of files becomes a catalog: it parses every file with {@link parseScenarioFile}
 * — the only grammar they exist in — and refuses the set as a whole if any file is
 * malformed or if two files claim one id. A library that silently dropped a broken file
 * would hide exactly the scenario a reader came for.
 *
 * There is no filesystem here on purpose: `@vdp/simulators` is a portable tool layer.
 * The caller hands the texts in (`loadScenarioLibrary`), and the environments that have
 * a disk — the workbench server, the test helpers — are where reading happens.
 */

import type { ScenarioDeterminism, ScenarioFileParseResult } from "./scenario-file.js";
import { parseScenarioFile } from "./scenario-file.js";
import type { VehicleScenario } from "./scenarios.js";

/** One file as the caller read it: a name for the error messages, the text itself. */
export interface ScenarioFileInput {
  readonly file: string;
  readonly text: string;
}

/** One parsed file: the scenario plus what a runner needs to reproduce it. */
export interface LoadedScenarioFile {
  readonly file: string;
  readonly id: string;
  readonly scenario: VehicleScenario;
  readonly determinism: ScenarioDeterminism;
  /** The vehicle kind the file asks to run on (today exactly one). */
  readonly vehicle: string;
}

export interface ScenarioLibraryIssue {
  readonly file: string;
  readonly problems: readonly string[];
}

export type ScenarioLibrary =
  | { readonly ok: true; readonly files: readonly LoadedScenarioFile[] }
  | { readonly ok: false; readonly issues: readonly ScenarioLibraryIssue[] };

/**
 * Parse a set of scenario files. Strict in both directions: a file that does not parse
 * and an id that appears twice both fail the whole library — a catalog with a silent
 * hole is worse than no catalog, because every consumer would have to re-ask which
 * scenarios exist.
 */
export function loadScenarioLibrary(inputs: readonly ScenarioFileInput[]): ScenarioLibrary {
  const issues: ScenarioLibraryIssue[] = [];
  const files: LoadedScenarioFile[] = [];
  const byId = new Map<string, string>();

  for (const input of inputs) {
    const result: ScenarioFileParseResult = parseScenarioFile(input.text);
    if (!result.ok) {
      issues.push({ file: input.file, problems: result.errors });
      continue;
    }
    const { scenario, determinism, vehicle } = result.file;
    const owner = byId.get(scenario.id);
    if (owner !== undefined) {
      issues.push({
        file: input.file,
        problems: [`scenario id "${scenario.id}" is already defined by ${owner}`],
      });
      continue;
    }
    byId.set(scenario.id, input.file);
    files.push({ file: input.file, id: scenario.id, scenario, determinism, vehicle });
  }

  return issues.length === 0 ? { ok: true, files } : { ok: false, issues };
}

/** The scenarios of a loaded library, in the order the caller listed the files. */
export function scenariosOf(library: ScenarioLibrary): readonly VehicleScenario[] {
  if (!library.ok) {
    throw new Error(
      `the scenario library has problems: ${library.issues
        .map((issue) => `${issue.file}: ${issue.problems.join("; ")}`)
        .join(" | ")}`,
    );
  }
  return library.files.map((file) => file.scenario);
}
