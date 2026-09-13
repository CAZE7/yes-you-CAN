/**
 * AI analysis contracts (AGENTS 22).
 *
 * The provider is swappable: a local heuristic provider ships in the box, and an
 * HTTP provider forwards to any model gateway. Nothing else in the platform may
 * depend on a specific provider.
 */

export interface AnalysisSignalSummary {
  signal: string;
  name: string;
  unit?: string;
  samples: number;
  min: number;
  max: number;
  average: number;
  delta: number;
  outOfRangeCount: number;
}

/**
 * The one measurement a definition package documents for this code and variant.
 *
 * `measurable` is the load-bearing field: only with a numeric bound or a window can
 * the engine call it a step to run; without one it stays a check a person judges, and
 * the wording has to keep that difference (AGENTS 22: no false certainty).
 */
export interface AnalysisCheck {
  signal: string;
  name?: string;
  expect?: string;
  min?: number;
  max?: number;
  windowMs?: number;
  measurable?: boolean;
}

export interface AnalysisDtc {
  code: string;
  description?: string;
  severity: string;
  ecu: string;
  status?: number;
  /** Suggested next step as the package words it — absent means nobody wrote one. */
  hint?: string;
  /**
   * Where the wording came from: `vehicle-engine` | `vehicle-gearbox` | `vehicle` |
   * `package`, or absent when no scan record carries knowledge for this code.
   */
  scope?: string;
  /** When the code sets — only variant knowledge documents this. */
  conditions?: string;
  /** The first documented check, most specific first. */
  measure?: AnalysisCheck;
}

export interface AnalysisInput {
  /**
   * Which vehicle this is about. Deliberately free of VIN and other personal data
   * unless the caller opted in — an HTTP provider sends this object off the box.
   *
   * `vehicleId`/`score`/`trust`/`provenanceType` come from the session determination
   * (AGENTS 11.1, ADR 0026). They are here because an answer that does not say which
   * variant it assumes is a manufacturer-wide guess wearing a diagnosis's clothes, and
   * because a weak match has to lower confidence instead of hiding.
   */
  vehicle?: {
    brand?: string;
    model?: string;
    modelYear?: number;
    vin?: string;
    vehicleId?: string;
    /** 0…1 — share of the evaluated criteria that confirmed the match. */
    score?: number;
    /** 0…1 — provenance trust of the data behind the match. */
    trust?: number;
    provenanceType?: string;
    /** Set when the resolution came back without a match (§11.1 rule 3). */
    unresolvedReason?: string;
  };
  mileageKm?: number;
  signals: readonly AnalysisSignalSummary[];
  dtcs: readonly AnalysisDtc[];
  anomalies: ReadonlyArray<{ signal: string; reason: string; value?: number }>;
  notes: readonly string[];
  question?: string;
}

export interface AnalysisFinding {
  id: string;
  severity: "info" | "minor" | "major" | "critical";
  title: string;
  detail: string;
  relatedSignals?: string[];
  relatedDtcs?: string[];
}

export interface AnalysisResult {
  provider: string;
  model?: string;
  summary: string;
  findings: AnalysisFinding[];
  recommendations: string[];
  /** Confidence in [0, 1]; heuristic results are conservative. */
  confidence: number;
  /** Provenance so the UI can label AI output as such. */
  source: "heuristic" | "model" | "cache";
  generatedAt: string;
  warnings?: string[];
}

export interface AnalysisProvider {
  readonly id: string;
  readonly label: string;
  /** Providers that send data off-box must say so. */
  readonly sendsDataOffBox: boolean;
  analyze(input: AnalysisInput): Promise<AnalysisResult>;
}

export class AnalysisError extends Error {
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "AnalysisError";
    if (details) this.details = details;
  }
}
