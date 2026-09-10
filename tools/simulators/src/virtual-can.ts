/**
 * Virtual CAN network (AGENTS 32).
 *
 * A wire plus any number of nodes. Each node is a regular CanBus, so the same
 * code paths (ISO-TP, UDS, discovery) run against the simulator as against real
 * hardware — that is the whole point of having it.
 */

import type { AdapterCapabilities, AdapterInfo, CanBus, CanFilter, CanFrame, FrameListener } from '@vdp/transport-can';
import { frameMatchesFilters } from '@vdp/transport-can';

export interface VirtualCanOptions {
  channel?: string;
  /** When true, a node also receives its own transmissions (like a raw bus tap). */
  echoToSender?: boolean;
  /** Inject artificial latency in ms — useful to exercise timing behaviour. */
  latencyMs?: number;
  /** Simulated frame loss rate 0..1 for robustness tests. */
  lossRate?: number;
  random?: () => number;
}

export interface VirtualCanNetwork {
  readonly frames: CanFrame[];
  createBus(id: string, capabilities?: Partial<AdapterCapabilities>): VirtualCanBus;
  /** Every frame seen on the wire, for assertions and raw traces. */
  snapshot(): CanFrame[];
  reset(): void;
}

export function createVirtualCanNetwork(options: VirtualCanOptions = {}): VirtualCanNetwork {
  const channel = options.channel ?? 'vcan0';
  const buses: VirtualCanBus[] = [];
  const frames: CanFrame[] = [];
  const random = options.random ?? Math.random;

  const network: VirtualCanNetwork = {
    frames,
    createBus(id, capabilities) {
      const bus = new VirtualCanBus(network, id, channel, capabilities ?? {}, options);
      buses.push(bus);
      return bus;
    },
    snapshot() {
      return frames.map((frame) => ({ ...frame, payload: frame.payload.slice() }));
    },
    reset() {
      frames.length = 0;
    },
  };

  const deliver = (frame: CanFrame, from: VirtualCanBus): void => {
    frames.push(frame);
    if (options.lossRate && options.lossRate > 0 && random() < options.lossRate) return;
    const dispatch = (): void => {
      for (const bus of buses) {
        if (bus === from && !options.echoToSender) continue;
        // `direction` is per observer: the sender sees its own frame as tx, every
        // other bus sees it as rx. A trace recorded with everything labelled rx
        // loses half the conversation and request/response pairing.
        bus.deliver({ ...frame, direction: bus === from ? 'tx' : 'rx' });
      }
    };
    if (options.latencyMs && options.latencyMs > 0) setTimeout(dispatch, options.latencyMs);
    else dispatch();
  };

  (network as { deliver?: unknown }).deliver = deliver;
  return network;
}

export class VirtualCanBus implements CanBus {
  readonly info: AdapterInfo;
  readonly capabilities: AdapterCapabilities;
  private listeners: Array<{ listener: FrameListener; filters?: readonly CanFilter[] }> = [];
  private opened = false;
  txCount = 0;
  rxCount = 0;

  constructor(
    private readonly network: VirtualCanNetwork,
    id: string,
    private readonly channel: string,
    capabilities: Partial<AdapterCapabilities>,
    private readonly options: VirtualCanOptions,
  ) {
    this.info = { id, kind: 'virtual', name: `Virtual CAN ${id}`, channels: [channel] };
    this.capabilities = {
      can: capabilities.can ?? true,
      canFd: capabilities.canFd ?? false,
      doip: false,
      isoTpOffload: false,
      channels: capabilities.channels ?? 1,
      supportsFunctionalAddressing: true,
    };
  }

  async open(): Promise<void> {
    this.opened = true;
  }

  async close(): Promise<void> {
    this.opened = false;
    this.listeners = [];
  }

  isOpen(): boolean {
    return this.opened;
  }

  async send(frame: CanFrame): Promise<void> {
    if (!this.opened) throw new Error(`virtual bus ${this.info.id} is not open`);
    this.txCount++;
    const withDirection: CanFrame = { ...frame, channel: this.channel, direction: frame.direction ?? 'tx' };
    const deliver = (this.network as unknown as { deliver: (frame: CanFrame, from: VirtualCanBus) => void }).deliver;
    deliver(withDirection, this);
  }

  subscribe(listener: FrameListener, filters?: readonly CanFilter[]): () => void {
    const entry = { listener, ...(filters ? { filters } : {}) };
    this.listeners.push(entry);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== entry);
    };
  }

  /** Called by the network. */
  deliver(frame: CanFrame): void {
    this.rxCount++;
    for (const entry of this.listeners) {
      if (entry.filters && !frameMatchesFilters(frame, entry.filters)) continue;
      entry.listener(frame);
    }
  }
}
