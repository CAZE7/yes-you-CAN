/**
 * The pure core of `npm run formal:conform` (ADR 0045).
 *
 * File reading, toolchain probing and process spawning arrive through the
 * injected `io`, so every branch is unit-testable without a filesystem or a
 * compiler; `cli.ts` is the thin real wiring on top.
 *
 * Exit codes: 0 = everything ran and agreed; 1 = a deviation; 2 = usage, an
 * invalid vector file, or `--compare` without a Haskell toolchain — “I could
 * not ask” is deliberately not the same answer as “it agrees” (AGENTS 34.21).
 */

import type { IsoTpResult } from "./canonical.js";
import { type RunnerTime, runIsoTpVector } from "./isotp-runner.js";
import {
  compareAgainstExpectations,
  compareRecordSets,
  formatDiff,
  parseDriverJsonl,
  type VectorRecord,
} from "./report.js";
import { runSafetyVector } from "./safety-runner.js";
import { type IsoTpVector, parseIsoTpVectorFile, parseSafetyVectorFile } from "./vectors.js";

export interface CliIo {
  readFile(path: string): string;
  writeFile(path: string, text: string): void;
  /** True when a Haskell runner (`runghc`, `runhaskell` or a plain `ghc`) exists. */
  hasHaskell(): boolean;
  /** Runs the Haskell driver for one set; resolves to its JSONL stdout. */
  runHaskell(set: "isotp" | "safety", vectorsPath: string): Promise<string>;
  time: RunnerTime;
}

export interface CliResult {
  exit: 0 | 1 | 2;
  report: string;
}

export interface ConformanceFlags {
  isotp: string;
  safety: string;
  compare: boolean;
  jsonOut: string | null;
}

export const USAGE = [
  "usage: npm run formal:conform -- [--isotp FILE] [--safety FILE] [--compare] [--json OUT]",
  "",
  "  runs the shared test vectors against the production TypeScript implementations",
  "  (IsoTpConnection; SafetyManager, WritePort, DiagnosticTransaction).",
  "  --compare additionally runs formal/ConformanceDriver.hs (ghc preferred — one",
  "  compile, one run per set; runhaskell/runghc for interpreter-only machines)",
  "  and reports every deviation as: vector, input, TS result, Haskell result, difference.",
].join("\n");

export function parseArgs(
  argv: readonly string[],
): { flags: ConformanceFlags } | { usage: string } {
  const flags: ConformanceFlags = {
    isotp: "tools/formal-conformance/vectors/isotp.json",
    safety: "tools/formal-conformance/vectors/safety.json",
    compare: false,
    jsonOut: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string | undefined => argv[++i];
    if (arg === "--compare") flags.compare = true;
    else if (arg === "--isotp") {
      const value = next();
      if (!value) return { usage: "--isotp needs a file" };
      flags.isotp = value;
    } else if (arg === "--safety") {
      const value = next();
      if (!value) return { usage: "--safety needs a file" };
      flags.safety = value;
    } else if (arg === "--json") {
      const value = next();
      if (!value) return { usage: "--json needs an output file" };
      flags.jsonOut = value;
    } else if (arg === "--help" || arg === "-h") {
      return { usage: USAGE };
    } else {
      return { usage: `unknown argument ${JSON.stringify(arg)}\n${USAGE}` };
    }
  }
  return { flags };
}

interface Expectation {
  name: string;
  expect: unknown;
}

function isoExpectations(vectors: readonly IsoTpVector[]): Expectation[] {
  return vectors.map((vector) => ({ name: vector.name, expect: vector.expect as IsoTpResult }));
}

/**
 * Run both vector sets against the TypeScript implementations and, when asked
 * for, against the Haskell reference. A pure function over injected `io`: the
 * report text is its second result, so a test can assert on *both*.
 */
