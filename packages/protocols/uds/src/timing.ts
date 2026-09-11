/**
 * ISO 14229-2 timing parameters.
 *
 * AGENTS 9: these MUST be configurable per ECU/definition package — ECUs report
 * different values in the DiagnosticSessionControl positive response and the
 * client has to adopt them instead of relying on global constants.
 */

export interface UdsTiming {
  /** P2Client_max: max wait for the first response (ISO 14229-2, server default 50 ms). */
  p2Ms: number;
  /** P2*Client_max: max wait after a Response Pending / NRC 0x78 (server default 5000 ms). */
  p2StarMs: number;
  /** S3Server: session timeout without a TesterPresent (server default 5000 ms). */
  s3Ms: number;
}

export const DEFAULT_UDS_TIMING: UdsTiming = {
  p2Ms: 50,
  p2StarMs: 5000,
  s3Ms: 5000,
};

/**
 * Parse the timing fields of a DiagnosticSessionControl positive response:
 * [0x50, session, P2 high, P2 low, P2* high (10 ms units), P2* low].
 */
export function parseSessionTiming(response: Uint8Array): { p2Ms: number; p2StarMs: number } | null {
  if (response.length < 6) return null;
  // Length is validated above, so the indexed reads cannot fall off the end
  // (casts instead of `?? 0` — the fallback would be dead code and untestable).
  const p2 = ((response[2] as number) << 8) | (response[3] as number);
  const p2StarUnits = ((response[4] as number) << 8) | (response[5] as number);
  if (p2 === 0xffff || p2StarUnits === 0xffff) return null;
  return { p2Ms: p2, p2StarMs: p2StarUnits * 10 };
}

/** Extra headroom on top of P2 for transport/scheduling jitter. */
export const TIMING_MARGIN_MS = 25;
