/**
 * SocketCAN adapter for Linux (AGENTS 4).
 *
 * Thin wrapper turning a SocketCAN channel into the platform's CanBus contract.
 * The frame layer stays dumb — no ISO-TP, no UDS (AGENTS 6).
 */

import { createLogger, type Logger, messageOf, TransportError } from "@vdp/shared";
import type {
  AdapterCapabilities,
  AdapterInfo,
  CanBus,
  CanFilter,
  CanFrame,
  ConnectionStatus,
  FrameListener,
} from "@vdp/transport-can";
import { ConnectionTracker, frameMatchesFilters } from "@vdp/transport-can";
import type { SocketCanBinding, SocketCanChannel, SocketCanFrameData } from "./binding.js";

export interface SocketCanOptions {
  binding: SocketCanBinding;
  iface?: string;
  bitrate?: number;
  /** Advertise CAN-FD only when the interface really supports it. */
  canFd?: boolean;
  logger?: Logger;
}

export class SocketCanAdapter implements CanBus {
  /**
   * Capabilities of this adapter class. CAN-FD depends on both the interface and
   * the binding, so the caller has to opt in explicitly — advertising FD by
   * default would make the engine send frames the bus cannot carry.
   */
  static readonly CAPABILITIES: AdapterCapabilities = {
    can: true,
    canFd: false,
    doip: false,
    isoTpOffload: false,
    channels: 1,
    supportsFunctionalAddressing: true,
  };

  readonly info: AdapterInfo;
  readonly capabilities: AdapterCapabilities;

  private readonly log: Logger;
  private readonly iface: string;
  private channel: SocketCanChannel | null = null;
  private listeners: Array<{ listener: FrameListener; filters?: readonly CanFilter[] }> = [];
  private unsubscribe: (() => void) | null = null;
  /** The link's state, reason and counters (master prompt P1). */
  private readonly connection: ConnectionTracker;

  constructor(private readonly options: SocketCanOptions) {
    this.iface = options.iface ?? "can0";
    this.log = (options.logger ?? createLogger("can", { level: "INFO" })).child("can");
    this.info = {
      id: "socketcan",
      kind: "socketcan",
      name: `SocketCAN ${this.iface}`,
      channels: [this.iface],
    };
    this.connection = new ConnectionTracker({
      adapterId: this.info.id,
      detail: `${this.info.name} (${options.binding.name})`,
    });
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
    this.connection.connect(`opening ${this.iface} through ${this.options.binding.name}`);
    let channel: SocketCanChannel;
    try {
      channel = await this.options.binding.open(this.iface);
      if (this.options.bitrate && channel.setBitrate)
        await channel.setBitrate(this.options.bitrate);
    } catch (error) {
      // Interface missing, permission denied, bitrate refused: the link is not
      // there and the reason has to survive (master prompt P1).
      this.connection.fail(`cannot open ${this.iface}: ${messageOf(error)}`);
      throw error;
    }
    this.unsubscribe = channel.onData((frame) => this.handleFrame(frame));
    this.channel = channel;
    this.log.info("SocketCAN channel opened", {
      iface: this.iface,
      binding: this.options.binding.name,
    });
    this.connection.connected(
      `${this.info.name} (${this.options.binding.name}${this.options.bitrate ? `, ${this.options.bitrate} bit/s` : ""})`,
    );
  }

  async close(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    await this.channel?.close();
    this.channel = null;
    this.listeners = [];
    this.connection.disconnected("closed by the caller");
  }

  isOpen(): boolean {
    return this.channel !== null;
  }

  async send(frame: CanFrame): Promise<void> {
    if (!this.channel) throw new TransportError("SocketCAN channel is not open");
    if (frame.fd && !this.capabilities.canFd)
      throw new TransportError("CAN-FD frame sent to a CAN-FD incapable interface");
    // fd/brs travel with the frame: a binding that supports CAN-FD needs them,
    // and silently dropping them is how a 64-byte ISO-TP FD segment ends up on
    // the wire as a classic frame the kernel has to refuse (ISO 11898-1).
    this.connection.report({ tx: 1, at: Date.now() });
    try {
      await this.channel.send({
        id: frame.id,
        extended: frame.extended,
        data: frame.payload,
        fd: frame.fd,
        ...(frame.brs === undefined ? {} : { brs: frame.brs }),
      });
    } catch (error) {
      // The kernel refused the frame while the socket is still open (bus off,
      // a full queue, a vanished interface reported per write). That is a
      // degradation of a link that is still there — the next frame that goes
      // through clears it, and the reason stays readable until then.
      this.connection.degraded(`send refused by the kernel: ${messageOf(error)}`);
      throw error;
    }
  }

  subscribe(listener: FrameListener, filters?: readonly CanFilter[]): () => void {
    const entry = { listener, ...(filters ? { filters } : {}) };
    this.listeners.push(entry);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== entry);
    };
  }

  get counters(): { tx: number; rx: number } {
    const status = this.connection.status();
    return { tx: status.txCount ?? 0, rx: status.rxCount ?? 0 };
  }

  /** The link state, its reason, when it was entered and the frame counters. */
  getStatus(): ConnectionStatus {
    return this.connection.status();
  }

  private handleFrame(frame: SocketCanFrameData): void {
    this.connection.report({ rx: 1, at: Date.now() });
    this.connection.healthy("frames are arriving again");
    const canFrame: CanFrame = {
      timestamp: Date.now(),
      id: frame.id,
      extended: frame.extended,
      // A binding that reports CAN-FD gets FD frames; one that cannot stays
      // classic. `fd: false` hardcoded here used to flatten every FD frame on
      // the receive side, even when the binding and the interface could carry it.
      fd: frame.fd === true,
      dlc: frame.data.length,
      payload: frame.data,
      channel: this.iface,
      direction: "rx",
      ...(frame.brs === true ? { brs: true } : {}),
    };
    this.log.raw("socketcan rx", {
      id: `0x${canFrame.id.toString(16)}`,
      payload: canFrame.payload,
    });
    // One filter vocabulary for every adapter (`frameMatchesFilters`).
    for (const entry of this.listeners) {
      if (entry.filters && !frameMatchesFilters(canFrame, entry.filters)) continue;
      entry.listener(canFrame);
    }
  }
}