export async function runConformanceCli(argv: readonly string[], io: CliIo): Promise<CliResult> {
  const parsed = parseArgs(argv);
  if ("usage" in parsed) return { exit: 2, report: parsed.usage };
  const { flags } = parsed;

  const readErrors: string[] = [];
  const read = (path: string): string | null => {
    try {
      return io.readFile(path);
    } catch (error) {
      readErrors.push(`cannot read ${path}: ${error instanceof Error ? error.message : "?"}`);
      return null;
    }
  };
  const isotpText = read(flags.isotp);
  const safetyText = read(flags.safety);
  if (readErrors.length > 0) return { exit: 2, report: readErrors.join("\n") };

  const isotpFile = parseIsoTpVectorFile(isotpText ?? "");
  if (!isotpFile.ok) {
    return {
      exit: 2,
      report: `invalid vector file ${flags.isotp}:\n${isotpFile.errors.join("\n")}`,
    };
  }
  const safetyFile = parseSafetyVectorFile(safetyText ?? "");
  if (!safetyFile.ok) {
    return {
      exit: 2,
      report: `invalid vector file ${flags.safety}:\n${safetyFile.errors.join("\n")}`,
    };
  }

  if (flags.compare && !io.hasHaskell()) {
    return {
      exit: 2,
      report:
        "--compare needs a Haskell toolchain (runghc, runhaskell or ghc on PATH); none was found.\n" +
        "Run without --compare for the TypeScript side alone.",
    };
  }

  const isoRecords = await runAll(
    isoExpectations(isotpFile.vectors),
    (vector) => runIsoTpVector(vector, io.time),
    isotpFile.vectors,
  );
  const safetyRecords = await runAll(
    safetyFile.vectors.map((vector) => ({ name: vector.name, expect: vector.expect })),
    (vector) => runSafetyVector(vector),
    safetyFile.vectors,
  );

  const lines: string[] = [];
  let failed = false;
  const jsonSets: Record<
    string,
    { name: string; expect: unknown; ts: unknown; haskell?: unknown }[]
  > = {};

  const sets: readonly {
    label: string;
    set: "isotp" | "safety";
    path: string;
    expectations: Expectation[];
    records: VectorRecord[];
  }[] = [
    {
      label: "iso15765-2",
      set: "isotp",
      path: flags.isotp,
      expectations: isoExpectations(isotpFile.vectors),
      records: isoRecords,
    },
    {
      label: "write-safety",
      set: "safety",
      path: flags.safety,
      expectations: safetyFile.vectors.map((v) => ({ name: v.name, expect: v.expect })),
      records: safetyRecords,
    },
  ];

  for (const current of sets) {
    const compared = compareAgainstExpectations(current.expectations, current.records);
    lines.push(
      `${current.label}: ${current.expectations.length} vectors — TS matches the formal expectations: ${compared.matches}/${current.expectations.length}`,
    );
    for (const mismatch of compared.mismatches) {
      lines.push(formatDiff(mismatch));
      failed = true;
    }
    const entries: { name: string; expect: unknown; ts: unknown; haskell?: unknown }[] =
      current.expectations.map((expectation) => ({
        name: expectation.name,
        expect: expectation.expect,
        ts: current.records.find((record) => record.name === expectation.name)?.result ?? null,
      }));
    if (flags.compare) {
      const hsRecords = parseDriverJsonl(await io.runHaskell(current.set, current.path));
      const deviations = compareRecordSets(current.records, hsRecords, current.expectations);
      if (deviations.length === 0) {
        lines.push(
          `${current.label}: TS ⇄ Haskell differential clean (${current.expectations.length} vectors)`,
        );
      } else {
        lines.push(`${current.label}: ${deviations.length} TS ⇄ Haskell deviation(s):`);
        for (const deviation of deviations) lines.push(formatDiff(deviation));
        failed = true;
      }
      const hsByName = new Map(hsRecords.map((record) => [record.name, record]));
      for (const entry of entries) {
        entry.haskell = hsByName.get(entry.name)?.result ?? null;
      }
    } else {
      lines.push(
        `${current.label}: haskell NOT RUN — pass --compare on a machine with a Haskell toolchain to verify the reference model itself`,
      );
    }
    jsonSets[current.label] = entries;
  }

  if (flags.jsonOut) {
    io.writeFile(
      flags.jsonOut,
      JSON.stringify({ generatedBy: "tools/formal-conformance", sets: jsonSets }, null, 2) + "\n",
    );
  }
  return { exit: failed ? 1 : 0, report: lines.join("\n") };
}

async function runAll<V>(
  expectations: Expectation[],
  run: (vector: V) => Promise<unknown>,
  vectors: readonly V[],
): Promise<VectorRecord[]> {
  const records: VectorRecord[] = [];
  for (let i = 0; i < vectors.length; i++) {
    const name = expectations[i]?.name ?? `vector[${i}]`;
    try {
      records.push({ name, result: await run(vectors[i] as V) });
    } catch (error) {
      records.push({
        name,
        result: null,
        runError: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return records;
}
