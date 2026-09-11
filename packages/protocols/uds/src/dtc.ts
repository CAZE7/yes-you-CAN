/**
 * DTC encoding/decoding (ISO 14229-1 §10 and Annex C, DTC status byte §8.3).
 *
 * A DTC is transmitted as three bytes: [high, low, failureType].
 * The 5-character code (e.g. P0420) is derived from the first two bytes.
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

const STATUS_BIT_ORDER = [
  "testFailed",
  "testFailedThisOperationCycle",
  "pendingDtc",
  "confirmedDtc",
  "testNotCompletedSinceLastClear",
  "testFailedSinceLastClear",
  "testNotCompletedThisOperationCycle",
  "warningIndicatorRequested",
] as const;

export function decodeDtcStatus(status: number): DtcStatusBits {
  const bit = (index: number): boolean => ((status >> index) & 0x01) === 1;
  return {
    testFailed: bit(0),
    testFailedThisOperationCycle: bit(1),
    pendingDtc: bit(2),
    confirmedDtc: bit(3),
    testNotCompletedSinceLastClear: bit(4),
    testFailedSinceLastClear: bit(5),
    testNotCompletedThisOperationCycle: bit(6),
    warningIndicatorRequested: bit(7),
  };
}

export function encodeDtcStatus(bits: Partial<DtcStatusBits>): number {
  let value = 0;
  STATUS_BIT_ORDER.forEach((name, index) => {
    if (bits[name]) value |= 1 << index;
  });
  return value & 0xff;
}

/** Severity heuristic derived from the status bits (AGENTS 20 "Severity"). */
export type DtcSeverity = "info" | "minor" | "major" | "critical";

export function dtcSeverity(bits: DtcStatusBits): DtcSeverity {
  if (bits.testFailed) return "critical";
  if (bits.confirmedDtc) return "major";
  if (bits.pendingDtc) return "minor";
  return "info";
}

export const DTC_LETTERS = ["P", "C", "B", "U"] as const;

export interface DecodedDtc {
  /** Human readable code, e.g. "P0420". */
  code: string;
  /** P / C / B / U. */
  letter: string;
  /** Four hex digits after the letter. */
  digits: string;
  /** Failure type byte (FTB), rendered as two hex digits. */
  failureType: string;
  raw: string;
}

/**
 * Decode the two-byte DTC number into its ISO 14229-1 character form.
 * Bits 7-6 of the first byte select the letter, bits 5-4 the first digit.
 */
export function decodeDtc(highByte: number, lowByte: number, failureType = 0): DecodedDtc {
  const letter = DTC_LETTERS[(highByte >> 6) & 0x03] ?? "P";
  const digits = [
    ((highByte >> 4) & 0x03).toString(16),
    (highByte & 0x0f).toString(16),
    ((lowByte >> 4) & 0x0f).toString(16),
    (lowByte & 0x0f).toString(16),
  ]
    .join("")
    .toUpperCase();
  return {
    code: `${letter}${digits}`,
    letter,
    digits,
    failureType: failureType.toString(16).padStart(2, "0").toUpperCase(),
    raw: `${highByte.toString(16).padStart(2, "0")}${lowByte.toString(16).padStart(2, "0")}${failureType.toString(16).padStart(2, "0")}`.toUpperCase(),
  };
}

export function decodeDtcBytes(raw: Uint8Array): DecodedDtc {
  return decodeDtc(raw[0] ?? 0, raw[1] ?? 0, raw[2] ?? 0);
}

/** Encode "P0420" back into [high, low]. Throws on malformed input. */
export function encodeDtc(code: string): { high: number; low: number } {
  const match = /^([PCBU])([0-3])([0-9A-Fa-f])([0-9A-Fa-f])([0-9A-Fa-f])$/.exec(
    code.trim().toUpperCase(),
  );
  if (!match) throw new Error(`Invalid DTC code "${code}" (expected e.g. P0420)`);
  const letterIndex = DTC_LETTERS.indexOf(match[1] as (typeof DTC_LETTERS)[number]);
  const firstDigit = Number.parseInt(match[2] as string, 10);
  const secondDigit = Number.parseInt(match[3] as string, 16);
  const high = (letterIndex << 6) | (firstDigit << 4) | secondDigit;
  const low =
    (Number.parseInt(match[4] as string, 16) << 4) | Number.parseInt(match[5] as string, 16);
  return { high, low };
}

/** "P0420" / "P0420-00" → three-byte raw value. */
export function encodeDtcToBytes(code: string, failureType = 0): Uint8Array {
  const { high, low } = encodeDtc(code);
  return new Uint8Array([high, low, failureType & 0xff]);
}
