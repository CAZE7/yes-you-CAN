/**
 * Normalized diagnostic definition model (AGENTS 13).
 *
 * Manufacturer/ECU specific knowledge lives ONLY here — never in UI code and
 * never in the diagnostic engine (AGENTS 34.5). A definition package is plain
 * data, semantically versioned (SemVer) so recorded sessions stay reproducible
 * after a definition changes, and it always carries provenance (AGENTS 24).
 */

export type SignalEncoding =
  | "uint8"
  | "uint16"
  | "uint24"
  | "uint32"
  | "int8"
  | "int16"
  | "int32"
  | "float32"
  | "ascii"
  | "bool"
  | "bitmask"
  | "bcd";

export type Endianness = "big" | "little";

export interface SignalDefinition {
  /** Stable identifier, namespaced by ECU, e.g. "engine.coolant_temperature". */
  id: string;
  name: string;
  /** ECU id this signal belongs to (must exist in the package). */
  ecu: string;
  /** Data Identifier the raw bytes come from. */
  did: number;
  /** UDS service used to obtain the raw bytes; defaults to 0x22. */
  service?: number;
  /** Byte offset inside the DID payload. */
  byteOffset: number;
  /** Length in bytes. */
  length: number;
  /** Optional bit range inside the byte window (MSB-first), for packed signals. */
  bitOffset?: number;
  bitLength?: number;
  encoding: SignalEncoding;
  /** Defaults to "big" (network order), which is what ISO 14229 payloads use. */
  endianness?: Endianness;
  scale?: number;
  offsetValue?: number;
  unit?: string;
  min?: number;
  max?: number;
  enumMapping?: Record<number, string>;
  description?: string;
  /** Marks a signal as safety relevant for reports/anomaly detection. */
  critical?: boolean;
}

export interface EcuAddress {
  /** Physical request identifier (tester → ECU). */
  txId: number;
  /** Physical response identifier (ECU → tester). */
  rxId: number;
  extended?: boolean;
  addressing?: "normal" | "extended";
  /** Functional request identifier used for discovery (e.g. 0x7DF). */
  functionalId?: number;
}

export interface EcuTiming {
  p2Ms?: number;
  p2StarMs?: number;
  s3Ms?: number;
}

/**
 * One environment value inside a freeze frame snapshot record (AGENTS 20).
 *
 * ISO 14229-1 defines the *service* that returns a snapshot record
 * (0x19 0x04, `reportDTCSnapshotRecordByDTCNumber`), but it deliberately leaves
 * the record layout to the manufacturer. The record therefore has to be
 * described by the definition package: this is exactly the kind of OEM knowledge
 * that must not be guessed in code (AGENTS 13, 34.18).
 */
export interface FreezeFrameField {
  /** Data identifier the ECU reports inside the snapshot record. */
  did: number;
  /** Label for the report/UI; defaults to the DID in hex. */
  name?: string;
  /**
   * Length of the value in bytes. Optional when `signals` is given (the signals
   * determine the length); required for a field without decoded signals so the
   * record can still be split correctly.
   */
  length?: number;
  /** Signal ids (of this package) to decode from the value bytes. */
  signals?: string[];
}

export interface DtcDefinition {
  /** ISO 14229-1 character form, e.g. "P0420". */
  code: string;
  description: string;
  /** Optional curated severity override; otherwise derived from status bits. */
  severity?: "info" | "minor" | "major" | "critical";
  /** Suggested next diagnostic step (feeds reports and the AI layer). */
  hint?: string;
  /**
   * Environment data recorded by the ECU when the fault was stored, in the order
   * the ECU reports it. Absent means "not documented" — the reader then keeps the
   * snapshot raw instead of inventing a layout.
   */
  freezeFrame?: FreezeFrameField[];
  /**
   * Signal ids (of this package) that belong to diagnosing this fault (AGENTS 20
   * "Related Signals"): they drive the live-data suggestion in the UI and the
   * analysis, and they are only ever the package's own signals.
   */
  relatedSignals?: string[];
}

