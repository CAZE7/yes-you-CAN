/**
 * ELM327 / OBDLink adapter (AGENTS 4, 29).
 *
 * This is the "normal CAN adapter" the first release must work with. It stays a
 * pure CAN frame adapter: no UDS, no ISO-TP, no OEM logic (AGENTS 6).
 */

import {
  AdapterUnsupportedError,
  asError,
  createLogger,
  type Logger,
  messageOf,
  TransportError,
} from "@vdp/shared";
import type {
  AdapterCapabilities,
  AdapterInfo,
  CanBus,
  CanFilter,
  CanFrame,
  FrameListener,
} from "@vdp/transport-can";
import {
  DEFAULT_INIT_SEQUENCE,
  formatIdentifier,
  formatSendPayload,
  initSequenceFor,
  isElmError,
  parseFrameLine,
} from "./protocol.js";
import type { ByteStream } from "./stream.js";

export interface Elm327Options {
  stream: ByteStream;
  /** Channel label used in traces. */
  channel?: string;
  /** Override the whole AT init sequence. */
  initSequence?: readonly string[];
  /**
   * ISO 15765-4 protocol number for the `ATSP` command (default 6 = 11-bit,
   * 500 kBaud). A 29-bit vehicle needs 7, a 250 kBaud bus 8 or 9 — see
   * `ELM_CAN_PROTOCOLS`. The identifier width in `formatIdentifier` already
   * follows the frame; this makes the bus the adapter listens on follow too.
   *
   * Named `canProtocol` rather than `protocol` because `Elm327Status.protocol`
   * already means something else: the string the adapter reports for `ATDP`,
   * i.e. what it ended up speaking, not what was asked for.
   */
  canProtocol?: number;
  /** Timeout per AT command in ms. */
  commandTimeoutMs?: number;
  logger?: Logger;
  /** Device name shown in the UI. */
  name?: string;
}

export interface Elm327Status {
  version?: string;
  protocol?: string;
  voltage?: string;
  commandsRun: number;
  errors: string[];
}

export class Elm327Adapter implements CanBus {
  /**
   * Capabilities of this adapter class.
   *
   * Static because the host needs them *before* a device exists — the adapter
   * catalog and the UI list what an adapter can do without opening it.
   */
  static readonly CAPABILITIES: AdapterCapabilities = {
    can: true,
    canFd: false,
    doip: false,
    // ISO-TP runs in this platform, not in the ELM327 (AGENTS 5): the adapter
    // only carries frames, so multi-frame messages behave the same on every
    // adapter and stay part of the tested code path.
    isoTpOffload: false,
    channels: 1,
    supportsFunctionalAddressing: true,
  };

  readonly info: AdapterInfo;
  readonly capabilities: AdapterCapabilities = Elm327Adapter.CAPABILITIES;

  readonly status: Elm327Status = { commandsRun: 0, errors: [] };

  private readonly log: Logger;
  private readonly channel: string;
  private readonly initSequence: readonly string[];
  private readonly commandTimeoutMs: number;
  private listeners: Array<{ listener: FrameListener; filters?: readonly CanFilter[] }> = [];
  private buffer = "";
  private unsubscribeStream: (() => void) | null = null;
  private unsubscribeError: (() => void) | null = null;
  private opened = false;
  private currentTxId: number | null = null;
  private pending: Array<{
    resolve: (lines: string[]) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  private currentLines: string[] = [];
  private lastCommand = "";
  private txCount = 0;
  private rxCount = 0;

  constructor(private readonly options: Elm327Options) {
    this.channel = options.channel ?? "elm0";
    this.log = (options.logger ?? createLogger("can", { level: "INFO" })).child("can");
    this.initSequence =
      options.initSequence ??
      (options.canProtocol === undefined
        ? DEFAULT_INIT_SEQUENCE
        : initSequenceFor(options.canProtocol));
    this.commandTimeoutMs = options.commandTimeoutMs ?? 3000;
    this.info = {
      id: "elm327",
      kind: "elm327",
      name: options.name ?? "ELM327",
      channels: [this.channel],
    };
  }

  async open(): Promise<void> {
    if (this.opened) return;
    this.unsubscribeStream = this.options.stream.onData((chunk) => this.onChunk(chunk));
    // A stream that reports its own death must not leave this adapter claiming
    // to be open: the host catalog owns the stream, so without this the UI says
    // `connected: true` until the next request times out — a pulled USB cable
    // or a dropped Bluetooth link reads as a silent vehicle, not a dead link.
    if (this.options.stream.onError) {
      this.unsubscribeError = this.options.stream.onError((error) => this.onStreamError(error));
    }
    this.opened = true;

    for (const command of this.initSequence) {
      const lines = await this.command(command);
      // A silent ATZ must not erase a version that was identified before; the
      // fallback keeps the previous reading instead of writing `undefined`.
      if (command === "ATZ") {
        const reported = lines.join(" ").trim();
        if (reported) this.status.version = reported;
      }
      if (command === "ATDP") this.status.protocol = lines.join(" ").trim();
    }
    this.log.info("ELM327 initialised", { version: this.status.version, channel: this.channel });
  }

  async close(): Promise<void> {
    this.unsubscribeStream?.();
    this.unsubscribeStream = null;
    this.unsubscribeError?.();
    this.unsubscribeError = null;
    this.opened = false;
    this.listeners = [];
    for (const entry of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new TransportError("adapter closed"));
    }
    this.pending = [];
  }

