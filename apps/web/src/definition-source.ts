/**
 * Extra definition packages as files (ADR 0003, backlog #11).
 *
 * Built-in packages stay in TypeScript. Anything a workshop actually owns —
 * licensed OEM JSON, a community pack with provenance — lands in
 * `data/definitions/*.json` and is parsed with the same `parseDefinitionPackage`
 * the importer uses. Missing directory = no extras (the demo must boot). A file
 * that does not parse stops the process with the file named: a silent skip would
 * look like knowledge that is not there.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type DefinitionPackage, parseDefinitionPackageJson } from "@vdp/definitions";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the extra-package directory.
 *
 * `VDP_DEFINITIONS_DIR` wins when set: a packaged install does not run from the
 * repository root, and a silent walk that finds nothing would look like "no
 * licensed data" when the operator pointed at a path. A missing override is a
 * refusal with the path named. Without the override, a missing directory is
 * fine — the demo boots on the built-ins.
 */
export function findDefinitionsDir(start: string = HERE): string | undefined {
  const override = process.env.VDP_DEFINITIONS_DIR?.trim();
  if (override) {
    const resolved = resolve(override);
    if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
      throw new Error(`VDP_DEFINITIONS_DIR="${override}" is not a directory`);
    }
    return resolved;
  }
  let current = resolve(start);
  for (;;) {
    const candidate = join(current, "data", "definitions");
    if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export interface LoadedDefinitionFile {
  file: string;
  pkg: DefinitionPackage;
}

/**
 * Parse every `*.json` in the directory. Empty / missing directory → `[]`.
 * A broken file throws with its name.
 */
export function loadDefinitionFiles(dir?: string): readonly LoadedDefinitionFile[] {
  const root = dir ?? findDefinitionsDir();
  if (root === undefined) return [];
  if (!existsSync(root) || !statSync(root).isDirectory()) return [];
  const names = readdirSync(root)
    .filter((name) => name.endsWith(".json"))
    .sort();
  const loaded: LoadedDefinitionFile[] = [];
  for (const name of names) {
    const text = readFileSync(join(root, name), "utf8");
    try {
      loaded.push({ file: name, pkg: parseDefinitionPackageJson(text) });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`definition file ${name} is not a valid package: ${reason}`);
    }
  }
  return loaded;
}

/** Packages only — the workbench concatenates them onto the built-in set. */
export function loadOptionalDefinitionPackages(dir?: string): readonly DefinitionPackage[] {
  return loadDefinitionFiles(dir).map((entry) => entry.pkg);
}
