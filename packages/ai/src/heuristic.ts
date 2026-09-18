/**
 * Local heuristic analysis provider.
 *
 * Runs entirely in-process, so it works offline and never leaves personal data
 * behind. Rules are explicit and testable — every finding states the numeric
 * evidence it is based on, and every statement says what it is: a measured fact, an
 * observation, or a hypothesis about a variant the session actually determined
 * (AGENTS 22). Where the input carries no determination, the answer says so and its
 * confidence goes down instead of staying comfortably in the middle.
 *
 * The provider phrases only the difference that matters here — variant wording versus
 * manufacturer-wide wording. The four-way scope (`vehicle-engine`, `vehicle-gearbox`,
 * `vehicle`, `package`) is spelled out by the report and the UI, which own that
 * vocabulary; duplicating the table here would put diagnostic wording into a
 * provider layer that is meant to be swappable.
 */

import { type HypothesisTest, itemsOf } from "@vdp/diagnostic-ir";
import { citableIds, knownCitations, provenanceOf } from "./provenance.js";
import type {
  AnalysisDtc,
  AnalysisFinding,
  AnalysisInput,
  AnalysisProvider,
  AnalysisResult,
  AnalysisSignalSummary,
} from "./types.js";

export interface HeuristicOptions {
  /** Signals whose delta above this factor of the average is reported. */
  deltaFactor?: number;
  /** Signals below this sample count are reported as insufficient data. */
  minSamples?: number;
}

export class HeuristicAnalysisProvider implements AnalysisProvider {
  readonly id = "heuristic";
  readonly label = "Local rule engine";
  readonly sendsDataOffBox = false;

  constructor(private readonly options: HeuristicOptions = {}) {}

  async analyze(input: AnalysisInput): Promise<AnalysisResult> {
    const findings: AnalysisFinding[] = [];
    const recommendations: string[] = [];
    const deltaFactor = this.options.deltaFactor ?? 3;
    const minSamples = this.options.minSamples ?? 5;

    for (const dtc of input.dtcs) {
      findings.push({
        id: `dtc-${dtc.code}`,
        severity: severityOf(dtc.severity),
        title: `${dtc.code} stored in ${dtc.ecu}`,
        detail: detailOf(dtc),
        ...(dtc.code ? { relatedDtcs: [dtc.code] } : {}),
        // A code cites the evidence item that carries it; no item, no citation.
        ...(dtc.evidence?.itemId === undefined ? {} : { basedOn: [dtc.evidence.itemId] }),
      });
      if (dtc.severity === "critical" || dtc.severity === "major") {
        recommendations.push(dtcRecommendation(dtc));
      }
    }

    for (const anomaly of input.anomalies) {
      findings.push({
        id: `anomaly-${anomaly.signal}`,
        severity: "minor",
        title: `${anomaly.signal} deviates`,
        detail: anomaly.reason,
        relatedSignals: [anomaly.signal],
      });
    }

    for (const signal of input.signals) {
      if (signal.samples < minSamples) {
        findings.push({
          id: `low-samples-${signal.signal}`,
          severity: "info",
          title: `${signal.name}: too few samples`,
          detail: `Only ${signal.samples} sample(s) recorded — increase the recording duration before drawing conclusions.`,
          relatedSignals: [signal.signal],
        });
        continue;
      }
      if (signal.outOfRangeCount > 0) {
        findings.push({
          id: `range-${signal.signal}`,
          severity: "minor",
          title: `${signal.name}: out of range`,
          detail: `${signal.outOfRangeCount} of ${signal.samples} samples were outside the plausible range defined for this signal.`,
          relatedSignals: [signal.signal],
        });
      }
      const spread =
        Math.abs(signal.average) > 0 ? signal.delta / Math.abs(signal.average) : signal.delta;
      if (spread > deltaFactor) {
        findings.push({
          id: `spread-${signal.signal}`,
          severity: "minor",
          title: `${signal.name}: wide spread`,
          detail: `Range ${format(signal.min)}–${format(signal.max)} ${signal.unit ?? ""} against an average of ${format(signal.average)} — the signal swings far more than usual for a steady operating point.`,
          relatedSignals: [signal.signal],
        });
      }
    }

    for (const hypothesis of input.hypotheses ?? []) {
      const cited = knownCitations(hypothesis.evidence, citableIds(input)) ?? [];
      findings.push({
        id: `pattern-${hypothesis.id}-${hypothesis.outcome}`,
        // A confirmed pattern inherits the code's severity; anything else is a
        // statement about the *search*, not about this car (see module note).
        severity:
          hypothesis.outcome === "confirmed"
            ? severityOf(dtcSeverityOf(input, hypothesis.code))
            : "info",
        title: `${hypothesis.claim} — ${hypothesis.outcome}`,
        detail: `${hypothesis.reason} · confidence ${hypothesis.confidence}${
          hypothesis.likelihood === undefined ? "" : ` · package prior: ${hypothesis.likelihood}`
        }`,
        relatedDtcs: [hypothesis.code],
        ...(cited.length > 0 ? { basedOn: cited } : {}),
      });
      if (hypothesis.nextTest !== undefined) {
        recommendations.push(
          `next test for ${hypothesis.code}: ${testClause(hypothesis.nextTest)}`,
        );
      }
    }

    if (findings.length === 0) {
      findings.push({
        id: "no-findings",
        severity: "info",
        title: "No findings",
        detail: "Recorded signals stay inside their defined ranges and no fault codes are stored.",
      });
      recommendations.push("No action required based on this recording.");
    }
    if (recommendations.length === 0) {
      recommendations.push(
        "Repeat the recording under load to confirm the deviations are reproducible.",
      );
    }

    const vehicle = vehicleOf(input);
    const caveats = caveatsOf(input);
    // What the session leaves open, named in the answer. Not a caveat: an open
    // question is not a claim without a source (see `caveatsOf`).
    const openQuestions = input.evidence === undefined ? [] : itemsOf(input.evidence, "gap");
    // Confidence is a ceiling, never a reward: knowing the variant cannot raise it
    // above what the rules alone justify, but not knowing it lowers what may be
    // claimed at all (§22: keine Scheinsicherheit).
    const base = findings.every((finding) => finding.severity === "info") ? 0.55 : 0.4;
    const confidence = caveats.length > 0 ? Math.min(base, 0.3) : base;

    return {
      provider: this.id,
      summary: summarise(input, findings, vehicle),
      findings,
      recommendations: dedupe(recommendations),
      confidence,
      source: "heuristic",
      generatedAt: new Date().toISOString(),
      warnings: [
        "Heuristic analysis is rule based — it is a hint, not a diagnosis.",
        // The ceiling the numbers cannot lift: an answer without an evidence set has
        // nothing to cite, so say it out loud instead of answering comfortably.
        ...(input.evidence === undefined
          ? [
              "No evidence set was supplied — statements here cannot be traced back to an observation.",
            ]
          : []),
        ...(openQuestions.length === 0
          ? []
          : [
              `${openQuestions.length} question(s) stay open in this session: ${openQuestions
                .slice(0, 3)
                .map((item) => item.subject)
                .join(", ")}${openQuestions.length > 3 ? " …" : ""}.`,
            ]),
        ...caveats,
      ],
      provenance: provenanceOf(input, { provider: this.id }),
    };
  }
}

