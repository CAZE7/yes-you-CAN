/**
 * Guardrail self-check — the gates are described by the repository, and they run.
 *
 * `dependencies.test.ts` proves the *shape* of the module graph, `hygiene.test.ts`
 * proves the *discipline inside* the modules. This file proves the third thing
 * that was missing until 2026-09-14: that the **automatic guardrails still bite**.
 *
 * The situation it fixes: `ci.yml` ran `npm ci` → `npm run build` → `npm test`
 * only. Biome and both strict `--noEmit` passes were declared in `npm run ci`,
 * but nothing in CI called it, so a spec with a type error or a lint violation
 * could merge green. Workflow files cannot be changed with the current GitHub App
 * installation (`refusing to allow a GitHub App to create or update workflow …`,
 * re-measured 2026-09-14, see AGENTS 0.E E10/E20), so the gates are carried into
 * the test run instead: the `architecture` project runs them here. Measured cost
 * on a warm tree: Biome 0.82 s, `tsconfig.typecheck.json` 0.83 s,
 * `tsconfig.frontend.json` 0.31 s — ≈2 s on a ~21 s suite, and zero on the fast
 * `npm run test:unit` loop, which does not include this project.
 *
 * The rules below are deliberately about *policy*, not about style preferences:
 *
 *  1. One linter. ESLint next to Biome would be a second vocabulary for the same
 *     question, and the repository's answer to "too few lints" is *harder rules*
 *     (ADR 0029), not more linters.
 *  2. A rule is either an error or it is on the record with a reason. `warn` in
 *     Biome does not fail `biome check`; it is a decision not to gate, written in
 *     the syntax of a decision to gate. Every `off`/`warn` entry here names the
 *     measured finding that justifies it, and a dead entry fails the test, so the
 *     record cannot rot.
 *  3. Overrides may only relax rules for test sources or for a named
 *     non-production file. Production code has no exemption path.
 *  4. TypeScript strictness is inherited, not negotiated: `strict`,
 *     `noUncheckedIndexedAccess` and `noImplicitOverride` are on for the whole
 *     workspace, and every relaxation is listed with the measurement that keeps it
 *     open.
 *  5. No build orchestrator. Turborepo/Nx is not a *guardrail*, it is build
 *     complexity ahead of need (ADR 0029) — the test fails if one appears without
 *     the decision being revisited.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "vitest";
import { discoverWorkspaceDirs, repoRoot as root } from "./workspace.js";

const readJson = (file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;

/* ------------------------------------------------------------------ 1. linter */

/**
 * One linter: Biome (ADR 0016 §1, ADR 0029 §1). ESLint, oxlint or tslint beside
 * it would re-introduce exactly the problem the strictness change addresses —
 * rule *volume* instead of rule *sharpness* — and give every rule two homes.
 */
const SECOND_LINTERS = /^(eslint|@eslint\/|typescript-eslint|@typescript-eslint\/|oxlint|tslint)/;

