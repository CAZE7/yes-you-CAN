export * from './adapter.js';
export * from './protocol.js';
export * from './stream.js';
import { Elm327Adapter, type Elm327Options } from './adapter.js';
import type { CanAdapterFactory } from '@vdp/transport-can';
import type { ByteStream } from './stream.js';

/**
 * Factory for the adapter registry (AGENTS 4: adapters plug in, the engine never
 * references a concrete one). A stream must be supplied by the host platform.
 */
export function createElm327Factory(stream: ByteStream, defaults: Partial<Elm327Options> = {}): CanAdapterFactory {
  return {
    id: 'elm327',
    displayName: 'ELM327 / OBDLink (serial)',
    create: (options) => new Elm327Adapter({ stream, ...defaults, ...(options as Partial<Elm327Options>) }),
    isAvailable: () => stream.isOpen(),
  };
}
