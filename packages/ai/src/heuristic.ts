/**
 * Local heuristic analysis provider.
 *
 * Runs entirely in-process, so it works offline and never leaves personal data
 * behind. Rules are explicit and testable — every finding states the numeric
 * evidence it is based on.
 */

import type {
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
        detail: dtc.description ?? "No description available for this code.",
        ...(dtc.code ? { relatedDtcs: [dtc.code] } : {}),
      });
      if (dtc.severity === "critical" || dtc.severity === "major") {
        recommendations.push(
          `${dtc.code} (${dtc.ecu}): ${dtc.description ?? "diagnose before further use"}`,
        );
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

    return {
      provider: this.id,
      summary: summarise(input, findings),
      findings,
      recommendations: dedupe(recommendations),
      confidence: findings.every((finding) => finding.severity === "info") ? 0.55 : 0.4,
      source: "heuristic",
      generatedAt: new Date().toISOString(),
      warnings: ["Heuristic analysis is rule based — it is a hint, not a diagnosis."],
    };
  }
}

function summarise(input: AnalysisInput, findings: AnalysisFinding[]): string {
  const critical = findings.filter((finding) => finding.severity === "critical").length;
  const parts = [
    `${input.dtcs.length} fault code(s)`,
    `${input.signals.length} signal(s) analysed`,
    `${findings.length} finding(s)`,
  ];
  const head = critical > 0 ? `${critical} critical finding(s).` : "No critical findings.";
  return `${head} Recorded: ${parts.join(", ")}.`;
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
