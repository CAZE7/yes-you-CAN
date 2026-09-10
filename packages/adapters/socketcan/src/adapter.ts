/**
 * SocketCAN adapter for Linux (AGENTS 4).
 *
 * Thin wrapper turning a SocketCAN channel into the platform's CanBus contract.
 * The frame layer stays dumb — no ISO-TP, no UDS (AGENTS 6).
 */

import { TransportError, createLogger, type Logger } from '@vdp/shared';
import { type AdapterCapabilities, type AdapterInfo, type CanBus, type CanFilter, type CanFrame, type FrameListener } from '@vdp/transport-can';
import type { SocketCanBinding, SocketCanChannel } from './binding.js';

export interface SocketCanOptions {
  binding: SocketCanBinding;
  iface?: string;
  bitrate?: number;
  /** Advertise CAN-FD only when the interface really supports it. */
  canFd?: boolean;
  logger?: Logger;
}

export class SocketCanAdapter implements CanBus {
  readonly info: AdapterInfo;
  readonly capabilities: AdapterCapabilities;

  private readonly log: Logger;
  private readonly iface: string;
  private channel: SocketCanChannel | null = null;
  private listeners: Array<{ listener: FrameListener; filters?: readonly CanFilter[] }> = [];
  private unsubscribe: (() => void) | null = null;
  private txCount = 0;
  private rxCount = 0;

  constructor(private readonly options: SocketCanOptions) {
    this.iface = options.iface ?? 'can0';
    this.log = (options.logger ?? createLogger('can', { level: 'INFO' })).child('can');
    this.info = { id: 'socketcan', kind: 'socketcan', name: `SocketCAN ${this.iface}`, channels: [this.iface] };
    this.capabilities = {
      can: true,
      canFd: options.canFd ?? false,
      doip: false,
      isoTpOffload: false,
      channels: 1,
      supportsFunctionalAddressing: true,
    };
  }

  async open(): Promise<void> {
    if (this.channel) return;
    const channel = await this.options.binding.open(this.iface);
    if (this.options.bitrate && channel.setBitrate) await channel.setBitrate(this.options.bitrate);
    this.unsubscribe = channel.onData((frame) => this.handleFrame(frame));
    this.channel = channel;
    this.log.info('SocketCAN channel opened', { iface: this.iface, binding: this.options.binding.name });
  }

  async close(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    await this.channel?.close();
    this.channel = null;
    this.listeners = [];
  }

  isOpen(): boolean {
    return this.channel !== null;
  }

  async send(frame: CanFrame): Promise<void> {
    if (!this.channel) throw new TransportError('SocketCAN channel is not open');
    if (frame.fd && !this.capabilities.canFd) throw new TransportError('CAN-FD frame sent to a CAN-FD incapable interface');
    this.txCount++;
    await this.channel.send({ id: frame.id, extended: frame.extended, data: frame.payload });
  }

  subscribe(listener: FrameListener, filters?: readonly CanFilter[]): () => void {
    const entry = { listener, ...(filters ? { filters } : {}) };
    this.listeners.push(entry);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== entry);
    };
  }

  get counters(): { tx: number; rx: number } {
    return { tx: this.txCount, rx: this.rxCount };
  }

  private handleFrame(frame: { id: number; extended: boolean; data: Uint8Array }): void {
    this.rxCount++;
    const canFrame: CanFrame = {
      timestamp: Date.now(),
      id: frame.id,
      extended: frame.extended,
      fd: false,
      dlc: frame.data.length,
      payload: frame.data,
      channel: this.iface,
      direction: 'rx',
    };
    this.log.raw('socketcan rx', { id: `0x${canFrame.id.toString(16)}`, payload: canFrame.payload });
    for (const entry of this.listeners) {
      if (entry.filters && entry.filters.length > 0) {
        const matches = entry.filters.some((filter) => (canFrame.id & filter.mask) === (filter.id & filter.mask));
        if (!matches) continue;
      }
      entry.listener(canFrame);
    }
  }
}
