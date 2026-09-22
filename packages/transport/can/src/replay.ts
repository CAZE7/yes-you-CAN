/**
 * Replay transport (AGENTS 31.5, 31.6).
 *
 * Replays a recorded CAN conversation instead of talking to a vehicle. Two uses:
 *   - replay tests: a recorded session must decode to the same values again,
 *   - regression tests: a decoder change shows up as a deviation here.
 *
 * Matching is deliberately strict and *reported* rather than silently fuzzy: when
 * a request differs from the recording, that is a deviation worth failing a test
 * over, not something to paper over.
 */

import type { Logger } from "@vdp/shared";
import { createLogger, TransportError, toHex } from "@vdp/shared";
import type { FrameListener } from "./bus.js";
import { type CanFilter, type CanFrame, frameMatchesFilters } from "./frame.js";
import type { AdapterCapabilities, AdapterInfo } from "./transport.js";

/** One recorded frame. Structurally compatible with the core session trace. */
export interface ReplayFrameEntry {
  /** Milliseconds relative to the start of the recording. */
  t: number;
  canId: number;
  direction: "tx" | "rx";
  payload: Uint8Array;
  channel?: string;
  extended?: boolean;
  fd?: boolean;
}

export interface ReplayRecording {
  channel?: string;
  frames: readonly ReplayFrameEntry[];
}

export interface ReplayDeviation {
  kind: "no-recorded-request" | "payload-differs" | "no-recorded-response";
  canId: number;
  sentPayload: string;
  /** Recorded payload, when a request with this id existed. */
  recordedPayload?: string;
  message: string;
}

export interface ReplayStats {
  sends: number;
  matched: number;
  unmatched: number;
  delivered: number;
}

export interface ReplayTransportOptions {
  channel?: string;
  info?: Partial<AdapterInfo>;
  logger?: Logger;
  /**
   * Deliver responses synchronously inside send(). Off by default so callers see
   * the same asynchronous ordering as a real bus; tests that need determinism
   * without awaiting can switch it on.
   */
  immediate?: boolean;
  /** Fall back to matching by identifier when the payload differs. Default true. */
  matchByIdOnly?: boolean;
  /**
   * Deliver each recorded response at its recorded offset after the request.
   *
   * A recording is not only its bytes but also its timing, and the timing is load
   * bearing: an ECU that answers "response pending" (NRC 0x78) and sends the real
   * answer 30 ms later is *two* messages, and the tester only asks for the second
   * one after it has processed the first. Delivered in one burst, the second
   * message arrives before anyone listens for it and is lost.
   *
   * A paced replay therefore behaves like a bus, not like a table: `send` schedules
   * the recorded responses and returns, each response is emitted at its recorded
   * offset, and the tester can act in between. Off by default — a unit test wants
   * `await send()` to mean "the answer has been delivered".
   */
  pace?: boolean;
}

interface Exchange {
  request: ReplayFrameEntry;
  responses: ReplayFrameEntry[];
  used: boolean;
}

const REPLAY_INFO: AdapterInfo = {
  id: "replay",
  kind: "replay",
  name: "Trace replay",
  channels: ["replay0"],
};

const REPLAY_CAPABILITIES: AdapterCapabilities = {
  can: true,
  canFd: true,
  doip: false,
  isoTpOffload: false,
  channels: 1,
};

export class ReplayTransport {
  readonly info: AdapterInfo;
  readonly capabilities: AdapterCapabilities = REPLAY_CAPABILITIES;
  readonly deviations: ReplayDeviation[] = [];
  readonly stats: ReplayStats = { sends: 0, matched: 0, unmatched: 0, delivered: 0 };

  private readonly log: Logger;
  private readonly exchanges: Exchange[] = [];
  private readonly listeners: Array<{ listener: FrameListener; filters?: readonly CanFilter[] }> =
    [];
  private readonly channel: string;
  private readonly immediate: boolean;
  private readonly matchByIdOnly: boolean;
  private readonly pace: boolean;
  private opened = false;
  private clock = 0;
  /** Scheduled response timers of a paced replay; cleared on close. */
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(
    private readonly recording: ReplayRecording,
    options: ReplayTransportOptions = {},
  ) {
    this.channel = options.channel ?? recording.channel ?? "replay0";
    this.immediate = options.immediate ?? false;
    this.matchByIdOnly = options.matchByIdOnly ?? true;
    this.pace = options.pace ?? false;
    this.log = (options.logger ?? createLogger("replay", { level: "INFO" })).child("replay");
    this.info = { ...REPLAY_INFO, channels: [this.channel], ...(options.info ?? {}) };
    this.groupExchanges();
  }

