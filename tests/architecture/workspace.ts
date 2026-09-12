/**
 * Workspace discovery for the architecture tests.
 *
 * Both the dependency graph and the manifest metadata are statements about
 * "every package in this repo", so the enumeration lives here once instead of
 * once per test file. `WORKSPACE_ROOTS` mirrors the `workspaces` field of the
 * root manifest — if that field changes, this list has to change with it (the
 * manifest test asserts the count, so silence is not possible).
 */

import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root, derived from this file so the tests run from any cwd. */
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Directories that hold workspace packages (mirrors `workspaces` in the root manifest). */
export const WORKSPACE_ROOTS: ReadonlyArray<{ root: string; depth: number }> = [
  { root: "packages", depth: 1 },
  { root: "packages", depth: 2 },
  { root: "tools", depth: 1 },
  { root: "apps", depth: 1 },
];

/** Absolute paths of every directory that holds a `package.json`, sorted. */
export function discoverWorkspaceDirs(): string[] {
  const found = new Set<string>();
  for (const { root, depth } of WORKSPACE_ROOTS) {
    const base = join(repoRoot, root);
    if (!existsSync(base)) continue;
    const collect = (dir: string, level: number): void => {
      if (existsSync(join(dir, "package.json"))) {
        found.add(dir);
        return;
      }
      if (level >= depth) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (
          !entry.isDirectory() ||
          entry.name.startsWith(".") ||
          entry.name === "node_modules" ||
          entry.name === "dist"
        )
          continue;
        collect(join(dir, entry.name), level + 1);
      }
    };
    collect(base, 0);
  }
  return Array.from(found).sort();
}
