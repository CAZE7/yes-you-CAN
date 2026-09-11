/**
 * ELM327 wire format helpers.
 *
 * Frame line with headers enabled (ATH1):  "7E8 06 62 F1 90 57 56 57"
 *   → identifier, length byte, data bytes.
 * Frame line without headers:              "06 62 F1 90 57 56 57"
 *   → identifier is unknown, which is why this adapter always enables ATH1:
 *     without identifiers a multi-ECU bus cannot be interpreted at all.
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

/** Parse one response line into a CAN frame, or null if it is not a frame line. */
export function parseFrameLine(
  line: string,
  channel: string,
  timestamp = Date.now(),
): CanFrame | null {
  const tokens = line
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);
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
  const dataTokens = tokens.slice(2, 2 + declaredLength);
  if (dataTokens.length !== declaredLength) return null;

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

/** Format a frame the way ELM327 expects it as input (data bytes only). */
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

export const DEFAULT_INIT_SEQUENCE = ["ATZ", "ATE0", "ATL1", "ATH1", "ATS0", "ATSP6"] as const;

/**
 * ELM327 does not implement CAN-FD and cannot offload ISO-TP, so the platform's
 * own ISO-TP layer does the segmentation. Declaring that honestly matters: an
 * adapter that claims offload it does not have breaks every layer above it.
 */
export function assertCanSupport(canFd: boolean): void {
  if (canFd) throw new AdapterUnsupportedError("ELM327 adapters do not support CAN-FD");
}
