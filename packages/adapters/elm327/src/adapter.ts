/**
 * ELM327 / OBDLink adapter (AGENTS 4, 29).
 *
 * This is the "normal CAN adapter" the first release must work with. It stays a
 * pure CAN frame adapter: no UDS, no ISO-TP, no OEM logic (AGENTS 6).
 */

import { AdapterUnsupportedError, TransportError, createLogger, type Logger } from '@vdp/shared';
import { type AdapterCapabilities, type AdapterInfo, type CanBus, type CanFilter, type CanFrame, type FrameListener } from '@vdp/transport-can';
import { DEFAULT_INIT_SEQUENCE, formatIdentifier, formatSendPayload, isElmError, parseFrameLine } from './protocol.js';
import type { ByteStream } from './stream.js';

export interface Elm327Options {
  stream: ByteStream;
  /** Channel label used in traces. */
  channel?: string;
  /** Override the AT init sequence. */
  initSequence?: readonly string[];
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
  readonly info: AdapterInfo;
  readonly capabilities: AdapterCapabilities = {
    can: true,
    canFd: false,
    doip: false,
    isoTpOffload: false,
    channels: 1,
    supportsFunctionalAddressing: true,
  };

  readonly status: Elm327Status = { commandsRun: 0, errors: [] };

  private readonly log: Logger;
  private readonly channel: string;
  private readonly initSequence: readonly string[];
  private readonly commandTimeoutMs: number;
  private listeners: Array<{ listener: FrameListener; filters?: readonly CanFilter[] }> = [];
  private buffer = '';
  private unsubscribeStream: (() => void) | null = null;
  private opened = false;
  private currentTxId: number | null = null;
  private pending: Array<{ resolve: (lines: string[]) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];
  private currentLines: string[] = [];
  private txCount = 0;
  private rxCount = 0;

  constructor(private readonly options: Elm327Options) {
    this.channel = options.channel ?? 'elm0';
    this.log = (options.logger ?? createLogger('can', { level: 'INFO' })).child('can');
    this.initSequence = options.initSequence ?? DEFAULT_INIT_SEQUENCE;
    this.commandTimeoutMs = options.commandTimeoutMs ?? 3000;
    this.info = {
      id: 'elm327',
      kind: 'elm327',
      name: options.name ?? 'ELM327',
      channels: [this.channel],
    };
  }

  async open(): Promise<void> {
    if (this.opened) return;
    this.unsubscribeStream = this.options.stream.onData((chunk) => this.onChunk(chunk));
    this.opened = true;

    for (const command of this.initSequence) {
      const lines = await this.command(command);
      if (command === 'ATZ') this.status.version = lines.join(' ').trim() || this.status.version;
      if (command === 'ATDP') this.status.protocol = lines.join(' ').trim();
    }
    this.log.info('ELM327 initialised', { version: this.status.version, channel: this.channel });
  }

  async close(): Promise<void> {
    this.unsubscribeStream?.();
    this.unsubscribeStream = null;
    this.opened = false;
    this.listeners = [];
    for (const entry of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new TransportError('adapter closed'));
    }
    this.pending = [];
  }

  isOpen(): boolean {
    return this.opened;
  }

  async send(frame: CanFrame): Promise<void> {
    if (!this.opened) throw new TransportError('ELM327 adapter is not open');
    if (frame.fd) throw new AdapterUnsupportedError('ELM327 does not support CAN-FD frames');

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
        this.log.warn('ELM327 reported an error', { error, command: payload });
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
    const lines = await this.command('ATRV');
    const value = Number.parseFloat(lines.join('').replace(/[^0-9.]/g, ''));
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
    return new Promise<string[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = this.pending.filter((entry) => entry.resolve !== resolve);
        reject(new TransportError(`ELM327 command "${command}" timed out after ${this.commandTimeoutMs} ms`));
      }, this.commandTimeoutMs);
      this.pending.push({ resolve, reject, timer });
      void this.options.stream.write(`${command}\r`).catch((error) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  private onChunk(chunk: string): void {
    this.buffer += chunk;
    let newlineIndex = this.buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = this.buffer.slice(0, newlineIndex).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newlineIndex + 1);
      this.handleLine(line);
      newlineIndex = this.buffer.indexOf('\n');
    }
    // A prompt can arrive without a trailing newline.
    if (this.buffer.includes('>')) {
      const parts = this.buffer.split('>');
      const remainder = parts.pop() ?? '';
      for (const part of parts) this.handleLine(part);
      this.buffer = remainder;
      this.flushPending();
    }
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed === '>') return;
    this.currentLines.push(trimmed);

    const frame = parseFrameLine(trimmed, this.channel);
    if (frame) {
      this.rxCount++;
      this.log.raw('elm327 rx', { id: `0x${frame.id.toString(16)}`, payload: frame.payload });
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
        const matches = entry.filters.some((filter) => (frame.id & filter.mask) === (filter.id & filter.mask));
        if (!matches) continue;
      }
      entry.listener(frame);
    }
  }
}
