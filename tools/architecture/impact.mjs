#!/usr/bin/env node
/**
 * Impact analysis (master backlog §22/23, ADR 0045).
 *
 * One question, answered from one source: *if this file or package changes,
 * what has to be re-run, re-read and re-checked?* The answer is computed from
 * `architecture/architecture.yaml` — the same graph `npm run check:deps` enforces
 * (ADR 0031/0043). A tool that restated the edges in its own vocabulary would be
 * a second source of the rule; there is exactly one, and this file reads it.
 *
 * Usage:
 *   node tools/architecture/impact.mjs <file|package> [--json]
 *   node tools/architecture/impact.mjs --changed [base] [--json]   (default base: HEAD)
 *
 * `--changed` collects the working-tree diff against `base` (plus untracked files)
 * and maps every file to the workspace package that contains it; a positional
 * argument names one file or one `@vdp/...` package directly.
 *
 * Exit codes: 0 = report written, 2 = usage error or a target that resolves to
 * no package (so a typo never looks like "nothing is affected").
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const MANIFEST = join(ROOT, "architecture", "architecture.yaml");

/** Workspace roots, mirroring the `workspaces` field of the root manifest. */
const WORKSPACE_ROOTS = [
  { root: "packages", depth: 2 },
  { root: "tools", depth: 1 },
  { root: "apps", depth: 1 },
];

/* ------------------------------------------------------------------ shared helpers (exported for ai-context --changed) */

/** The one architecture source, parsed (JSON syntax, ADR 0002). Throws on a broken file. */
export function loadManifest() {
  if (!existsSync(MANIFEST)) throw new Error(`manifest not found: ${relative(ROOT, MANIFEST)}`);
  return JSON.parse(readFileSync(MANIFEST, "utf8"));
}

