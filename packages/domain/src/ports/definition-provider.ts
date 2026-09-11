/**
 * Definition provider port (target architecture §4: "Definitions sind Daten,
 * nicht Code"; §13 of AGENTS.md).
 *
 * The engine must not know *where* definitions live — JSON, YAML, SQLite,
 * Postgres, a cloud API or a local cache. It only sees this port. Concrete
 * providers live in the `definitions`/`storage` layers and are injected at
 * the composition root. The `Ref` shapes below are deliberately narrower than
 * the rich `@vdp/definitions` package: the domain only needs to *find*
 * things, not to model every field.
 */

export interface VehicleDefinitionRef {
  /** Manufacturer key: "generic", "vag", "mercedes", … */
  oem: string;
  name: string;
  /** SemVer — sessions reference the exact version they recorded with (§16). */
  version: string;
  platform?: string;
}

export interface EcuAddressRef {
  /** Physical request identifier (tester → ECU). */
  txId: number;
  /** Physical response identifier (ECU → tester). */
  rxId: number;
  extended?: boolean;
}

export interface EcuDefinitionRef {
  id: string;
  name: string;
  oem: string;
  protocol: string;
  address?: EcuAddressRef;
  /** Services the definition declares as known; empty means "discover". */
  services?: readonly number[];
}

export interface DidDefinitionRef {
  did: number;
  ecu?: string;
  name?: string;
  /** Signal ids decoded from this DID, if the package defines any. */
  signalIds?: readonly string[];
}

export interface SignalDefinitionRef {
  id: string;
  name: string;
  ecu: string;
  did: number;
  unit?: string;
}

export interface FindEcuQuery {
  id?: string;
  /** Physical response identifier seen on the bus. */
  rxId?: number;
  txId?: number;
  oem?: string;
}

export interface FindDidQuery {
  did: number;
  ecu?: string;
}

export interface DefinitionProvider {
  /** Where the definitions come from ("builtin", "file:…", "cloud:…") — provenance. */
  readonly source: string;
  listPackages(): VehicleDefinitionRef[];
  findEcu(query: FindEcuQuery): EcuDefinitionRef | undefined;
  findDid(query: FindDidQuery): DidDefinitionRef | undefined;
  findSignal(signalId: string): SignalDefinitionRef | undefined;
}

/**
 * No-op provider: everything is unknown. Useful as a default so callers never
 * need a `null` check, and as the base for partial implementations.
 */
export class NullDefinitionProvider implements DefinitionProvider {
  readonly source = 'none';

  listPackages(): VehicleDefinitionRef[] {
    return [];
  }

  findEcu(_query: FindEcuQuery): EcuDefinitionRef | undefined {
    return undefined;
  }

  findDid(_query: FindDidQuery): DidDefinitionRef | undefined {
    return undefined;
  }

  findSignal(_signalId: string): SignalDefinitionRef | undefined {
    return undefined;
  }
}

/**
 * Provider over plain reference data — the shape every external source
 * (JSON/YAML/SQLite/cloud) can be normalised into. Also used by tests.
 */
export class StaticDefinitionProvider implements DefinitionProvider {
  readonly source: string;
  private readonly packages: VehicleDefinitionRef[];
  private readonly ecus: EcuDefinitionRef[];
  private readonly dids: DidDefinitionRef[];
  private readonly signals: SignalDefinitionRef[];

  constructor(data: {
    packages?: readonly VehicleDefinitionRef[];
    ecus?: readonly EcuDefinitionRef[];
    dids?: readonly DidDefinitionRef[];
    signals?: readonly SignalDefinitionRef[];
    source?: string;
  }) {
    this.source = data.source ?? 'static';
    this.packages = [...(data.packages ?? [])];
    this.ecus = [...(data.ecus ?? [])];
    this.dids = [...(data.dids ?? [])];
    this.signals = [...(data.signals ?? [])];
  }

  listPackages(): VehicleDefinitionRef[] {
    return [...this.packages];
  }

  findEcu(query: FindEcuQuery): EcuDefinitionRef | undefined {
    return this.ecus.find((ecu) => {
      if (query.oem !== undefined && ecu.oem !== query.oem) return false;
      if (query.id !== undefined) return ecu.id === query.id;
      if (query.rxId !== undefined) return ecu.address?.rxId === query.rxId;
      if (query.txId !== undefined) return ecu.address?.txId === query.txId;
      return false;
    });
  }

  findDid(query: FindDidQuery): DidDefinitionRef | undefined {
    return this.dids.find((did) => did.did === query.did && (query.ecu === undefined || did.ecu === query.ecu));
  }

  findSignal(signalId: string): SignalDefinitionRef | undefined {
    return this.signals.find((signal) => signal.id === signalId);
  }
}
