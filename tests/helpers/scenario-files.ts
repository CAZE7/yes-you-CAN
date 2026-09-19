/**
 * The scenario files, loaded for tests (ADR 0048).
 *
 * The `scenarios/*.json` directory is the only catalog there is, so the suites read it
 * through the same loader the workbench server uses — `loadScenarioLibrary` over
 * `parseScenarioFile`. A test helper, not a second source: if a file stops parsing, the
 * suites fail with the file named, exactly as the server does.
 *
 * Production code may not import from `tests/`; the workbench has its own thin reader
 * (`apps/web/src/scenario-source.ts`). Both are environments binding one pure loader.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type LoadedScenarioFile,
  type ScenarioFileInput,
  loadScenarioLibrary,
} from "@vdp/simulators";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "..", "..");

/** Every `scenarios/*.json`, parsed and validated — sorted by file name. */
export function scenarioFiles(): readonly LoadedScenarioFile[] {
  const dir = join(REPO_ROOT, "scenarios");
  const inputs: readonly ScenarioFileInput[] = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => ({ file: name, text: readFileSync(join(dir, name), "utf8") }));
  const library = loadScenarioLibrary(inputs);
  if (!library.ok) {
    throw new Error(
      `the scenario files have problems:\n${library.issues
        .map((issue) => `  ${issue.file}: ${issue.problems.join("; ")}`)
        .join("\n")}`,
    );
  }
  return library.files;
}

/** One scenario file by id — the way a test names the script it wants. */
export function scenarioFileById(id: string): LoadedScenarioFile {
  const found = scenarioFiles().find((file) => file.id === id);
  if (found === undefined) {
    const known = scenarioFiles()
      .map((file) => file.id)
      .join(", ");
    throw new Error(`no scenario file "${id}" — known: ${known}`);
  }
  return found;
}
