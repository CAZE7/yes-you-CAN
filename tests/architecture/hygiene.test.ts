/**
 * Hygiene gates — the prose rules of this repository as executable tests.
 *
 * `dependencies.test.ts` proves the *shape* of the module graph; this file
 * proves the *discipline inside the modules*. Every rule below was a written
 * rule first (AGENTS 34.25 no silently swallowed errors, 34.21 measurement
 * before claims, ADR 0019 condition waits instead of sleeps, §28 module
 * boundaries) and every one of them was already satisfied when the gate was
 * written — measured 2026-09-12 over 212 TypeScript/JavaScript files:
 * 0 empty `catch`, 0 `any`, 0 `@ts-ignore`, 0 focused/skipped tests,
 * 0 `debugger`, 0 work markers, 0 fixed sleeps in tests.
 *
 * A gate that is green on day one is the point: these zeros were the result of
 * an audit, and nothing but a test keeps them zero. Each allowlist entry names
 * the file *and* the reason it is exempt, so an exemption is a decision on the
 * record rather than an accident — and each one is verified to still exist, so
 * dead allowlist entries fail too.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { MAX_SETTLE_MS } from "../helpers/wait.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Directories that never hold reviewed source. */
const IGNORED_DIRS = new Set(["node_modules", "dist", "coverage", ".git", ".arena", ".cache"]);

interface SourceFile {
  /** Repository-relative path with forward slashes — the stable identifier. */
  rel: string;
  abs: string;
  /** Source with comments removed; string literals are kept. */
  code: string;
  /** Source with comments *and* string contents removed. */
  codeOnly: string;
  /** Untouched source — the only view in which comment markers are visible. */
  raw: string;
  lineCount: number;
  isTest: boolean;
}

function isTestPath(rel: string): boolean {
  return rel.endsWith(".spec.ts") || rel.endsWith(".test.ts") || rel.startsWith("tests/");
}

/**
 * Remove comments, and optionally the contents of string literals.
 *
 * Rules must match code, not prose: a doc comment may legitimately talk about
 * `catch {}` or `any`, and `tests/helpers/pty.ts` embeds a whole generated
 * device script in a template literal. Newlines survive in both views so a
 * violation can still be reported with its line number. Template
 * interpolations (`${…}`) are real code and stay visible.
 */
function scan(source: string, dropStrings: boolean): string {
  type State = "code" | "line" | "block" | "quote" | "template";
  let out = "";
  let state: State = "code";
  let quote = "";
  const templateDepth: number[] = [];
  let braceDepth = 0;

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i] ?? "";
    const next = source[i + 1] ?? "";

    if (state === "line") {
      if (ch === "\n") {
        state = "code";
        out += ch;
      }
      continue;
    }
    if (state === "block") {
      if (ch === "*" && next === "/") {
        state = "code";
        i += 1;
        continue;
      }
      if (ch === "\n") out += ch;
      continue;
    }
    if (state === "quote") {
      if (ch === "\\") {
        // Keep the escaped character in the literal view, drop both otherwise.
        if (!dropStrings) out += ch + next;
        i += 1;
        continue;
      }
      if (ch === quote) state = "code";
      if (!dropStrings) out += ch;
      continue;
    }
    if (state === "template") {
      if (ch === "\\") {
        if (!dropStrings) out += ch + next;
        i += 1;
        continue;
      }
      if (ch === "$" && next === "{") {
        templateDepth.push(braceDepth + 1);
        braceDepth += 1;
        if (!dropStrings) out += ch + next;
        state = "code";
        i += 1;
        continue;
      }
      if (ch === "`") {
        state = "code";
        if (!dropStrings) out += ch;
        continue;
      }
      // Newlines always survive so line numbers stay correct in both views.
      if (ch === "\n" || !dropStrings) out += ch;
      continue;
    }

    // state === "code"
    if (ch === "/" && next === "/") {
      state = "line";
      i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      state = "block";
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      state = "quote";
      quote = ch;
      if (!dropStrings) out += ch;
      continue;
    }
    if (ch === "`") {
      state = "template";
      if (!dropStrings) out += ch;
      continue;
    }
    if (ch === "{") braceDepth += 1;
    if (ch === "}") {
      const open = templateDepth.at(-1);
      if (open !== undefined && braceDepth === open) {
        templateDepth.pop();
        state = "template";
        braceDepth -= 1;
        continue;
      }
      braceDepth -= 1;
    }
    out += ch;
  }
  return out;
}

function lineOf(code: string, index: number): number {
  return code.slice(0, index).split("\n").length;
}

function collectSources(): SourceFile[] {
  const found: SourceFile[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!/\.(ts|js)$/.test(entry.name)) continue;
      const raw = readFileSync(abs, "utf8");
      const rel = relative(root, abs).split(sep).join("/");
      found.push({
        rel,
        abs,
        code: scan(raw, false),
        codeOnly: scan(raw, true),
        raw,
        lineCount: raw.split("\n").length,
        isTest: isTestPath(rel),
      });
    }
  };
  for (const area of ["packages", "apps", "tools", "tests"]) {
    const base = join(root, area);
    if (existsSync(base)) walk(base);
  }
  return found.sort((a, b) => a.rel.localeCompare(b.rel));
}

