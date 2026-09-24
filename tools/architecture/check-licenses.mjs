#!/usr/bin/env node
/**
 * Third-party licences, checked instead of assumed (ADR 0060).
 *
 * ADR 0002 keeps `dependencies` empty in every workspace package, and AGENTS 34.20
 * demands a licence check for anything that is allowed in anyway. Both statements were
 * true and both were *narrated* — until now no gate read them. This tool reads them:
 * it walks `package-lock.json`, evaluates every SPDX expression it finds against the
 * policy in `architecture.yaml`, and fails on a licence the project has not decided to
 * accept.
 *
 * Two scopes, because "may I use it" is not one question:
 *
 *  - **production** — the closure that could end up in a distributed artefact. It is
 *    empty today (measured, and the report says so), and it must stay permissive: weak
 *    copyleft is a licence question the moment something ships, and the open core is
 *    published.
 *  - **development** — build- and test-time only. File-level copyleft (MPL-2.0 — the
 *    `lightningcss` platform binaries under `vite`) is a deliberate, recorded decision
 *    here rather than a surprise, because nothing of it is redistributed.
 *
 * The expression is *parsed*, not string-matched: `(MIT OR CC0-1.0)` is allowed (a
 * consumer may pick MIT) while `MIT AND GPL-3.0-only` is not (both obligations apply),
 * and `GPL-2.0-only WITH Classpath-exception-2.0` keeps its copyleft — an exception
 * clause does not soften the policy this file enforces. A licence nobody has decided
 * about is a violation, never a pass: the point of the gate is that the *next* package
 * is a decision, not that the current tree is quiet.
 *
 * Usage:
 *   node tools/architecture/check-licenses.mjs [--root <dir>] [--json]
 *
 * Exit codes: 0 = every scanned package is inside the policy, 1 = a violation, 2 = the
 * tool could not evaluate (no lockfile, no policy, nothing to scan) — "not measured" is
 * never "clean".
 *
 * The architecture source and the workspace enumeration are `impact.mjs`'s (ADR
 * 0043/0045): a second copy of what a workspace package is would be the duplication this
 * repository keeps failing checks for.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadManifest } from "./impact.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(HERE, "../..");

/** `(`, `)`, the three operators, or a licence id — nothing else is part of an SPDX expression. */
const TOKEN = /\(|\)|\bAND\b|\bOR\b|\bWITH\b|[^\s()]+/gi;

