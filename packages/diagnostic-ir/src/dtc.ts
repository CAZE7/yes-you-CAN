/**
 * Fault-memory observations (master backlog P0 #6; AGENTS 20).
 *
 * Two things are kept apart here that used to be one object (`EnrichedDtc`):
 *
 * - {@link DtcObservation} — what the vehicle said: code, status byte, raw value,
 *   which ECU, when, with which bytes.
 * - {@link DtcEnrichment} — what our knowledge says about it: description, hint,
 *   related signals. Its evidence says whether a definition package actually
 *   documented this code or whether nobody knows it.
 *
 * {@link DtcState} combines both and adds the history of the observation
 * (first/last seen). Keeping the halves separate means a report can say "the ECU
 * reported P0420, and our knowledge base has nothing on it" — instead of a code
 * that looks unexplained because nobody noticed the difference.
 */

import type { Evidence } from "./provenance.js";
import { proven, unproven } from "./provenance.js";

/**
 * ISO 14229-1 status bits (the IR's own vocabulary — this package knows no
 * protocol, which is the point of an intermediate representation).
 */
export interface DtcStatusBits {
  testFailed: boolean;
  testFailedThisOperationCycle: boolean;
  pendingDtc: boolean;
  confirmedDtc: boolean;
  testNotCompletedSinceLastClear: boolean;
  testFailedSinceLastClear: boolean;
  testNotCompletedThisOperationCycle: boolean;
  warningIndicatorRequested: boolean;
}

/**
 * How urgent a code is for the operator (the IR's own words for it).
 *
 * Two parties can answer this: the reader that classified the status byte, and a
 * definition package that documents the code. Neither may be silently preferred —
 * a projection therefore resolves `enrichment.severity ?? observation.severity`,
 * and an observation without a classification keeps it absent instead of
 * defaulting to something reassuring.
 */
export type DtcSeverity = "info" | "minor" | "major" | "critical";

export interface DtcObservation {
  kind: "dtc";
  code: string;
  /** Raw DTC value as reported by the ECU. */
  raw: string;
  failureType: string;
  /** Status byte as received, next to its decomposition. */
  status: number;
  statusBits: DtcStatusBits;
  ecuId: string;
  ecuName: string;
  at: string;
  /** Classification the reader derived from the response — absent when nobody classified. */
  severity?: DtcSeverity;
  /**
   * The DTC status availability mask the ECU sent with this code
   * (ISO 14229-1 §11.3.4.2): which of the eight status bits it implements at all.
   *
   * It belongs to the observation because it changes what the status bits *mean*:
   * a `false` bit inside the mask is a measurement, a `false` bit outside it is
   * silence the ECU never spoke. Reports and evidence can only stay honest about
   * "not confirmed" versus "does not report confirmation" while this travels with
   * the code (ADR 0033: missing evidence is not a negative result). Absent on
   * observations built before the mask was carried, and on stored sessions that
   * predate it — never defaulted to 0xff, which would invent the claim.
   */
  availabilityMask?: number;
  /** Snapshot (freeze frame) bytes, when the ECU sent them (AGENTS 20). */
  snapshot?: Uint8Array;
  /** Extra records the ECU sent with the code, when it sent any. */
  extendedData?: Uint8Array;
  evidence: Evidence;
}

/** A signal the definition relates to a code — an id and its name, nothing inferred. */
export interface RelatedSignal {
  id: string;
  name: string;
}

/**
 * Definition knowledge about a code, with its own provenance: either a package
 * documented it, or it did not — and then that is the observation.
 */
export interface DtcEnrichment {
  kind: "dtc-enrichment";
  code: string;
  ecuId: string;
  description?: string;
  hint?: string;
  /** The package's own urgency, when it declares one. */
  severity?: DtcSeverity;
  relatedSignals?: RelatedSignal[];
  evidence: Evidence;
}

/** Observation + knowledge + history: what a report or a view works with. */
export interface DtcState {
  observation: DtcObservation;
  enrichment?: DtcEnrichment;
  /** First scan that saw this code (AGENTS 20) — absent until the second scan. */
  firstSeen?: string;
  /** Most recent scan that saw this code. */
  lastSeen?: string;
  /** True when the code was absent from the previous scan. */
  firstSeenInThisScan?: boolean;
}

export interface DtcObservationInput {
  code: string;
  raw: string;
  failureType: string;
  status: number;
  statusBits: DtcStatusBits;
  ecuId: string;
  ecuName: string;
  at?: string;
  severity?: DtcSeverity;
  availabilityMask?: number;
  snapshot?: Uint8Array;
  extendedData?: Uint8Array;
  definitionVersion?: string;
}

