/**
 * Vehicle Identification Number handling (ISO 3779 / ISO 3780).
 *
 * AGENTS 11: store more than a model name, detect the VIN automatically and
 * validate the check digit so a transmission error can be told apart from a
 * genuinely different vehicle.
 */

/** Characters I, O and Q are not used (ISO 3779). */
const FORBIDDEN = /[IOQ]/i;
const VALID_PATTERN = /^[A-HJ-NPR-Z0-9]{17}$/;
/** The same character class without the length anchor — for reporting only. */
const CHARACTER_CLASS = /^[A-HJ-NPR-Z0-9]+$/;

/** Transliteration table for the check digit calculation (ISO 3779 / 49 CFR 565). */
const TRANSLITERATION: Record<string, number> = {
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8,
  J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9,
  S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9,
};

const WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2] as const;

export type VinCheckResult = 'valid' | 'invalid-check-digit' | 'malformed';

export interface VinAnalysis {
  vin: string;
  wellFormed: boolean;
  checkDigit: VinCheckResult;
  /** Position 9 as transmitted. */
  checkDigitChar: string;
  /** Position 9 as computed ("X" for remainder 10). */
  expectedCheckDigitChar: string;
  wmi: string;
  modelYearChar: string;
  plantChar: string;
  serial: string;
  notes: string[];
}

export function isWellFormedVin(candidate: string): boolean {
  const vin = candidate.trim().toUpperCase();
  return vin.length === 17 && VALID_PATTERN.test(vin) && !FORBIDDEN.test(vin);
}

/** Compute the ISO 3779 check digit (position 9). Returns "X" for remainder 10. */
export function computeVinCheckDigit(vin: string): string {
  const normalized = vin.trim().toUpperCase();
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const char = normalized[i] ?? '0';
    const value = /\d/.test(char) ? parseInt(char, 10) : (TRANSLITERATION[char] ?? 0);
    sum += value * (WEIGHTS[i] ?? 0);
  }
  const remainder = sum % 11;
  return remainder === 10 ? 'X' : String(remainder);
}

/**
 * Analyse a VIN.
 *
 * The check digit is mandatory in North America and optional elsewhere, so a
 * mismatch is reported as a finding rather than rejecting the VIN outright —
 * which is exactly the distinction AGENTS 11 asks for.
 */
export function analyseVin(candidate: string): VinAnalysis {
  const vin = candidate.trim().toUpperCase();
  const wellFormed = isWellFormedVin(vin);
  const notes: string[] = [];
  const expected = wellFormed ? computeVinCheckDigit(vin) : '';
  const actual = vin[8] ?? '';

  let checkDigit: VinCheckResult = 'malformed';
  if (wellFormed) {
    checkDigit = actual === expected ? 'valid' : 'invalid-check-digit';
    if (checkDigit === 'invalid-check-digit') {
      notes.push(
        `check digit mismatch: position 9 is "${actual}" but "${expected}" was computed — likely a read/transmission error, or a non-North-American VIN where the check digit is not enforced`,
      );
    }
  } else {
    if (vin.length !== 17) notes.push(`VIN must be 17 characters, got ${vin.length}`);
    if (FORBIDDEN.test(vin)) notes.push('VIN contains I, O or Q which ISO 3779 does not allow');
    // The alphabet question is reported on its own terms: `VALID_PATTERN` mixes
    // length into it, so a 22-character VIN of perfectly legal characters would be
    // told it contains illegal ones — a wrong note is worse than no note when a
    // human reads it back from a stored session.
    if (vin.length > 0 && !CHARACTER_CLASS.test(vin)) notes.push('VIN contains characters outside A-HJ-NPR-Z0-9');
  }

  return {
    vin,
    wellFormed,
    checkDigit,
    checkDigitChar: actual,
    expectedCheckDigitChar: expected,
    wmi: vin.slice(0, 3),
    modelYearChar: vin[9] ?? '',
    plantChar: vin[10] ?? '',
    serial: vin.slice(11),
    notes,
  };
}

/** Model year decoding from position 10 (ISO 3779 / common practice, cycles every 30 years). */
const MODEL_YEAR_CODES: Record<string, number[]> = {
  A: [1980, 2010, 2040], B: [1981, 2011, 2041], C: [1982, 2012, 2042], D: [1983, 2013, 2043],
  E: [1984, 2014, 2044], F: [1985, 2015, 2045], G: [1986, 2016, 2046], H: [1987, 2017, 2047],
  J: [1988, 2018, 2048], K: [1989, 2019, 2049], L: [1990, 2020, 2050], M: [1991, 2021, 2051],
  N: [1992, 2022, 2052], P: [1993, 2023, 2053], R: [1994, 2024, 2054], S: [1995, 2025, 2055],
  T: [1996, 2026, 2056], V: [1997, 2027, 2057], W: [1998, 2028, 2058], X: [1999, 2029, 2059],
  Y: [2000, 2030, 2060], '1': [2001, 2031], '2': [2002, 2032], '3': [2003, 2033],
  '4': [2004, 2034], '5': [2005, 2035], '6': [2006, 2036], '7': [2007, 2037],
  '8': [2008, 2038], '9': [2009, 2039],
};

/** Returns the possible model years (the code repeats every 30 years). */
export function possibleModelYears(modelYearChar: string): number[] {
  return MODEL_YEAR_CODES[modelYearChar.toUpperCase()] ?? [];
}

/** Best guess for the model year given an optional reference year (e.g. first registration). */
export function guessModelYear(modelYearChar: string, referenceYear = new Date().getFullYear()): number | null {
  const candidates = possibleModelYears(modelYearChar);
  if (candidates.length === 0) return null;
  let best = candidates[0] as number;
  for (const candidate of candidates) {
    if (candidate <= referenceYear + 1 && candidate > best) best = candidate;
  }
  return best;
}
