/**
 * Hypothesis ranking: documented failure patterns, judged against what was measured
 * (master backlog P0 #40, roadmap step 16 "Geführte Diagnose"; AGENTS 22).
 *
 * The package lists patterns with checks (`min`, `max`, `windowMs`). Until now a
 * human read that list and decided; here the *decidable half* is decided once, the
 * same way for every consumer:
 *
 * 1. take the readings of the check's signal inside the check's window,
 * 2. if the window holds no value, the check is **untested** — never "passed" and
 *    never "failed": absence of measurement is absence of evidence (ADR 0033),
 * 3. if every value in it stays inside the documented bounds, **confirmed**,
 * 4. otherwise **refuted**.
 *
 * A pattern's outcome is the worst verdict of its checks (a refuted check refutes
 * the pattern), which is why {@link Hypothesis.checks} keeps each verdict: a reader
 * has to see which measurement decided it. `nextTest` is then the first check that
 * is still *undecided* — a refuted one has been answered, and asking for it again
 * would send the technician back to a wire they already measured.
 *
 * Confidence is a heuristic, not a diagnosis. It starts from the package's own
 * `likelihood`, moves by what was measured, and is capped — a pattern nobody
 * measured cannot outrank one that was measured and confirmed. The rule is spelled
 * out in {@link confidenceOf} with its numbers, because an opaque score is exactly
 * the "black box" this project refuses (AGENTS 22, 36).
 */

import type { DtcKnowledgeCheck, DtcKnowledgePattern } from "@vdp/definitions";
import {
  type EvidenceSet,
  evidenceItemId,
  type Hypothesis,
  type HypothesisCheck,
  type HypothesisOutcome,
  type HypothesisTest,
  itemById,
  summariseWindow,
} from "@vdp/diagnostic-ir";
import type { EvidenceDtc } from "./collect.js";

/** One recorded value of a signal, as far as the ranking needs it. */
export interface SamplePoint {
  at: string;
  value: number;
}

export interface HypothesisInput {
  /** The evidence set the hypotheses cite — item ids come from it. */
  evidence: EvidenceSet;
  /** The same scan the evidence set was collected from — empty means nothing was scanned. */
  dtcs: readonly EvidenceDtc[];
  /**
   * Recorded values per signal id, oldest first.
   *
   * Absent means the caller has no series to offer (a report of a stored session, a
   * replay without a recorder): every documented check then stays **untested** with
   * that reason, and the ranking degrades to "what the package thinks", labelled as
   * such. An invented series would be the one thing worse than an open question.
   */
  samplesOf?: (signalId: string) => readonly SamplePoint[];
}

/** Likelihoods as prior weights — the package's word, turned into a number once. */
const LIKELIHOOD_PRIOR: Record<string, number> = {
  common: 0.6,
  plausible: 0.45,
  rare: 0.25,
};

/** What a pattern without any `likelihood` starts from: below "plausible", on purpose. */
const UNKNOWN_PRIOR = 0.4;

/**
 * The confidence rule, in the open.
 *
 * `prior` from the package's likelihood, plus 0.25 when a check was measured and
 * confirmed, minus 0.1 while nothing was measured, plus 0.05 when the window was
 * conclusive, minus 0.15 when the code itself is undocumented. A refuted pattern is
 * **demoted, not dropped** (×0.25): "the measurement speaks against it" is a result
 * a workshop needs to see, and a zero would hide it. Clamped to [0.05, 0.9] — the
 * ceiling is the point: no combination of documents and windows reaches certainty,
 * because the numbers here describe a recording, not the car.
 */
export function confidenceOf(parts: {
  prior: number;
  outcome: HypothesisOutcome;
  conclusive: boolean;
  codeDocumented: boolean;
}): number {
  let score = parts.prior;
  if (parts.outcome === "confirmed") score += 0.25;
  if (parts.outcome === "untested") score -= 0.1;
  if (parts.outcome === "refuted") score *= 0.25;
  score += parts.conclusive ? 0.05 : -0.05;
  if (!parts.codeDocumented) score -= 0.15;
  return Math.min(0.9, Math.max(0.05, Number(score.toFixed(3))));
}

