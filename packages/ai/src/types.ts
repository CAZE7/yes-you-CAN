/**
 * AI analysis contracts (AGENTS 22).
 *
 * The provider is swappable: a local heuristic provider ships in the box, and an
 * HTTP provider forwards to any model gateway. Nothing else in the platform may
 * depend on a specific provider.
 *
 * What a provider may *read* is the diagnostic IR: the evidence set and the ranked
 * hypotheses are the whole factual input, and neither names a request, a DID to
 * write or a service to call (AGENTS 22, master backlog P0 #16 — an analysis
 * proposes, the write chain decides). `@vdp/ai` may import `@vdp/shared` and
 * `@vdp/diagnostic-ir` and nothing else, which the dependency rule enforces.
 */

import type {
  DiscriminatingTest,
  EvidenceSet,
  GuidedDiagnosisState,
  Hypothesis,
} from "@vdp/diagnostic-ir";

/**
 * The scenario a session was recorded against, if any (master prompt §14).
 *
 * A reproducible experiment has a name and a seed, and an answer that does not
 * say which script was running reads like field data. Nothing here is invented:
 * the caller passes the file/catalog id and the declared determinism, or passes
 * nothing and the field stays absent.
 */
export interface AnalysisScenario {
  id: string;
  title?: string;
  /** The seed a scenario file declared; absent when the runner named none. */
  seed?: number;
}

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

/**
 * What backs one statement about a code, in the shape an analysis can act on.
 *
 * `proven` is a boolean instead of a rule over the text, because "the package
 * documented this" versus "nobody knows this code" changes what may be claimed — and
 * because an answer built by reading the wording would be a second parser of a
 * sentence the IR already owns. `line` is that sentence, quoted unchanged.
 */
export interface AnalysisEvidence {
  proven: boolean;
  line: string;
  /** The id in `AnalysisInput.evidence` this claim corresponds to, when it has one. */
  itemId?: string;
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
  /** The IR's own verdict on how well the wording above is sourced (P0 #39). */
  evidence?: AnalysisEvidence;
}

/**
 * The versions an answer was produced under (P0 #42, AGENTS 13).
 *
 * Three plus one field, because those are what can make the same session answer
 * differently: the prompt wording, the platform build, the definition package the
 * codes were interpreted with, and the knowledge versions behind a variant statement.
 * The *transport* is deliberately absent: a different cable changes what was
 * measured, and what was measured is in the evidence set.
 */
export interface AnalysisVersions {
  promptVersion: string;
  runtimeVersion: string;
  /** `oem@version` of the definition package the session was recorded with. */
  definitionVersion?: string;
  /** Every definition package that was loaded, as `oem@version`. */
  packageVersions?: readonly string[];
}

/**
 * What an answer rests on — the part a reader checks before acting on it.
 *
 * `evidence` are item ids of the set that was handed in. A finding without citations
 * is allowed (an observation about the recording as a whole), but a *provider that
 * cites* can be checked: opening the id in the set shows the statement behind it.
 */
export interface AnalysisProvenance extends AnalysisVersions {
  provider: string;
  model?: string;
  /** Item ids of the evidence the answer was built from — empty means "from none". */
  evidence: readonly string[];
  /**
   * Which recording the answer was about (P0 #42: reproducibility). It travels in
   * the provenance, not the summary text, because a reader needs a pointer to
   * open, not a sentence to trust — and, like the versions, it comes from the
   * request, never from the answer.
   */
  recordingId?: string;
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
  /**
   * The session's evidence set (P0 #39). Absent means the caller has none: an
   * answer then says so, because reasoning without a source list is reasoning an
   * auditor cannot follow.
   */
  evidence?: EvidenceSet;
  /** Documented patterns, judged against the recording (P0 #40). */
  hypotheses?: readonly Hypothesis[];
  /**
   * The loop state the session was evaluated in (ADR 0056): which hypothesis
   * leads, which test reduces the uncertainty the most, how many steps ran.
   * Assembled once by the runtime — a provider cites it, it does not re-derive
   * it, and an answer without one says so by not carrying the field.
   */
  diagnosis?: GuidedDiagnosisState;
  /**
   * Which session/recording these observations came from (master prompt §14).
   * An answer that cannot say which recording it read cannot be re-asked; the
   * field is the pointer, the provenance repeats it where a reader looks.
   */
  recordingId?: string;
  /** The scenario the session was driven by, if a script was on the bench (§14). */
  scenario?: AnalysisScenario;
  versions?: AnalysisVersions;
}

export interface AnalysisFinding {
  id: string;
  severity: "info" | "minor" | "major" | "critical";
  title: string;
  detail: string;
  relatedSignals?: string[];
  relatedDtcs?: string[];
  /**
   * Evidence item ids this finding rests on (see {@link AnalysisProvenance}).
   * Unknown ids are dropped by the provider that parses an outside answer — a
   * citation to something that does not exist is not a citation.
   */
  basedOn?: readonly string[];
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
  /** Versions and citations, so the same question can be asked again (P0 #42). */
  provenance?: AnalysisProvenance;
  /**
   * The next test, machine-readable (P0 #40, master prompt §13/§14).
   *
   * The prose recommendation says it in a sentence; this names the hypothesis it
   * discriminates and the documented check — and it only ever references what the
   * input offered: a provider cannot invent a test the definition package did not
   * document, and a `hypothesisId` outside the input is dropped, like a citation
   * to a missing item.
   */
  nextTest?: DiscriminatingTest;
  /**
   * The loop state the answer was judged in (ADR 0056), machine-readable:
   * the leading hypothesis with its for/against evidence, the test that
   * reduces the uncertainty the most (with the number) and how many steps ran.
   * It travels with the answer the way `nextTest` does — derived from the
   * input, never from the wording of the answer, and dropped whole when an
   * outside answer references what the input did not offer.
   */
  diagnosis?: GuidedDiagnosisState;
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
