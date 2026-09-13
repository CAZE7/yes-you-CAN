/**
 * DTC system (AGENTS 20).
 *
 * Adds the pieces the raw UDS layer does not have: description enrichment from
 * definition packages, severity, snapshots and before/after comparison.
 *
 * Enrichment has two layers, and they stay distinguishable:
 *  - what a code means for a manufacturer (`EcuDefinition.dtcs`) — always
 *    available as soon as a package is loaded,
 *  - what it means for the *resolved vehicle* with its engine and gearbox
 *    (`VehicleDefinition.dtcKnowledge`, AGENTS 23) — available once
 *    {@link DtcScanner.setVehicle} knows which car is connected.
 * The second layer overrides the first where it says something, and everything it
 * cannot say is reported in `notes` instead of being dressed up (§24).
 */

import {
  type DefinitionPackage,
  type DtcKnowledgeHit,
  type DtcKnowledgePattern,
  type DtcKnowledgeScope,
  findDtcKnowledge,
} from "@vdp/definitions";
import type { DtcRecord } from "@vdp/protocols-uds";

/** The resolved vehicle a scan belongs to (AGENTS 11 → AGENTS 20). */
export interface DtcVehicleContext {
  /** Manufacturer key of the package the vehicle was resolved in. */
  oem?: string;
  vehicleId?: string;
  /** Powertrains the resolution narrowed down; empty means "not narrowed". */
  engineIds?: readonly string[];
  gearboxIds?: readonly string[];
}

/** Where a code was read from, in the definition package's own words. */
export interface DtcDefinitionRef {
  /** Manufacturer key the ECU id belongs to ("<oem>:<id>" split apart). */
  oem?: string;
  /** Bare ECU id of the package, e.g. "engine". */
  ecu?: string;
}

/**
 * Variant knowledge as it travels with a scanned code (§20, §23).
 *
 * This is the *record* shape — what is stored in a session and shown in a report
 * — so it carries only what a reader can act on: the scope that says where the
 * wording came from, the documented failure patterns with their measurement
 * checks, the source of the statement and what is missing. The definitions layer
 * knows more (package version, baseline provenance); flattening it here keeps
 * every stored DTC small and self-contained.
 */
export interface DtcVariantKnowledge {
  /**
   * Where description/severity/hint came from: `vehicle-engine`,
   * `vehicle-gearbox`, `vehicle` or `package` (AGENTS 24: no guess poses as
   * variant knowledge).
   */
  scope: DtcKnowledgeScope;
  vehicleId?: string;
  /** When the code sets — only variant knowledge documents this. */
  conditions?: string;
  /** Known failure patterns, most specific first, with their measurement checks. */
  patterns: DtcKnowledgePattern[];
  /** Where the variant statement comes from (AGENTS 24). */
  provenanceType?: string;
  provenanceSource?: string;
  /** What is missing or had to be assumed; shown next to the answer. */
  notes: string[];
}

export interface EnrichedDtc extends DtcRecord {
  /** Description from the definition package, when one exists. */
  description?: string;
  /** Suggested next diagnostic step from the definition package. */
  hint?: string;
  /** ECU the code was read from. */
  ecuName: string;
  ecuId: string;
  /** ISO-8601 timestamp of the first scan that saw this code (AGENTS 20). */
  firstSeen?: string;
  /** ISO-8601 timestamp of the most recent scan that saw this code (AGENTS 20). */
  lastSeen?: string;
  /** True when this code was absent from the previous scan. */
  firstSeenInThisScan?: boolean;
  /**
   * Signals the definition package lists as related (AGENTS 20 "Related Signals").
   * Only ids the package itself defines — no inferred relation.
   */
  relatedSignals?: Array<{ id: string; name: string }>;
  /**
   * What the resolved vehicle's variant knowledge adds (§23). Absent when no
   * vehicle is bound or when nothing is documented for this code.
   */
  knowledge?: DtcVariantKnowledge;
}

