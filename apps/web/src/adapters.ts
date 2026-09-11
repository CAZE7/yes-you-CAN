/**
 * Adapter catalog of the workbench application.
 *
 * Layer position: this module lives in the *application* (ADR 0001), so it may
 * know both the host adapter integration and the simulator. The adapter packages
 * must not know the simulator — that is why `@vdp/adapter-host` only describes
 * the serial/SocketCAN adapters and the application registers the two entries it
 * owns itself:
 *
 * - `simulator` — a virtual vehicle (AGENTS 32), the default for a workstation
 *   without hardware.
 * - `replay`    — a recorded trace instead of a vehicle (AGENTS 19), so a
 *   problem can be reproduced without the car.
 *
 * Both are marked `managedBy: 'application'`: the catalog describes and validates
 * them, but the bus is created by the backend, because building a virtual vehicle
 * requires layers above the adapter layer.
 */

import { AdapterUnsupportedError } from '@vdp/shared';
import { AdapterCatalog, createHostAdapterCatalog, type AdapterEntry } from '@vdp/adapter-host';

export const SIMULATOR_ADAPTER_ID = 'simulator';
export const REPLAY_ADAPTER_ID = 'replay';

/** Entries whose bus is built by the application, not by the adapter layer. */
export const APPLICATION_MANAGED = 'application' as const;

/**
 * The simulator entry: no hardware requirements, always available.
 *
 * `probe` reports the definition package that will be loaded so the operator can
 * see what the virtual ECUs will answer before connecting.
 */
function simulatorEntry(): AdapterEntry {
  return {
    id: SIMULATOR_ADAPTER_ID,
    displayName: 'Simulator (virtuelles Fahrzeug)',
    kind: 'simulator',
    transport: 'can',
    description:
      'Virtuelles Fahrzeug mit UDS-Servern, DTCs und zeitlich veränderlichen Messwerten (AGENTS 32). Kein Adapter, kein Fahrzeug nötig.',
    capabilities: {
      can: true,
      canFd: false,
      doip: false,
      isoTpOffload: false,
      channels: 1,
      supportsFunctionalAddressing: true,
    },
    requires: {},
    managedBy: 'application',
    probe: async () => ({ available: true, detail: 'virtuelle ECUs über ein virtuelles CAN-Netz — immer verfügbar' }),
    create: async () => {
      throw new AdapterUnsupportedError(
        'the simulator bus is created by the application — select it with mode "simulator"',
        { adapterId: SIMULATOR_ADAPTER_ID },
      );
    },
  };
}

/**
 * The replay entry.
 *
 * A recording is addressed either by stored session id (`--session=<id>`) or by
 * a session export file (`--trace=<file>`, produced by the JSON export). Both
 * contain the raw trace, so replay does not need the original vehicle.
 */
function replayEntry(): AdapterEntry {
  return {
    id: REPLAY_ADAPTER_ID,
    displayName: 'Trace-Replay (aufgezeichnete Sitzung)',
    kind: 'replay',
    transport: 'can',
    description:
      'Spielt den Roh-Trace einer gespeicherten Sitzung ab (AGENTS 19). Abweichungen zu den aufgezeichneten Requests werden gemeldet statt geglättet.',
    capabilities: {
      can: true,
      canFd: true,
      doip: false,
      isoTpOffload: false,
      channels: 1,
    },
    // `--trace` is optional: a stored session id (selected in the UI) works the
    // same way, so demanding a file would reject the common case.
    requires: {},
    managedBy: 'application',
    probe: async (config) => {
      if (config.trace) return { available: true, detail: `recording: ${config.trace}` };
      return { available: true, detail: 'recording: gespeicherte Sitzung oder Session-Export wählen' };
    },
    create: async () => {
      throw new AdapterUnsupportedError(
        'the replay bus is created by the application — select it with mode "replay"',
        { adapterId: REPLAY_ADAPTER_ID },
      );
    },
  };
}

export interface WebAdapterCatalogOptions {
  /** Include the simulator entry (default true). */
  simulator?: boolean;
  /** Include the trace replay entry (default true). */
  replay?: boolean;
  /** Include the real adapters (default true). */
  host?: boolean;
}

/** Catalog used by the workbench: simulator, replay and every adapter of this host. */
export function createWebAdapterCatalog(options: WebAdapterCatalogOptions = {}): AdapterCatalog {
  const entries: AdapterEntry[] = [];
  if (options.simulator !== false) entries.push(simulatorEntry());
  if (options.replay !== false) entries.push(replayEntry());
  if (options.host !== false) entries.push(...createHostAdapterCatalog().list());
  return new AdapterCatalog(entries);
}

/** True when the entry's bus is built by the application instead of the catalog. */
export function isApplicationManaged(entry: AdapterEntry): boolean {
  return entry.managedBy === APPLICATION_MANAGED;
}

/** Availability line for the UI header: the first usable adapter wins. */
export function summarizeAvailability(descriptions: ReadonlyArray<{ id: string; displayName: string; probe: { available: boolean } }>): string {
  const usable = descriptions.filter((entry) => entry.probe.available);
  if (usable.length === 0) return 'kein Adapter einsatzbereit';
  return `${usable.length} von ${descriptions.length} Adaptern einsatzbereit`;
}