/**
 * Rank the documented patterns of one scan.
 *
 * Only codes that carry knowledge produce hypotheses; a code nobody documented
 * produces none, and stays visible as an unproven `dtc` item plus a `gap` in the
 * evidence set. That asymmetry is deliberate: an analysis must not receive an empty
 * list and read it as "nothing to check" — it reads the evidence set for that.
 */
export function rankHypotheses(input: HypothesisInput): Hypothesis[] {
  const { evidence, dtcs, samplesOf } = input;
  const hypotheses: Hypothesis[] = [];
  for (const dtc of dtcs) {
    const knowledge = dtc.knowledge;
    if (knowledge === undefined || knowledge.patterns.length === 0) continue;
    for (const pattern of knowledge.patterns) {
      hypotheses.push(
        hypothesisOf({
          dtc,
          pattern,
          evidence,
          ...(samplesOf !== undefined ? { samplesOf } : {}),
          // An unproven `dtc` item is the evidence set's own verdict on "is this
          // code documented" — one source, no re-derivation here.
          codeDocumented: !evidence.items.some(
            (item) =>
              item.kind === "dtc" && item.subject === dtc.code && item.evidence.kind === "unproven",
          ),
        }),
      );
    }
  }
  return hypotheses.sort(compareHypotheses);
}

/** Highest first; equal scores keep scan order, so a rerun cannot reorder a report. */
function compareHypotheses(left: Hypothesis, right: Hypothesis): number {
  if (left.confidence !== right.confidence) return right.confidence - left.confidence;
  if (left.code !== right.code) return left.code < right.code ? -1 : 1;
  return left.id < right.id ? -1 : left.id === right.id ? 0 : 1;
}

interface HypothesisParts {
  dtc: EvidenceDtc;
  pattern: DtcKnowledgePattern;
  evidence: EvidenceSet;
  codeDocumented: boolean;
  samplesOf?: (signalId: string) => readonly SamplePoint[];
}

function hypothesisOf(parts: HypothesisParts): Hypothesis {
  const { dtc, pattern, evidence, samplesOf, codeDocumented } = parts;
  const checks = pattern.checks.map((check) => checkVerdict(check, samplesOf));
  // `every` on an empty list is true, and a pattern that documents nothing has
  // documented nothing: without this line it would read as "confirmed" and collect
  // the +0.25 for a measurement that never happened.
  const outcome: HypothesisOutcome = checks.some((check) => check.outcome === "refuted")
    ? "refuted"
    : checks.length > 0 && checks.every((check) => check.outcome === "confirmed")
      ? "confirmed"
      : "untested";
  const decided = checks.find((check) => check.window !== undefined);
  const conclusive = decided?.window?.conclusive ?? false;
  const prior =
    pattern.likelihood === undefined
      ? UNKNOWN_PRIOR
      : (LIKELIHOOD_PRIOR[pattern.likelihood] ?? UNKNOWN_PRIOR);
  const hypothesis: Hypothesis = {
    id: pattern.id,
    code: dtc.code,
    ...(dtc.ecuId !== undefined ? { ecuId: dtc.ecuId } : {}),
    claim: pattern.name,
    ...(pattern.explanation !== undefined ? { explanation: pattern.explanation } : {}),
    ...(pattern.likelihood !== undefined ? { likelihood: pattern.likelihood } : {}),
    outcome,
    confidence: confidenceOf({ prior, outcome, conclusive, codeDocumented }),
    evidence: citedIds(parts.dtc, pattern, checks, evidence),
    checks,
    reason: reasonOf(outcome, checks, conclusive),
  };
  // The *undecided* check, not merely the first one that did not pass: a refuted
  // check is decided, and telling someone to run it again wastes a workshop hour.
  const next = checks.find((check) => check.outcome === "untested");
  if (next !== undefined) hypothesis.nextTest = next.test;
  return hypothesis;
}

