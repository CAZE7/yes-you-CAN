/**
 * The golden-session format (master backlog P0 #10).
 *
 * A golden session is the smallest thing that makes a diagnosis reproducible:
 *
 *   1. the **wire conversation** — the raw frames both directions, as a
 *      `vdp.session` export (raw trace, never a decoded summary),
 *   2. the **circumstances** — adapter, definition package and version, when and
 *      from where it was recorded, and what was redacted before it was stored,
 *   3. the **expectation** — what the platform must conclude from that recording
 *      today: which ECUs answer, which fault codes are stored, which values the
 *      signals carry.
 *
 * Together they turn "worked on the bench" into a fact that can be re-measured:
 * every change to the protocol, the definitions or the decoding runs the same
 * session again and the expectation either still holds or it does not.
 *
 * The format is deliberately plain JSON with a version number, and the version
 * is checked before anything else — a fixture that was written by a newer writer
 * must fail loudly instead of being half-read.
 */

/** Media type of the format, written into every file. */
export const GOLDEN_FORMAT = "vdp.golden";

/** Current format version. Bumping it means old files are refused, not guessed. */
export const GOLDEN_FORMAT_VERSION = 1;

/**
 * What a real VIN is replaced with (AGENTS 24, §21: a session that leaves the
 * workshop is personal data).
 *
 * Exactly 17 characters — the length of a VIN — so the recorded frames keep their
 * length and the ISO-TP conversation stays replayable byte for byte. No letters
 * are used that a VIN check would accept: the placeholder has to be recognisable
 * as one, and `VIN_PATTERN` must not match it.
 */
export const VIN_PLACEHOLDER = "REDACTED-VIN-0000";

/** Characters a VIN may contain (I, O and Q are not used by ISO 3779). */
export const VIN_PATTERN = /\b[A-HJ-NPR-Z0-9]{17}\b/g;

/** Where a recording came from. */
export type GoldenSource = "simulator" | "vehicle" | "bench";

export interface GoldenDefinitionRef {
  /** Package name as the tooling knows it, e.g. `generic`. */
  package: string;
  /** Package version string, e.g. `3.0.0`. */
  version: string;
}

/** What was done to the recording before it was committed. */
export interface GoldenProvenance {
  source: GoldenSource;
  /** ISO-8601 timestamp of the recording. */
  recordedAt: string;
  /** Tool and command that produced the file, for reproducibility. */
  recordedBy: string;
  /** Adapter the session ran on, e.g. `virtual-can` or `elm327`. */
  adapter: string;
  definitions: GoldenDefinitionRef;
  /** Fields that were replaced. Today that is `["vin"]`, never an empty promise. */
  redaction: string[];
  note?: string;
}

/** One ECU the recording is expected to produce. */
export interface GoldenEcuExpectation {
  /** Definition ECU id when the address matched one, e.g. `engine`. */
  ecu: string;
  rxId: number;
  /** True when the expectation is "this ECU is discovered but unusable". */
  unreachable?: boolean;
}

export interface GoldenIdentityExpectation {
  /** The VIN as it appears *after* redaction. */
  vin: string;
  manufacturer?: string;
  model?: string;
  modelYear?: number;
  /**
   * Identity fields the recording derived from the VIN itself (the VIN analysis
   * reads the manufacturer and the model year out of the number).
   *
   * They are kept — they are part of what the session found — but a *redacted*
   * recording cannot reproduce them: the placeholder carries no WMI. The runner
   * reports such a check as skipped with that reason instead of failing or, worse,
   * quietly dropping it.
   */
  vinDerived?: string[];
}

export interface GoldenDtcExpectation {
  ecu: string;
  code: string;
  /** Status byte, or `null` when only presence matters. */
  status: number | null;
}

export interface GoldenSignalExpectation {
  signal: string;
  /** ECU the value must come from, when that matters (`DecodedSignal.ecu`). */
  ecu?: string;
  /** Expected value, when the recording has a single deterministic value. */
  equal?: number | string | boolean;
  min?: number;
  max?: number;
  /** Samples the recording must deliver at least (0 = presence is enough). */
  minSamples?: number;
}

export interface GoldenExpectations {
  ecus: GoldenEcuExpectation[];
  identity?: GoldenIdentityExpectation;
  /** Expected fault memory. An empty array means "no codes at all". */
  dtcs: GoldenDtcExpectation[];
  signals: GoldenSignalExpectation[];
}

/**
 * The recorded session as it is stored inside a golden file.
 *
 * Structurally this is a `vdp.session` export — the same object the workbench
 * writes out — kept as data so a reader can look at the frames without a decoder.
 */
export interface GoldenRecording {
  format: string;
  formatVersion?: number;
  exportedAt?: string;
  meta?: Record<string, unknown>;
  measurements?: unknown[];
  markers?: unknown[];
  dtcs?: unknown[];
  trace: GoldenTraceEntry[];
  log?: unknown[];
}

export interface GoldenTraceEntry {
  t: number;
  canId: number;
  direction: "tx" | "rx";
  /** Payload as hex, no separators (the `vdp.session` export form). */
  payload: string;
  channel?: string;
  extended?: boolean;
  fd?: boolean;
  [key: string]: unknown;
}

/** One golden session: recording + circumstances + expectation. */
export interface GoldenSession {
  format: typeof GOLDEN_FORMAT;
  formatVersion: number;
  /** Stable identifier, also the file name without extension. */
  id: string;
  title: string;
  recording: GoldenRecording;
  expectations: GoldenExpectations;
  provenance: GoldenProvenance;
}

/** One check of a golden run, phrased so a failure states what it compared. */
export interface GoldenCheck {
  name: string;
  ok: boolean;
  expected: string;
  actual: string;
  /** Set for checks that were not applicable (e.g. no expectation present). */
  skipped?: boolean;
}

export interface GoldenRunResult {
  sessionId: string;
  ok: boolean;
  checks: GoldenCheck[];
  /** Observed ECUs of the run, in the IR vocabulary (P0 #6). */
  sessionObservation: import("@vdp/diagnostic-ir").SessionObservation;
  /** Observed fault memory, in the IR vocabulary (P0 #6). */
  dtcObservations: import("@vdp/diagnostic-ir").DtcObservation[];
}
