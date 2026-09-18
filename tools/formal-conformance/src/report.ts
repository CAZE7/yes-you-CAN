/**
 * Comparison and reporting for conformance runs (ADR 0045).
 *
 * A differential report has exactly one job: when two readers of the same
 * vector disagree, say *what was fed, what each side produced, and where the
 * objects differ*. Everything here is pure over plain data — the CLI writes the
 * text, the protocol suite asserts its shape.
 */

import { canonicalJson, diffPaths } from "./canonical.js";

/** One side's answer for one vector: a result, or the reason none was produced. */
export interface VectorRecord {
  name: string;
  result: unknown | null;
  /** Set when the run itself failed (a stuck vector, an unmapped error). */
  runError?: string;
}

export interface ConformanceDiff {
  name: string;
  /** The vector's input, rendered as canonical JSON — the reproduction recipe. */
  input: string;
  ts: unknown | null;
  haskell: unknown | null;
  /** Paths where the two results differ; `["<missing:ts>"]` if a side lacks it. */
  difference: string[];
}

export interface SetComparison {
  vectorSet: string;
  tsChecked: number;
  tsMatchesExpect: number;
  /** TS results that differ from the vector's own `expect`. */
  tsMismatches: ConformanceDiff[];
  /** Ran only when a Haskell run was provided. */
  differential: ConformanceDiff[];
  hsRun: boolean;
}

/** Records (one side) compared against the vectors' expectations. */
export function compareAgainstExpectations(
  vectors: readonly { name: string; expect: unknown }[],
  records: readonly VectorRecord[],
): { matches: number; mismatches: ConformanceDiff[] } {
  const byName = new Map(records.map((record) => [record.name, record]));
  const mismatches: ConformanceDiff[] = [];
  let matches = 0;
  for (const vector of vectors) {
    const record = byName.get(vector.name);
    if (!record || record.runError !== undefined) {
      mismatches.push({
        name: vector.name,
        input: canonicalJson(vector),
        ts: record ? null : { missing: "no result for this vector" },
        haskell: null,
        difference: [record?.runError ?? "<missing:result>"],
      });
      continue;
    }
    if (canonicalJson(record.result) === canonicalJson(vector.expect)) {
      matches++;
      continue;
    }
    mismatches.push({
      name: vector.name,
      input: canonicalJson(vector),
      ts: record.result,
      haskell: null,
      difference: diffPaths(vector.expect, record.result),
    });
  }
  return { matches, mismatches };
}

/** Per-vector TS ⇄ Haskell comparison of two record sets. */
export function compareRecordSets(
  tsRecords: readonly VectorRecord[],
  hsRecords: readonly VectorRecord[],
  vectors: readonly { name: string }[],
): ConformanceDiff[] {
  const ts = new Map(tsRecords.map((r) => [r.name, r]));
  const hs = new Map(hsRecords.map((r) => [r.name, r]));
  const diffs: ConformanceDiff[] = [];
  for (const vector of vectors) {
    const tsRecord = ts.get(vector.name);
    const hsRecord = hs.get(vector.name);
    const difference: string[] = [];
    if (!tsRecord || tsRecord.runError !== undefined)
      difference.push("ts: " + (tsRecord?.runError ?? "missing"));
    if (!hsRecord || hsRecord.runError !== undefined)
      difference.push("haskell: " + (hsRecord?.runError ?? "missing"));
    if (
      tsRecord &&
      hsRecord &&
      tsRecord.result !== null &&
      hsRecord.result !== null &&
      canonicalJson(tsRecord.result) !== canonicalJson(hsRecord.result)
    ) {
      difference.push(...diffPaths(tsRecord.result, hsRecord.result));
    }
    if (difference.length > 0) {
      diffs.push({
        name: vector.name,
        input: canonicalJson({ ts: tsRecord?.result ?? null, haskell: hsRecord?.result ?? null }),
        ts: tsRecord?.result ?? null,
        haskell: hsRecord?.result ?? null,
        difference,
      });
    }
  }
  return diffs;
}

/**
 * Render one deviation the way the gate requires (§17): the vector, its input,
 * each side's result, the differing paths — enough to reproduce from.
 */
export function formatDiff(diff: ConformanceDiff): string {
  return [
    `--- deviation: ${diff.name} ---`,
    `input: ${diff.input}`,
    `ts:      ${canonicalJson(diff.ts)}`,
    `haskell: ${canonicalJson(diff.haskell)}`,
    "difference:",
    ...diff.difference.map((path) => `  - ${path}`),
  ].join("\n");
}

export function formatSummary(set: SetComparison): string {
  const lines = [
    `${set.vectorSet}: ${set.tsChecked} vectors — TS matches expectations: ${set.tsMatchesExpect}/${set.tsChecked}`,
  ];
  for (const mismatch of set.tsMismatches) lines.push(formatDiff(mismatch));
  if (!set.hsRun) {
    lines.push(
      "haskell: NOT RUN — no toolchain in this environment (run `npm run formal:conform -- --compare` where runghc or ghc exists)",
    );
  } else {
    lines.push(
      set.differential.length === 0
        ? "haskell: differential clean — TS results and Haskell results agree on every vector"
        : `haskell: ${set.differential.length} deviation(s)`,
    );
    for (const deviation of set.differential) lines.push(formatDiff(deviation));
  }
  return lines.join("\n");
}

/**
 * Parse the driver's output: one canonical result object per line (JSONL),
 * each `{ "name": ..., "result": ... }` — or `{"name":..., "error":...}` for a
 * vector the Haskell side refused to run at all.
 */
export function parseDriverJsonl(text: string): VectorRecord[] {
  const records: VectorRecord[] = [];
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .forEach((line, i) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new Error(`driver line ${i + 1}: not JSON: ${line.slice(0, 120)}`);
      }
      if (typeof parsed !== "object" || parsed === null) {
        throw new Error(`driver line ${i + 1}: expected an object`);
      }
      const record = parsed as { name?: unknown; result?: unknown; error?: unknown };
      if (typeof record.name !== "string") {
        throw new Error(`driver line ${i + 1}: missing string "name"`);
      }
      if (typeof record.error === "string") {
        records.push({ name: record.name, result: null, runError: record.error });
        return;
      }
      if (!("result" in record)) {
        throw new Error(`driver line ${i + 1}: neither "result" nor "error"`);
      }
      records.push({ name: record.name, result: record.result ?? null });
    });
  return records;
}

/** Serialise runner records as the driver's JSONL (shared by fixture stubs and the CLI). */
export function recordsToJsonl(records: readonly VectorRecord[]): string {
  return (
    records
      .map((record) =>
        record.runError !== undefined
          ? JSON.stringify({ name: record.name, error: record.runError })
          : JSON.stringify({ name: record.name, result: record.result }),
      )
      .join("\n") + "\n"
  );
}
