/**
 * ELM327 wire format helpers.
 *
 * Frame line with headers enabled (ATH1):  "7E8 06 62 F1 90 57 56 57"
 *   → identifier, length byte, data bytes. This is the form this adapter runs
 *     in and the only one `parseFrameLine` accepts: without an identifier a
 *     multi-ECU bus cannot be interpreted at all, and without the length byte
 *     there is no way to tell a DLC from a payload byte.
 * Frame line without headers:              "06 62 F1 90 57 56 57"
 *   → identifier unknown, so a received frame cannot be attributed.
 */

import { AdapterUnsupportedError } from "@vdp/shared";
import type { CanFrame } from "@vdp/transport-can";

export interface ParsedFrame {
  id: number;
  extended: boolean;
  payload: Uint8Array;
}

export const ELM_ERRORS = [
  "NO DATA",
  "BUFFER FULL",
  "BUS BUSY",
  "BUS ERROR",
  "CAN ERROR",
  "UNABLE TO CONNECT",
  "FB ERROR",
  "DATA ERROR",
  "<DATA ERROR",
  "ERR",
  "STOPPED",
  "?",
] as const;

export function isElmError(line: string): string | null {
  const trimmed = line.trim().toUpperCase();
  if (trimmed.length === 0) return null;
  for (const error of ELM_ERRORS)
    if (trimmed === error || trimmed.startsWith(`${error}`)) return error;
  return null;
}

/**
 * ELM327 errors that describe the *link or the bus*, not the frame: sending the
 * same bytes again has a real chance of getting through.
 *
 * `NO DATA` is a P2 timeout in disguise. `BUS BUSY`/`BUS ERROR`/`CAN ERROR` are
 * arbitration and error frames on the bus — on a Bluetooth SPP link, where the
 * radio adds 50–150 ms and jitter, they are routine. `BUFFER FULL` is the
 * adapter's own TX queue. `STOPPED` is the adapter aborting a command it could
 * not finish. `UNABLE TO CONNECT` and `FB ERROR` belong to the setup phase.
 *
 * The complement — `DATA ERROR`, `<DATA ERROR`, `ERR`, `?` — means the adapter
 * did not understand what it was given. Sending identical bytes again produces
 * the identical refusal, so a retry only spends the timeout twice.
 *
 * This is a *classification*, not a decision: the adapter says "transient" and
 * the ISO-TP layer decides whether that is worth an attempt (`isRetryable` in
 * `connection.ts`).
 */
const ELM_TRANSIENT_ERRORS: ReadonlySet<string> = new Set([
  "NO DATA",
  "BUFFER FULL",
  "BUS BUSY",
  "BUS ERROR",
  "CAN ERROR",
  "UNABLE TO CONNECT",
  "FB ERROR",
  "STOPPED",
]);

export function isTransientElmError(error: string): boolean {
  return ELM_TRANSIENT_ERRORS.has(error.trim().toUpperCase());
}

/** Parse one response line into a CAN frame, or null if it is not a frame line. */
export function parseFrameLine(
  line: string,
  channel: string,
  timestamp = Date.now(),
): CanFrame | null {
  // Strip trailing prompts, carriage returns and null bytes from cheap clones
  const cleaned = line.replace(/[\r\0>]/g, "").trim();
  const tokens = cleaned.split(/\s+/).filter((token) => token.length > 0);
  if (tokens.length < 2) return null;
  if (!tokens.every((token) => /^[0-9A-Fa-f]+$/.test(token))) return null;

  const first = tokens[0] as string;
  // Identifier: 3 hex digits for 11-bit, 8 hex digits for 29-bit.
  const idLength = first.length === 3 ? 3 : first.length === 8 ? 8 : null;
  if (!idLength) return null;

  const id = Number.parseInt(first, 16);
  const lengthToken = tokens[1] as string;
  if (lengthToken.length !== 2) return null;
  const declaredLength = Number.parseInt(lengthToken, 16);

  // If token 1 specifies a length between 0 and 8:
  if (declaredLength <= 8) {
    const dataTokens = tokens.slice(2, 2 + declaredLength);
    // Truncated frame check: if fewer tokens exist than declared, it's corrupt/truncated
    if (tokens.length - 2 < declaredLength) return null;
    if (dataTokens.length === declaredLength && tokens.length === 2 + declaredLength) {
      const payload = new Uint8Array(dataTokens.map((token) => Number.parseInt(token, 16)));
      return {
        timestamp,
        id,
        extended: idLength === 8,
        fd: false,
        dlc: payload.length,
        payload,
        channel,
        direction: "rx",
      };
    }
  }

  // Raw CAN frame mode (e.g. UDS First Frame "7E8 10 14 62 F1 90 57 56 57" where 10 is payload)
  const rawDataTokens = tokens.slice(1);
  if (rawDataTokens.length >= 1 && rawDataTokens.length <= 8) {
    if (rawDataTokens.every((token) => token.length === 2)) {
      const payload = new Uint8Array(rawDataTokens.map((token) => Number.parseInt(token, 16)));
      return {
        timestamp,
        id,
        extended: idLength === 8,
        fd: false,
        dlc: payload.length,
        payload,
        channel,
        direction: "rx",
      };
    }
  }

  return null;
}