export interface EcuDefinition {
  id: string;
  name: string;
  address: EcuAddress;
  protocol: "uds" | "kwp2000";
  timing?: EcuTiming;
  /** DIDs holding identification data (part number, software/hardware version). */
  identification?: { label: string; did: number; encoding?: SignalEncoding }[];
  /** Services this ECU is known to support; empty means "discover at runtime". */
  services?: number[];
  dtcs?: DtcDefinition[];
  description?: string;
}

/**
 * One powertrain option of a vehicle definition.
 *
 * The engine is the pivot between "which car is this" and "which ECUs and which
 * DIDs does it have": a 1.5 TSI and a 2.0 TDI of the same platform run different
 * software on differently addressed engine control units. `codes` are the
 * manufacturer's own engine codes (the ones stamped into the engine and printed
 * on the data sticker), matched against what an ECU reports in its identification
 * DIDs.
 */
export interface EngineDefinition {
  /** Stable identifier inside the package, e.g. "1-5-tsi-110kw". */
  id: string;
  /** Human readable designation, e.g. "1.5 TSI 110 kW (EA211 evo)". */
  name: string;
  fuel?: "petrol" | "diesel" | "electric" | "hybrid" | "plugin-hybrid" | "cng" | "lpg";
  displacementCc?: number;
  powerKw?: number;
  torqueNm?: number;
  /** Manufacturer engine codes, e.g. ["CU", "CUC", "DADA"] — identification evidence. */
  codes?: string[];
  /** Emission standard as documented, e.g. "euro6d-isc-fcm". */
  emissionStandard?: string;
  description?: string;
}

/** One gearbox option of a vehicle definition — same role as {@link EngineDefinition}. */
export interface GearboxDefinition {
  id: string;
  name: string;
  type?: "manual" | "automatic" | "dual-clutch" | "cvt" | "single-speed";
  gears?: number;
  /** Manufacturer gearbox codes, matched against identification DIDs. */
  codes?: string[];
  description?: string;
}

/**
 * VIN based selection rules (ISO 3779 / ISO 3780 positions).
 *
 * Every field is optional: a definition that only knows the WMI is still useful,
 * and a criterion that is not declared produces *no* evidence in either
 * direction — the resolver never punishes a vehicle for data nobody documented.
 * This module only compares positions; check-digit arithmetic and VIN validation
 * stay in `@vdp/core` (ADR 0002: `definitions` imports nothing but `shared`).
 */
export interface VinMatcher {
  /** World Manufacturer Identifier — positions 1–3, e.g. ["WVW", "WV1"]. */
  wmi?: string[];
  /** Vehicle Descriptor Section — positions 4–8, `.` matches any single character. */
  vdsPattern?: string;
  /** Accepted model-year characters at position 10 (ISO 3779 / 49 CFR 565). */
  modelYearChars?: string[];
  /** Accepted plant characters at position 11. */
  plantChars?: string[];
}

/**
 * An ECU as it occurs on *this* vehicle, plus the identification values that
 * prove it. This is the link between the vehicle axis and the diagnostic axis:
 * the same `EcuDefinition` (protocol, addresses, DIDs) can serve many vehicles,
 * while the part number / software version read from it selects the variant.
 */
export interface VehicleEcuRef {
  /** {@link EcuDefinition} id inside the same package. */
  ecu: string;
  /** Part numbers reported by the identification DIDs (e.g. F187) for this vehicle. */
  partNumbers?: string[];
  softwareVersions?: string[];
  hardwareVersions?: string[];
  /** Engine id this ECU belongs to, when the ECU is powertrain specific. */
  engine?: string;
  /** Gearbox id this ECU belongs to, when the ECU is powertrain specific. */
  gearbox?: string;
  /** Optional equipment (ACC, trailer recognition, …) — absence is not a conflict. */
  optional?: boolean;
}

