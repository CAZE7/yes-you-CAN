/**
 * Where the workbench's scenarios come from: the `scenarios/` directory (ADR 0048).
 *
 * The files are the only truth — there is no second, hand-written catalog in the tree —
 * so the server reads them at startup, through the one loader
 * (`loadScenarioLibrary` over `parseScenarioFile`). A broken or duplicated file is a
 * startup failure with the file named, never a scenario missing from the panel: a
 * silent hole here would send a technician to a vehicle with half a bench.
 *
 * This file is the whole of the web layer's filesystem stake in scenarios: it reads
 * texts and hands them to the portable loader, which does the grammar.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type LoadedScenarioFile,
  loadScenarioLibrary,
  type ScenarioFileInput,
  type ScenarioLibrary,
} from "@vdp/simulators";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Walk up from the module (or a start dir) until a `scenarios` directory with files appears. */
export function findScenariosDir(start: string = HERE): string {
  let current = resolve(start);
  for (;;) {
    const candidate = join(current, "scenarios");
    if (existsSync(candidate) && statSync(candidate).isDirectory()) {
      const has = readdirSync(candidate).some((name) => name.endsWith(".json"));
      if (has) return candidate;
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(
        `no scenarios/ directory with *.json files found above ${start} — ` +
          "the workbench cannot offer scenarios without its scenario files",
      );
    }
    current = parent;
  }
}

/** Read every `*.json` of the directory, sorted so the catalog order is stable. */
export function readScenarioInputs(dir: string): readonly ScenarioFileInput[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => ({ file: name, text: readFileSync(join(dir, name), "utf8") }));
}

/**
 * Load the catalog for a workbench process. Throws with every problem named — a
 * scenario file that does not parse stops the server, because a bench that offers a
 * subset without saying so is lying about the vehicle.
 */
export function loadScenarioCatalog(dir?: string): readonly LoadedScenarioFile[] {
  const library: ScenarioLibrary = loadScenarioLibrary(
    readScenarioInputs(dir ?? findScenariosDir()),
  );
  if (!library.ok) {
    const detail = library.issues
      .map((issue) => `  ${issue.file}: ${issue.problems.join("; ")}`)
      .join("\n");
    throw new Error(`the scenario files have problems:\n${detail}`);
  }
  return library.files;
}