  /** Group the recording into request → responses exchanges. */
  private groupExchanges(): void {
    let current: Exchange | null = null;
    for (const entry of this.recording.frames) {
      if (entry.direction === "tx") {
        // The tester's Flow Control frame belongs to the answer being received; it
        // neither opens an exchange nor closes the current one (see isFlowControl).
        if (isFlowControl(entry.payload)) continue;
        current = { request: entry, responses: [], used: false };
        this.exchanges.push(current);
      } else if (current) {
        current.responses.push(entry);
      }
      // rx frames before any tx are ambient bus traffic; they are not replayable
      // as a response and are ignored on purpose.
    }
  }

  async open(): Promise<void> {
    this.opened = true;
    this.log.info("replay opened", { exchanges: this.exchanges.length, channel: this.channel });
  }

  async close(): Promise<void> {
    this.opened = false;
    this.listeners.length = 0;
    // A paced replay owns timers; leaving them running would emit into a closed
    // transport (and keep a test runner alive).
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  isOpen(): boolean {
    return this.opened;
  }

  subscribe(listener: FrameListener, filters?: readonly CanFilter[]): () => void {
    const entry = { listener, ...(filters ? { filters } : {}) };
    this.listeners.push(entry);
    return () => {
      const index = this.listeners.indexOf(entry);
      if (index >= 0) this.listeners.splice(index, 1);
    };
  }

  /** Answer a sent frame from the recording. */
  async send(frame: CanFrame): Promise<void> {
    if (!this.opened) {
      throw new TransportError("replay transport is not open", { adapterId: this.info.id });
    }
    this.stats.sends++;

    // A Flow Control frame is part of the answer the tester is receiving, not a
    // request of its own: answering it with the next recorded exchange would shift
    // every following match by one (see isFlowControl).
    if (isFlowControl(frame.payload)) {
      this.log.debug("replay: flow control frame ignored (it belongs to a response)", {
        canId: `0x${frame.id.toString(16)}`,
      });
      return;
    }

    const exchange = this.takeExchange(frame);
    if (!exchange) {
      this.stats.unmatched++;
      this.log.warn("replay: no recorded request matches", {
        canId: `0x${frame.id.toString(16)}`,
        payload: toHex(frame.payload),
      });
      return;
    }
    this.stats.matched++;

    // Pacing wins over `immediate`: "deliver it now" and "deliver it when it
    // happened" are two different answers, and the caller asked for the latter.
    if (this.pace) {
      this.schedulePaced(exchange);
      return;
    }

    if (this.immediate) {
      this.deliver(exchange);
      return;
    }
    await Promise.resolve().then(() => this.deliver(exchange));
  }

  /** Emit every recorded response of one exchange, in recording order. */
  private deliver(exchange: Exchange): void {
    for (const response of exchange.responses) {
      this.emitResponse(response);
    }
  }

  /**
   * Emit the recorded responses at the offsets they were recorded with.
   *
   * Timer based and not awaited on purpose: the caller must be able to react
   * between two messages of the same exchange (NRC 0x78 → wait → final response),
   * which is impossible if `send` blocks until the whole answer has been emitted.
   */
  private schedulePaced(exchange: Exchange): void {
    const requestAt = exchange.request.t;
    const byOffset = new Map<number, ReplayFrameEntry[]>();
    for (const response of exchange.responses) {
      const offset = Math.max(0, response.t - requestAt);
      const group = byOffset.get(offset) ?? [];
      group.push(response);
      byOffset.set(offset, group);
    }
    for (const [offset, group] of [...byOffset.entries()].sort(([a], [b]) => a - b)) {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        for (const response of group) this.emitResponse(response);
      }, offset);
      this.timers.add(timer);
    }
  }

  private emitResponse(response: ReplayFrameEntry): void {
    this.clock = Math.max(this.clock, response.t);
    this.emit({
      timestamp: this.clock,
      id: response.canId,
      extended: response.extended ?? false,
      fd: response.fd ?? false,
      dlc: response.payload.length,
      payload: response.payload,
      channel: response.channel ?? this.channel,
      direction: "rx",
    });
    this.stats.delivered++;
  }

  private takeExchange(frame: CanFrame): Exchange | undefined {
    const payload = frame.payload;
    const exact = this.exchanges.find(
      (exchange) =>
        !exchange.used &&
        exchange.request.canId === frame.id &&
        sameBytes(exchange.request.payload, payload),
    );
    if (exact) {
      exact.used = true;
      return exact;
    }

    if (!this.matchByIdOnly) {
      const byId = this.exchanges.find(
        (exchange) => !exchange.used && exchange.request.canId === frame.id,
      );
      this.deviations.push({
        kind: byId ? "payload-differs" : "no-recorded-request",
        canId: frame.id,
        sentPayload: toHex(payload),
        ...(byId ? { recordedPayload: toHex(byId.request.payload) } : {}),
        message: byId
          ? `request payload differs from the recording for 0x${frame.id.toString(16)}`
          : `no recorded request for 0x${frame.id.toString(16)}`,
      });
      return undefined;
    }

    const byId = this.exchanges.find(
      (exchange) => !exchange.used && exchange.request.canId === frame.id,
    );
    if (!byId) {
      this.deviations.push({
        kind: "no-recorded-request",
        canId: frame.id,
        sentPayload: toHex(payload),
        message: `no recorded request for 0x${frame.id.toString(16)}`,
      });
      return undefined;
    }
    byId.used = true;
    this.deviations.push({
      kind: "payload-differs",
      canId: frame.id,
      sentPayload: toHex(payload),
      recordedPayload: toHex(byId.request.payload),
      message: `request payload differs from the recording for 0x${frame.id.toString(16)} — answered from the recorded exchange anyway`,
    });
    return byId;
  }

  private emit(frame: CanFrame): void {
    for (const entry of [...this.listeners]) {
      if (!frameMatchesFilters(frame, entry.filters ?? [])) continue;
      entry.listener(frame);
    }
  }

  /** Recorded exchanges that were never requested — a sign the client changed. */
  unusedExchanges(): Exchange[] {
    return this.exchanges.filter((exchange) => !exchange.used);
  }

  /** Recording length in milliseconds. */
  get durationMs(): number {
    return this.recording.frames.reduce((max, frame) => Math.max(max, frame.t), 0);
  }
}

