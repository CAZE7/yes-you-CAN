/**
 * Reading an NRC out of a failure without importing the error class (ADR 0058).
 *
 * `UdsNegativeResponseError` lives in `@vdp/shared`, and a harvest classifies its
 * refusals by code — but the classification must also work for an error that came
 * from somewhere else (a wrapped timeout, a future transport error). Reading the
 * `nrc` property structurally keeps the harvest honest about both: a code it can
 * read is a refusal the ECU stated, anything else is a transport failure and is
 * reported as a gap instead (ADR 0033).
 */

/** The NRC an error carries, when it carries one. */
export function nrcOf(error: unknown): number | undefined {
  return typeof error === "object" &&
    error !== null &&
    "nrc" in error &&
    typeof (error as { nrc?: unknown }).nrc === "number"
    ? (error as { nrc: number }).nrc
    : undefined;
}

/**
 * True when the NRC is one of the ordinary answers of a read sweep.
 *
 * `requestOutOfRange` (0x31) is "this identifier/record does not exist here",
 * `serviceNotSupported` (0x11) and `serviceNotSupportedInActiveSession` (0x7F) are
 * "not in this session". All three are statements about the vehicle, so they are
 * recorded as refusals — while a timeout or a broken frame is recorded as a gap,
 * because that says something about the bus, not about the ECU.
 */
export function isOrdinaryRefusal(nrc: number | undefined): boolean {
  return nrc === 0x31 || nrc === 0x11 || nrc === 0x7f;
}