  /**
   * The stream underneath is gone. Record it, fail what is in flight instead of
   * letting it run into its own timeout, and stop claiming to be open — an
   * adapter whose device left is not an adapter.
   */
  private onStreamError(error: Error): void {
    this.status.errors.push(messageOf(error));
    this.log.warn("the byte stream reported an error", { error: messageOf(error) });
    this.opened = false;
    this.currentTxId = null;
    for (const entry of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new TransportError(`byte stream failed: ${messageOf(error)}`));
    }
    this.pending = [];
    this.buffer = "";
  }

  isOpen(): boolean {
    return this.opened;
  }

  async send(frame: CanFrame): Promise<void> {
    if (!this.opened) throw new TransportError("ELM327 adapter is not open");
    if (frame.fd) throw new AdapterUnsupportedError("ELM327 does not support CAN-FD frames");

    if (this.currentTxId !== frame.id) {
      await this.command(`ATSH ${formatIdentifier(frame.id, frame.extended)}`);
      this.currentTxId = frame.id;
    }
    const payload = formatSendPayload(frame);
    this.txCount++;
    const lines = await this.command(payload);
    for (const line of lines) {
      const error = isElmError(line);
      if (error) {
        this.status.errors.push(error);
        this.log.warn("ELM327 reported an error", { error, command: payload });
        // `CAN ERROR`, `BUFFER FULL` and `STOPPED` mean the frame never reached
        // the bus. Returning normally here tells ISO-TP the opposite, and it
        // waits for an answer that was never asked for — a timeout that reads
        // as "the ECU is silent" instead of "the adapter refused". An
        // unproven outcome is a failure (AGENTS 34.21, ADR 0033).
        throw new TransportError(`ELM327 refused the frame: ${error}`, {
          command: payload,
          frameId: frame.id,
        });
      }
    }
  }

  subscribe(listener: FrameListener, filters?: readonly CanFilter[]): () => void {
    const entry = { listener, ...(filters ? { filters } : {}) };
    this.listeners.push(entry);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== entry);
    };
  }

  /** Read the battery voltage (ATRV) — useful for the safety layer (AGENTS 26). */
  async readVoltage(): Promise<number | null> {
    const lines = await this.command("ATRV");
    const value = Number.parseFloat(lines.join("").replace(/[^0-9.]/g, ""));
    if (!Number.isFinite(value)) return null;
    this.status.voltage = `${value.toFixed(2)}V`;
    return value;
  }

  get counters(): { tx: number; rx: number } {
    return { tx: this.txCount, rx: this.rxCount };
  }

  /** Run one AT command and collect the response lines up to the prompt. */
  async command(command: string): Promise<string[]> {
    this.status.commandsRun++;
    this.currentLines = [];
    this.lastCommand = command.trim();
    return new Promise<string[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = this.pending.filter((entry) => entry.resolve !== resolve);
        reject(
          new TransportError(
            `ELM327 command "${command}" timed out after ${this.commandTimeoutMs} ms`,
          ),
        );
      }, this.commandTimeoutMs);
      this.pending.push({ resolve, reject, timer });
      void this.options.stream.write(`${command}\r`).catch((error) => {
        clearTimeout(timer);
        reject(asError(error));
      });
    });
  }

  private onChunk(chunk: string): void {
    this.buffer += chunk;
    // Three line endings, because three exist on real hardware: `\n` (ATL1,
    // what this adapter asks for), `\r\n` (ATL1 plus a clone that appends its
    // own CR), and a bare `\r` — what an ELM327 with `ATL0` emits, and what a
    // Bluetooth SPP link often delivers when the peer buffers by carriage
    // return. Splitting only on `\n` parks a bare-`\r` stream in the buffer
    // forever, which looks exactly like a silent vehicle.
    let match = /\r\n|\n|\r/.exec(this.buffer);
    while (match) {
      const line = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      this.handleLine(line);
      match = /\r\n|\n|\r/.exec(this.buffer);
    }
    // A prompt can arrive without a trailing newline.
    if (this.buffer.includes(">")) {
      const parts = this.buffer.split(">");
      const remainder = parts.pop() ?? "";
      for (const part of parts) this.handleLine(part);
      this.buffer = remainder;
      this.flushPending();
    }
  }

  private handleLine(line: string): void {
    const trimmed = line.replace(/[\r\0>]/g, "").trim();
    if (trimmed.length === 0) return;
    this.currentLines.push(trimmed);

    // Suppress command echoes from cheap clones that fail to disable echo (ATE0)
    if (trimmed.toUpperCase().startsWith("AT") || trimmed === this.lastCommand) {
      return;
    }

    const frame = parseFrameLine(trimmed, this.channel);
    if (frame) {
      this.rxCount++;
      this.log.raw("elm327 rx", { id: `0x${frame.id.toString(16)}`, payload: frame.payload });
      this.dispatch(frame);
    }
  }

  private flushPending(): void {
    const entry = this.pending.shift();
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.resolve([...this.currentLines]);
    this.currentLines = [];
  }

  private dispatch(frame: CanFrame): void {
    for (const entry of this.listeners) {
      if (entry.filters && entry.filters.length > 0) {
        const matches = entry.filters.some(
          (filter) => (frame.id & filter.mask) === (filter.id & filter.mask),
        );
        if (!matches) continue;
      }
      entry.listener(frame);
    }
  }
}