function summarise(input: AnalysisInput, findings: AnalysisFinding[], vehicle: string): string {
  const critical = findings.filter((finding) => finding.severity === "critical").length;
  const parts = [
    `${input.dtcs.length} fault code(s)`,
    `${input.signals.length} signal(s) analysed`,
    `${findings.length} finding(s)`,
  ];
  const head = critical > 0 ? `${critical} critical finding(s)` : "No critical findings";
  return `${head} on ${vehicle}. Recorded: ${parts.join(", ")}.`;
}

/** Which vehicle the input speaks about — never a guess about one it does not name. */
function vehicleOf(input: AnalysisInput): string {
  const vehicle = input.vehicle;
  if (vehicle === undefined) return "an unidentified vehicle";
  const name = [
    vehicle.brand,
    vehicle.model,
    vehicle.modelYear === undefined ? undefined : String(vehicle.modelYear),
  ]
    .filter((part): part is string => part !== undefined && part !== "")
    .join(" ");
  if (name !== "") return vehicle.vehicleId === undefined ? name : `${name} (${vehicle.vehicleId})`;
  return vehicle.vehicleId ?? "an unidentified vehicle";
}

/**
 * What the statements are worth, in the order a reader has to hear it.
 *
 * Three separate honestys: no determination at all, a determination the evidence
 * barely supports, and a determination resting on data whose rights or origin are
 * weak (AGENTS 24). A provider that stays silent about all three lets a rule look
 * like a diagnosis.
 */