/**
 * Is this frame an ISO-TP Flow Control frame?
 *
 * A response that does not fit into one frame arrives as First Frame plus
 * Consecutive Frames, and the *tester* answers the First Frame with a Flow Control
 * frame — on the same two identifiers, in the middle of the response. For the
 * replay that frame is not a request: if it opened an exchange, the consecutive
 * frames of the real answer would be attached to it, the answer would never be
 * complete, and every following request would be matched against the wrong
 * recorded exchange (a cascade that looks like a broken recording, not like a
 * matching bug).
 *
 * The test is the PCI nibble, which is how ISO 15765-2 distinguishes the four
 * frame types: `0x30`–`0x3F` is Flow Control, and the frame is at least three bytes
 * long. A framed UDS request cannot begin with one of those bytes — its first byte
 * is its own PCI (`0x0n` single frame, `0x1n` first frame).
 */
function isFlowControl(payload: Uint8Array): boolean {
  const pci = payload[0];
  if (pci === undefined || pci >> 4 !== 0x3) return false;
  // A Flow Control frame is at least three bytes: PCI plus Block Size plus STmin
  // (ISO 15765-2 §9.6.3.2). A shorter frame that starts with 0x3n is a TesterPresent
  // written without ISO-TP framing, which a bus capture of a raw tester contains —
  // treating it as Flow Control would silently swallow a real request.
  return payload.length >= 3;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Build a replay recording from a session JSON export (`format: vdp.session`).
 * Keeps replay usable straight from a recorded workshop session.
 */
export function recordingFromSessionJson(json: string): ReplayRecording {
  const parsed = JSON.parse(json) as {
    format?: string;
    trace?: Array<{
      t: number;
      canId: number;
      direction: "tx" | "rx";
      payload: string;
      channel?: string;
      extended?: boolean;
      fd?: boolean;
    }>;
  };
  if (parsed.format !== "vdp.session")
    throw new Error(`not a vdp.session export (format: ${String(parsed.format)})`);
  return {
    frames: (parsed.trace ?? []).map((entry) => ({
      t: entry.t,
      canId: entry.canId,
      direction: entry.direction,
      payload: hexToBytes(entry.payload),
      ...(entry.channel ? { channel: entry.channel } : {}),
      ...(entry.extended !== undefined ? { extended: entry.extended } : {}),
      ...(entry.fd !== undefined ? { fd: entry.fd } : {}),
    })),
  };
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/[^0-9a-f]/gi, "");
  const out = new Uint8Array(Math.floor(clean.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}
