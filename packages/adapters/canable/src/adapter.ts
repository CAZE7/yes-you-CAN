/**
 * CANable / CANtact adapter (slcan over a serial byte stream) — AGENTS 4.
 * Pure CAN frame adapter; ISO-TP and UDS stay above it (AGENTS 6).
 */

import { TransportError, createLogger, type Logger } from '@vdp/shared';
import { type AdapterCapabilities, type AdapterInfo, type CanBus, type CanFilter, type CanFrame, type FrameListener } from '@vdp/transport-can';
import type { ByteStream } from '@vdp/adapter-elm327';
import { BITRATES, SLCAN_COMMANDS, formatSlcanFrame, isSlcanError, parseSlcanLine } from './slcan.js';

export interface CanableOptions {
  stream: ByteStream;
  channel?: string;
  bitrate?: keyof typeof BITRATES;
  /**
   * Budget for the device answer to a configuration command (`S6`, `O`, ...).
   *
   * Labelled honestly because it matters on real hardware: slcan confirms every
   * command with an empty line and rejects it with BEL. This adapter writes the command
   * and counts a BEL when one arrives, but it does not *wait* for the confirmation —
   * so open() returns once the bytes are handed to the serial layer, not once the
   * CANable has accepted the bitrate. `commandTimeoutMs` is the budget for that wait
   * and is not read yet; adding it changes when open() fails against firmware that
   * stays silent, which is why it needs a hardware run before it goes in (see the
   * audit finding on adapter command serialisation).
   */
  commandTimeoutMs?: number;
  logger?: Logger;
  name?: string;
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

  private readonly log: Logger;
  private readonly channel: string;
  /** Documented at {@link CanableOptions.commandTimeoutMs}: a budget nothing spends yet. */
  private readonly commandTimeoutMs: number;
  private readonly bitrate: keyof typeof BITRATES;
  private listeners: Array<{ listener: FrameListener; filters?: readonly CanFilter[] }> = [];
  private buffer = '';
  private unsubscribeStream: (() => void) | null = null;
  private opened = false;
  private txCount = 0;
  private rxCount = 0;
  private errors = 0;

  constructor(private readonly options: CanableOptions) {
    this.channel = options.channel ?? 'slcan0';
    this.bitrate = options.bitrate ?? '500k';
    this.commandTimeoutMs = options.commandTimeoutMs ?? 2000;
    this.log = (options.logger ?? createLogger('can', { level: 'INFO' })).child('can');
    this.info = { id: 'canable', kind: 'slcan', name: options.name ?? 'CANable (slcan)', channels: [this.channel] };
  }

  async open(): Promise<void> {
    if (this.opened) return;
    this.unsubscribeStream = this.options.stream.onData((chunk) => this.onChunk(chunk));
    this.opened = true;
    await this.command(BITRATES[this.bitrate] ?? 'S6');
    await this.command(SLCAN_COMMANDS.timestampOn);
    await this.command(SLCAN_COMMANDS.open);
    this.log.info('slcan channel opened', { channel: this.channel, bitrate: this.bitrate });
  }

  async close(): Promise<void> {
    if (this.opened) {
      try {
        await this.command(SLCAN_COMMANDS.close);
      } catch {
        // closing a broken channel must not throw
      }
    }
    this.unsubscribeStream?.();
    this.unsubscribeStream = null;
    this.opened = false;
    this.listeners = [];
  }

  isOpen(): boolean {
    return this.opened;
  }

  async send(frame: CanFrame): Promise<void> {
    if (!this.opened) throw new TransportError('slcan adapter is not open');
    if (frame.fd) throw new TransportError('slcan does not support CAN-FD');
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

  private async command(command: string): Promise<void> {
    await this.write(`${command}\r`);
  }

  private async write(data: string): Promise<void> {
    await this.options.stream.write(data).catch((error) => {
      throw new TransportError(`slcan write failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private onChunk(chunk: string): void {
    if (isSlcanError(chunk)) {
      this.errors++;
      this.log.warn('slcan reported BEL (command error)');
    }
    this.buffer += chunk.replace(/\u0007/g, '');
    let index = this.buffer.indexOf('\r');
    while (index >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (line.trim().length > 0) this.handleLine(line);
      index = this.buffer.indexOf('\r');
    }
  }

  private handleLine(line: string): void {
    const frame = parseSlcanLine(line, this.channel);
    if (!frame) return;
    this.rxCount++;
    this.log.raw('slcan rx', { id: `0x${frame.id.toString(16)}`, payload: frame.payload });
    for (const entry of this.listeners) {
      if (entry.filters && entry.filters.length > 0) {
        const matches = entry.filters.some((f) => (frame.id & f.mask) === (f.id & f.mask));
        if (!matches) continue;
      }
      entry.listener(frame);
    }
  }
}
