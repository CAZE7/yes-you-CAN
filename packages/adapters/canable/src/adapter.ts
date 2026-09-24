/**
 * CANable / CANtact adapter (slcan over a serial byte stream) — AGENTS 4.
 * Pure CAN frame adapter; ISO-TP and UDS stay above it (AGENTS 6).
 */

import type { ByteStream } from "@vdp/adapter-elm327";
import { createLogger, type Logger, messageOf, TransportError } from "@vdp/shared";
import type {
  AdapterCapabilities,
  AdapterInfo,
  CanBus,
  CanFilter,
  CanFrame,
  FrameListener,
} from "@vdp/transport-can";
import { frameMatchesFilters } from "@vdp/transport-can";
import {
  BITRATES,
  formatSlcanFrame,
  isSlcanError,
  parseSlcanLine,
  SLCAN_COMMANDS,
} from "./slcan.js";

export interface CanableOptions {
  stream: ByteStream;
  channel?: string;
  bitrate?: keyof typeof BITRATES;
  /**
   * Budget for the wire answer to one slcan config command, in ms.
   *
   * Every Lawicel command is answered: config commands with an empty CR on
   * success and BEL (0x07) on refusal, the `V` version query with a text line.
   * This timeout bounds that wait. `open()` spends it to prove that the byte
   * stream belongs to a slcan firmware at this baud rate and that the channel
   * really opened — instead of reporting `connected` on a silent cable, which
   * reads exactly like a silent vehicle.
   */
  commandTimeoutMs?: number;
  /**
   * Open the channel in listen-only mode (`L` instead of `O`, Lawicel): the
   * adapter can observe the bus without acknowledging or error-flagging a
   * single frame, useful to watch a vehicle without influencing it. Sent
   * frames never leave the adapter while listen-only is on.
   */
  listenOnly?: boolean;
  logger?: Logger;
  name?: string;
}

