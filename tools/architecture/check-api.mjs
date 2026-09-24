#!/usr/bin/env node
/**
 * The public API of a contract package, frozen and measured (ADR 0059).
 *
 * `check-dependencies.mjs` answers *may* a package import another one, and
 * `check-package-manifests.mjs` answers whether the manifest knows about it. Both
 * describe the graph. Neither answers the question an open-core boundary lives or dies
 * by: **did the surface change that somebody else compiles against?**
 *
 * The architecture carries a `contracts` section for exactly that. A contract package
 * (or, with `entry`, one module of a package) is the surface a *separate* repository may
 * build against — the closed modules, a third-party adapter, a customer integration.
 * "Surface" is the package's `types` entry **and** the `types` of every subpath in its
 * `exports` map: a consumer that imports `@vdp/definitions/vag` compiles against that
 * file, and a walk that starts at one entry would measure it only by luck.
 * This tool walks the emitted declarations of that surface, hashes them comment-free and
 * whitespace-normalised, and compares the result with the record in
 * `architecture/public-api.json`.
 *
 * Why the emitted `.d.ts` and not the sources: the promise is made to a *consumer* of the
 * built package (`dist` + `.d.ts`, which is also what a published package would contain).
 * A source comment must not move the fingerprint — a signature must (the comment and
 * unrelated whitespace are stripped before hashing for that reason). The walk follows
 * `from "…"` specifiers transitively, so a change to a type the contract *references*
 * shows up too: that is the change that breaks a pinned consumer and would otherwise be
 * invisible.
 *
 * What a drift means is a *decision*, not a failure: bump the version and run
 * `--update`, or take the change back. The gate exists so that the change cannot happen
 * by accident — the diff in `architecture/public-api.json` is the review prompt, and
 * `--update` prints what it rewrote instead of being silent.
 *
 * Usage:
 *   node tools/architecture/check-api.mjs [--root <dir>] [--manifest <file>] [--json]
 *   node tools/architecture/check-api.mjs --update      (npm run check:api -- --update)
 *
 * Exit codes: 0 = the recorded surface is the built surface, 1 = drift or a violated
 * rule, 2 = the tool could not evaluate (no contract declared, no build, no record, a
 * broken config) — so "not measured" is never mistaken for "measured and clean".
 *
 * The workspace enumeration is `impact.mjs`'s — this tool must not own a second copy of
 * what "a workspace package" is (ADR 0043/0045, the same reason `ai-context.mjs` imports
 * it).
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadManifest, packageDirs } from "./impact.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(HERE, "../..");
const RECORD_NAME = "vdp.public-api";
/** Format 2: a surface is a *set* of type entries (subpath exports are part of it). */
const RECORD_VERSION = 2;

/** A contract's default entry: the package's own claim about its public entry. */
const DEFAULT_ENTRY = "dist/src/index.d.ts";

