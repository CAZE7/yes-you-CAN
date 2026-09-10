/**
 * CAN frame layer (AGENTS 6).
 *
 * Pure transport representation — no UDS, no OEM interpretation.
 * `channel` is required because multi-channel adapters (CAN dual, DoIP gateways)
 * must stay distinguishable end to end for trace replay.
 */

export interface CanFrame {
  /** Milliseconds since epoch; sub-ms precision where the adapter provides it. */
  timestamp: number;
  id: number;
  extended: boolean;
  fd: boolean;
  dlc: number;
  payload: Uint8Array;
  channel: string;
  /** true when this frame was sent by us (raw trace `direction`, AGENTS 18). */
  direction?: 'tx' | 'rx';
  /** Bitrate switch (CAN-FD BRS). */
  brs?: boolean;
}

export type CanFilter = { id: number; mask: number; extended?: boolean };

export function frameMatchesFilters(frame: CanFrame, filters: readonly CanFilter[]): boolean {
  if (filters.length === 0) return true;
  return filters.some((f) => {
    if (f.extended !== undefined && f.extended !== frame.extended) return false;
    return (frame.id & f.mask) === (f.id & f.mask);
  });
}

/** CAN 2.0 allows 8 payload bytes; CAN-FD up to 64 with non-linear DLC mapping (ISO 11898-1). */
export const CAN_MAX_DLC = 8;
export const CANFD_MAX_PAYLOAD = 64;

const FD_LENGTHS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 12, 16, 20, 24, 32, 48, 64] as const;

export function dlcToLength(dlc: number, fd = false): number {
  if (!fd) return Math.min(dlc, CAN_MAX_DLC);
  return FD_LENGTHS[Math.min(dlc, FD_LENGTHS.length - 1)] ?? CAN_MAX_DLC;
}

export function lengthToDlc(length: number, fd = false): number {
  if (!fd) return Math.min(length, CAN_MAX_DLC);
  for (let dlc = 0; dlc < FD_LENGTHS.length; dlc++) if ((FD_LENGTHS[dlc] ?? 0) >= length) return dlc;
  return FD_LENGTHS.length - 1;
}

export function createFrame(
  id: number,
  payload: Uint8Array,
  options: Partial<Pick<CanFrame, 'extended' | 'fd' | 'channel' | 'timestamp' | 'direction' | 'brs' | 'dlc'>> = {},
): CanFrame {
  const fd = options.fd ?? false;
  return {
    timestamp: options.timestamp ?? Date.now(),
    id,
    extended: options.extended ?? id > 0x7ff,
    fd,
    dlc: options.dlc ?? lengthToDlc(payload.length, fd),
    payload,
    channel: options.channel ?? 'can0',
    ...(options.direction ? { direction: options.direction } : {}),
    ...(options.brs === undefined ? {} : { brs: options.brs }),
  };
}
