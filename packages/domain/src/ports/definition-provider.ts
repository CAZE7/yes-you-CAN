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
  /** How many vehicle definitions the package carries; 0 means "OEM-wide". */
  vehicles?: number;
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

/**
 * Vehicle resolution (§11) — the narrow domain view of what the definitions
 * layer computes.
 *
 * The shapes mirror the evidence-based answer deliberately: the domain never
 * sees a single "this is the car" fact, only ranked candidates with the reasons
 * for and against each. Anything above the port — the AI layer, guided
 * diagnostics, the UI — therefore has to handle uncertainty, and cannot pretend
 * a guess was knowledge.
 */

/** One identification value an ECU reported (UDS 0x22 on an identification DID). */
export interface IdentificationFactRef {
  /** Manufacturer key of the package the ECU id belongs to, when known. */
  oem?: string;
  /** ECU id as the definition package names it. */
  ecu: string;
  /** DID the value came from, when the reader recorded it. */
  did?: number;
  value: string;
}

/** One ECU that answered during discovery. */
export interface EcuAddressFactRef {
  txId: number;
  rxId: number;
  extended?: boolean;
}

export interface ResolveVehicleQuery {
  /** VIN as read from the vehicle or entered by the operator. */
  vin?: string;
  identifications?: readonly IdentificationFactRef[];
  discoveredAddresses?: readonly EcuAddressFactRef[];
  /** What the operator or a previous session already claims. */
  declared?: {
    oem?: string;
    brand?: string;
    model?: string;
    platform?: string;
    modelYear?: number;
  };
}

/** One criterion that spoke for or against a candidate. */
export interface VehicleEvidenceRef {
  /** Criterion name as the definitions layer reports it, e.g. "part-number". */
  kind: string;
  observed: string;
  expected: string;
  weight: number;
  reason: string;
}

export interface VehicleCandidateRef {
  oem: string;
  packageVersion: string;
  vehicleId: string;
  brand: string;
  model: string;
  platform?: string;
  /**
   * Where the data behind this candidate comes from ("own", "licensed",
   * "example-placeholder", …). The UI has to be able to say that a match rests
   * on placeholder data instead of implying vehicle truth (§24).
   */
  provenanceType?: string;
  /** Powertrains the evidence narrowed down; empty means "not narrowed". */
  engineIds: readonly string[];
  gearboxIds: readonly string[];
  /** 0…1 — the share of evaluated criteria that supports this candidate. */
  score: number;
  /** 0…1 — how far the data behind this candidate can be trusted (§24). */
  trust: number;
  evidence: VehicleEvidenceRef[];
  conflicts: VehicleEvidenceRef[];
  expectedEcus: number;
  matchedEcus: number;
  missingEcus: readonly string[];
}

/** What the VIN says about the manufacturer, even when no vehicle matched. */
export interface VinLookupRef {
  wmi: string;
  manufacturer?: string;
  brand?: string;
  country?: string;
  region?: string;
  known: boolean;
}

export interface VehicleResolutionRef {
  candidates: VehicleCandidateRef[];
  best?: VehicleCandidateRef;
  unresolved: boolean;
  vinLookup?: VinLookupRef;
  /** Context to show next to the result — placeholder data, unknown WMI, … */
  notes: readonly string[];
  /** Observations no registered definition could explain. */
  unexplained: readonly string[];
}

export interface DefinitionProvider {
  /** Where the definitions come from ("builtin", "file:…", "cloud:…") — provenance. */
  readonly source: string;
  listPackages(): VehicleDefinitionRef[];
  findEcu(query: FindEcuQuery): EcuDefinitionRef | undefined;
  findDid(query: FindDidQuery): DidDefinitionRef | undefined;
  findSignal(signalId: string): SignalDefinitionRef | undefined;
  /**
   * Resolve the connected vehicle from whatever is known about it (§11). Always
   * returns a result — an empty, explained one when nothing matches.
   */
  resolveVehicle(query: ResolveVehicleQuery): VehicleResolutionRef;
}

/**
 * The empty answer, with a reason.
 *
 * Providers that cannot resolve a vehicle must still say why — an unresolved
 * vehicle is information the layers above act on ("no definitions installed"),
 * not a blank field.
 */
export function unresolvedVehicleResolution(reason: string): VehicleResolutionRef {
  return { candidates: [], unresolved: true, notes: [reason], unexplained: [] };
}

/**
 * No-op provider: everything is unknown. Useful as a default so callers never
 * need a `null` check, and as the base for partial implementations.
 */
export class NullDefinitionProvider implements DefinitionProvider {
  readonly source = "none";

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

  resolveVehicle(_query: ResolveVehicleQuery): VehicleResolutionRef {
    return unresolvedVehicleResolution("no definitions are registered");
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
  private readonly resolve: ((query: ResolveVehicleQuery) => VehicleResolutionRef) | undefined;

  constructor(data: {
    packages?: readonly VehicleDefinitionRef[];
    ecus?: readonly EcuDefinitionRef[];
    dids?: readonly DidDefinitionRef[];
    signals?: readonly SignalDefinitionRef[];
    source?: string;
    /**
     * Resolution hook. Reference data alone cannot resolve a vehicle — that needs
     * the full definition model — so a static provider either delegates (tests,
     * a source that resolves elsewhere) or answers "unresolved" with a reason.
     */
    resolveVehicle?: (query: ResolveVehicleQuery) => VehicleResolutionRef;
  }) {
    this.source = data.source ?? "static";
    this.packages = [...(data.packages ?? [])];
    this.ecus = [...(data.ecus ?? [])];
    this.dids = [...(data.dids ?? [])];
    this.signals = [...(data.signals ?? [])];
    this.resolve = data.resolveVehicle;
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
    return this.dids.find(
      (did) => did.did === query.did && (query.ecu === undefined || did.ecu === query.ecu),
    );
  }

  findSignal(signalId: string): SignalDefinitionRef | undefined {
    return this.signals.find((signal) => signal.id === signalId);
  }

  resolveVehicle(query: ResolveVehicleQuery): VehicleResolutionRef {
    if (this.resolve) return this.resolve(query);
    return unresolvedVehicleResolution(
      `the "${this.source}" definitions carry reference data only — no vehicle definitions to resolve against`,
    );
  }
}