const sources = collectSources();
const production = sources.filter((file) => !file.isTest);

/** An exemption: the file it applies to and the decision it records. */
interface Exemption {
  file: string;
  reason: string;
}

function findViolations(
  pattern: RegExp,
  appliesTo: (file: SourceFile) => boolean,
  exemptions: readonly Exemption[] = [],
  view: "codeOnly" | "code" | "raw" = "codeOnly",
): string[] {
  const allowed = new Set(exemptions.map((entry) => entry.file));
  const violations: string[] = [];
  for (const file of sources) {
    if (!appliesTo(file) || allowed.has(file.rel)) continue;
    const text = file[view];
    pattern.lastIndex = 0;
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
      violations.push(`${file.rel}:${lineOf(text, match.index)}  ${match[0].trim().slice(0, 60)}`);
    }
  }
  return violations;
}

/** Fail on violations, and fail on exemptions whose file no longer exists. */
function assertGate(
  label: string,
  violations: string[],
  exemptions: readonly Exemption[] = [],
): void {
  assert.deepEqual(violations, [], `${label}:\n${violations.join("\n")}`);
  const stale = exemptions
    .map((entry) => entry.file)
    .filter((file) => !sources.some((source) => source.rel === file));
  assert.deepEqual(
    stale,
    [],
    `${label}: exemptions for files that no longer exist: ${stale.join(", ")}`,
  );
}

test("the gate scans the whole tree (packages, apps, tools, tests)", () => {
  // A gate that silently scans nothing is worse than no gate: if the walker
  // breaks, every rule below turns green for the wrong reason.
  assert.ok(sources.length >= 200, `expected at least 200 source files, scanned ${sources.length}`);
  assert.ok(
    sources.some((file) => file.rel === "packages/shared/src/logger.ts"),
    "the foundation package must be part of the scan",
  );
  assert.ok(
    production.length >= 100,
    `expected at least 100 production files, found ${production.length}`,
  );
});

test("no empty catch blocks (AGENTS 34.25: errors are handled or logged)", () => {
  assertGate(
    "empty catch blocks swallow errors silently",
    findViolations(/catch\s*(?:\([^)]*\))?\s*\{\s*\}/g, () => true),
  );
});

test("no type escapes in production code (no `any`, no @ts-ignore)", () => {
  const escapes = [
    ["`: any`", /:\s*any\b/g],
    ["`as any`", /\bas\s+any\b/g],
    ["`<any>`", /<\s*any\s*>/g],
    ["`@ts-ignore`", /@ts-ignore/g],
    ["`@ts-expect-error`", /@ts-expect-error/g],
  ] as const;
  for (const [label, pattern] of escapes) {
    assertGate(
      `${label} defeats the type system that AGENTS 7 makes the first line of defence`,
      findViolations(pattern, (file) => !file.isTest && file.rel.endsWith(".ts")),
    );
  }
});