/**
 * Judge one documented check.
 *
 * The bounds are the package's `min`/`max`; a missing bound is "not constrained",
 * never "zero". `expect` is prose for a human and is carried along untouched — it
 * never decides anything here, because a sentence cannot be compared to a number.
 */
function checkVerdict(
  check: DtcKnowledgeCheck,
  samplesOf: HypothesisParts["samplesOf"],
): HypothesisCheck {
  const test: HypothesisTest = {
    signal: check.signal,
    ...(check.signalName !== undefined && check.signalName !== check.signal
      ? { name: check.signalName }
      : {}),
    expect: check.expect,
    ...(check.min !== undefined ? { min: check.min } : {}),
    ...(check.max !== undefined ? { max: check.max } : {}),
    ...(check.windowMs !== undefined ? { windowMs: check.windowMs } : {}),
    measurable: check.measurable,
  };
  // Prose only: no number can decide it, so it is untested — not "passed because
  // nothing contradicts it" (AGENTS 22: the difference a workshop acts on).
  if (!check.measurable) return { test, outcome: "untested" };
  if (samplesOf === undefined) return { test, outcome: "untested" };

  const points = samplesOf(check.signal);
  const last = points.at(-1);
  const first = points.at(0);
  // A series that is empty decides nothing — the same answer as no series at all.
  if (last === undefined || first === undefined) return { test, outcome: "untested" };
  const from =
    check.windowMs === undefined
      ? first.at
      : new Date(Date.parse(last.at) - check.windowMs).toISOString();
  const window = summariseWindow(points, [], { signalId: check.signal, from, to: last.at });
  if (!window.conclusive || window.min === undefined || window.max === undefined) {
    return { test, outcome: "untested", window };
  }
  const below = check.min !== undefined && window.min < check.min;
  const above = check.max !== undefined && window.max > check.max;
  return { test, outcome: below || above ? "refuted" : "confirmed", window };
}

function reasonOf(
  outcome: HypothesisOutcome,
  checks: readonly HypothesisCheck[],
  conclusive: boolean,
): string {
  const measurable = checks.filter((check) => check.test.measurable);
  if (checks.length === 0) {
    return "the pattern documents no check at all — nothing was decided";
  }
  if (measurable.length === 0) {
    return "the package documents prose only — no number decides this pattern";
  }
  if (outcome === "untested") {
    return conclusive
      ? "a window exists but holds no value"
      : `no reading of ${measurable.map((check) => check.test.signal).join(", ")} in the documented window`;
  }
  const decided = checks.find((check) => check.outcome === "refuted") ?? checks[0];
  const window = decided?.window;
  if (window === undefined)
    return `${outcome} without a window - the check has no readings to judge`;
  const spread =
    window.min === undefined || window.max === undefined
      ? "no numeric value"
      : `${window.min}…${window.max}${window.unit === undefined ? "" : ` ${window.unit}`}`;
  return `${outcome} on ${window.samples} reading(s) between ${window.from} and ${window.to}: ${spread}`;
}

/** Which items support this hypothesis — cited, never restated. */
function citedIds(
  dtc: EvidenceDtc,
  pattern: DtcKnowledgePattern,
  checks: readonly HypothesisCheck[],
  evidence: EvidenceSet,
): string[] {
  const ids = [
    evidenceItemId("dtc", dtc.code, dtc.ecuId),
    evidenceItemId("pattern", `${dtc.code}/${pattern.id}`, dtc.ecuId),
  ];
  for (const check of checks) {
    if (check.window === undefined) continue;
    ids.push(evidenceItemId("signal", check.test.signal));
  }
  // A cited id that is not in the set is a bug in the citation, not a fact about the
  // session — so unknown ids are dropped rather than printed as dangling references.
  return ids.filter((id) => itemById(evidence, id) !== undefined);
}