/** What the tracker knows about one code of one ECU. */
export interface DtcOccurrence {
  firstSeen: string;
  lastSeen: string;
  /** Scans in which the code was present. */
  scans: number;
}

/**
 * First seen / last seen tracking across scans (AGENTS 20).
 *
 * The tracker is deliberately kept out of the protocol layer: "when did this code
 * first appear" is knowledge about the *session*, not about a UDS response. It
 * lives in memory and is written into the session snapshots, so a stored session
 * keeps the history even though a live scan only ever sees the current state.
 */
export class DtcTracker {
  private readonly seen = new Map<string, DtcOccurrence>();

  private static key(ecuId: string, code: string): string {
    return `${ecuId}:${code.toUpperCase()}`;
  }

  /** Register one scan of one ECU; returns the per-code bookkeeping. */
  record(ecuId: string, codes: readonly string[], timestamp: string): Map<string, DtcOccurrence> {
    const result = new Map<string, DtcOccurrence>();
    for (const code of codes) {
      const key = DtcTracker.key(ecuId, code);
      const previous = this.seen.get(key);
      const occurrence: DtcOccurrence = previous
        ? { firstSeen: previous.firstSeen, lastSeen: timestamp, scans: previous.scans + 1 }
        : { firstSeen: timestamp, lastSeen: timestamp, scans: 1 };
      this.seen.set(key, occurrence);
      result.set(key, occurrence);
    }
    return result;
  }

  occurrenceOf(ecuId: string, code: string): DtcOccurrence | undefined {
    return this.seen.get(DtcTracker.key(ecuId, code));
  }

  /** Codes seen in this scan that were not present in any earlier scan. */
  isNewIn(ecuId: string, code: string): boolean {
    return this.occurrenceOf(ecuId, code)?.scans === 1;
  }

  /** Everything the tracker has seen, for persisting into the session (AGENTS 10). */
  snapshot(): Array<{
    ecuId: string;
    code: string;
    firstSeen: string;
    lastSeen: string;
    scans: number;
  }> {
    return Array.from(this.seen, ([key, occurrence]) => {
      const [ecuId = "", code = ""] = key.split(":");
      return { ecuId, code, ...occurrence };
    });
  }

  reset(): void {
    this.seen.clear();
  }
}

export interface DtcComparison {
  added: EnrichedDtc[];
  removed: EnrichedDtc[];
  /** Same code, different status bits. */
  changed: Array<{ code: string; before: number; after: number; ecuName: string }>;
  unchanged: EnrichedDtc[];
}

export interface DtcScannerOptions {
  definitions?: readonly DefinitionPackage[];
  /** Clock used for first/last seen timestamps (injectable for tests). */
  clock?: () => Date;
}

export class DtcScanner {
  private readonly packages: readonly DefinitionPackage[];
  /** Signal names across all packages, first declaration wins. */
  private readonly signalNames = new Map<string, string>();
  private vehicle: DtcVehicleContext | undefined;
  /** Knowledge per code and context: a scan asks for the same codes repeatedly. */
  private readonly knowledgeCache = new Map<string, DtcKnowledgeHit | undefined>();
  private readonly descriptions = new Map<
    string,
    {
      description: string;
      hint?: string;
      severity?: EnrichedDtc["severity"];
      relatedSignals?: Array<{ id: string; name: string }>;
    }
  >();
  private readonly clock: () => Date;
  /** First/last seen tracking shared by every scan of this session (AGENTS 20). */
  readonly tracker = new DtcTracker();