function fail(message) {
  process.stderr.write(`check-licenses: ${message}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const options = { root: DEFAULT_ROOT, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") options.json = true;
    else if (arg === "--root") options.root = resolve(argv[++i] ?? fail("--root needs a path"));
    else fail(`unknown argument ${arg}`);
  }
  return options;
}

/* ------------------------------------------------------------------ SPDX expression */

/**
 * A minimal recursive-descent parser for the `AND`/`OR`/`WITH` subset that npm writes
 * into a lockfile. `WITH` keeps its base licence on purpose (see the header).
 */
function parseExpression(expression) {
  const tokens = expression.match(TOKEN) ?? [];
  let at = 0;
  const peek = () => (at < tokens.length ? tokens[at].toUpperCase() : undefined);
  const take = () => tokens[at++];

  const primary = () => {
    if (peek() === "(") {
      take();
      const node = parseOr();
      if (peek() !== ")") throw new Error("unbalanced parenthesis");
      take();
      return node;
    }
    const id = take();
    if (id === undefined) throw new Error("unexpected end of expression");
    // `WITH`: the base licence is what binds us; the exception is recorded, not trusted.
    if (peek() === "WITH") {
      take();
      take();
    }
    return { kind: "id", id };
  };
  const parseAnd = () => {
    const operands = [primary()];
    while (peek() === "AND") {
      take();
      operands.push(primary());
    }
    return operands.length === 1 ? operands[0] : { kind: "and", operands };
  };
  function parseOr() {
    const operands = [parseAnd()];
    while (peek() === "OR") {
      take();
      operands.push(parseAnd());
    }
    return operands.length === 1 ? operands[0] : { kind: "or", operands };
  }
  const tree = parseOr();
  if (at !== tokens.length) throw new Error(`unexpected token "${tokens[at]}"`);
  return tree;
}

/** Licence ids a package manager writes that are not SPDX at all. */
const NOT_A_LICENCE = new Set(["UNLICENSED", "SEE", "LICENSE", "NONE", "UNKNOWN"]);

function classify(id, policy) {
  if (NOT_A_LICENCE.has(id.toUpperCase())) return "unknown";
  const lower = id.toLowerCase();
  for (const forbidden of policy.forbidden ?? []) {
    if (lower === forbidden.toLowerCase() || lower.startsWith(`${forbidden.toLowerCase()}-`)) {
      return "forbidden";
    }
  }
  for (const allowed of policy.allowed ?? []) {
    if (lower === allowed.toLowerCase() || lower.startsWith(`${allowed.toLowerCase()}-`)) {
      return "allowed";
    }
  }
  return "unknown";
}

/** Evaluate a parsed expression; returns the verdict plus the id that decided it. */
function evaluateExpression(node, policy) {
  if (node.kind === "id") return { verdict: classify(node.id, policy), id: node.id };
  const results = node.operands.map((operand) => evaluateExpression(operand, policy));
  if (node.kind === "and") {
    // Every obligation applies: one unacceptable operand decides the whole expression.
    const bad = results.find((result) => result.verdict !== "allowed");
    return bad ?? { verdict: "allowed", id: results[0].id };
  }
  // `OR`: the consumer may choose — one acceptable alternative is enough.
  const good = results.find((result) => result.verdict === "allowed");
  if (good !== undefined) return good;
  const forbidden = results.find((result) => result.verdict === "forbidden");
  return forbidden ?? results[0];
}

/** The raw licence text of one lockfile entry, if it has one. */
function licenceOf(entry) {
  const value = entry.license ?? entry.licenses;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === "string" ? item : (item?.type ?? "")))
      .filter((item) => item !== "")
      .join(" OR ");
  }
  if (value !== null && typeof value === "object") return value.type ?? undefined;
  return undefined;
}

/* ------------------------------------------------------------------ the rule */

function evaluate(root, manifest) {
  const lockPath = join(root, "package-lock.json");
  if (!existsSync(lockPath)) fail(`no lockfile at ${relative(root, lockPath)}`);
  let lock;
  try {
    lock = JSON.parse(readFileSync(lockPath, "utf8"));
  } catch (error) {
    fail(`the lockfile is not valid JSON: ${error.message}`);
  }
  const entries = lock.packages ?? {};
  if (Object.keys(entries).length === 0) {
    fail("the lockfile carries no `packages` map — nothing would be scanned");
  }

  const policy = manifest.licenses;
  if (policy === undefined || policy.production === undefined || policy.development === undefined) {
    fail(
      "architecture.yaml has no licence policy — an empty policy would accept everything; " +
        "declare `licenses.production` and `licenses.development` (ADR 0060)",
    );
  }
  for (const scope of ["production", "development"]) {
    const entry = policy[scope];
    if (!Array.isArray(entry.allowed) || entry.allowed.length === 0) {
      fail(`licenses.${scope}.allowed is empty — the list of what is acceptable is the rule`);
    }
    if (!entry.why || String(entry.why).trim() === "") {
      fail(`licenses.${scope} carries no "why" — a policy without a reason cannot be reviewed`);
    }
  }

  const exceptions = policy.exceptions ?? [];
  const violations = [];
  const used = new Set();
  const scanned = [];
  const scopeCounts = { production: 0, development: 0 };

  for (const name of Object.keys(entries).sort()) {
    const entry = entries[name];
    // Third-party means: installed under `node_modules/` and not a link to our own
    // workspace. Everything else in a v3 lockfile is this repository (`""` is the root
    // manifest, `packages/…` are the workspace directories) — and *their* licence is
    // already owned by `manifests.test.ts` ("every package declares the license the root
    // declares"). A second opinion here would be a second rule.
    if (entry.link === true || !name.startsWith("node_modules/")) continue;
    const packageName = name.split("node_modules/").pop();
    const scope = entry.dev === true || entry.devOptional === true ? "development" : "production";
    scopeCounts[scope] += 1;
    const licence = licenceOf(entry);
    const where = `node_modules/${packageName}`;

    if (licence === undefined || licence.trim() === "") {
      violations.push({
        rule: "unknown-license",
        package: packageName,
        scope,
        message: `${where} declares no licence — nobody can decide to use it (AGENTS 34.20)`,
      });
      continue;
    }

    let verdict;
    try {
      verdict = evaluateExpression(parseExpression(licence), policy[scope]);
    } catch (error) {
      violations.push({
        rule: "unknown-license",
        package: packageName,
        scope,
        message: `${where}: "${licence}" is not a SPDX expression this tool can read (${error.message})`,
      });
      continue;
    }
    scanned.push({ package: packageName, scope, license: licence, verdict: verdict.verdict });

    if (verdict.verdict === "allowed") continue;
    const exception = exceptions.find(
      (candidate) =>
        candidate.package === packageName ||
        candidate.package === `${packageName}@${entry.version}`,
    );
    // An exception only counts when it is dated. `check-dependencies.mjs` requires the
    // date in the schema, but this tool is also run against fixtures and should fail
    // closed even then: an exception without an end does not excuse anything, so the
    // licence violation below stands (ADR 0060 — "an exception without an end is a
    // policy", and a policy is what the allowed list is for).
    const until = typeof exception?.until === "string" ? exception.until : undefined;
    if (until !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(until)) {
      used.add(exception.package);
      if (until < new Date().toISOString().slice(0, 10)) {
        violations.push({
          rule: "expired-exception",
          package: packageName,
          scope,
          message: `the licence exception for ${packageName} expired on ${until} — decide again (renew it with a reason and a date, or replace the dependency)`,
        });
      }
      continue;
    }

    violations.push({
      rule: verdict.verdict === "forbidden" ? "forbidden-license" : "unknown-license",
      package: packageName,
      scope,
      message:
        `${where} is licensed "${licence}" (decided by ${verdict.id}) and the project has not ` +
        `accepted that in the ${scope} scope — decide it in architecture.yaml (allowed list, or a ` +
        "dated exception with a reason)",
    });
  }

  for (const exception of exceptions) {
    const present = scanned.some(
      (item) =>
        item.package === exception.package || exception.package.startsWith(`${item.package}@`),
    );
    if (!present) {
      violations.push({
        rule: "stale-exception",
        package: exception.package,
        scope: "-",
        message: `architecture.yaml carries a licence exception for ${exception.package}, which is not in the lockfile — drop it`,
      });
      continue;
    }
    if (!used.has(exception.package)) {
      violations.push({
        rule: "unused-exception",
        package: exception.package,
        scope: "-",
        message: `the licence exception for ${exception.package} is no longer needed — the recorded decision must not outlive the finding it excused`,
      });
    }
  }

  return { violations, scanned, scopeCounts };
}

function humanReport(scanned, scopeCounts, violations) {
  const headline =
    `license rule: ${scanned.length} third-party packages ` +
    `(${scopeCounts.production} production, ${scopeCounts.development} development)`;
  if (violations.length === 0) {
    return `${headline}, every licence inside the policy.`;
  }
  const lines = [headline];
  for (const violation of violations) lines.push(`  ✗ [${violation.rule}] ${violation.message}`);
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
  const { violations, scanned, scopeCounts } = evaluate(options.root, manifest);
  if (options.json) {
    process.stdout.write(
      `${JSON.stringify({ root: options.root, scanned, scopeCounts, violations }, null, 2)}\n`,
    );
  } else {
    process.stdout.write(`${humanReport(scanned, scopeCounts, violations)}\n`);
  }
  process.exit(violations.length === 0 ? 0 : 1);
}

main();
