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
import { createLogger, toHex } from "@vdp/shared";
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
  private opened = false;
  private clock = 0;

  constructor(
    private readonly recording: ReplayRecording,
    private readonly options: ReplayTransportOptions = {},
  ) {
    this.channel = options.channel ?? recording.channel ?? "replay0";
    this.immediate = options.immediate ?? false;
    this.matchByIdOnly = options.matchByIdOnly ?? true;
    this.log = (options.logger ?? createLogger("replay", { level: "INFO" })).child("replay");
    this.info = { ...REPLAY_INFO, channels: [this.channel], ...(options.info ?? {}) };
    this.groupExchanges();
  }

  /** Group the recording into request → responses exchanges. */
  private groupExchanges(): void {
    let current: Exchange | null = null;
    for (const entry of this.recording.frames) {
      if (entry.direction === "tx") {
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
    if (!this.opened) throw new Error("replay transport is not open");
    this.stats.sends++;

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

    const deliver = (): void => {
      for (const response of exchange.responses) {
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
    };

    if (this.immediate) deliver();
    else await Promise.resolve().then(deliver);
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
