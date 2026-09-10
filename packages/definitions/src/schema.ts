/**
 * Normalized diagnostic definition model (AGENTS 13).
 *
 * Manufacturer/ECU specific knowledge lives ONLY here — never in UI code and
 * never in the diagnostic engine (AGENTS 34.5). A definition package is plain
 * data, semantically versioned (SemVer) so recorded sessions stay reproducible
 * after a definition changes, and it always carries provenance (AGENTS 24).
 */

export type SignalEncoding =
  | 'uint8'
  | 'uint16'
  | 'uint24'
  | 'uint32'
  | 'int8'
  | 'int16'
  | 'int32'
  | 'float32'
  | 'ascii'
  | 'bool'
  | 'bitmask'
  | 'bcd';

export type Endianness = 'big' | 'little';

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
  addressing?: 'normal' | 'extended';
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
  severity?: 'info' | 'minor' | 'major' | 'critical';
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
  protocol: 'uds' | 'kwp2000';
  timing?: EcuTiming;
  /** DIDs holding identification data (part number, software/hardware version). */
  identification?: { label: string; did: number; encoding?: SignalEncoding }[];
  /** Services this ECU is known to support; empty means "discover at runtime". */
  services?: number[];
  dtcs?: DtcDefinition[];
  description?: string;
}

/** Provenance is mandatory — no undocumented data sources (AGENTS 24). */
export interface Provenance {
  sourceType: 'own' | 'standard' | 'licensed' | 'community' | 'reverse-engineered' | 'example-placeholder';
  source: string;
  license?: string;
  version?: string;
  retrievedAt?: string;
  notes?: string;
}

export interface DefinitionPackage {
  /** Bumped when the model itself changes (see migration support in storage). */
  schemaVersion: number;
  /** Manufacturer key: "generic", "vag", "mercedes", … */
  oem: string;
  name: string;
  /** SemVer — recorded sessions reference the exact version they used. */
  version: string;
  provenance: Provenance;
  ecus: EcuDefinition[];
  signals: SignalDefinition[];
}

export const CURRENT_SCHEMA_VERSION = 1;

export interface SignalIndex {
  byId: Map<string, SignalDefinition>;
  byEcu: Map<string, SignalDefinition[]>;
  /** ecu id → did → signals, so a single 0x22 response can feed many signals. */
  byDid: Map<string, Map<number, SignalDefinition[]>>;
}

export function indexPackage(pkg: DefinitionPackage): SignalIndex {
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
  return { byId, byEcu, byDid };
}
