/**
 * DTC system (AGENTS 20).
 *
 * Adds the pieces the raw UDS layer does not have: description enrichment from
 * definition packages, severity, snapshots and before/after comparison.
 */

import type { DtcRecord } from '@vdp/protocols-uds';
import type { DefinitionPackage } from '@vdp/definitions';

export interface EnrichedDtc extends DtcRecord {
  /** Description from the definition package, when one exists. */
  description?: string;
  /** Suggested next diagnostic step from the definition package. */
  hint?: string;
  /** ECU the code was read from. */
  ecuName: string;
  ecuId: string;
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
}

export class DtcScanner {
  private readonly descriptions = new Map<string, { description: string; hint?: string; severity?: EnrichedDtc['severity'] }>();

  constructor(options: DtcScannerOptions = {}) {
    for (const pkg of options.definitions ?? []) {
      for (const ecu of pkg.ecus) {
        for (const dtc of ecu.dtcs ?? []) {
          const existing = this.descriptions.get(dtc.code);
          if (!existing) {
            this.descriptions.set(dtc.code, {
              description: dtc.description,
              ...(dtc.hint ? { hint: dtc.hint } : {}),
              ...(dtc.severity ? { severity: dtc.severity } : {}),
            });
          }
        }
      }
    }
  }

  enrich(records: readonly DtcRecord[], ecuName: string, ecuId: string): EnrichedDtc[] {
    return records.map((record) => {
      const info = this.descriptions.get(record.code);
      return {
        ...record,
        ...(info?.description ? { description: info.description } : {}),
        ...(info?.hint ? { hint: info.hint } : {}),
        severity: info?.severity ?? record.severity,
        ecuName,
        ecuId,
      };
    });
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
    const changed: DtcComparison['changed'] = [];
    const unchanged: EnrichedDtc[] = [];

    for (const dtc of after) {
      const previous = beforeMap.get(key(dtc));
      if (!previous) continue;
      if (previous.status !== dtc.status) {
        changed.push({ code: dtc.code, before: previous.status, after: dtc.status, ecuName: dtc.ecuName });
      } else {
        unchanged.push(dtc);
      }
    }
    return { added, removed, changed, unchanged };
  }

  /** Group by severity for reports (AGENTS 21 "DTC Summary"). */
  groupBySeverity(dtcs: readonly EnrichedDtc[]): Record<'critical' | 'major' | 'minor' | 'info', EnrichedDtc[]> {
    const groups: Record<'critical' | 'major' | 'minor' | 'info', EnrichedDtc[]> = { critical: [], major: [], minor: [], info: [] };
    for (const dtc of dtcs) groups[dtc.severity].push(dtc);
    return groups;
  }

  summary(dtcs: readonly EnrichedDtc[]): { total: number; critical: number; major: number; minor: number; info: number; codes: string[] } {
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
