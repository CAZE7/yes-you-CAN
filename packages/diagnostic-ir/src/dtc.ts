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
  /** Snapshot (freeze frame) bytes, when the ECU sent them (AGENTS 20). */
  snapshot?: Uint8Array;
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
  snapshot?: Uint8Array;
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
    ...(input.snapshot !== undefined ? { snapshot: input.snapshot } : {}),
    evidence: proven({
      origin: "ecu-response",
      at,
      ecuId: input.ecuId,
      serviceId: 0x19,
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
    (input.relatedSignals !== undefined && input.relatedSignals.length > 0);
  return {
    kind: "dtc-enrichment",
    code: input.code,
    ecuId: input.ecuId,
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.hint !== undefined ? { hint: input.hint } : {}),
    ...(input.relatedSignals !== undefined ? { relatedSignals: input.relatedSignals } : {}),
    evidence: documented
      ? proven({
          origin: "definition",
          at,
          ...(input.definitionVersion !== undefined
            ? { definitionVersion: input.definitionVersion }
            : {}),
          ...(input.hint !== undefined ? { note: input.hint } : {}),
        })
      : unproven("no description, hint or related signal is documented for this code", {
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

/** Codes of a set, in a stable order — the key a comparison works with. */
function byCode(observations: readonly DtcObservation[]): Map<string, DtcObservation> {
  const map = new Map<string, DtcObservation>();
  for (const observation of observations) map.set(observation.code, observation);
  return map;
}

/**
 * Compare two fault-memory observations of the same ECU.
 *
 * This is the IR's own comparison (the clear operation used to carry it): what
 * survived a clear, what appeared, what changed its status. A code that is still
 * failing legitimately stays — the comparison says *that* it stayed, not that the
 * write failed (AGENTS 25).
 */
export function compareDtcObservations(
  before: readonly DtcObservation[],
  after: readonly DtcObservation[],
): DtcComparison {
  const beforeByCode = byCode(before);
  const afterByCode = byCode(after);
  const comparison: DtcComparison = { added: [], removed: [], changed: [], unchanged: [] };
  for (const [code, previous] of beforeByCode) {
    const current = afterByCode.get(code);
    if (!current) {
      comparison.removed.push(previous);
      continue;
    }
    if (current.status === previous.status) comparison.unchanged.push(current);
    else comparison.changed.push(current);
  }
  for (const [code, current] of afterByCode) {
    if (!beforeByCode.has(code)) comparison.added.push(current);
  }
  return comparison;
}
