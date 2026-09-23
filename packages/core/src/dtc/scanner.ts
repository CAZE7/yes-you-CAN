/**
 * DTC system (AGENTS 20; master backlog P0 #6).
 *
 * Adds the pieces the raw UDS layer does not have: description enrichment from
 * definition packages, severity, snapshots and before/after comparison.
 *
 * The data flow is `records → observation → projection`, never
 * `records → projection` with the observation left implicit:
 *
 *   {@link DtcScanner.observe}  protocol record → IR (`DtcState`: what the ECU
 *                                said, what the definition says, what the history
 *                                says — each with its own evidence)
 *   {@link toEnrichedDtc}        IR → the flat record the session, the runtime and
 *                                the reports have always spoken
 *   {@link DtcScanner.enrich}    `observe` + projection, the compatibility entry
 *                                point — two entry points, one code path (the same
 *                                shape `SignalDecoder.observe/decode` uses)
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
import {
  compareDtcObservations,
  type DtcObservation,
  type DtcState,
  describeEvidence,
  dtcEnrichment,
  dtcKey,
  dtcObservation,
  type Evidence,
} from "@vdp/diagnostic-ir";
import { type DtcRecord, dtcSeverity } from "@vdp/protocols-uds";

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
  /**
   * One line naming what backs description, hint and severity — the IR's
   * {@link describeEvidence} of the enrichment, so "the package documented it"
   * and "nobody knows this code" are different answers with different words
   * (§24). A projection carries it on purpose: a stored session then still says
   * where its own statements came from (AGENTS 17, P0 #6).
   */
  evidence?: string;
  /**
   * The same proof as {@link evidence}, as data: the IR's `Evidence` of the
   * enrichment that produced `description`, `hint` and the package `severity`.
   *
   * A string answers a person; this answers a program that must not re-read the
   * sentence to decide whether it may build on the wording (P0 #39, ADR 0038). It is
   * absent on a record that came from a build which named none — which is an answer
   * of its own ("we cannot tell"), not a missing field to guess about.
   */
  enrichmentEvidence?: Evidence;
}

/**
 * One scanned code as the platform holds it: the IR state, and the variant claim
 * behind the wording when a resolved vehicle produced one.
 *
 * The second half is deliberately *not* part of the IR: `patterns[]`, `checks[]`
 * and their numeric windows are a definition package's vocabulary with its own
 * schema version (AGENTS 23, ADR 0025), while the IR is the transport- and
 * protocol-free middle. They travel side by side, they do not merge into a third
 * shape — the projection {@link toEnrichedDtc} is where the two meet.
 */
export interface DtcScan {
  state: DtcState;
  knowledge?: DtcVariantKnowledge;
}

/** Any fault-memory record the platform can hold: protocol, enriched or stored. */
export type DtcRecordLike = DtcRecord &
  Partial<Pick<EnrichedDtc, "ecuId" | "ecuName" | "lastSeen">>;

/**
 * Project any fault-memory record into an IR observation.
 *
 * This is the one place that turns `code`/`status`/`raw` into an observation, so a
 * live scan, a session reloaded from disk and a replay cannot drift apart in what
 * "the same code" means. A stored record that predates the ECU axis keeps no ECU
 * identity — the empty string says exactly that, instead of inventing one (§24).
 */