/**
 * Format a frame the way ELM327 expects it as input: the DLC, then the data
 * bytes — `03 02 10 01` for a three-byte payload.
 *
 * **The length prefix is not a bug, and removing it breaks the adapter in both
 * directions.** It is the same field `parseFrameLine` reads back: the ELM327
 * prints `<ID> <DLC> <data>` with headers on, and it accepts `<DLC> <data>` on
 * the way out. Dropping it on send puts the first payload byte where the
 * adapter expects the length (a single frame `02 10 01` becomes `02`, i.e. DLC
 * 2, payload `10 01` — the ECU reads service id `0x10` as byte 2 and the whole
 * request is a different request); dropping it on receive makes `06` in
 * `7E8 06 62 F1 90 …` a payload byte, and ISO-TP then rejects the frame because
 * `0x62 & 0xF0` is neither a Single nor a First Frame. Both halves are pinned by
 * `elm327.spec.ts`; an 8-byte padded frame is 9 tokens, which is what the DLC
 * says, and the adapter accepts it.
 */
export function formatSendPayload(frame: CanFrame): string {
  // Upper case keeps transmitted and parsed frames consistent (ELM327 accepts
  // both, but a trace should not mix styles).
  const bytes = Array.from(frame.payload)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join(" ")
    .toUpperCase();
  return `${frame.payload.length.toString(16).padStart(2, "0")} ${bytes}`.trim();
}

/** ATSH identifier formatting: 3 digits for 11-bit, 8 for 29-bit. */
export function formatIdentifier(id: number, extended: boolean): string {
  return extended ? id.toString(16).padStart(8, "0") : id.toString(16).padStart(3, "0");
}

/**
 * ISO 15765-4 protocol numbers the ELM327 accepts in raw CAN mode. `ATSP6` is
 * 11-bit identifiers at 500 kBaud; a 29-bit vehicle needs 7, a 250 kBaud bus 8
 * or 9. Hardcoding one of them declares every other bus unsupportable.
 */
export const ELM_CAN_PROTOCOLS = {
  CAN_11BIT_500K: 6,
  CAN_29BIT_500K: 7,
  CAN_11BIT_250K: 8,
  CAN_29BIT_250K: 9,
} as const;

/**
 * The AT commands this adapter runs on open.
 *
 * - `ATH1` headers on — without an identifier a multi-ECU bus cannot be read at
 *   all, and `parseFrameLine` needs it.
 * - `ATS1` spaces on — with `ATS0` the ELM327 prints `7E80662F190575657` as one
 *   token, and `parseFrameLine` rejects a line with fewer than two tokens. The
 *   parser and the sequence disagreed about the same wire format; the cheaper
 *   of the two is the one that changes.
 * - `ATCAF0` CAN auto-formatting off — the platform does its own ISO-TP
 *   (AGENTS 5, `isoTpOffload: false`), so this adapter carries frames and
 *   nothing else. With `CAF1` the adapter's firmware builds its own flow
 *   control frames and answers the TypeScript stack's. The host catalog has
 *   described this adapter as "raw CAN mode (ATH1/ATCAF0)" since it was
 *   written; the sequence is what was missing.
 * - `ATSP6` 11-bit / 500 kBaud — see `ELM_CAN_PROTOCOLS` for the rest.
 */
export function initSequenceFor(protocol: number = ELM_CAN_PROTOCOLS.CAN_11BIT_500K): string[] {
  return ["ATZ", "ATE0", "ATL1", "ATH1", "ATS1", "ATCAF0", `ATSP${protocol}`];
}

export const DEFAULT_INIT_SEQUENCE: readonly string[] = initSequenceFor();

/**
 * ELM327 does not implement CAN-FD and cannot offload ISO-TP, so the platform's
 * own ISO-TP layer does the segmentation. Declaring that honestly matters: an
 * adapter that claims offload it does not have breaks every layer above it.
 */
export function assertCanSupport(canFd: boolean): void {
  if (canFd) throw new AdapterUnsupportedError("ELM327 adapters do not support CAN-FD");
}
