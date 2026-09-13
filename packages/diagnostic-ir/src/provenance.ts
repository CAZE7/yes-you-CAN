/**
 * Provenance and evidence (master backlog P0 #6, AGENTS 24).
 *
 * Every observation in this package carries where it came from and when. That is
 * not bookkeeping for its own sake: an unproven observation is the data-level
 * form of the rule "missing evidence is a failure" (ADR 0030, P0 #5) — a signal
 * that nobody could read is a {@link SignalGap}, not a signal with a missing
 * value. Reports (§21), the evidence engine (#41) and the AI layer (§22) all need
 * exactly this distinction, and they need it in one vocabulary.
 *
 * Nothing here performs I/O. An observation is built by whoever read the vehicle
 * (core) and is consumed by whoever projects it (runtime, reports, storage).
 */

/** Where an observation came from. */
export type ObservationOrigin = "ecu-response" | "definition" | "operator" | "derived";

/**
 * The full record of one observation's origin (AGENTS 17 logging, §24 data
 * provenance). `at` is the moment the observation is *about*, not the moment it
 * was written down.
 */
export interface Provenance {
  origin: ObservationOrigin;
  /** ISO-8601 timestamp of the observation. */
  at: string;
  /** ECU that produced the value, when a vehicle was asked. */
  ecuId?: string;
  /** Data identifier the value came from, when a read produced it. */
  did?: number;
  /** UDS/KWP service id, when a service call produced it. */
  serviceId?: number;
  /** Definition package version the value was interpreted with (§13). */
  definitionVersion?: string;
  /** Raw bytes the value was derived from, as hex — always kept (AGENTS 14/17). */
  raw?: string;
  /** Free-form note for the audit trail (e.g. "re-read after a clear"). */
  note?: string;
}

/**
 * Proven evidence: somebody read this, from this ECU, at this time.
 *
 * It is a distinct type instead of an optional field so that "proven" cannot be
 * forgotten: code that needs a value has to narrow the evidence first.
 */
export interface Proven {
  kind: "proven";
  provenance: Provenance;
}

/**
 * Missing evidence: the value is unknown, and *why* is part of the observation.
 *
 * A gap is data, not an absence of data. `reason` is written for an operator
 * ("the ECU did not answer the DID read"), not for a stack trace.
 */
export interface Unproven {
  kind: "unproven";
  reason: string;
  /** ISO-8601 timestamp of the failed attempt. */
  at: string;
  ecuId?: string;
  did?: number;
  serviceId?: number;
}

/** Evidence for one observation: proven or unproven, never "assumed". */
export type Evidence = Proven | Unproven;

/** Build proven evidence; `at` defaults to now so callers cannot forget it. */
export function proven(provenance: Omit<Provenance, "at"> & { at?: string }): Proven {
  return {
    kind: "proven",
    provenance: { ...provenance, at: provenance.at ?? new Date().toISOString() },
  };
}

/** Build unproven evidence — the honest form of "we do not know". */
export function unproven(
  reason: string,
  options: { at?: string; ecuId?: string; did?: number; serviceId?: number } = {},
): Unproven {
  return {
    kind: "unproven",
    reason,
    at: options.at ?? new Date().toISOString(),
    ...(options.ecuId !== undefined ? { ecuId: options.ecuId } : {}),
    ...(options.did !== undefined ? { did: options.did } : {}),
    ...(options.serviceId !== undefined ? { serviceId: options.serviceId } : {}),
  };
}

/** Narrowing helper: does this piece of evidence carry a value? */
export function isProven(evidence: Evidence): evidence is Proven {
  return evidence.kind === "proven";
}

/** One line for logs, reports and audit trails — never an empty string. */
export function describeEvidence(evidence: Evidence): string {
  if (evidence.kind === "proven") {
    const { origin, at, ecuId, did, definitionVersion, note } = evidence.provenance;
    const parts = [origin, at];
    if (ecuId !== undefined) parts.push(ecuId);
    if (did !== undefined) parts.push(`DID 0x${did.toString(16).toUpperCase()}`);
    if (definitionVersion !== undefined) parts.push(`def ${definitionVersion}`);
    if (note !== undefined) parts.push(note);
    return parts.join(" · ");
  }
  const location = evidence.ecuId !== undefined ? ` (${evidence.ecuId})` : "";
  return `not proven${location}: ${evidence.reason}`;
}