export function dtcObservationOf(record: DtcRecordLike, timestamp?: string): DtcObservation {
  const at = timestamp ?? record.lastSeen;
  return dtcObservation({
    code: record.code,
    raw: record.raw,
    failureType: record.failureType,
    status: record.status,
    statusBits: record.statusBits,
    ecuId: record.ecuId ?? "",
    ecuName: record.ecuName ?? "",
    ...(at !== undefined ? { at } : {}),
    ...(record.severity !== undefined ? { severity: record.severity } : {}),
    // The mask travels with the code: without it a stored observation cannot say
    // whether an unset status bit was measured or simply not reported (ADR 0033).
    ...(record.availabilityMask !== undefined ? { availabilityMask: record.availabilityMask } : {}),
    ...(record.snapshot !== undefined ? { snapshot: record.snapshot } : {}),
    ...(record.extendedData !== undefined ? { extendedData: record.extendedData } : {}),
  });
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

  /** Identity of one code within one ECU — the IR's key, not a second one. */
  private static key(ecuId: string, code: string): string {
    return dtcKey({ ecuId, code });
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

/**
 * The flat view of one before/after comparison.
 *
 * The *decision* — which entries are the same fault, which status counts as a
 * change — is the IR's (`compareDtcObservations`, P0 #6) and is never made here;
 * this type only carries the records of both sides through so that a caller can
 * read timestamps, descriptions and snapshots off the entries it handed in.
 */
export interface DtcComparison {
  added: EnrichedDtc[];
  removed: EnrichedDtc[];
  /** Same code, different status bits. */
  changed: Array<{ code: string; before: number; after: number; ecuName: string }>;
  unchanged: EnrichedDtc[];
}

/**
 * Project one IR scan onto the flat record the session and the reports speak.
 *
 * Lossless in both directions of the fields it carries: `severity` resolves to
 * the definition's claim first and to the reader's classification of the status
 * byte second — the same rule the protocol applies to the bytes, so a projection
 * can never disagree with the record it came from (AGENTS 20). Absent statements
 * stay absent: no empty description, no default severity (§24).
 */
export function toEnrichedDtc(scan: DtcScan): EnrichedDtc {
  const { observation, enrichment, firstSeen, lastSeen, firstSeenInThisScan } = scan.state;
  const severity = observation.severity ?? dtcSeverity(observation.statusBits);
  return {
    code: observation.code,
    raw: observation.raw,
    failureType: observation.failureType,
    status: observation.status,
    statusBits: observation.statusBits,
    severity: enrichment?.severity ?? severity,
    ...(enrichment?.description !== undefined ? { description: enrichment.description } : {}),
    ...(enrichment?.hint !== undefined ? { hint: enrichment.hint } : {}),
    ...(enrichment?.relatedSignals !== undefined && enrichment.relatedSignals.length > 0
      ? { relatedSignals: enrichment.relatedSignals.map((signal) => ({ ...signal })) }
      : {}),
    ecuName: observation.ecuName,
    ecuId: observation.ecuId,
    ...(scan.knowledge !== undefined ? { knowledge: scan.knowledge } : {}),
    ...(enrichment !== undefined
      ? { evidence: describeEvidence(enrichment.evidence), enrichmentEvidence: enrichment.evidence }
      : {}),
    ...(observation.snapshot !== undefined ? { snapshot: observation.snapshot } : {}),
    ...(observation.extendedData !== undefined ? { extendedData: observation.extendedData } : {}),
    ...(firstSeen !== undefined ? { firstSeen } : {}),
    ...(lastSeen !== undefined ? { lastSeen } : {}),
    ...(firstSeenInThisScan !== undefined ? { firstSeenInThisScan } : {}),
  };
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

  /**
   * Read one ECU's fault memory into the diagnostic IR.
   *
   * The result is a {@link DtcScan} per code: the IR state (what the ECU said,
   * what the definition says, what the history says) and, when a resolved vehicle
   * narrowed it down, the variant claim that applies. Nothing is flattened here —
   * {@link DtcScanner.enrich} is the projection, so a caller that wants to decide
   * what an absent statement means (report, evidence engine, replay check) reads
   * this instead.
   */
  observe(
    records: readonly DtcRecord[],
    ecuName: string,
    ecuId: string,
    definition?: DtcDefinitionRef,
  ): DtcScan[] {
    const timestamp = this.clock().toISOString();
    // Register the whole scan first, so "first seen in this scan" is decided once
    // for all codes of the ECU instead of depending on the response order.
    const occurrences = this.tracker.record(
      ecuId,
      records.map((record) => record.code),
      timestamp,
    );
    // The version the knowledge claims are made under (AGENTS 13): the package
    // whose ECU definition this scan was matched against, when one was.
    const definitionVersion = this.definitionVersionOf(definition);
    return records.map((record) => {
      const observation = dtcObservation({
        code: record.code,
        raw: record.raw,
        failureType: record.failureType,
        status: record.status,
        statusBits: record.statusBits,
        ecuId,
        ecuName,
        at: timestamp,
        severity: record.severity,
        ...(record.snapshot !== undefined ? { snapshot: record.snapshot } : {}),
        ...(record.extendedData !== undefined ? { extendedData: record.extendedData } : {}),
        ...(definitionVersion !== undefined ? { definitionVersion } : {}),
      });
      const info = this.descriptions.get(record.code);
      const hit = this.knowledgeFor(record.code, definition);
      // Variant wording wins over the package wording; whatever the variant does
      // not declare keeps the package's answer (AGENTS 20).
      const description = hit?.description ?? info?.description;
      const hint = hit?.hint ?? info?.hint;
      const severity = hit?.severity ?? info?.severity;
      const related = hit
        ? hit.relatedSignals
            .filter((id) => this.signalNames.has(id))
            .map((id) => ({ id, name: this.signalNames.get(id) ?? id }))
        : info?.relatedSignals;
      const occurrence = occurrences.get(dtcKey({ ecuId, code: record.code }));
      const state: DtcState = {
        observation,
        enrichment: dtcEnrichment({
          code: record.code,
          ecuId,
          ...(description ? { description } : {}),
          ...(hint ? { hint } : {}),
          ...(severity ? { severity } : {}),
          ...(related && related.length > 0 ? { relatedSignals: related } : {}),
          at: timestamp,
          ...(definitionVersion !== undefined ? { definitionVersion } : {}),
        }),
        ...(occurrence
          ? {
              firstSeen: occurrence.firstSeen,
              lastSeen: occurrence.lastSeen,
              firstSeenInThisScan: occurrence.scans === 1,
            }
          : {}),
      };
      return { state, ...(hit ? { knowledge: this.variantKnowledgeOf(hit) } : {}) };
    });
  }

  /** The version of the package a definition reference points into, when known. */
  private definitionVersionOf(definition: DtcDefinitionRef | undefined): string | undefined {
    if (definition?.oem === undefined) return undefined;
    return this.packages.find((pkg) => pkg.oem === definition.oem)?.version;
  }

  /**
   * Enrich a scan for callers that speak {@link EnrichedDtc}: the IR observation
   * plus its projection, in one pass ({@link DtcScanner.observe} does the work).
   */
  enrich(
    records: readonly DtcRecord[],
    ecuName: string,
    ecuId: string,
    definition?: DtcDefinitionRef,
  ): EnrichedDtc[] {
    return this.observe(records, ecuName, ecuId, definition).map(toEnrichedDtc);
  }

  /** Definition of a code, including the layout of its freeze frame (AGENTS 20). */
  definitionOf(code: string): { description?: string; hint?: string } | undefined {
    return this.descriptions.get(code.toUpperCase());
  }

  describe(code: string): string | undefined {
    return this.descriptions.get(code)?.description;
  }

  /** Before/after comparison for "Clear DTCs" verification (AGENTS 20). */
  /**
   * Before/after comparison for "Clear DTCs" verification (AGENTS 20).
   *
   * The classification is delegated to the IR ({@link compareDtcObservations}):
   * one identity rule per fault code — ECU plus code, case and whitespace
   * normalised — for the history, the comparison and the replay check alike.
   * A scan that repeats one code classifies every repeat against the last
   * record of the other side, which is what the IR's key map does.
   */
  compare(before: readonly EnrichedDtc[], after: readonly EnrichedDtc[]): DtcComparison {
    const beforeObservations = before.map((dtc) => dtcObservationOf(dtc));
    const afterObservations = after.map((dtc) => dtcObservationOf(dtc));
    const comparison = compareDtcObservations(beforeObservations, afterObservations);
    const keys = (list: readonly DtcObservation[]): Set<string> =>
      new Set(list.map((observation) => dtcKey(observation)));
    const addedKeys = keys(comparison.added);
    const removedKeys = keys(comparison.removed);
    const changedKeys = keys(comparison.changed);
    const unchangedKeys = keys(comparison.unchanged);
    const previousByEcuAndCode = new Map(
      beforeObservations.map((observation) => [dtcKey(observation), observation]),
    );

    const changed: DtcComparison["changed"] = [];
    const unchanged: EnrichedDtc[] = [];
    for (const dtc of after) {
      const key = dtcKey(dtc);
      if (addedKeys.has(key)) continue;
      if (changedKeys.has(key)) {
        // A change always has both sides — the IR derived it from a pair. The
        // guard is defensive, so a missing "before" is skipped rather than
        // reported as a change against an invented value (§24).
        const previous = previousByEcuAndCode.get(key);
        if (previous !== undefined) {
          changed.push({
            code: dtc.code,
            before: previous.status,
            after: dtc.status,
            ecuName: dtc.ecuName,
          });
        }
        continue;
      }
      if (unchangedKeys.has(key)) unchanged.push(dtc);
    }
    return {
      added: after.filter((dtc) => addedKeys.has(dtcKey(dtc))),
      removed: before.filter((dtc) => removedKeys.has(dtcKey(dtc))),
      changed,
      unchanged,
    };
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
