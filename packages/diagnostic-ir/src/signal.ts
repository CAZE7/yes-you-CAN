/**
 * Signal observations (master backlog P0 #6; AGENTS 14).
 *
 * A measurement is one of two things, and they are different types:
 *
 * - {@link SignalReading} — an ECU answered, here is the value and how it was
 *   derived (raw bytes, scaling, unit, whether it is inside the declared range),
 * - {@link SignalGap} — nobody could read it, here is why.
 *
 * The distinction is the data-level twin of ADR 0030 ("missing evidence is a
 * failure"). Before this package, a failed read was represented by *nothing at
 * all* — the signal simply did not appear in the list, which is how a broken
 * sensor and a broken cable look the same in a report.
 */

import type { Evidence, Unproven } from "./provenance.js";
import { proven, unproven } from "./provenance.js";

/** Physical value a decoding rule produces. */
export type ObservationValue = number | string | boolean;

export interface SignalReading {
  kind: "signal";
  signalId: string;
  /** Human-readable name from the definition, absent when the signal is unknown. */
  name?: string;
  ecuId: string;
  did: number;
  /** Raw bytes as received — always kept (AGENTS 14/17). */
  raw: Uint8Array;
  rawHex: string;
  /** Value before scale/offset, as the definition decoded it. */
  rawValue: ObservationValue;
  /** Physical value after scale/offset. */
  value: ObservationValue;
  unit?: string;
  /** Enum text when the raw value matched an enumerated mapping. */
  enumText?: string;
  /** True when the physical value is outside the declared min/max range. */
  outOfRange: boolean;
  /** When the vehicle produced this value (ISO-8601). */
  at: string;
  evidence: Evidence;
}

/**
 * A signal that could not be observed. It keeps the identity of what was *asked*
 * for, so a report can name the missing measurement instead of dropping it.
 */
export interface SignalGap {
  kind: "signal-gap";
  signalId: string;
  name?: string;
  ecuId?: string;
  did?: number;
  /** Operator-facing reason: what was attempted and what happened. */
  reason: string;
  at: string;
  evidence: Unproven;
}

/** One signal of one ECU: a reading or a named gap. */
export type SignalObservation = SignalReading | SignalGap;

export interface SignalReadingInput {
  signalId: string;
  name?: string;
  ecuId: string;
  did: number;
  raw: Uint8Array;
  rawHex: string;
  rawValue: ObservationValue;
  value: ObservationValue;
  unit?: string;
  enumText?: string;
  outOfRange: boolean;
  at?: string;
  definitionVersion?: string;
  note?: string;
}

/** Build a proven reading — the ECU answered and the definition decoded it. */
export function signalReading(input: SignalReadingInput): SignalReading {
  const at = input.at ?? new Date().toISOString();
  return {
    kind: "signal",
    signalId: input.signalId,
    ...(input.name !== undefined ? { name: input.name } : {}),
    ecuId: input.ecuId,
    did: input.did,
    raw: input.raw,
    rawHex: input.rawHex,
    rawValue: input.rawValue,
    value: input.value,
    ...(input.unit !== undefined ? { unit: input.unit } : {}),
    ...(input.enumText !== undefined ? { enumText: input.enumText } : {}),
    outOfRange: input.outOfRange,
    at,
    evidence: proven({
      origin: "ecu-response",
      at,
      ecuId: input.ecuId,
      did: input.did,
      raw: input.rawHex,
      ...(input.definitionVersion !== undefined
        ? { definitionVersion: input.definitionVersion }
        : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
    }),
  };
}

export interface SignalGapInput {
  signalId: string;
  name?: string;
  ecuId?: string;
  did?: number;
  reason: string;
  at?: string;
}

/** Build a gap: the observation that is missing, with the reason it is missing. */
export function signalGap(input: SignalGapInput): SignalGap {
  const at = input.at ?? new Date().toISOString();
  return {
    kind: "signal-gap",
    signalId: input.signalId,
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.ecuId !== undefined ? { ecuId: input.ecuId } : {}),
    ...(input.did !== undefined ? { did: input.did } : {}),
    reason: input.reason,
    at,
    evidence: unproven(input.reason, {
      at,
      ...(input.ecuId !== undefined ? { ecuId: input.ecuId } : {}),
      ...(input.did !== undefined ? { did: input.did } : {}),
    }),
  };
}

/** Readings only — the projection most callers want. */
export function readings(observations: readonly SignalObservation[]): SignalReading[] {
  return observations.filter((entry): entry is SignalReading => entry.kind === "signal");
}

/** Gaps only — what a report has to show as missing (never silently dropped). */
export function gaps(observations: readonly SignalObservation[]): SignalGap[] {
  return observations.filter((entry): entry is SignalGap => entry.kind === "signal-gap");
}
