/** ISO 15765-2 addressing, timing and flow-control parameters (AGENTS 7). */

export type IsoTpAddressing = "normal" | "extended";

export interface IsoTpTiming {
  /** N_As: time to transmit a single frame (adapter dependent, approximated). */
  nAsMs: number;
  /**
   * How long the *adapter* may take to accept one outgoing frame. Without a bound a
   * wedged serial write — an unplugged USB cable, a CANable whose TX buffer stopped
   * draining — keeps that send pending forever, and with it the connection's
   * serialisation lock and every request queued behind it. 0 disables the guard.
   */
  sendTimeoutMs: number;
  /** N_Bs: max wait for a Flow Control frame after our First Frame. */
  nBsMs: number;
  /** N_Cr: max wait for the next Consecutive Frame while receiving. */
  nCrMs: number;
  /** STmin we request from the sender in our Flow Control frames. */
  stMinMs: number;
  /** Separation time we honour between our own Consecutive Frames. */
  stMinTxMs: number;
  /** Block Size announced in our Flow Control frames (0 = send all). */
  blockSize: number;
  /** Max Flow Control "Wait" frames we accept before aborting (WFTmax). */
  wftMax: number;
  /** Retries of the whole request on N_Bs/N_Cr timeout. */
  maxRetries: number;
}

export const DEFAULT_TIMING: IsoTpTiming = {
  nAsMs: 5,
  sendTimeoutMs: 1000,
  nBsMs: 1000,
  nCrMs: 1000,
  stMinMs: 0,
  stMinTxMs: 0,
  blockSize: 0,
  wftMax: 8,
  maxRetries: 0,
};

export interface IsoTpOptions {
  txId: number;
  rxId: number;
  /** 29-bit identifiers (typical: physical 0x18DAxxxx, functional 0x18DBxxxx). */
  extended?: boolean;
  addressing?: IsoTpAddressing;
  /** Address-extension byte (extended addressing) / source address for the ECU. */
  targetAddress?: number;
  sourceAddress?: number;
  padding?: boolean;
  padByte?: number;
  fd?: boolean;
  channel?: string;
  timing?: Partial<IsoTpTiming>;
  /** Injectable for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export const FRAME_TYPE = {
  SINGLE: 0x00,
  FIRST: 0x10,
  CONSECUTIVE: 0x20,
  FLOW_CONTROL: 0x30,
} as const;

export const FLOW_STATUS = {
  CONTINUE_TO_SEND: 0x00,
  WAIT: 0x01,
  OVERFLOW: 0x02,
} as const;

/**
 * STmin decoding (ISO 15765-2):
 *  0x00-0x7F  → 0-127 ms
 *  0xF1-0xF9  → 100-900 µs, i.e. tenths of a millisecond
 *  everything else is reserved and must be treated as the maximum (0x7F).
 *
 * The sub-millisecond range stays fractional on purpose. Rounding 100 µs up to 1 ms
 * makes an ECU that granted a fast flow ten times slower than it promised: a 4 kByte
 * transfer at blockSize 16 then loses ~2.4 ms per block of separation time alone and
 * drifts past P2, which reads to the user as "the ECU does not answer".
 */
export function parseStMin(byte: number): number {
  if (byte <= 0x7f) return byte;
  if (byte >= 0xf1 && byte <= 0xf9) return (byte - 0xf0) / 10;
  return 0x7f;
}

export function encodeStMin(ms: number): number {
  const clamped = Math.max(0, Math.min(127, Math.round(ms)));
  return clamped;
}