test("Biome is the only linter in the workspace", () => {
  const offenders: string[] = [];

  for (const dir of [root, ...discoverWorkspaceDirs()]) {
    const manifestPath = join(dir, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = readJson(manifestPath) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    for (const name of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) {
      if (SECOND_LINTERS.test(name)) offenders.push(`${relative(root, dir)} → ${name}`);
    }
    for (const entry of readdirSync(dir)) {
      if (/^\.eslintrc|^eslint\.config\./.test(entry)) {
        offenders.push(`${relative(root, join(dir, entry))}`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    "a second linter was added — the answer to weak rules is harder rules (ADR 0029 §1):\n" +
      offenders.join("\n"),
  );
});

/* --------------------------------------------------- 2/3. rule decisions on record */

interface RuleDecision {
  /** `global` for `linter.rules`, otherwise the override's include list. */
  scope: string[];
  rule: string;
  value: string;
}

/** Every `group.rule: value` pair in the config, overrides included. */
function configuredRules(config: Record<string, unknown>): RuleDecision[] {
  const decisions: RuleDecision[] = [];

  const normalizeValue = (raw: unknown): string => {
    if (typeof raw === "string") return raw;
    if (raw && typeof raw === "object") {
      const obj = raw as { level?: string; value?: string };
      if (typeof obj.level === "string") return obj.level;
      if (typeof obj.value === "string") return obj.value;
    }
    return "unknown";
  };

  const collect = (rules: Record<string, Record<string, unknown>>, scope: string[]): void => {
    for (const group of Object.keys(rules)) {
      if (group === "preset") continue;
      const groupRules = rules[group] ?? {};
      for (const [rule, raw] of Object.entries(groupRules)) {
        decisions.push({ scope, rule, value: normalizeValue(raw) });
      }
    }
  };

  const linter = config.linter as { rules?: Record<string, Record<string, unknown>> } | undefined;
  collect((linter?.rules ?? {}) as Record<string, Record<string, unknown>>, []);

  const overrides = (config.overrides ?? []) as Array<{
    include?: string[];
    includes?: string[];
    linter?: { rules?: Record<string, Record<string, unknown>> };
  }>;
  for (const override of overrides) {
    const scope = override.includes ?? override.include ?? [];
    collect((override.linter?.rules ?? {}) as Record<string, Record<string, unknown>>, scope);
  }

  return decisions;
}

/**
 * The rules that are *not* errors, each with the measurement that justifies it
 * and the scope it applies to. Scope is the override's `include` list, so a rule
 * justified for tests cannot silently be used to soften production code.
 *
 * Falling out of an earlier audit rather than a preference, every reason names
 * what was counted on 2026-09-14 over 298 files.
 */
const JUSTIFIED_RULES: ReadonlyArray<{
  rule: string;
  scope: string[];
  value: "off" | "warn";
  reason: string;
}> = [
  {
    rule: "useExhaustiveDependencies",
    scope: [],
    value: "off",
    reason:
      "There is no React and no hook: the workbench is vanilla ESM over the DOM (ADR 0006), so the rule has no subject in this repository.",
  },
  {
    rule: "noControlCharactersInRegex",
    scope: [],
    value: "off",
    reason:
      "slcan frames carry control characters by definition — canable/adapter.ts strips BEL (U+0007) before parsing, which a human-written protocol constant expresses better than the rule's escape-hatch comment.",
  },
  {
    rule: "useTemplate",
    scope: [],
    value: "off",
    reason:
      "18 findings, all long expert messages wrapped across lines with `+` to stay inside the 100-character budget; Biome classifies the fix as *unsafe* precisely because the alternative is one unreadable line. The repository chose readability (measured 2026-09-14: 18 findings in 7 files).",
  },
  {
    rule: "useLiteralKeys",
    scope: [],
    value: "off",
    reason:
      '37 findings, all `record["key"]` reads on untrusted `Record<string, unknown>` input. The bracket form keeps the boundary visible; with `noPropertyAccessFromIndexSignature` off, `record.key` would compile and hide it (measured 2026-09-14: 37 findings in 10 files).',
  },
  {
    rule: "noForEach",
    scope: [],
    value: "off",
    reason:
      "2 findings and a style opinion, not a defect — the rule exists for `forEach` in hot paths, and neither site is one.",
  },
  {
    rule: "noExplicitAny",
    scope: ["**/*.spec.ts", "**/*.test.ts", "**/tests/**"],
    value: "off",
    reason:
      "Tests inject deliberately wrong shapes (malformed frames, junk JSON) and say so; the production default is `error` (0 findings on 2026-09-14).",
  },
  {
    rule: "noNonNullAssertion",
    scope: ["**/*.spec.ts", "**/*.test.ts", "**/tests/**"],
    value: "off",
    reason:
      "In fixtures the `!` asserts a precondition the test itself just established; production is `error` (0 findings outside tests).",
  },
  {
    rule: "useConst",
    scope: ["**/*.spec.ts", "**/*.test.ts", "**/tests/**"],
    value: "off",
    reason:
      "One fixture registers a listener that disposes a variable which only exists after registration — `const` cannot express that order; production is `error` (0 findings outside tests).",
  },
  {
    rule: "noDelete",
    scope: ["**/*.spec.ts", "**/*.test.ts", "**/tests/**"],
    value: "off",
    reason:
      "Definition tests delete a required field to build the invalid package the validator must reject; `= undefined` would test a different thing. Production is `error`.",
  },
  {
    rule: "noAssignInExpressions",
    scope: ["**/*.spec.ts", "**/*.test.ts", "**/tests/**"],
    value: "off",
    reason:
      "One logger fixture advances an injected clock inside the argument list (`(now += 10)`) because the frame order *is* the subject of the test. Production is `error`.",
  },
  {
    rule: "noConsole",
    scope: ["**/*.spec.ts", "**/*.test.ts", "**/tests/**"],
    value: "off",
    reason:
      "Tests use console.warn/error to assert logging (server-logging.spec.ts, logger.spec.ts) and to print diagnostics when openssl is missing (tls.spec.ts). Production default is error with allow log (measured 2026-09-22: 0 findings in prod after migration).",
  },
  {
    rule: "noConsole",
    scope: ["**/scripts/**", "**/packages/shared/src/logger.ts"],
    value: "off",
    reason:
      "`ConsoleSink` is the console writer, and scripts are repo tooling whose output is a message. Same reason as noConsoleLog above, now expressed as noConsole in Biome 2.",
  },
  {
    rule: "noConsole",
    scope: ["**/public/**"],
    value: "off",
    reason:
      "Frontend files (app.js, vehicle.js) use console.warn for degraded UX (history not available) and console.error for user-visible errors. They run in the browser, not in production Node, and the alternative (silent failure) would be worse (ADR 0049). Measured 2026-09-22: 2 findings in public after Biome 2 migration.",
  },
  {
    rule: "noConsole",
    scope: ["**/packages/charts/**"],
    value: "off",
    reason:
      "Chart package logs rendering warnings to console — a canvas that fails to render must be visible to the developer, not silent. Production Node code is error.",
  },
  {
    rule: "noConsole",
    scope: ["**/tools/**"],
    value: "off",
    reason:
      "Tools (golden-sessions, formal-conformance) are CLIs whose output is console — same as scripts. Production packages are error.",
  },
  {
    rule: "useButtonType",
    scope: ["**/public/**"],
    value: "off",
    reason:
      "Biome 2 a11y rule requires explicit type on buttons. Fixed in index.html (46 buttons → type=button), but public/ contains vanilla JS that creates buttons dynamically and the rule would require type in JS too. Disabled for public/ where HTML already carries type, and JS buttons are created with type via helper. Measured 2026-09-22: 46 findings in index.html fixed, 0 remaining after override.",
  },
];

/** Scopes allowed to relax a rule, with the reason the scope is not production. */
const JUSTIFIED_SCOPES: ReadonlyArray<{ scope: string[]; reason: string }> = [
  {
    scope: ["**/*.spec.ts", "**/*.test.ts", "**/tests/**"],
    reason: "Test sources — never shipped, and their job is to construct the wrong input.",
  },
  {
    scope: ["**/scripts/**", "**/packages/shared/src/logger.ts"],
    reason:
      "Repo tooling plus the one module whose purpose is the console; both are outside every production package's entry points.",
  },
  {
    scope: ["**/public/**"],
    reason:
      "Frontend static assets — vanilla JS/HTML served to the browser, not Node production code. Console and button type handled separately.",
  },
  {
    scope: ["**/packages/charts/**"],
    reason: "Chart rendering package — browser canvas, console warnings are UX, not Node logs.",
  },
  {
    scope: ["**/tools/**"],
    reason: "CLI tools (golden-sessions, formal-conformance) — same as scripts, output is console.",
  },
];

const scopeKey = (scope: string[]): string => (scope.length === 0 ? "global" : scope.join(" "));

test("every rule that is not an error carries a measured reason", () => {
  const config = readJson(join(root, "biome.json"));
  const decisions = configuredRules(config);
  const relaxed = decisions.filter((entry) => entry.value !== "error");

  const unjustified = relaxed
    .filter(
      (entry) =>
        !JUSTIFIED_RULES.some(
          (allowed) =>
            allowed.rule === entry.rule &&
            allowed.value === entry.value &&
            scopeKey(allowed.scope) === scopeKey(entry.scope),
        ),
    )
    .map((entry) => `${entry.rule} = "${entry.value}" (${scopeKey(entry.scope)})`);

  assert.deepEqual(
    unjustified,
    [],
    "a rule was softened without a reason on the record — either make it an error or " +
      "justify it in JUSTIFIED_RULES with the finding that keeps it open (ADR 0029 §2):\n" +
      unjustified.join("\n"),
  );

  const dead = JUSTIFIED_RULES.filter(
    (allowed) =>
      !decisions.some(
        (entry) =>
          entry.rule === allowed.rule &&
          entry.value === allowed.value &&
          scopeKey(entry.scope) === scopeKey(allowed.scope),
      ),
  ).map((allowed) => `${allowed.rule} = "${allowed.value}" (${scopeKey(allowed.scope)})`);

  assert.deepEqual(
    dead,
    [],
    "JUSTIFIED_RULES lists decisions the config no longer makes — a justification that " +
      "outlived its finding is a stale exemption:\n" +
      dead.join("\n"),
  );
});

test("every non-error rule is a real exemption, not an unnoticed default", () => {
  const config = readJson(join(root, "biome.json"));
  const relaxed = configuredRules(config).filter((entry) => entry.value !== "error");
  const scopes = relaxed.filter((entry) => entry.scope.length > 0);

  for (const entry of scopes) {
    assert.ok(
      JUSTIFIED_SCOPES.some((allowed) => scopeKey(allowed.scope) === scopeKey(entry.scope)),
      `override scope [${entry.scope.join(", ")}] relaxes ${entry.rule} but is not listed as a ` +
        "non-production scope — production code has no exemption path (ADR 0029 §3)",
    );
    assert.equal(
      entry.value,
      "off",
      `override scope [${entry.scope.join(", ")}] sets ${entry.rule} to warn — a warning fails no ` +
        "gate; use `off` plus a reason, or make it an error",
    );
  }
});

/* -------------------------------------------- 4. TypeScript strictness inheritance */

/**
 * Strict flags that must be on for every workspace project, inherited from
 * `tsconfig.base.json` (AGENTS 34.19).
 */
const REQUIRED_STRICT_FLAGS = [
  "strict",
  "noUncheckedIndexedAccess",
  "noImplicitOverride",
  "verbatimModuleSyntax",
  "forceConsistentCasingInFileNames",
  // Turned on 2026-09-14 (E18): 88 errors across production sources and specs
  // were migrated, and the flag is now inherited like the others. A workspace
  // project that re-opens it fails this test.
  "exactOptionalPropertyTypes",
] as const;

/**
 * Flags that are deliberately *not* strict, with the measurement that keeps them
 * open. Turning them on is a task, not a config line (AGENTS 0.E E18/E19).
 *
 * Empty since 2026-09-14: E18 turned `exactOptionalPropertyTypes` on for the whole
 * workspace (88 errors migrated), E19 turned the frontend's `noImplicitAny` on
 * (221 errors in `apps/web/public/*.js` migrated), and both are now required
 * instead of recorded. The list and its three assertions stay: the next
 * relaxation has to name a file, a flag and a measurement, and a stale entry
 * still fails the test.
 */
const RELAXED_FLAGS: ReadonlyArray<{ file: string; flag: string; reason: string }> = [];

const ALL_TS_CONFIGS = (): string[] => {
  const configs = [
    "tsconfig.base.json",
    "tsconfig.json",
    "tsconfig.typecheck.json",
    "tsconfig.frontend.json",
  ];
  for (const dir of discoverWorkspaceDirs()) {
    if (existsSync(join(dir, "tsconfig.json"))) {
      configs.push(relative(root, join(dir, "tsconfig.json")));
    }
  }
  return configs;
};

test("the workspace inherits strict TypeScript, and every relaxation is on the record", () => {
  const base = readJson(join(root, "tsconfig.base.json")) as {
    compilerOptions: Record<string, unknown>;
  };
  for (const flag of REQUIRED_STRICT_FLAGS) {
    assert.equal(
      base.compilerOptions[flag],
      true,
      `tsconfig.base.json must enable ${flag} — strictness is inherited, not negotiated (AGENTS 34.19)`,
    );
  }

  // A workspace project may not re-open a flag the base closed.
  const reopenings: string[] = [];
  for (const rel of ALL_TS_CONFIGS()) {
    const config = readJson(join(root, rel)) as {
      compilerOptions?: Record<string, unknown>;
      extends?: string;
    };
    for (const flag of REQUIRED_STRICT_FLAGS) {
      if (config.compilerOptions?.[flag] === false) reopenings.push(`${rel}: ${flag} = false`);
    }
  }
  assert.deepEqual(
    reopenings,
    [],
    "a package turned a strict flag off — that is a workspace-wide decision, not a local one:\n" +
      reopenings.join("\n"),
  );

  // Every *relaxed* strict-ish flag has to be listed, and the listing has to be honest.
  const relaxed: string[] = [];
  for (const rel of ALL_TS_CONFIGS()) {
    const config = readJson(join(root, rel)) as { compilerOptions?: Record<string, unknown> };
    const options = config.compilerOptions ?? {};
    for (const [flag, value] of Object.entries(options)) {
      if (value !== false) continue;
      if (
        !/^(strict|no[A-Z]|exactOptionalPropertyTypes|useUnknownInCatchVariables|alwaysStrict)$/.test(
          flag,
        )
      )
        continue;
      if (RELAXED_FLAGS.some((entry) => entry.file === rel && entry.flag === flag)) continue;
      relaxed.push(`${rel}: ${flag} = false`);
    }
  }
  assert.deepEqual(
    relaxed,
    [],
    "a type-checking flag was switched off without a measurement — add it to RELAXED_FLAGS " +
      "with the finding that keeps it open, or turn it on (AGENTS 0.E E18/E19):\n" +
      relaxed.join("\n"),
  );

  const stale = RELAXED_FLAGS.filter((entry) => {
    const config = readJson(join(root, entry.file)) as {
      compilerOptions?: Record<string, unknown>;
    };
    return config.compilerOptions?.[entry.flag] !== false;
  }).map((entry) => `${entry.file}: ${entry.flag}`);
  assert.deepEqual(
    stale,
    [],
    "RELAXED_FLAGS names a flag that is no longer off — delete the entry and say so in the ADR:\n" +
      stale.join("\n"),
  );
});

/**
 * The browser project is the only automated check the front end has: it cannot be
 * unit-tested (a canvas needs a browser), so its safety net is the type-check of
 * `apps/web/public/*.js` against the wire contract in `apps/web/src/views.ts`.
 * Three things make that net real, and all three are asserted here.
 */
test("the browser project checks the front end against the wire contract", () => {
  const frontend = readJson(join(root, "tsconfig.frontend.json")) as {
    compilerOptions?: {
      checkJs?: boolean;
      noImplicitAny?: boolean;
      paths?: Record<string, string[]>;
    };
    include?: string[];
  };
  assert.equal(
    frontend.compilerOptions?.checkJs,
    true,
    "the frontend project must keep checking JavaScript — otherwise the file list is decorative",
  );
  assert.equal(
    frontend.compilerOptions?.noImplicitAny,
    true,
    "E19 closed the last relaxation of the workspace: an unannotated parameter in the front end is an error",
  );

  // Every absolute import the front end uses needs a path mapping, or TypeScript
  // silently types the import as `any` and the check above stops meaning anything.
  const specifiers = new Set<string>();
  for (const file of readdirSync(join(root, "apps/web/public"))) {
    if (!file.endsWith(".js")) continue;
    const source = readFileSync(join(root, "apps/web/public", file), "utf8");
    for (const match of source.matchAll(/from "(\/[^"]+)"/g)) specifiers.add(match[1] ?? "");
  }
  const paths = frontend.compilerOptions?.paths ?? {};
  const unmapped = [...specifiers].filter((specifier) => !(specifier in paths)).sort();
  assert.deepEqual(
    unmapped,
    [],
    "an absolute import without a `paths` mapping is typed as `any` — add it to " +
      "tsconfig.frontend.json (the browser resolves these at runtime, TypeScript does not):\n" +
      unmapped.join("\n"),
  );

  // The contract module is what the mapping above points the views at; it stays
  // node-free, or the browser project would have to type the Node backend.
  const contract = readFileSync(join(root, "apps/web/src/views.ts"), "utf8");
  assert.ok(
    !/from "node:/.test(contract),
    "apps/web/src/views.ts must stay node-free — it is the shared wire contract, checked by the browser project",
  );
  assert.ok(
    !/from "\.\/backend\.js"/.test(contract),
    "views.ts must not import the backend module: the front end would then typecheck `node:fs`",
  );
});

/* ------------------------------------------------------ 5. the gates actually run */

interface ToolResult {
  code: number;
  output: string;
}

/** Run a workspace binary; never throw, so the assertion can carry the output. */
function runTool(binary: string, args: readonly string[]): ToolResult {
  const executable = join(
    root,
    "node_modules",
    ".bin",
    process.platform === "win32" ? `${binary}.cmd` : binary,
  );
  try {
    const output = execFileSync(executable, args as string[], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
    return { code: 0, output };
  } catch (error) {
    const failed = error as { status?: number; stdout?: string; stderr?: string };
    return { code: failed.status ?? 1, output: `${failed.stdout ?? ""}${failed.stderr ?? ""}` };
  }
}

/**
 * The gates `npm run ci` declares, executed from inside the test run so that CI
 * (`npm ci` → `build` → `npm test`) enforces them today. `npm run ci` itself is
 * not spawned: it would run this suite again.
 */
test("the quality gates pass — biome check and both strict noEmit passes", {
  timeout: 180_000,
}, () => {
  const biome = join(root, "node_modules", ".bin", "biome");
  assert.ok(
    existsSync(biome) || existsSync(`${biome}.cmd`),
    "the toolchain is missing — run `npm ci` before the suite (the gates are part of the tests)",
  );

  const gates: ReadonlyArray<{ label: string; binary: string; args: string[]; hint: string }> = [
    {
      label: "biome check .",
      binary: "biome",
      args: ["check", "."],
      hint: "run `npm run check:fix` for the automatic part and read the rest",
    },
    {
      label: "tsc --noEmit -p tsconfig.typecheck.json",
      binary: "tsc",
      args: ["--noEmit", "-p", "tsconfig.typecheck.json"],
      hint: "specs, tests and the vitest config must typecheck — `npm run build` does not cover them",
    },
    {
      label: "tsc --noEmit -p tsconfig.frontend.json",
      binary: "tsc",
      args: ["--noEmit", "-p", "tsconfig.frontend.json"],
      hint: "apps/web/public/*.js is checked JavaScript (checkJs)",
    },
  ];

  const failures: string[] = [];
  for (const gate of gates) {
    const result = runTool(gate.binary, gate.args);
    if (result.code !== 0) {
      failures.push(`✗ ${gate.label} — ${gate.hint}\n${result.output.trim()}`);
    }
  }

  assert.deepEqual(
    failures,
    [],
    "a guardrail is red — this test exists because CI cannot run `npm run ci` directly " +
      `(AGENTS 0.E E10/E20):\n\n${failures.join("\n\n")}`,
  );
});

/* ------------------------------------------------------------------- 6. CI itself */

test("CI still runs the gate carrier on both Node versions", () => {
  const workflow = readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8");

  assert.match(workflow, /npm ci\b/, "CI must install exactly the lockfile");
  assert.match(
    workflow,
    /run: npm test\b/,
    "CI must run `npm test` — since ADR 0029 that is where the lint and typecheck gates live, " +
      "so removing it would silently remove them",
  );
  assert.match(
    workflow,
    /node-version: \[22, 24\]/,
    "the CI matrix is part of the contract: 22 (engines/.nvmrc) and 24 (next LTS)",
  );
});

/* ------------------------------------------------------- 7. no orchestrator ahead of need */

test("no build orchestrator is introduced without revisiting the decision", () => {
  const rootManifest = readJson(join(root, "package.json")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  };
  const deps = Object.keys({ ...rootManifest.dependencies, ...rootManifest.devDependencies });
  const orchestrators = deps.filter((name) =>
    /^(turbo|nx|@nx\/|lerna|rush|lage|wireit)/.test(name),
  );
  assert.deepEqual(
    orchestrators,
    [],
    "a build orchestrator appeared: the measured need comes first (ADR 0029 §5) — `tsc -b` over 25 " +
      "projects plus a 21 s suite is not a bottleneck, and Turborepo/Nx would add a caching layer " +
      "whose invalidation bugs are exactly the class of bug this repository gates against",
  );

  const manifests = ["turbo.json", "nx.json", "lerna.json", "rush.json"].filter((file) =>
    existsSync(join(root, file)),
  );
  assert.deepEqual(
    manifests,
    [],
    `orchestrator configuration without the dependency: ${manifests}`,
  );

  for (const [name, command] of Object.entries(rootManifest.scripts ?? {})) {
    assert.doesNotMatch(
      command,
      /\b(turbo|nx)\s/,
      `script "${name}" calls an orchestrator that is not a dependency`,
    );
  }
});

/**
 * An analysis provider cannot reach the vehicle (AGENTS 22; master backlog P0 #16,
 * ADR 0038). "AI never calls CAN.write()/UDS.send()" is a *policy*, and a policy that
 * lives in prose is a wish. The rule file is still the only source of the module
 * graph (`dependencies.test.ts` proves the tool enforces it, including negative
 * fixtures); this test adds the consequence the file cannot express on its own:
 * the packages an analysis may read must not be able to reach the write chain —
 * not directly, and not through three hops.
 *
 * It is deliberately computed from `architecture/architecture.yaml` instead of listing the
 * forbidden names, so the day someone widens `@vdp/ai`'s allowlist the test fails
 * with the reason, and the day someone widens a *middle* package the same happens.
 */
test("the read-only layers stay read-only: no path from ai or the IR to a write", () => {
  const rules = JSON.parse(readFileSync(join(root, "architecture/architecture.yaml"), "utf8")) as {
    packages: Record<string, { mayImport: string[] }>;
  };
  const WRITE_CAPABLE = "@vdp/core";
  const edges = new Map<string, ReadonlySet<string>>(
    Object.entries(rules.packages).map(([name, entry]) => [name, new Set(entry.mayImport)]),
  );
  const reaching = (target: string): Set<string> => {
    const found = new Set<string>([target]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const [name, imports] of edges) {
        if (found.has(name)) continue;
        if (Array.from(imports).some((target2) => found.has(target2))) {
          found.add(name);
          grew = true;
        }
      }
    }
    return found;
  };
  const canWrite = reaching(WRITE_CAPABLE);
  // The four layers an answer is built from. `@vdp/core` is the first package that
  // *may* write (it owns the WritePort, ADR 0032), so "cannot reach core" is the
  // machine-checkable form of "cannot touch the vehicle". `@vdp/application` is
  // deliberately not in this list: forwarding a write intent to the chain is its job.
  for (const reader of ["@vdp/ai", "@vdp/diagnostic-ir", "@vdp/domain", "@vdp/shared"]) {
    assert.ok(
      !canWrite.has(reader) || reader === WRITE_CAPABLE,
      `${reader} can reach ${WRITE_CAPABLE} through the rules — an analysis or a ` +
        "projection that can reach the write chain can bypass the safety chain",
    );
  }
  // The AI's allowlist is exactly what an analysis needs and nothing more.
  assert.deepEqual(
    Array.from(edges.get("@vdp/ai") ?? []).sort(),
    ["@vdp/diagnostic-ir", "@vdp/shared"],
    "widening @vdp/ai is a decision about the safety chain, not a convenience",
  );
});
