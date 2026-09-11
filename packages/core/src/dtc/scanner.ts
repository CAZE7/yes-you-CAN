/**
 * DTC system (AGENTS 20).
 *
 * Adds the pieces the raw UDS layer does not have: description enrichment from
 * definition packages, severity, snapshots and before/after comparison.
 */

import type { DefinitionPackage } from "@vdp/definitions";
import type { DtcRecord } from "@vdp/protocols-uds";

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
    for (const pkg of options.definitions ?? []) {
      const signalNames = new Map<string, string>();
      for (const signal of pkg.signals ?? []) signalNames.set(signal.id, signal.name);
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

  enrich(records: readonly DtcRecord[], ecuName: string, ecuId: string): EnrichedDtc[] {
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
      return {
        ...record,
        ...(info?.description ? { description: info.description } : {}),
        ...(info?.hint ? { hint: info.hint } : {}),
        ...(info?.relatedSignals ? { relatedSignals: info.relatedSignals } : {}),
        severity: info?.severity ?? record.severity,
        ecuName,
        ecuId,
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