  constructor(options: DtcScannerOptions = {}) {
    this.clock = options.clock ?? (() => new Date());
    this.packages = options.definitions ?? [];
    for (const pkg of this.packages) {
      const signalNames = this.signalNames;
      for (const signal of pkg.signals ?? []) {
        if (!signalNames.has(signal.id)) signalNames.set(signal.id, signal.name);
      }
      for (const ecu of pkg.ecus) {
        for (const dtc of ecu.dtcs ?? []) {
          const existing = this.descriptions.get(dtc.code);
          if (existing) continue;
          const related = (dtc.relatedSignals ?? [])
            .map((id) => ({ id, name: signalNames.get(id) ?? id }))
            .filter((entry) => signalNames.has(entry.id));
          this.descriptions.set(dtc.code, {
            description: dtc.description,
            ...(dtc.hint ? { hint: dtc.hint } : {}),
            ...(dtc.severity ? { severity: dtc.severity } : {}),
            ...(related.length > 0 ? { relatedSignals: related } : {}),
          });
        }
      }
    }
  }

  /**
   * Bind the resolved vehicle (AGENTS 11). Every later scan enriches its codes
   * with what this variant documents about them.
   *
   * `undefined` detaches: a new connection is a new car until the resolution
   * proves otherwise, and knowledge attributed to the previous one would be a
   * statement about a vehicle that is no longer connected.
   */
  setVehicle(context: DtcVehicleContext | undefined): void {
    this.vehicle = context;
    this.knowledgeCache.clear();
  }

  /** The vehicle the scanner currently enriches for, when one is bound. */
  get vehicleContext(): DtcVehicleContext | undefined {
    return this.vehicle;
  }

  /**
   * Variant knowledge for one code, or `undefined` when nothing is documented.
   *
   * Deliberately refuses to answer without a bound vehicle: the package-wide
   * description is already on the record, and presenting it as variant knowledge
   * would hide the difference the whole vehicle axis exists for (§24).
   */
  private knowledgeFor(
    code: string,
    definition: DtcDefinitionRef | undefined,
  ): DtcKnowledgeHit | undefined {
    const vehicle = this.vehicle;
    if (vehicle?.vehicleId === undefined) return undefined;
    const oem = vehicle.oem ?? definition?.oem;
    const engineIds = vehicle.engineIds ?? [];
    const gearboxIds = vehicle.gearboxIds ?? [];
    const key = [
      oem ?? "",
      vehicle.vehicleId,
      engineIds.join(","),
      gearboxIds.join(","),
      definition?.ecu ?? "",
      code.trim().toUpperCase(),
    ].join("|");
    if (this.knowledgeCache.has(key)) return this.knowledgeCache.get(key);

    const hit = findDtcKnowledge(this.packages, {
      code,
      vehicleId: vehicle.vehicleId,
      ...(definition?.ecu !== undefined ? { ecu: definition.ecu } : {}),
      ...(oem !== undefined ? { oem } : {}),
      ...(engineIds.length > 0 ? { engineIds } : {}),
      ...(gearboxIds.length > 0 ? { gearboxIds } : {}),
    });
    this.knowledgeCache.set(key, hit);
    return hit;
  }

  /** The record shape of one lookup result (see {@link DtcVariantKnowledge}). */
  private variantKnowledgeOf(hit: DtcKnowledgeHit): DtcVariantKnowledge {
    const knowledge: DtcVariantKnowledge = {
      scope: hit.scope,
      patterns: [...hit.patterns],
      notes: [...hit.notes],
    };
    if (hit.vehicleId !== undefined) knowledge.vehicleId = hit.vehicleId;
    if (hit.conditions !== undefined) knowledge.conditions = hit.conditions;
    const provenance = hit.knowledgeProvenance;
    if (provenance !== undefined) {
      knowledge.provenanceType = provenance.sourceType;
      knowledge.provenanceSource = provenance.source;
    }
    return knowledge;
  }