/** One in-flight config command waiting for the device to answer it. */
interface PendingCommand {
  /** Human readable purpose, for the error if the device stays silent. */
  description: string;
  /** Decide which completed line (the empty ack or a text line) finishes this command. */
  expected: (line: string) => boolean;
  resolve: (answer: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class CanableAdapter implements CanBus {
  /** Capabilities of this adapter class; static so the host can probe before opening (AGENTS 4). */
  static readonly CAPABILITIES: AdapterCapabilities = {
    can: true,
    canFd: false,
    doip: false,
    isoTpOffload: false,
    channels: 1,
    supportsFunctionalAddressing: true,
  };

  readonly info: AdapterInfo;
  readonly capabilities: AdapterCapabilities = CanableAdapter.CAPABILITIES;

  /** Firmware version the `V` query returned, once open() proved the device. */
  version: string | null = null;

  private readonly log: Logger;
  private readonly channel: string;
  private readonly commandTimeoutMs: number;
  private readonly bitrate: keyof typeof BITRATES;
  private readonly listenOnly: boolean;
  private listeners: Array<{ listener: FrameListener; filters?: readonly CanFilter[] }> = [];
  private buffer = "";
  private pending: PendingCommand | null = null;
  private unsubscribeStream: (() => void) | null = null;
  private unsubscribeError: (() => void) | null = null;
  private opened = false;
  private txCount = 0;
  private rxCount = 0;
  private errors = 0;

  constructor(private readonly options: CanableOptions) {
    this.channel = options.channel ?? "slcan0";
    this.bitrate = options.bitrate ?? "500k";
    this.listenOnly = options.listenOnly ?? false;
    this.commandTimeoutMs = options.commandTimeoutMs ?? 2000;
    this.log = (options.logger ?? createLogger("can", { level: "INFO" })).child("can");
    this.info = {
      id: "canable",
      kind: "slcan",
      name: options.name ?? "CANable (slcan)",
      channels: [this.channel],
    };
  }

  async open(): Promise<void> {
    if (this.opened) return;
    this.unsubscribeStream = this.options.stream.onData((chunk) => this.onChunk(chunk));
    // A stream that reports its own death must not leave this adapter claiming
    // to be open (same contract as the ELM327 adapter): without this, a pulled
    // USB cable reads as a silent vehicle.
    if (this.options.stream.onError) {
      this.unsubscribeError = this.options.stream.onError((error) => this.onStreamError(error));
    }
    this.opened = true;

    // A failed handshake must not leave a half-open adapter claiming to be
    // open: close() puts state, subscriptions and the pending command back to
    // zero before the reason travels up.
    try {
      await this.handshakeAndConfigure();
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  /** V handshake, then the channel setup — see {@link open} for the failure contract. */
  private async handshakeAndConfigure(): Promise<void> {
    // Prove the attachment before configuring it: `V` is the one query every
    // Lawicel firmware answers. Silence here means the stream works but the
    // device is a different adapter — or no adapter at all — and every later
    // failure would wear the costume of a silent vehicle.
    const versionLine = await this.query(
      SLCAN_COMMANDS.version,
      (line) => line.startsWith("V"),
      'the slcan version query "V"',
    );
    this.version = versionLine.startsWith("V") ? versionLine.slice(1).trim() : versionLine;

    const bitrateCommand = BITRATES[this.bitrate] ?? "S6";
    await this.configure(
      bitrateCommand,
      `the slcan bitrate command "${bitrateCommand}" (${this.bitrate})`,
    );
    // Timestamp mode is optional firmware territory (USBtin has no `Z`), so a
    // refusal downgrades to "no timestamp suffix on the wire" instead of
    // failing open(): the parser accepts both line forms.
    try {
      await this.configure(
        SLCAN_COMMANDS.timestampOn,
        `the slcan timestamp command "${SLCAN_COMMANDS.timestampOn}"`,
      );
    } catch (error) {
      this.log.warn("slcan device has no timestamp mode — timestamps stay host-side", {
        error: messageOf(error),
      });
    }
    const openCommand = this.listenOnly ? SLCAN_COMMANDS.listenOnly : SLCAN_COMMANDS.open;
    await this.configure(
      openCommand,
      `the slcan open command "${openCommand}" (${this.listenOnly ? "listen-only" : "normal"} mode)`,
    );
    this.log.info("slcan channel opened", {
      channel: this.channel,
      bitrate: this.bitrate,
      listenOnly: this.listenOnly,
      version: this.version,
    });
  }

  async close(): Promise<void> {
    if (this.opened) {
      try {
        await this.write(`${SLCAN_COMMANDS.close}\r`);
      } catch (error) {
        // Closing a broken channel must not throw — the caller is on its way
        // out. The reason still gets a structured debug line (AGENTS 34.25).
        this.log.debug("slcan close command failed", {
          channel: this.channel,
          error: messageOf(error),
        });
      }
    }
    this.unsubscribeStream?.();
    this.unsubscribeStream = null;
    this.unsubscribeError?.();
    this.unsubscribeError = null;
    this.opened = false;
    this.listeners = [];
    this.failPending(new TransportError("slcan adapter closed"));
  }

  /**
   * The byte stream underneath is gone. Fail the in-flight config command and
   * stop claiming to be open — an adapter whose device left is not an adapter.
   */
  private onStreamError(error: Error): void {
    this.errors++;
    this.log.warn("the byte stream reported an error", { error: messageOf(error) });
    this.opened = false;
    this.failPending(new TransportError(`slcan link failed: ${messageOf(error)}`));
  }

  isOpen(): boolean {
    return this.opened;
  }

  /**
   * Send a frame. TX is fire-and-forget on purpose: the device acks every
   * command with CR/BEL, and a refused TX surfaces as a counted BEL error —
   * the round-trip budget on the diagnostic path belongs to ISO-TP, not to
   * double acking here.
   */
  async send(frame: CanFrame): Promise<void> {
    if (!this.opened) throw new TransportError("slcan adapter is not open");
    if (frame.fd) throw new TransportError("slcan does not support CAN-FD");
    this.txCount++;
    await this.write(formatSlcanFrame(frame));
  }

  subscribe(listener: FrameListener, filters?: readonly CanFilter[]): () => void {
    const entry = { listener, ...(filters ? { filters } : {}) };
    this.listeners.push(entry);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== entry);
    };
  }

  get counters(): { tx: number; rx: number; errors: number } {
    return { tx: this.txCount, rx: this.rxCount, errors: this.errors };
  }

  /** Run a config command and wait for its empty ack line (CR) or its refusal (BEL). */
  private configure(command: string, description: string): Promise<string> {
    return this.issue(command, (line) => line === "", description);
  }

  /** Run a query and wait for the first line `expected` accepts. */
  private query(
    command: string,
    expected: (line: string) => boolean,
    description: string,
  ): Promise<string> {
    return this.issue(command, expected, description);
  }

  private issue(
    command: string,
    expected: (line: string) => boolean,
    description: string,
  ): Promise<string> {
    if (this.pending) {
      // open() and this adapter's own helpers never overlap commands; a second
      // caller overlapped them — refuse, do not desynchronise the ack stream.
      return Promise.reject(
        new TransportError(
          `slcan command "${command}" started while another command is still in flight`,
        ),
      );
    }
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        reject(
          new TransportError(
            `no answer to ${description} within ${this.commandTimeoutMs} ms on ${this.describePort()} — wrong device path, wrong baud rate, or a different adapter (elm327 and slcan do not answer each other's hello)`,
            { command, description, timeoutMs: this.commandTimeoutMs },
          ),
        );
      }, this.commandTimeoutMs);
      this.pending = { description, expected, resolve, reject, timer };
      this.write(`${command}\r`).catch((error: unknown) => {
        this.failPending(error instanceof Error ? error : new TransportError(String(error)));
      });
    });
  }

  private failPending(error: Error): void {
    const pending = this.pending;
    this.pending = null;
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.reject(error);
  }

  private completePending(answer: string): void {
    const pending = this.pending;
    this.pending = null;
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.resolve(answer);
  }

  private describePort(): string {
    const described = this.options.stream.describe?.().trim();
    return described && described.length > 0 ? described : this.channel;
  }

  private async write(data: string): Promise<void> {
    await this.options.stream.write(data).catch((error) => {
      throw new TransportError(`slcan write failed: ${messageOf(error)}`);
    });
  }

  private onChunk(chunk: string): void {
    if (isSlcanError(chunk)) {
      this.errors++;
      this.log.warn("slcan reported BEL (command error)");
      const pending = this.pending;
      if (pending) {
        this.failPending(
          new TransportError(
            `slcan refused ${pending.description} (BEL) — the device did not accept it; check the bus bitrate and that no other program holds the channel`,
            { description: pending.description },
          ),
        );
      }
    }
    this.buffer += chunk.replace(/\u0007/g, "");
    let index = this.buffer.indexOf("\r");
    while (index >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      this.handleLine(line);
      index = this.buffer.indexOf("\r");
    }
  }

  private handleLine(line: string): void {
    if (this.pending?.expected(line)) {
      this.completePending(line);
      return;
    }
    if (line.trim().length === 0) return;
    const frame = parseSlcanLine(line, this.channel);
    if (!frame) return;
    this.rxCount++;
    this.log.raw("slcan rx", { id: `0x${frame.id.toString(16)}`, payload: frame.payload });
    // One filter vocabulary for every adapter (`frameMatchesFilters`), so a
    // filter that states `extended` means it on this adapter too.
    for (const entry of this.listeners) {
      if (entry.filters && !frameMatchesFilters(frame, entry.filters)) continue;
      entry.listener(frame);
    }
  }
}
