#!/usr/bin/env node
/**
 * The architecture/dependency rule as a tool (AGENTS 28; master backlog P0 #2,
 * item #22).
 *
 * The rule itself lives in exactly one place: `architecture/architecture.yaml`
 * at the repository root. This tool reads it, builds the real import graph of
 * every workspace package and fails with a non-zero exit code on any edge the
 * rules do not allow — *before* a test run has to explain it. The architecture
 * test suite calls this tool (with `--json`) instead of restating the graph,
 * so a rule change cannot land in one place and be missing in the other.
 *
 * The file is named `.yaml` but written in JSON syntax (valid YAML 1.2):
 * `JSON.parse` reads it without a runtime dependency (ADR 0002), and any YAML
 * reader can read it too. Beyond the dependency rule it also carries the layer
 * assignment of every package and the AI context `topics`
 * (`tools/architecture/ai-context.mjs` generates `.ai/generated/<topic>`
 * bundles from them) — one manifest, one source (ADR 0043).
 *
 * Why not dependency-cruiser: it would be a second rule vocabulary for a rule
 * that is already written down, and its configuration would restate the allow
 * list — the same duplication this tool exists to remove (ADR 0031). The scan
 * below is deliberately small enough to be read in one sitting.
 *
 * Usage:
 *   node tools/architecture/check-dependencies.mjs [--root <dir>] [--rules <file>] [--json]
 *
 * Exit codes: 0 = the graph satisfies every rule, 1 = violations, 2 = usage or
 * rules-file error (so a broken rules file is never mistaken for a clean tree).
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(HERE, "../..");
const DEFAULT_RULES = join(DEFAULT_ROOT, "architecture", "architecture.yaml");

/** Workspace roots, mirroring the `workspaces` field of the root manifest. */
const WORKSPACE_ROOTS = [
  { root: "packages", depth: 1 },
  { root: "packages", depth: 2 },
  { root: "tools", depth: 1 },
  { root: "apps", depth: 1 },
];

