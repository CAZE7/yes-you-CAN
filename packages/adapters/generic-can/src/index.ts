/**
 * Generic CAN adapter binding (AGENTS 4).
 *
 * Wraps any CanBus implementation the host provides (virtual bus, vendor SDK,
 * bridge) and normalises its metadata so the engine can treat every adapter the
 * same way. Also owns the adapter registry used by the UI's adapter picker.
 */

import { AdapterUnsupportedError, createLogger, type Logger } from "@vdp/shared";
import {
  type AdapterCapabilities,
  type AdapterInfo,
  type CanAdapterFactory,
  CanAdapterRegistry,
  type CanBus,
  type CanFilter,
  type CanFrame,
  type FrameListener,
  frameMatchesFilters,
} from "@vdp/transport-can";

export interface GenericCanOptions {
  /** Identifier used by the registry, e.g. "virtual" or "vendor-x". */
  id: string;
  displayName: string;
  bus: CanBus;
  /** Override the capabilities the wrapped bus advertises. */
  capabilities?: Partial<AdapterCapabilities>;
  logger?: Logger;
}

export class GenericCanAdapter implements CanBus {
  readonly info: AdapterInfo;
  readonly capabilities: AdapterCapabilities;
  private readonly log: Logger;
  private txCount = 0;
  private rxCount = 0;
  private listeners: Array<{ listener: FrameListener; filters?: readonly CanFilter[] }> = [];
  private unsubscribeWrapped: (() => void) | null = null;

  constructor(private readonly options: GenericCanOptions) {
    this.log = (options.logger ?? createLogger("can", { level: "INFO" })).child("can");
    this.info = { ...options.bus.info, id: options.id, name: options.displayName };
    this.capabilities = { ...options.bus.capabilities, ...(options.capabilities ?? {}) };
  }

  get wrapped(): CanBus {
    return this.options.bus;
  }

  async open(): Promise<void> {
    await this.options.bus.open();
    this.log.info("generic CAN adapter opened", {
      id: this.options.id,
      capabilities: this.capabilities,
    });
  }

  async close(): Promise<void> {
    this.detach();
    await this.options.bus.close();
  }

  isOpen(): boolean {
    return this.options.bus.isOpen();
  }

  async send(frame: CanFrame): Promise<void> {
    if (frame.fd && !this.capabilities.canFd) {
      throw new AdapterUnsupportedError(`adapter "${this.options.id}" does not support CAN-FD`, {
        adapterId: this.options.id,
      });
    }
    this.txCount++;
    await this.options.bus.send(frame);
  }

  /**
   * One wrapped subscription for everyone, attached on demand: the rx counter
   * counts *bus* frames, not listener deliveries — two subscribers used to
   * count the same frame twice, which is a soap bubble, not a measurement.
   * Filters are still applied, just locally, exactly as the other adapters do.
   */
  subscribe(listener: FrameListener, filters?: readonly CanFilter[]): () => void {
    const entry = { listener, ...(filters ? { filters } : {}) };
    this.listeners.push(entry);
    if (!this.unsubscribeWrapped) {
      this.unsubscribeWrapped = this.options.bus.subscribe((frame) => this.dispatch(frame));
    }
    return () => {
      this.listeners = this.listeners.filter((entry2) => entry2 !== entry);
      if (this.listeners.length === 0) this.detach();
    };
  }

  private dispatch(frame: CanFrame): void {
    this.rxCount++;
    // One filter vocabulary for every adapter (`frameMatchesFilters`): this
    // wrapper used to carry its own copy of the mask comparison — the fourth in
    // the tree — which ignored a filter's `extended` flag like the other three.
    for (const entry of this.listeners) {
      if (entry.filters && !frameMatchesFilters(frame, entry.filters)) continue;
      entry.listener(frame);
    }
  }

  private detach(): void {
    this.unsubscribeWrapped?.();
    this.unsubscribeWrapped = null;
  }

  get counters(): { tx: number; rx: number } {
    return { tx: this.txCount, rx: this.rxCount };
  }
}

export function createGenericCanFactory(
  options: Omit<GenericCanOptions, "bus"> & { create: () => CanBus },
): CanAdapterFactory {
  return {
    id: options.id,
    displayName: options.displayName,
    create: () => new GenericCanAdapter({ ...options, bus: options.create() }),
  };
}

/** Registry pre-populated with the adapters this repository ships. */
export function createAdapterRegistry(
  factories: readonly CanAdapterFactory[] = [],
): CanAdapterRegistry {
  const registry = new CanAdapterRegistry();
  for (const factory of factories) registry.register(factory);
  return registry;
}

export { CanAdapterRegistry };