/** Build a proven observation from a read fault-memory record. */
export function dtcObservation(input: DtcObservationInput): DtcObservation {
  const at = input.at ?? new Date().toISOString();
  return {
    kind: "dtc",
    code: input.code,
    raw: input.raw,
    failureType: input.failureType,
    status: input.status,
    statusBits: input.statusBits,
    ecuId: input.ecuId,
    ecuName: input.ecuName,
    at,
    ...(input.severity !== undefined ? { severity: input.severity } : {}),
    ...(input.availabilityMask !== undefined ? { availabilityMask: input.availabilityMask } : {}),
    ...(input.snapshot !== undefined ? { snapshot: input.snapshot } : {}),
    ...(input.extendedData !== undefined ? { extendedData: input.extendedData } : {}),
    evidence: proven({
      origin: "ecu-response",
      at,
      ecuId: input.ecuId,
      serviceId: 0x19,
      ...(input.raw.length > 0 ? { raw: input.raw } : {}),
      ...(input.definitionVersion !== undefined
        ? { definitionVersion: input.definitionVersion }
        : {}),
    }),
  };
}

export interface DtcEnrichmentInput {
  code: string;
  ecuId: string;
  description?: string;
  hint?: string;
  severity?: DtcSeverity;
  relatedSignals?: RelatedSignal[];
  at?: string;
  definitionVersion?: string;
}

/**
 * Build knowledge evidence for a code.
 *
 * A code without a documented description is *not* an empty enrichment: it is an
 * enrichment whose evidence is unproven, with the reason stating that the
 * definition package has nothing on it (AGENTS 24 — no invented knowledge).
 */
export function dtcEnrichment(input: DtcEnrichmentInput): DtcEnrichment {
  const at = input.at ?? new Date().toISOString();
  const documented =
    input.description !== undefined ||
    input.hint !== undefined ||
    input.severity !== undefined ||
    (input.relatedSignals !== undefined && input.relatedSignals.length > 0);
  return {
    kind: "dtc-enrichment",
    code: input.code,
    ecuId: input.ecuId,
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.hint !== undefined ? { hint: input.hint } : {}),
    ...(input.severity !== undefined ? { severity: input.severity } : {}),
    ...(input.relatedSignals !== undefined ? { relatedSignals: input.relatedSignals } : {}),
    evidence: documented
      ? proven({
          origin: "definition",
          at,
          ...(input.definitionVersion !== undefined
            ? { definitionVersion: input.definitionVersion }
            : {}),
          // The hint is the part a reader acts on, so the evidence line ends with
          // it — a proven provenance without a sentence nobody would read.
          ...(input.hint !== undefined ? { note: input.hint } : {}),
        })
      : unproven("no description, hint, severity or related signal is documented for this code", {
          at,
          ecuId: input.ecuId,
        }),
  };
}

export interface DtcComparison {
  /** Codes present after the change but not before. */
  added: DtcObservation[];
  /** Codes present before but not after. */
  removed: DtcObservation[];
  /** Codes that stayed but changed their status byte. */
  changed: DtcObservation[];
  /** Codes that stayed with an identical status byte. */
  unchanged: DtcObservation[];
}

/**
 * The key a comparison works with: the code **within its ECU**.
 *
 * `P0700` from the engine and `P0700` from the ABS are two observations, and a
 * scan over several ECUs is the normal case, not the exception. Keying on the bare
 * code would report "removed" and "added" for the same code moving between ECUs —
 * so the identity of a fault-memory entry is the pair, everywhere in the platform.
 */
function byEcuAndCode(observations: readonly DtcObservation[]): Map<string, DtcObservation> {
  const map = new Map<string, DtcObservation>();
  for (const observation of observations) map.set(dtcKey(observation), observation);
  return map;
}

/** Identity of one fault-memory entry: ECU and code, code normalised. */
export function dtcKey(observation: Pick<DtcObservation, "ecuId" | "code">): string {
  return `${observation.ecuId}:${observation.code.trim().toUpperCase()}`;
}

/**
 * Compare two fault-memory observations, whatever set of ECUs they cover.
 *
 * This is the platform's only DTC comparison (the clear operation used to carry
 * its own): what survived a clear, what appeared, what changed its status. A code
 * that is still failing legitimately stays — the comparison says *that* it
 * stayed, not that the write failed (AGENTS 25).
 */
export function compareDtcObservations(
  before: readonly DtcObservation[],
  after: readonly DtcObservation[],
): DtcComparison {
  const beforeByKey = byEcuAndCode(before);
  const afterByKey = byEcuAndCode(after);
  const comparison: DtcComparison = { added: [], removed: [], changed: [], unchanged: [] };
  for (const [key, previous] of beforeByKey) {
    const current = afterByKey.get(key);
    if (!current) {
      comparison.removed.push(previous);
      continue;
    }
    if (current.status === previous.status) comparison.unchanged.push(current);
    else comparison.changed.push(current);
  }
  for (const [key, current] of afterByKey) {
    if (!beforeByKey.has(key)) comparison.added.push(current);
  }
  return comparison;
}
