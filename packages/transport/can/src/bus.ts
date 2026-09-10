/**
 * Frame-level CAN bus contract used by the ISO-TP layer and adapters.
 * Sits *below* ISO-TP, above the physical adapter (AGENTS 5 layer stack).
 */

import type { CanFilter, CanFrame } from './frame.js';
import type { AdapterCapabilities, AdapterInfo } from './transport.js';

export type FrameListener = (frame: CanFrame) => void;

export interface CanBus {
  readonly info: AdapterInfo;
  readonly capabilities: AdapterCapabilities;
  open(): Promise<void>;
  close(): Promise<void>;
  isOpen(): boolean;
  send(frame: CanFrame): Promise<void>;
  /** Subscribe to received frames; returns an unsubscribe function. */
  subscribe(listener: FrameListener, filters?: readonly CanFilter[]): () => void;
}

/** Factory contract so new adapters plug in without touching the engine (AGENTS 4, rule 6). */
export interface CanAdapterFactory {
  readonly id: string;
  readonly displayName: string;
  create(options?: Record<string, unknown>): CanBus;
  /** Cheap environment probe: is this adapter usable on this host? */
  isAvailable?(): boolean | Promise<boolean>;
}

export class CanAdapterRegistry {
  private readonly factories = new Map<string, CanAdapterFactory>();

  register(factory: CanAdapterFactory): void {
    this.factories.set(factory.id, factory);
  }

  get(id: string): CanAdapterFactory | undefined {
    return this.factories.get(id);
  }

  create(id: string, options?: Record<string, unknown>): CanBus {
    const factory = this.factories.get(id);
    if (!factory) throw new Error(`Unknown CAN adapter "${id}". Registered: ${Array.from(this.factories.keys()).join(', ')}`);
    return factory.create(options);
  }

  list(): Array<{ id: string; displayName: string }> {
    return Array.from(this.factories.values()).map((f) => ({ id: f.id, displayName: f.displayName }));
  }
}