function caveatsOf(input: AnalysisInput): string[] {
  const vehicle = input.vehicle;
  const caveats: string[] = [];
  if (vehicle?.vehicleId === undefined) {
    caveats.push(
      vehicle?.unresolvedReason === undefined
        ? "No vehicle was determined for this session — every statement is manufacturer-wide."
        : `No vehicle matched (${vehicle.unresolvedReason}) — every statement is manufacturer-wide.`,
    );
  }
  if (vehicle?.score !== undefined && vehicle.score < 0.6) {
    caveats.push(
      `The vehicle match rests on ${Math.round(vehicle.score * 100)} % of the evaluated criteria — treat variant-specific statements as hypotheses.`,
    );
  }
  // Only *claims* that lack a source belong here. An open question (an ECU that never
  // answered, a scan nobody compared) is an absence, not an assertion: it is
  // reported, and it must not cap the confidence of every session that has one —
  // which is every session.
  const claims = (input.evidence?.items ?? []).filter(
    (item) => item.kind !== "gap" && item.evidence.kind === "unproven",
  );
  if (claims.length > 0) {
    caveats.push(
      `${claims.length} statement(s) in this session are unproven: ` +
        `${claims
          .slice(0, 3)
          .map((item) => item.subject)
          .join(", ")}` +
        `${claims.length > 3 ? " …" : ""} — say so in the answer.`,
    );
  }
  if (
    vehicle?.provenanceType === "example-placeholder" ||
    vehicle?.provenanceType === "reverse-engineered" ||
    vehicle?.provenanceType === "community"
  ) {
    caveats.push(`The definition behind the match is "${vehicle.provenanceType}" data.`);
  }
  return caveats;
}

/** Where the wording came from, phrased once — see the module note on scope keys. */
function scopeClause(scope: string | undefined): string {
  if (scope === undefined) return "no scan record carries knowledge for this code";
  if (scope === "package")
    return "manufacturer-wide wording only — nothing variant-specific is documented";
  return "wording of this vehicle's definition";
}

/** Fact plus what the input says about its own reach — no invented certainty. */
function detailOf(dtc: AnalysisDtc): string {
  const parts = [dtc.description ?? "No description available for this code."];
  if (dtc.conditions !== undefined) parts.push(`sets when: ${dtc.conditions}`);
  parts.push(scopeClause(dtc.scope));
  return parts.join(" — ");
}

/** The documented first step, or the honest generic line when nobody documented one. */
function dtcRecommendation(dtc: AnalysisDtc): string {
  const advice = [dtc.hint, measureClause(dtc.measure)].filter(
    (part): part is string => part !== undefined,
  );
  return `${dtc.code} (${dtc.ecu}): ${advice.length > 0 ? advice.join(" — ") : `${dtc.description ?? "diagnose before further use"}`}`;
}

function measureClause(check: AnalysisDtc["measure"]): string | undefined {
  if (check === undefined) return undefined;
  const bounds =
    check.min !== undefined && check.max !== undefined
      ? `${check.min}…${check.max}`
      : check.min !== undefined
        ? `≥ ${check.min}`
        : check.max !== undefined
          ? `≤ ${check.max}`
          : undefined;
  const parts = [
    check.name ?? check.signal,
    check.expect,
    bounds,
    check.windowMs === undefined ? undefined : `${check.windowMs / 1000} s`,
  ]
    .filter((part): part is string => part !== undefined && part !== "")
    .join(" · ");
  // The difference between a step and a hint is whether a number decides it.
  return check.measurable === true
    ? `measure first: ${parts}`
    : `documented check, a person judges it: ${parts}`;
}

/** The severity the input records for a code — "" when no code carries one. */
function dtcSeverityOf(input: AnalysisInput, code: string): string {
  return input.dtcs.find((dtc) => dtc.code === code)?.severity ?? "";
}

/** A check in one line, with the number that decides it — or the note that none does. */
function testClause(test: HypothesisTest): string {
  const bounds =
    test.min !== undefined && test.max !== undefined
      ? `${test.min}…${test.max}`
      : test.min !== undefined
        ? `>= ${test.min}`
        : test.max !== undefined
          ? `<= ${test.max}`
          : undefined;
  const parts = [test.name ?? test.signal, test.expect, bounds].filter(
    (part): part is string => part !== undefined && part !== "",
  );
  return test.measurable
    ? `${parts.join(" · ")}${test.windowMs === undefined ? "" : ` within ${test.windowMs / 1000} s`}`
    : `${parts.join(" · ")} (no numeric bound - a person judges this one)`;
}

function severityOf(severity: string): AnalysisFinding["severity"] {
  switch (severity) {
    case "critical":
    case "major":
    case "minor":
      return severity;
    default:
      return "info";
  }
}

function dedupe(values: readonly string[]): string[] {
  return Array.from(new Set(values));
}

function format(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export type { AnalysisSignalSummary };