/** Package name → workspace directory relative to the repo root. */
export function packageDirs() {
  const dirs = new Map();
  for (const { root: base, depth } of WORKSPACE_ROOTS) {
    const start = join(ROOT, base);
    if (!existsSync(start)) continue;
    const collect = (dir, level) => {
      const manifestPath = join(dir, "package.json");
      if (existsSync(manifestPath)) {
        try {
          const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
          if (manifest.name) dirs.set(manifest.name, relative(ROOT, dir).split(sep).join("/"));
        } catch {
          // A broken manifest is the checker's finding, not this tool's.
        }
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
    collect(start, 0);
  }
  return dirs;
}

/** Files changed against `base` plus untracked files (git's own vocabulary). */
export function gitChangedFiles(base) {
  const run = (args) =>
    execFileSync("git", args, { cwd: ROOT, encoding: "utf8" })
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
  try {
    const tracked = run(["diff", "--name-only", base]);
    const untracked = run(["ls-files", "--others", "--exclude-standard"]);
    return [...new Set([...tracked, ...untracked])].sort();
  } catch (error) {
    throw new Error(`git ${error.message.split("\n")[0]}`);
  }
}

/**
 * Repository paths → the packages that contain them, plus what could not map.
 * `architecture.yaml`, docs and tests are deliberately "unmapped": they are not
 * in any package's `mayImport`, and inventing a shadow package for them would
 * put a second graph where the real one already answers.
 */
export function filesToPackages(files, dirs) {
  const packages = new Set();
  const unmapped = [];
  for (const file of files) {
    let owner;
    for (const [name, dir] of dirs) {
      if (file === dir || file.startsWith(`${dir}/`)) {
        if (owner === undefined || dir.length > owner[1].length) owner = [name, dir];
      }
    }
    if (owner === undefined) unmapped.push(file);
    else packages.add(owner[0]);
  }
  return { packages: [...packages].sort(), unmapped: unmapped.sort() };
}

/**
 * Transitive reverse `mayImport` closure: every package that imports a seed,
 * directly or through any number of hops. This is the only direction the rule
 * file gives an impact tool — the graph says who may import whom, so the
 * dependents of a changed package are computable, not guessable.
 */
export function affectedClosure(manifest, seeds) {
  const importersOf = new Map();
  for (const [name, entry] of Object.entries(manifest.packages ?? {})) {
    for (const target of entry.mayImport ?? []) {
      if (!importersOf.has(target)) importersOf.set(target, []);
      importersOf.get(target).push(name);
    }
  }
  const found = new Map([...seeds].map((seed) => [seed, new Set()]));
  let grew = true;
  while (grew) {
    grew = false;
    for (const [target, importers] of importersOf) {
      if (!found.has(target)) continue;
      for (const importer of importers) {
        if (found.has(importer)) continue;
        found.set(importer, new Set([target]));
        grew = true;
      }
    }
    // A newly found package's own importers reach one hop further each round;
    // record *why* via every already-found edge that points at it.
    for (const [importer, via] of found) {
      for (const target of manifest.packages?.[importer]?.mayImport ?? []) {
        if (found.has(target) && !via.has(target)) via.add(target);
      }
    }
  }
  return found; // seed and affected package name → which closure members it imports
}

/** ADRs that name one of the packages, found by reading docs/adr/*.md. */
export function adrsForPackages(manifest, packages) {
  const adrDir = join(ROOT, "docs", "adr");
  const wanted = new Set(packages);
  const hits = [];
  for (const file of readdirSync(adrDir).sort()) {
    const match = file.match(/^(\d{4})/);
    if (!match || !file.endsWith(".md")) continue;
    const text = readFileSync(join(adrDir, file), "utf8");
    const named = [...wanted].filter((pkg) => text.includes(pkg));
    // A topic's ADRs belong to every package of the topic, so an ADR the
    // manifest assigns to a topic covering a seed package is relevant even
    // when its text never names the package.
    const inTopic = topicsForPackages(manifest, named.length > 0 ? [...wanted] : []).flatMap(
      (name) => manifest.topics?.[name]?.adrs ?? [],
    );
    if (named.length === 0 && !inTopic.includes(match[1])) continue;
    hits.push({ number: match[1], file, names: named.sort() });
  }
  return hits;
}

/** Topics of the manifest whose packages intersect the given set. */
export function topicsForPackages(manifest, packages) {
  const wanted = new Set(packages);
  return Object.entries(manifest.topics ?? {})
    .filter(([, topic]) => (topic.packages ?? []).some((pkg) => wanted.has(pkg)))
    .map(([name]) => name);
}

/**
 * Tests for a package set: the co-located specs inside the package, plus every
 * file under tests/ that imports the package by name. Not a guess at "unit vs
 * integration" — the import graph says which test files touch these packages,
 * which is exactly the re-run question the report answers.
 */
export function testsForPackages(packages, dirs) {
  const specs = new Set();
  for (const name of packages) {
    const dir = dirs.get(name);
    if (dir === undefined) continue;
    for (const file of walk(join(ROOT, dir))) {
      if (file.endsWith(".spec.ts")) specs.add(join(dir, file).split(sep).join("/"));
    }
  }
  const importers = new Set();
  const patterns = [...packages].map(
    (name) => new RegExp(`from\\s+"${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(/[^"]*)?"`),
  );
  for (const file of walk(join(ROOT, "tests"))) {
    if (!file.endsWith(".ts")) continue;
    const text = readFileSync(join(ROOT, "tests", file), "utf8");
    if (patterns.some((pattern) => pattern.test(text)))
      importers.add(join("tests", file).split(sep).join("/"));
  }
  return { specs: [...specs].sort(), testFiles: [...importers].sort() };
}

function walk(dir, prefix = "") {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith("."))
      continue;
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walk(join(dir, entry.name), path));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

/* ------------------------------------------------------------------------- analysis */

/** The whole answer for one seed set; shared by the CLI and by `ai:context --changed`. */
export function analyzeImpact(manifest, dirs, seeds) {
  const closure = affectedClosure(manifest, seeds);
  const all = [...closure.keys()];
  const affected = all.filter((name) => !seeds.includes(name));
  const { specs, testFiles } = testsForPackages(all, dirs);
  return {
    seeds,
    affected: affected
      .map((name) => ({
        name,
        layer: manifest.packages?.[name]?.layer ?? "?",
        imports: [...(closure.get(name) ?? [])].sort(),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    adrs: adrsForPackages(manifest, all),
    topics: topicsForPackages(manifest, all),
    tests: { specs, testFiles },
  };
}

function renderMarkdown(result, context) {
  const lines = [];
  lines.push(`# Impact: ${context}`);
  lines.push("");
  lines.push(
    "> Computed from `architecture/architecture.yaml` (the one source, ADR 0031/0043); " +
      "ADRs by mention scan of `docs/adr/`, tests by co-located specs and imports under `tests/`.",
  );
  lines.push("");
  lines.push(`**Seed:** ${result.seeds.map((name) => `\`${name}\``).join(", ") || "—"}`);
  lines.push("");
  lines.push("## Affected packages (reverse `mayImport`)");
  lines.push("");
  if (result.affected.length === 0) {
    lines.push("- none: no package imports the seed through the declared graph");
  } else {
    lines.push("| Package | Layer | Imports (from the graph) |");
    lines.push("|---|---|---|");
    for (const entry of result.affected) {
      lines.push(
        `| \`${entry.name}\` | ${entry.layer} | ${entry.imports.map((n) => `\`${n}\``).join(", ")} |`,
      );
    }
  }
  lines.push("");
  lines.push("## Relevant ADRs");
  lines.push("");
  if (result.adrs.length === 0) lines.push("- (none name these packages)");
  for (const adr of result.adrs) {
    lines.push(
      `- [ADR ${adr.number}](docs/adr/${adr.file})${adr.names.length > 0 ? ` — names ${adr.names.map((n) => `\`${n}\``).join(", ")}` : " — assigned by topic"}`,
    );
  }
  lines.push("");
  lines.push("## Tests to run");
  lines.push("");
  for (const file of [...result.tests.specs, ...result.tests.testFiles]) {
    lines.push(`- \`${file}\``);
  }
  if (result.tests.specs.length + result.tests.testFiles.length === 0)
    lines.push("- (none found — a package without a spec is a gap, not a pass)");
  lines.push("");
  lines.push("## AI context");
  lines.push("");
  if (result.topics.length === 0) lines.push("- (no topic covers these packages)");
  for (const topic of result.topics) {
    lines.push(`- \`npm run ai:context ${topic}\``);
  }
  lines.push("");
  return lines.join("\n");
}