test("no focused or skipped tests (a green suite must mean the whole suite)", () => {
  assertGate(
    "focused/skipped tests hide regressions",
    findViolations(
      /\b(?:test|it|describe)\.(?:only|skip|todo)\s*\(|(?<![.\w])(?:xit|xdescribe|fit|fdescribe)\s*\(/g,
      (file) => file.isTest,
    ),
  );
});

test("no debugger statements and no unresolved work markers", () => {
  assertGate(
    "debugger statements must not ship",
    findViolations(/^\s*debugger\s*$/gm, () => true),
  );
  // Markers live in comments, so this is the one rule that reads the raw
  // source. `Vector__XXX` in the DBC examples is not a marker: `\b` keeps it
  // out because the underscore is a word character.
  const selfReference: readonly Exemption[] = [
    {
      file: "tests/architecture/hygiene.test.ts",
      reason: "this gate spells out the marker pattern it forbids",
    },
  ];
  assertGate(
    "work markers must be tracked in AGENTS 0.E, not left in the source",
    findViolations(/\b(?:TODO|FIXME|HACK)\b/g, () => true, selfReference, "raw"),
    selfReference,
  );
});

test("console output only through the declared sinks", () => {
  const sinks: readonly Exemption[] = [
    {
      file: "packages/shared/src/logger.ts",
      reason: "the console sink itself — every other module logs through it",
    },
    {
      file: "packages/charts/src/group.ts",
      reason:
        "@vdp/charts is dependency-free by architecture (§28), so it cannot import the logger; " +
        "the subscriber-error hook reports to console.debug instead of swallowing (AGENTS 34.25)",
    },
    {
      file: "apps/web/public/app.js",
      reason:
        "browser front end — no Node logger available, errors also surface in the status line",
    },
  ];
  assertGate(
    "console.* bypasses the structured logger (AGENTS 22)",
    findViolations(
      /\bconsole\.(?:log|warn|error|info|debug|trace)\s*\(/g,
      (file) => !file.isTest,
      sinks,
    ),
    sinks,
  );
});

test("process.exit only at the entry point that owns exit codes", () => {
  const entries: readonly Exemption[] = [
    {
      file: "apps/web/src/server.ts",
      reason: "CLI entry point — the exit code is its interface (AGENTS 33)",
    },
  ];
  assertGate(
    "process.exit in a library kills the host process",
    findViolations(/\bprocess\.exit\s*\(/g, (file) => !file.isTest, entries),
    entries,
  );
});

test("nondeterminism is injectable (Math.random only as a default)", () => {
  const injectable: readonly Exemption[] = [
    {
      file: "tools/simulators/src/virtual-can.ts",
      reason: "`options.random ?? Math.random` — the caller can inject a seeded generator",
    },
  ];
  assertGate(
    "unreachable-from-tests randomness makes failures irreproducible (AGENTS 31)",
    findViolations(/\bMath\.random\b/g, (file) => !file.isTest, injectable),
    injectable,
  );
});

test("tests wait for conditions, never for a fixed duration (ADR 0019)", () => {
  const waiting: readonly Exemption[] = [
    {
      file: "tests/helpers/wait.ts",
      reason: "the single audited place where test code waits — tick(), waitFor(), settle()",
    },
  ];
  assertGate(
    "fixed sleeps are slow and racy; use tests/helpers/wait.ts",
    findViolations(
      /setTimeout\s*\([^,()]*,\s*[0-9_]+\s*\)|setTimeout\s*\(\s*resolve/g,
      (file) => file.isTest,
      waiting,
    ),
    waiting,
  );

  // settle() is the sanctioned quiet period for negative assertions; its cap
  // is enforced at runtime, and the call sites are checked statically too, so
  // an oversized wait fails in the architecture suite rather than at runtime.
  const oversized: string[] = [];
  for (const file of sources) {
    if (!file.isTest) continue;
    const pattern = /\bsettle\s*\(\s*([0-9_]+)/g;
    for (let match = pattern.exec(file.codeOnly); match; match = pattern.exec(file.codeOnly)) {
      const ms = Number((match[1] ?? "0").replace(/_/g, ""));
      if (ms > MAX_SETTLE_MS)
        oversized.push(`${file.rel}:${lineOf(file.codeOnly, match.index)}  settle(${ms})`);
    }
  }
  assert.deepEqual(
    oversized,
    [],
    `settle() above its ${MAX_SETTLE_MS} ms cap is a fixed sleep in disguise:\n${oversized.join("\n")}`,
  );
});

test("production imports never escape their own package (relative paths stay inside)", () => {
  const violations: string[] = [];
  for (const file of production) {
    const packageRoot = findPackageRoot(dirname(file.abs));
    if (!packageRoot) continue;
    // The `code` view, not `codeOnly`: an import specifier *is* a string
    // literal, so dropping string contents would make this rule blind —
    // proven by the negative control that introduced this comment.
    const pattern = /from\s+["'](\.[^"']+)["']/g;
    for (let match = pattern.exec(file.code); match; match = pattern.exec(file.code)) {
      const specifier = match[1] ?? "";
      const target = resolve(dirname(file.abs), specifier);
      if (!target.startsWith(packageRoot + sep)) {
        violations.push(`${file.rel}:${lineOf(file.code, match.index)}  ${specifier}`);
      }
    }
  }
  assert.deepEqual(
    violations,
    [],
    `cross-package relative imports bypass the dependency graph of §28:\n${violations.join("\n")}`,
  );
});

test("modules stay reviewable: no production file above the size budget", () => {
  const BUDGET_LINES = 800;
  const oversize: readonly Exemption[] = [
    {
      file: "apps/web/src/backend.ts",
      reason: "1267 lines — split tracked as AGENTS 0.E E15; the budget keeps it from growing",
    },
    {
      file: "apps/web/public/app.js",
      reason: "888 lines — browser front end without a bundler; served as one module",
    },
  ];
  const allowed = new Set(oversize.map((entry) => entry.file));
  const violations = production
    .filter((file) => !allowed.has(file.rel) && file.lineCount > BUDGET_LINES)
    .map((file) => `${file.rel}: ${file.lineCount} lines`);
  assert.deepEqual(
    violations,
    [],
    `production modules above ${BUDGET_LINES} lines need a split or a recorded exemption:\n${violations.join("\n")}`,
  );
  const stale = oversize
    .map((entry) => entry.file)
    .filter((file) => !production.some((source) => source.rel === file));
  assert.deepEqual(
    stale,
    [],
    `size exemptions for files that no longer exist: ${stale.join(", ")}`,
  );

  // An exemption that stops being needed must be removed, otherwise the budget
  // quietly stops applying to a file that could now comply.
  const shrunk = oversize.filter((entry) => {
    const file = production.find((source) => source.rel === entry.file);
    return file !== undefined && file.lineCount <= BUDGET_LINES;
  });
  assert.deepEqual(
    shrunk.map((entry) => entry.file),
    [],
    "these files are back inside the size budget — drop their exemption",
  );
});

/** Nearest ancestor directory that holds a package.json. */
function findPackageRoot(dir: string): string | null {
  let current = dir;
  for (;;) {
    if (existsSync(join(current, "package.json"))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
