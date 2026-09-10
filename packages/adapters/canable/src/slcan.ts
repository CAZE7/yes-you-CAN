/**
 * slcan (Lawicel ASCII) protocol used by CANable / CANtact / USBtin (AGENTS 4).
 *
 * Frame syntax:
 *   standard:  t<3 hex id><dlc><data hex>[\r]
 *   extended:  T<8 hex id><dlc><data hex>[\r]
 *   remote:    r / R variants (not used for diagnostics)
 * Optional trailing 3-digit timestamp in milliseconds when "Z1" is enabled.
 */

import type { CanFrame } from '@vdp/transport-can';

export const BITRATES: Record<string, string> = {
  '10k': 'S0', '20k': 'S1', '50k': 'S2', '100k': 'S3', '125k': 'S4',
  '250k': 'S5', '500k': 'S6', '800k': 'S7', '1000k': 'S8',
};

export const SLCAN_COMMANDS = {
  open: 'O',
  close: 'C',
  listenOnly: 'L',
  timestampOn: 'Z1',
  version: 'V',
  serial: 'N',
} as const;

/**
 * Parse a frame line deterministically.
 *
 * slcan distinguishes standard (3 hex digit) from extended (8 hex digit)
 * identifiers by length alone, so both are tried and each candidate has to
 * validate completely: identifier, DLC, payload length and the optional 3-digit
 * timestamp suffix. A regex alternation would backtrack data bytes into the
 * timestamp group and silently corrupt payloads.
 */
export function parseSlcanLine(line: string, channel: string, now = Date.now()): CanFrame | null {
  const trimmed = line.trim();
  const type = trimmed[0];
  if (!type || !'tTrR'.includes(type)) return null;
  if (type === 'r' || type === 'R') return null; // remote frames carry no diagnostic payload
  const rest = trimmed.slice(1);

  for (const idLength of [8, 3] as const) {
    const idHex = rest.slice(0, idLength);
    if (idHex.length !== idLength) continue;
    if (!/^[0-9A-Fa-f]+$/.test(idHex)) continue;
    const frame = parseWithId(idHex, rest.slice(idLength), channel, now);
    if (frame) return frame;
  }
  return null;
}

function parseWithId(idHex: string, rest: string, channel: string, now: number): CanFrame | null {
  const dlcChar = rest[0];
  if (!dlcChar || !/^[0-9A-Fa-f]$/.test(dlcChar)) return null;
  const dlc = parseInt(dlcChar, 16);
  if (dlc > 8) return null;
  const remainder = rest.slice(1);
  const expected = dlc * 2;
  if (remainder.length < expected) return null;
  const data = remainder.slice(0, expected);
  if (data.length > 0 && !/^[0-9A-Fa-f]+$/.test(data)) return null;
  const suffix = remainder.slice(expected);
  if (suffix.length !== 0 && !/^[0-9A-Fa-f]{3}$/.test(suffix)) return null;

  const payload = new Uint8Array(dlc);
  for (let i = 0; i < dlc; i++) payload[i] = parseInt(data.slice(i * 2, i * 2 + 2), 16);
  return {
    timestamp: suffix.length === 3 ? now - parseInt(suffix, 16) : now,
    id: parseInt(idHex, 16),
    extended: idHex.length === 8,
    fd: false,
    dlc,
    payload,
    channel,
    direction: 'rx',
  };
}

export function formatSlcanFrame(frame: CanFrame): string {
  const prefix = frame.extended ? 'T' : 't';
  const id = (frame.extended ? frame.id.toString(16).padStart(8, '0') : frame.id.toString(16).padStart(3, '0')).toUpperCase();
  const dlc = Math.min(frame.payload.length, 8).toString(16);
  // Upper case, consistent with the other serial adapters and the traces we parse.
  const data = Array.from(frame.payload.slice(0, 8))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
  return `${prefix}${id}${dlc}${data}\r`;
}

/** slcan answers with CR on success and BEL (0x07) on error. */
export function isSlcanError(chunk: string): boolean {
  return chunk.includes('\u0007');
}