/* ------------------------------------------------------------------------------ CLI */

function usage() {
  process.stderr.write(
    "usage: impact.mjs <file|package> [--json]\n" +
      "       impact.mjs --changed [base] [--json]   (default base: HEAD)\n",
  );
  process.exit(2);
}

function main() {
  const argv = process.argv.slice(2);
  const json = argv.includes("--json");
  const flags = new Set(argv.filter((a) => a.startsWith("--") && a !== "--json"));
  const positional = argv.filter((a) => !a.startsWith("--"));
  const changed = flags.has("--changed");
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) usage();
  if (changed && positional.length > 0) usage();
  if (!changed && positional.length !== 1) usage();
  for (const flag of flags) {
    if (flag !== "--changed") usage();
  }

  let manifest;
  let dirs;
  try {
    manifest = loadManifest();
    dirs = packageDirs();
  } catch (error) {
    process.stderr.write(`impact: ${error.message}\n`);
    process.exit(2);
    return;
  }

  let result;
  let context;
  if (changed) {
    const base = positional[0] ?? "HEAD";
    let files;
    try {
      files = gitChangedFiles(base);
    } catch (error) {
      process.stderr.write(`impact: ${error.message}\n`);
      process.exit(2);
      return;
    }
    const mapped = filesToPackages(files, dirs);
    result = analyzeImpact(manifest, dirs, mapped.packages);
    result.changedFiles = files;
    result.unmappedFiles = mapped.unmapped;
    context = `changed files vs \`${base}\` (${files.length})`;
  } else {
    const target = positional[0];
    let seeds;
    if (target.startsWith("@vdp/")) {
      if (!(target in (manifest.packages ?? {}))) {
        process.stderr.write(
          `impact: "${target}" is not placed in architecture/architecture.yaml\n`,
        );
        process.exit(2);
        return;
      }
      seeds = [target];
    } else {
      const rel = relative(ROOT, resolve(ROOT, target)).split(sep).join("/");
      if (rel.startsWith("..")) {
        process.stderr.write(`impact: "${target}" is outside the repository\n`);
        process.exit(2);
        return;
      }
      const mapped = filesToPackages([rel], dirs);
      if (mapped.packages.length === 0) {
        process.stderr.write(`impact: no workspace package contains "${rel}"\n`);
        process.exit(2);
        return;
      }
      seeds = mapped.packages;
    }
    result = analyzeImpact(manifest, dirs, seeds);
    context = seeds.join(", ");
  }

  if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(renderMarkdown(result, context));
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(HERE, "impact.mjs")) {
  main();
}