function fail(message) {
  process.stderr.write(`check-api: ${message}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const options = { root: DEFAULT_ROOT, manifest: undefined, json: false, update: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") options.json = true;
    else if (arg === "--update") options.update = true;
    else if (arg === "--root") options.root = resolve(argv[++i] ?? fail("--root needs a path"));
    else if (arg === "--manifest")
      options.manifest = resolve(argv[++i] ?? fail("--manifest needs a path"));
    else fail(`unknown argument ${arg}`);
  }
  options.manifest ??= join(options.root, "architecture", "public-api.json");
  return options;
}

function readJson(file, what) {
  if (!existsSync(file)) fail(`${what} not found: ${file}`);
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    fail(`${what} is not valid JSON: ${error.message}`);
  }
}

/**
 * The comment-free, whitespace-normalised form of a declaration file.
 *
 * Two reasons, and both are about the gate telling the truth: a doc comment is not part
 * of what a consumer compiles against (hashing it would cry wolf on every wording fix),
 * and a declaration split over three lines is the same declaration as one written on a
 * single line. `///` triple-slash directives stay — they are load-bearing (they pull in
 * `@types`) and stripping them would hide a real dependency.
 */
function normalizeDeclaration(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^[ \t]*\/\/(?![/]).*$/gm, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The type entry points a consumer may compile against: the package's own `types` field
 * plus the `types` of every subpath in its `exports` map.
 *
 * Why not just `types`: a subpath export *is* part of the published promise. A consumer
 * writes `import type { VagPackage } from "@vdp/definitions/vag"` and compiles against
 * that file — a single-entry walk would only measure it by luck. It happens to be luck
 * today (`@vdp/definitions` re-exports its subpaths from `index.d.ts`); the day a subpath
 * exists *only* as an entry, this walk has to see it on purpose (measured: `definitions`
 * declares five type entries, and the record lists all five).
 */
function entriesOf(manifest) {
  const entries = new Set();
  if (typeof manifest.types === "string") entries.add(manifest.types);
  for (const value of Object.values(manifest.exports ?? {})) {
    if (value === null || typeof value !== "object") continue;
    if (typeof value.types === "string") entries.add(value.types);
  }
  return [...entries].map((entry) => entry.replace(/^\.\//, "")).sort();
}

/**
 * The surface a consumer of `entries` compiles against: every declaration file reachable
 * through `from "…"` specifiers, plus the bare specifiers the surface names.
 */
function computeSurface(packageDir, entries) {
  const files = new Map();
  const external = new Set();
  const queue = [];
  for (const entry of entries) {
    const start = join(packageDir, entry);
    if (!existsSync(start)) {
      fail(
        `${relative(DEFAULT_ROOT, packageDir)}: ${entry} does not exist — a contract that is ` +
          "not built is not measured; run `npm run build` first",
      );
    }
    queue.push(start);
  }
  while (queue.length > 0) {
    const file = queue.pop();
    if (files.has(file)) continue;
    // Specifiers are read from the *normalised* text, not the file: a doc comment that
    // says `from "we never reached it"` is prose, and a scanner that reads prose invents
    // a dependency on a package with that name (measured — the first run of this tool
    // reported exactly that for `@vdp/diagnostic-ir`).
    const normalized = normalizeDeclaration(readFileSync(file, "utf8"));
    files.set(file, createHash("sha256").update(normalized).digest("hex"));
    for (const match of normalized.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) {
      const specifier = match[1];
      if (specifier.startsWith(".")) {
        // `./dtc.js` in a declaration is `./dtc.d.ts` on disk.
        queue.push(join(dirname(file), specifier.replace(/\.js$/, ".d.ts")));
      } else {
        // `@vdp/domain/x` and `node:fs` both name the seam this surface leans on.
        const parts = specifier.split("/");
        external.add(specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]);
      }
    }
  }
  const relativeFiles = {};
  for (const file of [...files.keys()].sort()) {
    relativeFiles[relative(packageDir, file).split("\\").join("/")] = files.get(file);
  }
  return { entries, files: relativeFiles, external: [...external].sort() };
}

function surfaceOf(packageDir, manifest, contract) {
  // An explicit `entry` in the YAML means "measure *this* module and nothing else" — the
  // package may export more, and the contract is deliberately the smaller thing (ADR 0059).
  const entries =
    contract.entry === undefined ? entriesOf(manifest) : [contract.entry.replace(/^\.\//, "")];
  return computeSurface(packageDir, entries.length > 0 ? entries : [DEFAULT_ENTRY]);
}

/** One line per changed file — a drift report that names the file, not just a count. */
function describeDrift(recorded, computed) {
  const notes = [];
  const recordedFiles = recorded.files ?? {};
  const computedFiles = computed.files;
  for (const file of Object.keys(computedFiles)) {
    if (recordedFiles[file] === undefined) notes.push(`+ ${file}`);
    else if (recordedFiles[file] !== computedFiles[file]) notes.push(`~ ${file}`);
  }
  for (const file of Object.keys(recordedFiles)) {
    if (computedFiles[file] === undefined) notes.push(`- ${file}`);
  }
  const before = (recorded.external ?? []).join(", ") || "(none)";
  const after = computed.external.join(", ") || "(none)";
  if (before !== after) notes.push(`external: ${before} → ${after}`);
  const beforeEntries = (recorded.entries ?? []).join(", ");
  const afterEntries = computed.entries.join(", ");
  if (beforeEntries !== afterEntries) {
    notes.push(`entries: ${beforeEntries} → ${afterEntries}`);
  }
  return notes;
}

function evaluate(root, manifest, options) {
  const violations = [];
  const contracts = manifest.contracts ?? {};
  const names = Object.keys(contracts);
  if (names.length === 0) {
    fail(
      "no contracts declared — an empty contract list would be a gate that can never " +
        "fire; name the surfaces a separate repository may build against (ADR 0059)",
    );
  }
  const dirs = packageDirs(root);
  const computedPackages = {};
  const checks = [];

  for (const name of names.sort()) {
    const contract = contracts[name] ?? {};
    const dir = dirs.get(name);
    if (dir === undefined) {
      violations.push({
        rule: "undeclared-contract-package",
        package: name,
        message: `architecture.yaml declares ${name} as a contract, but no workspace package has that name`,
      });
      continue;
    }
    const packageDir = join(root, dir);
    const packageManifest = readJson(join(packageDir, "package.json"), `${name} package.json`);
    const surface = surfaceOf(packageDir, packageManifest, contract);
    if (Object.keys(surface.files).length === 0) {
      violations.push({
        rule: "empty-contract",
        package: name,
        message: `${name}: the surface is empty — a contract nothing is measured over`,
      });
      continue;
    }
    computedPackages[name] = { version: packageManifest.version, ...surface };
    checks.push({ name, surface, version: packageManifest.version });
  }

  const record = existsSync(options.manifest)
    ? readJson(options.manifest, "the public API record")
    : undefined;
  if (record !== undefined) {
    if (record.format !== RECORD_NAME) {
      fail(`the record must declare format "${RECORD_NAME}", found "${record.format}"`);
    }
    // A record from an older tool version describes a *different* measurement (format 1
    // held one entry per contract). Comparing the two would report drift that no build
    // caused, and `--update` is the honest answer to it — so the check refuses with a
    // reason instead of inventing findings.
    if (record.version !== RECORD_VERSION && !options.update) {
      fail(
        `the record at ${relative(root, options.manifest)} is format version ${record.version}, ` +
          `this tool writes ${RECORD_VERSION} — run --update and commit the new record`,
      );
    }
    const recorded = record.packages ?? {};
    for (const { name, surface, version } of checks) {
      const entry = recorded[name];
      if (entry === undefined) {
        violations.push({
          rule: "unrecorded-contract",
          package: name,
          message: `${name} is a declared contract with no record in ${relative(root, options.manifest)} — run --update and commit the record`,
        });
        continue;
      }
      const drift = describeDrift(entry, surface);
      if (drift.length > 0) {
        violations.push({
          rule: "contract-drift",
          package: name,
          message:
            `${name}: the built surface differs from the record — a change of the contract ` +
            `is a decision (version, migration note, ADR), not an accident:\n      ${drift.join("\n      ")}`,
        });
      }
      if (entry.version !== version) {
        violations.push({
          rule: "version-drift",
          package: name,
          message: `${name}: the record says version ${entry.version}, the package is ${version} — --update refreshes the record`,
        });
      }
    }
    for (const name of Object.keys(recorded).sort()) {
      if (name in computedPackages) continue;
      violations.push({
        rule: "stale-api-entry",
        package: name,
        message: `${relative(root, options.manifest)} records ${name}, but it is no longer a declared contract — drop the entry`,
      });
    }
  } else if (!options.update) {
    fail(
      `no record at ${relative(root, options.manifest)} — the record is the promise; ` +
        "create it with --update and commit it",
    );
  }

  return { violations, computedPackages, checks };
}

function writeRecord(file, computedPackages) {
  const packages = {};
  for (const name of Object.keys(computedPackages).sort()) {
    const { version, entries, files, external } = computedPackages[name];
    packages[name] = { version, entries, files, external };
  }
  const record = { format: RECORD_NAME, version: RECORD_VERSION, packages };
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
}

function humanReport(checks, violations) {
  const files = checks.reduce((sum, check) => sum + Object.keys(check.surface.files).length, 0);
  const external = new Set(checks.flatMap((check) => check.surface.external));
  const headline =
    `public API rule: ${checks.length} contracts, ${files} surface files, ` +
    `${external.size} external type source(s)`;
  if (violations.length === 0) return `${headline} — the record is the build.`;
  const lines = [`${headline}`];
  for (const violation of violations) {
    lines.push(`  ✗ [${violation.rule}] ${violation.message}`);
  }
  return lines.join("\n");
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!existsSync(options.root)) fail(`no workspace at ${options.root}`);
  let manifest;
  try {
    manifest = loadManifest(options.root);
  } catch (error) {
    fail(error.message);
  }
  const { violations, computedPackages, checks } = evaluate(options.root, manifest, options);

  /**
   * The violations `--update` is allowed to answer: they *are* the record being out of
   * date. Everything else is a defect in the configuration, and a record written over one
   * would hide it — so the update refuses instead of blessing it.
   */
  const DRIFT_RULES = new Set([
    "contract-drift",
    "version-drift",
    "unrecorded-contract",
    "stale-api-entry",
  ]);

  if (options.update) {
    const blocking = violations.filter((violation) => !DRIFT_RULES.has(violation.rule));
    if (blocking.length > 0) {
      process.stdout.write(`${humanReport(checks, blocking)}\n`);
      process.stderr.write("check-api: nothing was written — fix the configuration first\n");
      process.exit(1);
    }
    const before = existsSync(options.manifest)
      ? readJson(options.manifest, "the public API record")
      : undefined;
    const changed = checks
      .filter((check) => {
        const entry = before?.packages?.[check.name];
        if (entry === undefined) return true;
        return (
          describeDrift(entry, check.surface).length > 0 ||
          entry.version !== check.version ||
          JSON.stringify(Object.keys(entry.files ?? {})) !==
            JSON.stringify(Object.keys(check.surface.files))
        );
      })
      .map((check) => check.name);
    writeRecord(options.manifest, computedPackages);
    const wrote =
      `check-api: record written to ${relative(options.root, options.manifest)} — ` +
      `${Object.keys(computedPackages).length} contract(s)`;
    process.stdout.write(
      changed.length === 0
        ? `${wrote}, unchanged.\n`
        : `${wrote}, changed: ${changed.join(", ")}\n`,
    );
    process.exit(0);
  }

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          root: options.root,
          contracts: checks.map((check) => ({
            name: check.name,
            version: check.version,
            entries: check.surface.entries,
            files: Object.keys(check.surface.files).length,
            external: check.surface.external,
          })),
          violations,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    process.stdout.write(`${humanReport(checks, violations)}\n`);
  }
  process.exit(violations.length === 0 ? 0 : 1);
}

main();