/**
 * One vehicle a definition package can describe (AGENTS 11, 13).
 *
 * The chain the product needs is `VIN → vehicle → platform → engine/gearbox →
 * ECUs → software → DIDs/DTCs`; before schema version 2 the model could not
 * express anything above "OEM", so a package was one flat bundle per manufacturer
 * and every ECU/DTC list applied to every car of that brand. A `VehicleDefinition`
 * is the missing axis: it narrows the package's ECUs to the ones this car really
 * has and carries the identification values that prove the narrowing.
 */
export interface VehicleDefinition {
  /** Stable identifier inside the package, e.g. "golf-vii-mqb". */
  id: string;
  brand: string;
  model: string;
  /** Platform code shared across models, e.g. "MQB", "MB-FGAW". */
  platform?: string;
  generation?: string;
  bodyStyles?: string[];
  /** Model years this definition covers, inclusive. */
  modelYears?: { from: number; to?: number };
  vinMatch?: VinMatcher;
  engines?: EngineDefinition[];
  gearboxes?: GearboxDefinition[];
  /** ECUs of this package that belong to this vehicle; empty means "all ECUs". */
  ecus?: VehicleEcuRef[];
  /** Refines the package provenance for this entry (AGENTS 24: per-data source). */
  provenance?: Provenance;
  description?: string;
}

/** Provenance is mandatory — no undocumented data sources (AGENTS 24). */
export interface Provenance {
  sourceType:
    | "own"
    | "standard"
    | "licensed"
    | "community"
    | "reverse-engineered"
    | "example-placeholder";
  source: string;
  license?: string;
  version?: string;
  retrievedAt?: string;
  notes?: string;
}

export interface DefinitionPackage {
  /**
   * Model version of the package. Version 1 carried ECUs and signals only;
   * version 2 adds the vehicle axis ({@link VehicleDefinition}). Both stay
   * readable — see {@link SUPPORTED_SCHEMA_VERSIONS} and `upgradePackage` in
   * `migrate.ts` — because recorded sessions reference the version they used
   * (AGENTS 13).
   */
  schemaVersion: number;
  /** Manufacturer key: "generic", "vag", "mercedes", … */
  oem: string;
  name: string;
  /** SemVer — recorded sessions reference the exact version they used. */
  version: string;
  provenance: Provenance;
  ecus: EcuDefinition[];
  signals: SignalDefinition[];
  /**
   * Vehicles this package describes. Absent or empty on schema version 1 data
   * and on OEM-wide packages: the ECUs and signals then apply to every vehicle
   * of the OEM, which is exactly what a generic OBD package means.
   */
  vehicles?: VehicleDefinition[];
}

export const CURRENT_SCHEMA_VERSION = 2;

/**
 * Registry key of a package: manufacturer and version.
 *
 * Lives next to the shape it identifies, because both the registry and the
 * vehicle resolver need it and a definition package is never edited in place —
 * `oem@version` is therefore a stable reference a recorded session can keep
 * (AGENTS 13).
 */
export function keyOf(pkg: DefinitionPackage): string {
  return `${pkg.oem}@${pkg.version}`;
}

/**
 * Schema versions this build can read.
 *
 * Reading stays behind writing on purpose: a session recorded with an older
 * definition package must still be interpretable after the model moved on
 * (AGENTS 13 "Definition Packages müssen semantisch versioniert werden, damit
 * Sessions nachvollziehbar bleiben"). Anything below the oldest supported
 * version has to be migrated explicitly, not silently accepted.
 */
export const SUPPORTED_SCHEMA_VERSIONS: readonly number[] = [1, 2];

export interface SignalIndex {
  byId: Map<string, SignalDefinition>;
  byEcu: Map<string, SignalDefinition[]>;
  /** ecu id → did → signals, so a single 0x22 response can feed many signals. */
  byDid: Map<string, Map<number, SignalDefinition[]>>;
}