  enrich(
    records: readonly DtcRecord[],
    ecuName: string,
    ecuId: string,
    definition?: DtcDefinitionRef,
  ): EnrichedDtc[] {
    const timestamp = this.clock().toISOString();
    // Register the whole scan first, so "first seen in this scan" is decided once
    // for all codes of the ECU instead of depending on the response order.
    const occurrences = this.tracker.record(
      ecuId,
      records.map((record) => record.code),
      timestamp,
    );
    return records.map((record) => {
      const info = this.descriptions.get(record.code);
      const occurrence = occurrences.get(`${ecuId}:${record.code.toUpperCase()}`);
      const hit = this.knowledgeFor(record.code, definition);
      // Variant wording wins over the package wording; whatever the variant does
      // not declare keeps the package's answer (AGENTS 20).
      const description = hit?.description ?? info?.description;
      const hint = hit?.hint ?? info?.hint;
      const related = hit
        ? hit.relatedSignals
            .filter((id) => this.signalNames.has(id))
            .map((id) => ({ id, name: this.signalNames.get(id) ?? id }))
        : info?.relatedSignals;
      return {
        ...record,
        ...(description ? { description } : {}),
        ...(hint ? { hint } : {}),
        ...(related && related.length > 0 ? { relatedSignals: related } : {}),
        severity: hit?.severity ?? info?.severity ?? record.severity,
        ecuName,
        ecuId,
        ...(hit ? { knowledge: this.variantKnowledgeOf(hit) } : {}),
        ...(occurrence
          ? {
              firstSeen: occurrence.firstSeen,
              lastSeen: occurrence.lastSeen,
              firstSeenInThisScan: occurrence.scans === 1,
            }
          : {}),
      };
    });
  }

  /** Definition of a code, including the layout of its freeze frame (AGENTS 20). */
  definitionOf(code: string): { description?: string; hint?: string } | undefined {
    return this.descriptions.get(code.toUpperCase());
  }

  describe(code: string): string | undefined {
    return this.descriptions.get(code)?.description;
  }

  /** Before/after comparison for "Clear DTCs" verification (AGENTS 20). */
  compare(before: readonly EnrichedDtc[], after: readonly EnrichedDtc[]): DtcComparison {
    const key = (dtc: EnrichedDtc): string => `${dtc.ecuId}:${dtc.code}`;
    const beforeMap = new Map(before.map((dtc) => [key(dtc), dtc]));
    const afterMap = new Map(after.map((dtc) => [key(dtc), dtc]));

    const added = after.filter((dtc) => !beforeMap.has(key(dtc)));
    const removed = before.filter((dtc) => !afterMap.has(key(dtc)));
    const changed: DtcComparison["changed"] = [];
    const unchanged: EnrichedDtc[] = [];

    for (const dtc of after) {
      const previous = beforeMap.get(key(dtc));
      if (!previous) continue;
      if (previous.status !== dtc.status) {
        changed.push({
          code: dtc.code,
          before: previous.status,
          after: dtc.status,
          ecuName: dtc.ecuName,
        });
      } else {
        unchanged.push(dtc);
      }
    }
    return { added, removed, changed, unchanged };
  }

  /** Group by severity for reports (AGENTS 21 "DTC Summary"). */
  groupBySeverity(
    dtcs: readonly EnrichedDtc[],
  ): Record<"critical" | "major" | "minor" | "info", EnrichedDtc[]> {
    const groups: Record<"critical" | "major" | "minor" | "info", EnrichedDtc[]> = {
      critical: [],
      major: [],
      minor: [],
      info: [],
    };
    for (const dtc of dtcs) groups[dtc.severity].push(dtc);
    return groups;
  }

  summary(dtcs: readonly EnrichedDtc[]): {
    total: number;
    critical: number;
    major: number;
    minor: number;
    info: number;
    codes: string[];
  } {
    const groups = this.groupBySeverity(dtcs);
    return {
      total: dtcs.length,
      critical: groups.critical.length,
      major: groups.major.length,
      minor: groups.minor.length,
      info: groups.info.length,
      codes: Array.from(new Set(dtcs.map((d) => d.code))).sort(),
    };
  }
}
