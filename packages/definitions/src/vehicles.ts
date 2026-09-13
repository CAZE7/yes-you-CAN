/**
 * Vehicle-level matching primitives (AGENTS 11, 13).
 *
 * These are the only VIN operations the definitions layer performs, and they are
 * deliberately trivial: cutting a VIN into its ISO 3779 *positions* and comparing
 * them against what a definition declares. Validation, check-digit arithmetic and
 * the model-year century logic stay in `@vdp/core/vehicle/vin.ts` — the resolver
 * works on facts handed to it, so `definitions` keeps importing nothing but
 * `shared` (ADR 0002) and cannot drift into a second VIN implementation.
 */

import type { VinMatcher } from "./schema.js";

/** VIN positions, as far as they are available and trusted by the caller. */
export interface VinFacts {
  /** The VIN as read (normalised: trimmed, upper case). */
  vin: string;
  /** Positions 1–3 (ISO 3780 World Manufacturer Identifier). */
  wmi?: string;
  /** Positions 4–8 (Vehicle Descriptor Section). */
  vds?: string;
  /**
   * Position 10. Left `undefined` when the caller does not treat it as a model
   * year — European VINs before 2010 use the position freely (ISO 3779 allows
   * it), and a resolver must not turn that into evidence against a vehicle.
   */
  modelYearChar?: string;
  /** Position 11 (assembly plant). */
  plantChar?: string;
  /** Positions 12–17 (serial). */
  serial?: string;
}

/** ISO 3779 positions, 0-based. Exported so callers and tests agree on the cut. */
export const VIN_POSITIONS = {
  wmi: { start: 0, end: 3 },
  vds: { start: 3, end: 8 },
  checkDigit: 8,
  modelYear: 9,
  plant: 10,
  serial: { start: 11, end: 17 },
} as const;

/**
 * Cut a VIN into its positions.
 *
 * Nothing is validated here: a short or malformed VIN simply yields fewer facts.
 * That is what makes the resolver safe on real buses, where an ECU may answer
 * F190 with 17 characters, with padding, or with a fragment.
 */
export function vinPositions(vin: string): VinFacts {
  const normalised = vin.trim().toUpperCase();
  const facts: VinFacts = { vin: normalised };
  const slice = (start: number, end: number): string | undefined =>
    normalised.length >= end ? normalised.slice(start, end) : undefined;

  const wmi = slice(VIN_POSITIONS.wmi.start, VIN_POSITIONS.wmi.end);
  if (wmi) facts.wmi = wmi;
  const vds = slice(VIN_POSITIONS.vds.start, VIN_POSITIONS.vds.end);
  if (vds) facts.vds = vds;
  const modelYearChar = normalised.charAt(VIN_POSITIONS.modelYear);
  if (modelYearChar) facts.modelYearChar = modelYearChar;
  const plantChar = normalised.charAt(VIN_POSITIONS.plant);
  if (plantChar) facts.plantChar = plantChar;
  const serial = slice(VIN_POSITIONS.serial.start, VIN_POSITIONS.serial.end);
  if (serial) facts.serial = serial;
  return facts;
}

/**
 * Position-for-position pattern comparison: `.` (and `?`) match any single
 * character, everything else matches itself, case-insensitively. Lengths must be
 * equal — a pattern is never a prefix search, so a five-character VDS pattern
 * cannot accidentally accept a four-character answer.
 */
export function matchesPattern(value: string, pattern: string): boolean {
  if (value.length !== pattern.length) return false;
  const left = value.toUpperCase();
  const right = pattern.toUpperCase();
  for (let i = 0; i < right.length; i += 1) {
    const expected = right.charAt(i);
    if (expected === "." || expected === "?") continue;
    if (left.charAt(i) !== expected) return false;
  }
  return true;
}

/** Case-insensitive membership test — identification answers differ in case by ECU. */
export function containsValue(
  value: string | undefined,
  list: readonly string[] | undefined,
): boolean {
  if (!value || !list || list.length === 0) return false;
  const needle = value.trim().toUpperCase();
  return list.some((entry) => entry.trim().toUpperCase() === needle);
}

/**
 * Find the declared token that appears inside a read identification value.
 *
 * Real F187/F191 answers are rarely just the part number — "03C906025AB   0001"
 * or "H04 03C906025AB" are typical. Matching the *token inside the answer* is
 * what makes identification evidence usable without a manufacturer-specific
 * answer parser, and returning the token keeps the evidence explainable.
 */
export function findToken(
  value: string | undefined,
  tokens: readonly string[] | undefined,
): string | undefined {
  if (!value || !tokens || tokens.length === 0) return undefined;
  const haystack = value.trim().toUpperCase();
  if (!haystack) return undefined;
  for (const token of tokens) {
    const needle = token.trim().toUpperCase();
    // A blank token would match everything; it is a data error the validator reports.
    if (needle.length > 0 && haystack.includes(needle)) return token;
  }
  return undefined;
}

/** The VIN criteria a matcher declares, in the order the resolver reports them. */
export function declaredVinCriteria(matcher: VinMatcher | undefined): (keyof VinMatcher)[] {
  if (!matcher) return [];
  const criteria: (keyof VinMatcher)[] = [];
  if (matcher.wmi && matcher.wmi.length > 0) criteria.push("wmi");
  if (matcher.vdsPattern) criteria.push("vdsPattern");
  if (matcher.modelYearChars && matcher.modelYearChars.length > 0) criteria.push("modelYearChars");
  if (matcher.plantChars && matcher.plantChars.length > 0) criteria.push("plantChars");
  return criteria;
}
