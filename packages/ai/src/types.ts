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

export interface AnalysisDtc {
  code: string;
  description?: string;
  severity: string;
  ecu: string;
  status?: number;
}

export interface AnalysisInput {
  /** Deliberately free of VIN and other personal data unless the caller opted in. */
  vehicle?: { brand?: string; model?: string; modelYear?: number; vin?: string };
  mileageKm?: number;
  signals: readonly AnalysisSignalSummary[];
  dtcs: readonly AnalysisDtc[];
  anomalies: ReadonlyArray<{ signal: string; reason: string; value?: number }>;
  notes: readonly string[];
  question?: string;
}

export interface AnalysisFinding {
  id: string;
  severity: 'info' | 'minor' | 'major' | 'critical';
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
  source: 'heuristic' | 'model' | 'cache';
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
    this.name = 'AnalysisError';
    if (details) this.details = details;
  }
}
