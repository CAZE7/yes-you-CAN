/**
 * Evidence bookkeeping for vehicle resolution (AGENTS 11, 13).
 *
 * Split out of `resolve.ts` on purpose: the resolver walks the definitions, this
 * module owns *how a criterion counts*. Keeping the weights, the tally and the
 * ordering rule in one place is what makes a resolution explainable — every
 * number a candidate shows is produced here, and every rule here has a test.
 */

import type { Provenance } from "./schema.js";

/** Every criterion the resolver can weigh, named the way a report shows it. */
export type EvidenceKind =
  | "vin-wmi"
  | "vin-vds"
  | "vin-model-year"
  | "vin-plant"
  | "declared-model-year"
  | "declared-oem"
  | "declared-brand"
  | "declared-model"
  | "declared-platform"
  | "part-number"
  | "software-version"
  | "hardware-version"
  | "powertrain-code"
  | "ecu-coverage"
  | "ecu-not-in-vehicle"
  | "unexpected-ecu";

/**
 * How much a criterion counts.
 *
 * Deliberately ordered by how hard the evidence is to come by: a part number read
 * from the ECU (4) beats a WMI from the VIN (3), which beats a model year a user
 * typed in (1). The numbers are relative, not probabilities — they only ever
 * matter as `support / evaluated`, so the absolute scale is free.
 */
export const EVIDENCE_WEIGHT: Readonly<Record<EvidenceKind, number>> = {
  "part-number": 4,
  "vin-wmi": 3,
  "powertrain-code": 3,
  "ecu-coverage": 3,
  "vin-vds": 2,
  "software-version": 2,
  "declared-model": 2,
  "unexpected-ecu": 2,
  "vin-model-year": 1,
  "vin-plant": 1,
  "hardware-version": 1,
  "declared-model-year": 1,
  "declared-oem": 1,
  "declared-brand": 1,
  "declared-platform": 1,
  "ecu-not-in-vehicle": 1,
};

/** One piece of reasoning — identical shape whether it supports or contradicts. */
export interface ResolutionEvidence {
  kind: EvidenceKind;
  /** What was observed on the bus or declared by the user. */
  observed: string;
  /** What the definition expected. */
  expected: string;
  /** Weight this criterion carried (fractional for coverage ratios). */
  weight: number;
  /** Human readable, one sentence — this is what the UI and the AI layer show. */
  reason: string;
}

/**
 * How far a provenance type can be trusted (ADR 0003, AGENTS 24).
 *
 * Used as a tie-break, never as a score multiplier: placeholder data with strong
 * evidence still has strong evidence, but it must not outrank real data that
 * explains the same observations.
 */
export function provenanceTrust(provenance: Provenance): number {
  switch (provenance.sourceType) {
    case "own":
    case "standard":
    case "licensed":
      return 1;
    case "community":
      return 0.8;
    case "reverse-engineered":
      return 0.6;
    case "example-placeholder":
      return 0.3;
  }
}

/** Accumulator for one candidate: evidence, conflicts and the three weights. */
export class Tally {
  readonly evidence: ResolutionEvidence[] = [];
  readonly conflicts: ResolutionEvidence[] = [];
  support = 0;
  conflict = 0;
  evaluated = 0;

  /** A criterion with an observation: it either supports or contradicts. */
  weigh(kind: EvidenceKind, observed: string, expected: string, reason: string, ok: boolean): void {
    const weight = EVIDENCE_WEIGHT[kind];
    this.evaluated += weight;
    const entry: ResolutionEvidence = { kind, observed, expected, weight, reason };
    if (ok) {
      this.support += weight;
      this.evidence.push(entry);
    } else {
      this.conflict += weight;
      this.conflicts.push(entry);
    }
  }

  /** A criterion that can only ever support: absence proves nothing. */
  credit(kind: EvidenceKind, observed: string, expected: string, reason: string): void {
    const weight = EVIDENCE_WEIGHT[kind];
    this.evaluated += weight;
    this.support += weight;
    this.evidence.push({ kind, observed, expected, weight, reason });
  }

  /** A penalty that does not correspond to a declared criterion. */
  penalise(kind: EvidenceKind, observed: string, expected: string, reason: string): void {
    const weight = EVIDENCE_WEIGHT[kind];
    this.conflict += weight;
    this.conflicts.push({ kind, observed, expected, weight, reason });
  }

  /** Partial credit, e.g. the share of expected ECUs that answered. */
  creditFraction(
    kind: EvidenceKind,
    fraction: number,
    observed: string,
    expected: string,
    reason: string,
  ): void {
    const weight = EVIDENCE_WEIGHT[kind];
    const gained = round2(weight * clamp01(fraction));
    this.evaluated += weight;
    this.support += gained;
    this.evidence.push({ kind, observed, expected, weight: gained, reason });
  }

  /** `(support − conflict) / evaluated`, clamped — 0 when nothing was evaluated. */
  score(): number {
    return this.evaluated > 0
      ? round2(clamp01((this.support - this.conflict) / this.evaluated))
      : 0;
  }

  weights(): { support: number; conflict: number; evaluated: number } {
    return {
      support: round2(this.support),
      conflict: round2(this.conflict),
      evaluated: round2(this.evaluated),
    };
  }
}

/** The fields the ordering needs — a narrow view so this stays reusable. */
export interface Rankable {
  score: number;
  trust: number;
  /** Absolute amount of supporting evidence (breaks "few criteria, all green"). */
  support: number;
  /** Expected ECUs that answered. */
  matched: number;
  conflicts: number;
  packageKey: string;
  vehicleId: string;
}

/**
 * Deterministic ordering: evidence first, then how far the data can be trusted,
 * then the absolute amount of evidence, then coverage, then fewer conflicts, and
 * finally the ids so two runs cannot differ (AGENTS 31).
 */
export function compareByEvidence(a: Rankable, b: Rankable): number {
  if (b.score !== a.score) return b.score - a.score;
  if (b.trust !== a.trust) return b.trust - a.trust;
  if (b.support !== a.support) return b.support - a.support;
  if (b.matched !== a.matched) return b.matched - a.matched;
  if (a.conflicts !== b.conflicts) return a.conflicts - b.conflicts;
  const byKey = a.packageKey.localeCompare(b.packageKey);
  return byKey !== 0 ? byKey : a.vehicleId.localeCompare(b.vehicleId);
}

export function sameText(a: string, b: string): boolean {
  return a.trim().toUpperCase() === b.trim().toUpperCase();
}

export function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}