const STATIC_IMPORT = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;
const REQUIRE_IMPORT = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function fail(message) {
  process.stderr.write(`check-dependencies: ${message}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const options = { root: DEFAULT_ROOT, rules: DEFAULT_RULES, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") options.json = true;
    else if (arg === "--root") options.root = resolve(argv[++i] ?? fail("--root needs a path"));
    else if (arg === "--rules") options.rules = resolve(argv[++i] ?? fail("--rules needs a path"));
    else fail(`unknown argument ${arg}`);
  }
  return options;
}

/** Every directory below `root` that holds a package.json, in workspace layout. */
function discoverWorkspaceDirs(root) {
  const found = new Set();
  for (const { root: base, depth } of WORKSPACE_ROOTS) {
    const start = join(root, base);
    if (!existsSync(start)) continue;
    const collect = (dir, level) => {
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
    collect(start, 0);
  }
  return Array.from(found).sort();
}

function listTsFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listTsFiles(full));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".spec.ts")) files.push(full);
  }
  return files;
}

/** `@vdp/definitions/generic` → `@vdp/definitions`. */
function baseName(specifier) {
  if (!specifier.startsWith("@")) return specifier;
  const [scope, name] = specifier.split("/");
  return `${scope}/${name}`;
}

function scanPackage(dir) {
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const node = { name: manifest.name, dir, imports: new Set(), nodeBuiltins: new Set(), files: 0 };
  if (!node.name) return node;
  const src = join(dir, "src");
  if (!existsSync(src) || !statSync(src).isDirectory()) return node;
  for (const file of listTsFiles(src)) {
    node.files += 1;
    const source = readFileSync(file, "utf8");
    for (const pattern of [STATIC_IMPORT, REQUIRE_IMPORT]) {
      pattern.lastIndex = 0;
      for (const match of source.matchAll(pattern)) {
        const specifier = match[1];
        if (specifier.startsWith("@vdp/")) node.imports.add(baseName(specifier));
        else if (specifier.startsWith("node:")) node.nodeBuiltins.add(specifier.slice(5));
      }
    }
  }
  return node;
}

function prefixMatches(name, prefix) {
  return name === prefix || name.startsWith(`${prefix}-`);
}

/** Unknown keys are errors: a typo in a rule must not look like a passing rule. */
function checkSchema(rules) {
  const problems = [];
  const allowedTop = ["schemaVersion", "description", "layers", "packages", "rules", "topics"];
  for (const key of Object.keys(rules)) {
    if (!allowedTop.includes(key)) problems.push(`unknown top-level key "${key}"`);
  }
  // `layers` is the manifest's layer vocabulary. When it is present the file
  // is the full manifest: every package carries a `layer` from it. When it is
  // absent (a minimal rules file, e.g. a fixture) the `layer` key is simply
  // unknown — the edge rule stays the only rule.
  const hasLayers = Object.keys(rules.layers ?? {}).length > 0;
  if (rules.layers !== undefined && !hasLayers)
    problems.push('"layers" must name at least one layer');
  const allowedRuleKeys = ["nodeBuiltins", "ui", "layerRules", "portableLayers"];
  for (const key of Object.keys(rules.rules ?? {})) {
    if (!allowedRuleKeys.includes(key)) problems.push(`unknown key in rules: "${key}"`);
  }
  for (const [name, entry] of Object.entries(rules.packages ?? {})) {
    const allowedKeys = hasLayers ? ["layer", "mayImport", "why"] : ["mayImport", "why"];
    for (const key of Object.keys(entry)) {
      if (!allowedKeys.includes(key)) problems.push(`unknown key in packages.${name}: "${key}"`);
    }
    if (!entry.why) problems.push(`packages.${name} has no "why"`);
    if (hasLayers && (!entry.layer || !Object.keys(rules.layers).includes(entry.layer)))
      problems.push(
        `packages.${name} has no valid "layer" (known layers: ${Object.keys(rules.layers).join(", ")})`,
      );
  }
  for (const [topicName, topic] of Object.entries(rules.topics ?? {})) {
    for (const key of Object.keys(topic ?? {})) {
      if (!["title", "summary", "packages", "adrs", "docs", "flows", "examples"].includes(key))
        problems.push(`unknown key in topics.${topicName}: "${key}"`);
    }
    if (!topic?.title || !topic?.summary)
      problems.push(`topics.${topicName} needs a "title" and a "summary"`);
    for (const pkg of topic?.packages ?? []) {
      if (!(pkg in (rules.packages ?? {})))
        problems.push(`topics.${topicName}.packages names unknown package "${pkg}"`);
    }
    for (const adr of topic?.adrs ?? []) {
      if (!/^\d{4}$/.test(adr))
        problems.push(`topics.${topicName}.adrs entry "${adr}" is not an ADR number`);
    }
  }
  for (const rule of rules.rules?.layerRules ?? []) {
    for (const key of Object.keys(rule)) {
      if (!["from", "forbidden", "why"].includes(key))
        problems.push(`unknown key in layerRules entry "${rule.from}": "${key}"`);
    }
  }
  for (const rule of rules.rules?.portableLayers ?? []) {
    for (const key of Object.keys(rule)) {
      if (!["packages", "forbidden", "why"].includes(key))
        problems.push(`unknown key in portableLayers entry: "${key}"`);
    }
  }
  return problems;
}

function evaluate(rules, packages, root) {
  const violations = [];
  const known = new Set(packages.map((pkg) => pkg.name));
  const declared = new Set(Object.keys(rules.packages));

  for (const pkg of packages) {
    if (!declared.has(pkg.name)) {
      violations.push({
        rule: "unplaced-package",
        message: `${pkg.name} is not placed in the architecture graph — add it to architecture/architecture.yaml`,
      });
    }
  }
  for (const name of declared) {
    if (!known.has(name)) {
      violations.push({
        rule: "stale-package",
        message: `architecture.yaml declares ${name}, but no such workspace package exists`,
      });
    }
  }

  for (const pkg of packages) {
    const allowed = new Set(rules.packages[pkg.name]?.mayImport ?? []);
    for (const dep of pkg.imports) {
      if (dep === pkg.name) continue;
      if (!allowed.has(dep)) {
        violations.push({
          rule: "forbidden-edge",
          message: `${pkg.name} → ${dep} (${relative(root, pkg.dir)})`,
        });
      }
    }
  }

  const uiPackage = rules.rules?.ui?.package;
  if (uiPackage) {
    for (const pkg of packages) {
      if (pkg.name !== uiPackage && pkg.imports.has(uiPackage)) {
        violations.push({
          rule: "ui-import",
          message: `${pkg.name} → ${uiPackage} (packages never import the UI)`,
        });
      }
    }
  }

  const builtinsAllowed = new Set(rules.rules?.nodeBuiltins?.allowedIn ?? []);
  for (const pkg of packages) {
    if (builtinsAllowed.has(pkg.name)) continue;
    for (const builtin of pkg.nodeBuiltins) {
      violations.push({
        rule: "node-builtin",
        message: `${pkg.name} imports node:${builtin}, but is a portable layer`,
      });
    }
  }

  for (const rule of rules.rules?.layerRules ?? []) {
    for (const pkg of packages) {
      if (!prefixMatches(pkg.name, rule.from)) continue;
      for (const dep of pkg.imports) {
        if (rule.forbidden.some((prefix) => prefixMatches(dep, prefix))) {
          violations.push({
            rule: "layer-rule",
            message: `${pkg.name} → ${dep} (${rule.why})`,
          });
        }
      }
    }
  }

  for (const rule of rules.rules?.portableLayers ?? []) {
    const subject = new Set(rule.packages);
    for (const pkg of packages) {
      if (!subject.has(pkg.name)) continue;
      for (const dep of pkg.imports) {
        if (rule.forbidden.some((prefix) => prefixMatches(dep, prefix))) {
          violations.push({
            rule: "portable-layer",
            message: `${pkg.name} → ${dep} (${rule.why})`,
          });
        }
      }
    }
  }

  // A prefix rule that matches no package cannot ever fire — a rule that cannot
  // fail is not a rule. This is the check the hand-written test was missing:
  // its "@vdp/adapters" prefix matched none of the "@vdp/adapter-*" packages.
  const names = packages.map((pkg) => pkg.name);
  const prefixes = [
    ...(rules.rules?.layerRules ?? []).flatMap((rule) => [
      { prefix: rule.from, where: `layerRules "${rule.from}".from` },
      ...rule.forbidden.map((prefix) => ({ prefix, where: `layerRules "${rule.from}".forbidden` })),
    ]),
    ...(rules.rules?.portableLayers ?? []).flatMap((rule) =>
      rule.forbidden.map((prefix) => ({ prefix, where: "portableLayers.forbidden" })),
    ),
  ];
  for (const { prefix, where } of prefixes) {
    if (!names.some((name) => prefixMatches(name, prefix))) {
      violations.push({
        rule: "blind-prefix",
        message: `${where}: "${prefix}" matches no workspace package — the rule can never fire`,
      });
    }
  }
  return violations;
}

function humanReport(rules, packages, violations) {
  const edges = packages.reduce((sum, pkg) => sum + pkg.imports.size, 0);
  const lines = [
    `dependency rule: ${Object.keys(rules.packages).length} packages placed, ${edges} edges, ` +
      `${(rules.rules?.layerRules?.length ?? 0) + (rules.rules?.portableLayers?.length ?? 0) + 2} rules`,
  ];
  if (violations.length === 0) {
    lines.push("no violations.");
    return lines.join("\n");
  }
  lines.push(`${violations.length} violation(s):`);
  for (const violation of violations) lines.push(`  ✗ [${violation.rule}] ${violation.message}`);
  return lines.join("\n");
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!existsSync(options.rules)) fail(`rules file not found: ${options.rules}`);
  let rules;
  try {
    rules = JSON.parse(readFileSync(options.rules, "utf8"));
  } catch (error) {
    fail(`rules file is not valid JSON: ${error.message}`);
  }
  const schemaProblems = checkSchema(rules);
  if (schemaProblems.length > 0) fail(`rules file is malformed: ${schemaProblems.join("; ")}`);

  const packages = discoverWorkspaceDirs(options.root)
    .map(scanPackage)
    .filter((pkg) => pkg.name)
    .sort((a, b) => a.name.localeCompare(b.name));
  const violations = evaluate(rules, packages, options.root);

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          root: options.root,
          packages: packages.map((pkg) => ({
            name: pkg.name,
            dir: relative(options.root, pkg.dir).split("\\").join("/"),
            imports: Array.from(pkg.imports).sort(),
            nodeBuiltins: Array.from(pkg.nodeBuiltins).sort(),
          })),
          violations,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    process.stdout.write(`${humanReport(rules, packages, violations)}\n`);
  }
  process.exit(violations.length === 0 ? 0 : 1);
}

main();