/**
 * Index caches (per package object).
 *
 * A definition package is plain data with a SemVer, and a recorded session
 * references that exact version — so a package is never edited in place
 * (AGENTS 13/24). That makes it safe to build the indexes once and reuse them:
 * every session, decoder instance, live-data round and freeze frame would
 * otherwise rebuild the same maps over and over (a package with a few hundred
 * signals is re-indexed on every single `findSignal` call).
 *
 * A `WeakMap` keeps the cache from outliving the package, and the entry stores
 * the length it was built for, so a package that *was* grown after all — an
 * importer that registers signals incrementally — is re-indexed instead of being
 * served from a stale view.
 */
const signalIndexCache = new WeakMap<DefinitionPackage, { signals: number; index: SignalIndex }>();
const ecuIndexCache = new WeakMap<
  DefinitionPackage,
  { ecus: number; index: Map<string, EcuDefinition> }
>();

export function indexPackage(pkg: DefinitionPackage): SignalIndex {
  const cached = signalIndexCache.get(pkg);
  if (cached && cached.signals === pkg.signals.length) return cached.index;

  const byId = new Map<string, SignalDefinition>();
  const byEcu = new Map<string, SignalDefinition[]>();
  const byDid = new Map<string, Map<number, SignalDefinition[]>>();
  for (const signal of pkg.signals) {
    byId.set(signal.id, signal);
    const ecuSignals = byEcu.get(signal.ecu) ?? [];
    ecuSignals.push(signal);
    byEcu.set(signal.ecu, ecuSignals);
    let dids = byDid.get(signal.ecu);
    if (!dids) {
      dids = new Map();
      byDid.set(signal.ecu, dids);
    }
    const list = dids.get(signal.did) ?? [];
    list.push(signal);
    dids.set(signal.did, list);
  }
  const index: SignalIndex = { byId, byEcu, byDid };
  signalIndexCache.set(pkg, { signals: pkg.signals.length, index });
  return index;
}

/**
 * ECU definitions of a package by id.
 *
 * Exists so a session that only knows the definition id (`"engine"`) resolves its
 * ECU definition in one map lookup instead of scanning `pkg.ecus` on every
 * attach (AGENTS 12/13).
 */
export function indexEcus(pkg: DefinitionPackage): Map<string, EcuDefinition> {
  const cached = ecuIndexCache.get(pkg);
  if (cached && cached.ecus === pkg.ecus.length) return cached.index;
  const index = new Map<string, EcuDefinition>();
  for (const ecu of pkg.ecus) index.set(ecu.id, ecu);
  ecuIndexCache.set(pkg, { ecus: pkg.ecus.length, index });
  return index;
}

const vehicleIndexCache = new WeakMap<
  DefinitionPackage,
  { vehicles: number; index: Map<string, VehicleDefinition> }
>();

/**
 * Vehicle definitions of a package by id.
 *
 * Same reasoning as {@link indexEcus}: a resolution, a session attach and every
 * report line would otherwise re-scan `pkg.vehicles` (AGENTS 11/13).
 */
export function indexVehicles(pkg: DefinitionPackage): Map<string, VehicleDefinition> {
  const vehicles = pkg.vehicles ?? [];
  const cached = vehicleIndexCache.get(pkg);
  if (cached && cached.vehicles === vehicles.length) return cached.index;
  const index = new Map<string, VehicleDefinition>();
  for (const vehicle of vehicles) index.set(vehicle.id, vehicle);
  vehicleIndexCache.set(pkg, { vehicles: vehicles.length, index });
  return index;
}

/**
 * The ECUs of a package that belong to one vehicle.
 *
 * A vehicle with no `ecus` list means "the whole package" — that is what a
 * generic OBD package declares, and narrowing must never invent exclusions.
 */
export function ecusOfVehicle(pkg: DefinitionPackage, vehicle: VehicleDefinition): EcuDefinition[] {
  const all = indexEcus(pkg);
  if (!vehicle.ecus || vehicle.ecus.length === 0) return pkg.ecus;
  const result: EcuDefinition[] = [];
  for (const ref of vehicle.ecus) {
    const ecu = all.get(ref.ecu);
    if (ecu) result.push(ecu);
  }
  return result;
}
