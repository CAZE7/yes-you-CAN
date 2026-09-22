/**
 * Virtual CAN network (AGENTS 32).
 *
 * A wire plus any number of nodes. Each node is a regular CanBus, so the same
 * code paths (ISO-TP, UDS, discovery) run against the simulator as against real
 * hardware — that is the whole point of having it.
 */

import { AdapterUnsupportedError, TransportError } from "@vdp/shared";
import type {
  AdapterCapabilities,
  AdapterInfo,
  CanBus,
  CanFilter,
  CanFrame,
  FrameListener,
} from "@vdp/transport-can";
import { frameMatchesFilters } from "@vdp/transport-can";

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

/**
 * A defect on the wire itself (AGENTS 32, master backlog P0 #16).
 *
 * The whole vehicle model needs this to be *measurable*: a module does not know
 * that a peer "went offline" from a function call, it knows because the frames it
 * expects do not arrive. So a bus fault is stated as a property of the wire —
 * frames matching `match` are swallowed on their way to every node, in both
 * directions — and every observer downstream (the gateway's timeout monitor, the
 * tester's UDS transaction) reacts to the same loss on its own.
 *
 * `lossRate` keeps the healthy frames flowing, which is what an intermittent
 * defect looks like on a car; `silent` is a cut wire.
 */
export interface CanWireImpairment {
  /** Name it — it appears in the log and in `impairments`, so a fault is traceable. */
  id?: string;
  /** A frame this impairment can see (a CAN id, one direction, one channel). */
  match(frame: CanFrame): boolean;
  /** Probability 0..1 that a matching frame is lost. */
  lossRate?: number;
  /** Every matching frame is lost (default when no `lossRate` is given). */
  silent?: boolean;
}

/** What the wire did to a frame — the accounting a test asserts on. */
export interface WireImpairmentStat {
  id: string;
  matched: number;
  dropped: number;
}

export interface VirtualCanNetwork {
  readonly frames: CanFrame[];
  createBus(id: string, capabilities?: Partial<AdapterCapabilities>): VirtualCanBus;
  /** Every frame seen on the wire, for assertions and raw traces. */
  snapshot(): CanFrame[];
  reset(): void;
  /**
   * Defect the wire until the returned handle is called.
   *
   * Returns the removal handle so a scenario can undo exactly what it did — an
   * impairment that cannot be lifted is a global state leak between tests.
   */
  impair(impairment: CanWireImpairment): () => void;
  /** Active impairments, in the order they were added. */
  readonly impairments: readonly string[];
  /** Frames matched and dropped per impairment id. */
  impairmentStats(): WireImpairmentStat[];
}

export function createVirtualCanNetwork(options: VirtualCanOptions = {}): VirtualCanNetwork {
  const channel = options.channel ?? "vcan0";
  const buses: VirtualCanBus[] = [];
  const frames: CanFrame[] = [];
  const random = options.random ?? Math.random;
  const impairments: ActiveImpairment[] = [];

  /**
   * The wire. `deliver` is on the type instead of hung off it after the fact: the
   * buses the network creates have to call it, and a `(network as unknown as
   * {deliver}).deliver` cast would hide a rename from the compiler (AGENTS 32).
   */
  const wire: VirtualCanWire = {
    frames,
    createBus(id, capabilities) {
      const bus = new VirtualCanBus(wire, id, channel, capabilities ?? {}, options);
      buses.push(bus);
      return bus;
    },
    snapshot() {
      return frames.map((frame) => ({ ...frame, payload: frame.payload.slice() }));
    },
    reset() {
      frames.length = 0;
      for (const active of impairments) active.stat.matched = 0;
      for (const active of impairments) active.stat.dropped = 0;
    },
    impair(impairment) {
      const active: ActiveImpairment = {
        ...impairment,
        id: impairment.id ?? `impairment_${impairments.length + 1}`,
        stat: {
          id: impairment.id ?? `impairment_${impairments.length + 1}`,
          matched: 0,
          dropped: 0,
        },
      };
      impairments.push(active);
      return () => {
        const index = impairments.indexOf(active);
        if (index >= 0) impairments.splice(index, 1);
      };
    },
    get impairments() {
      return impairments.map((active) => active.id);
    },
    impairmentStats() {
      return impairments.map((active) => ({ ...active.stat }));
    },
    deliver(frame, from) {
      frames.push(frame);
      if (lostToImpairments(frame, impairments, random)) return;
      // The network-wide loss rate is a *background* defect and applies on top of a
      // targeted impairment: a frame a defect let through can still be lost by the
      // lossy wire, which is how two real faults behave on one bus.
      if (options.lossRate && options.lossRate > 0 && random() < options.lossRate) return;
      const dispatch = (): void => {
        for (const bus of buses) {
          if (bus === from && !options.echoToSender) continue;
          // `direction` is per observer: the sender sees its own frame as tx, every
          // other bus sees it as rx. A trace recorded with everything labelled rx
          // loses half the conversation and request/response pairing.
          bus.deliver({ ...frame, direction: bus === from ? "tx" : "rx" });
        }
      };
      if (options.latencyMs && options.latencyMs > 0) setTimeout(dispatch, options.latencyMs);
      else dispatch();
    },
  };
  return wire;
}

/** An impairment plus its accounting, as the wire holds it. */
interface ActiveImpairment extends CanWireImpairment {
  id: string;
  stat: WireImpairmentStat;
}

/** Whether this frame is swallowed on its way to the other nodes. */
function lostToImpairments(
  frame: CanFrame,
  impairments: readonly ActiveImpairment[],
  random: () => number,
): boolean {
  for (const active of impairments) {
    if (!active.match(frame)) continue;
    active.stat.matched++;
    const rate = active.lossRate ?? (active.silent === false ? 0 : 1);
    if (rate > 0 && random() < rate) {
      active.stat.dropped++;
      return true;
    }
  }
  return false;
}

/** The network as the buses see it: the public surface plus the delivery entry. */
export interface VirtualCanWire extends VirtualCanNetwork {
  /** Hand a frame to every other node of the wire. Called by {@link VirtualCanBus}. */
  deliver(frame: CanFrame, from: VirtualCanBus): void;
}

export class VirtualCanBus implements CanBus {
  readonly info: AdapterInfo;
  readonly capabilities: AdapterCapabilities;
  private listeners: Array<{ listener: FrameListener; filters?: readonly CanFilter[] }> = [];
  private opened = false;
  txCount = 0;
  rxCount = 0;

  constructor(
    private readonly network: VirtualCanWire,
    id: string,
    private readonly channel: string,
    capabilities: Partial<AdapterCapabilities>,
    _options: VirtualCanOptions,
  ) {
    this.info = { id, kind: "virtual", name: `Virtual CAN ${id}`, channels: [channel] };
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
    if (!this.opened) {
      throw new TransportError(`virtual bus ${this.info.id} is not open`, {
        adapterId: this.info.id,
      });
    }
    // A bus that advertises `canFd: false` must not carry FD frames either: ISO-TP
    // decides from these capabilities, and a wire that quietly accepts what the
    // adapter says it cannot do hides exactly the mistake a real bus would fail on.
    if (frame.fd && !this.capabilities.canFd) {
      throw new AdapterUnsupportedError(
        `virtual bus ${this.info.id} does not advertise CAN-FD (AGENTS 4)`,
        { adapterId: this.info.id },
      );
    }
    this.txCount++;
    const withDirection: CanFrame = {
      ...frame,
      channel: this.channel,
      direction: frame.direction ?? "tx",
    };
    this.network.deliver(withDirection, this);
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
