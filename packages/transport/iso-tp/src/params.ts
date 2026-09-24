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

/**
 * Timing for a link whose round trip costs more than a bus cycle: Bluetooth SPP
 * (RFCOMM) measures 50–150 ms, and an ELM327 that has to switch its transmit
 * identifier first spends two of those before the payload moves at all.
 *
 * `DEFAULT_TIMING` deliberately does not change. One second and no retries is
 * right for a socket or a USB CANable, and loosening the default would quietly
 * weaken every test that measures a timeout — a gate that waits longer passes
 * more easily without anyone deciding that it should. A caller that knows its
 * link is slow says so:
 *
 * ```ts
 * new IsoTpConnection(bus, { txId: 0x7e0, rxId: 0x7e8, timing: SLOW_LINK_TIMING });
 * ```
 *
 * The numbers are the same three bounds doubled plus a retry, which is what a
 * 150 ms round trip needs to stay inside N_Bs and N_Cr without turning a real
 * failure into a slow one.
 */
export const SLOW_LINK_TIMING: IsoTpTiming = {
  nAsMs: 25,
  sendTimeoutMs: 3000,
  nBsMs: 2000,
  nCrMs: 2000,
  stMinMs: 0,
  stMinTxMs: 0,
  blockSize: 0,
  wftMax: 8,
  maxRetries: 2,
};

/**
 * Default receive buffer bound, see `IsoTpOptions.maxReceiveBytes`. 64 KiB:
 * the largest diagnostic answers are 4 KiB DID reads, the largest practical
 * UDS transfers stay below 64 KiB, and a bound has to exist somewhere because
 * the CAN-FD escape form of FF_DL is a 32-bit field (ISO 15765-2 §9.5.2).
 */
export const DEFAULT_MAX_RECEIVE_BYTES = 65_535;

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
  /**
   * How many bytes a *received* message may claim before this receiver
   * announces a buffer overflow in its Flow Control (flowStatus 0x02,
   * ISO 15765-2 Table 14) instead of starting a reception it cannot finish.
   *
   * Without a bound, the CAN-FD escape form of FF_DL — a 32-bit field — lets a
   * corrupt or hostile First Frame claim up to 4 GiB of `chunks`, and the only
   * thing that stops it is the N_Cr timer a second later. Classic CAN is
   * bounded by construction (12-bit FF_DL = 4095), so this guard concerns the
   * FD path; 64 KiB is comfortably above every diagnostic answer a vehicle
   * gives (the largest standard responses are 4 KiB DID reads) and far below
   * anything that could pressure a Node heap.
   */
  maxReceiveBytes?: number;
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
