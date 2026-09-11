/**
 * Session comparison (AGENTS 30, Phase 2: "Session Compare").
 *
 * Two recordings of the same vehicle are only comparable if the comparison says
 * what it compared and how. This module therefore produces three separate,
 * explicitly labelled blocks instead of one "diff score":
 *
 * 1. **Metadata** — vehicle, VIN, adapter, definition version. A difference here
 *    (a different definition package, a different adapter) invalidates a naive
 *    value-by-value comparison, so it is reported first and loudly.
 * 2. **Fault codes** — which codes appeared, disappeared or changed status.
 * 3. **Signals** — per signal the statistics of both sessions and the delta
 *    between them, with a configurable tolerance so measurement noise does not
 *    turn into a finding.
 *
 * Nothing is inferred that the data does not contain: a signal that only exists
 * in one session is reported as added/removed, never as "0 in the other run".
 */

import type { DtcRecord } from '@vdp/protocols-uds';
import type { MeasurementSample, SignalStatistics } from '../measurements/types.js';
import { summarizeAllSamples } from '../measurements/statistics.js';

export interface SessionComparisonSide {
  id: string;
  /** Label shown in the UI, e.g. "vorher" / "nachher". */
  label: string;
  startedAt?: string;
  endedAt?: string;
  vehicle?: string;
  vin?: string;
  adapter?: string;
  definitionPackage?: { oem: string; version: string };
  /** Fault codes as they were read; a description is optional because a code may be undocumented. */
  dtcs: ReadonlyArray<DtcRecord & { description?: string }>;
  samples: readonly MeasurementSample[];
}

export interface MetadataDifference {
  field: string;
  label: string;
  left: string | null;
  right: string | null;
  same: boolean;
  /**
   * True when the difference makes the rest of the comparison unreliable (a
   * different vehicle or a different definition version).
   */
  critical: boolean;
}

export interface DtcDifference {
  code: string;
  /** `removed` = only in the left session, `added` = only in the right one. */
  kind: 'added' | 'removed' | 'status-changed';
  left?: { status: number; description?: string };
  right?: { status: number; description?: string };
}

export interface SignalDelta {
  min: number | null;
  max: number | null;
  average: number | null;
}

export interface SignalComparison {
  signal: string;
  name: string;
  unit?: string;
  left?: SignalStatistics;
  right?: SignalStatistics;
  /** `right - left`; null when a side has no numeric samples. */
  delta: SignalDelta;
  verdict: 'added' | 'removed' | 'changed' | 'stable';
  /** Why the verdict was chosen — shown in the UI, so a result can be checked. */
  reason: string;
}

export interface SessionHeader {
  id: string;
  label: string;
  startedAt?: string;
  vehicle?: string;
  vin?: string;
}

export interface SessionComparison {
  left: SessionHeader;
  right: SessionHeader;
  /** Differences that make the two sessions hard to compare (vehicle, definitions). */
  critical: MetadataDifference[];
  metadata: MetadataDifference[];
  dtcs: DtcDifference[];
  signals: SignalComparison[];
  /** One line per finding, ready for a report or the UI (AGENTS 21). */
  summary: string[];
}

export interface CompareSessionsOptions {
  /**
   * Relative change of the average above which a signal counts as changed.
   * Default 5 % — below that, run-to-run variation of a real signal (temperature,
   * load) dominates and a "change" would be noise.
   */
  changeTolerancePercent?: number;
  /** Only compare these signals, when given. */
  signalIds?: readonly string[];
}

const DEFAULT_TOLERANCE_PERCENT = 5;

export function compareSessions(
  left: SessionComparisonSide,
  right: SessionComparisonSide,
  options: CompareSessionsOptions = {},
): SessionComparison {
  const metadata = compareMetadata(left, right);
  const dtcs = compareDtcs(left.dtcs, right.dtcs);
  const signals = compareSignals(left.samples, right.samples, options);

  const critical = metadata.filter((entry) => entry.critical && !entry.same);
  const summary: string[] = [];
  for (const entry of critical) {
    summary.push(`${entry.label} unterscheidet sich (${entry.left ?? '—'} → ${entry.right ?? '—'}) — Werte nur eingeschränkt vergleichbar`);
  }
  const added = dtcs.filter((entry) => entry.kind === 'added');
  const removed = dtcs.filter((entry) => entry.kind === 'removed');
  const statusChanged = dtcs.filter((entry) => entry.kind === 'status-changed');
  if (added.length === 0 && removed.length === 0 && statusChanged.length === 0) {
    summary.push('Fehlerspeicher unverändert');
  } else {
    if (removed.length > 0) summary.push(`Fehlercodes nur in "${left.label}": ${removed.map((d) => d.code).join(', ')}`);
    if (added.length > 0) summary.push(`Fehlercodes nur in "${right.label}": ${added.map((d) => d.code).join(', ')}`);
    if (statusChanged.length > 0) {
      summary.push(
        `Status geändert: ${statusChanged
          .map((entry) => `${entry.code} (0x${(entry.left?.status ?? 0).toString(16)} → 0x${(entry.right?.status ?? 0).toString(16)})`)
          .join(', ')}`,
      );
    }
  }
  const changedSignals = signals.filter((entry) => entry.verdict === 'changed');
  if (changedSignals.length > 0) {
    summary.push(`Signale außerhalb der Toleranz: ${changedSignals.map((entry) => entry.name).join(', ')}`);
  }

  return {
    left: sideHeader(left),
    right: sideHeader(right),
    critical,
    metadata,
    dtcs,
    signals,
    summary,
  };
}

function sideHeader(side: SessionComparisonSide): SessionHeader {
  return {
    id: side.id,
    label: side.label,
    ...(side.startedAt ? { startedAt: side.startedAt } : {}),
    ...(side.vehicle ? { vehicle: side.vehicle } : {}),
    ...(side.vin ? { vin: side.vin } : {}),
  };
}

function compareMetadata(left: SessionComparisonSide, right: SessionComparisonSide): MetadataDifference[] {
  const fields: Array<{ field: string; label: string; left: string | null; right: string | null; critical: boolean }> = [
    { field: 'vehicle', label: 'Fahrzeug', left: left.vehicle ?? null, right: right.vehicle ?? null, critical: true },
    { field: 'vin', label: 'VIN', left: left.vin ?? null, right: right.vin ?? null, critical: true },
    {
      field: 'definitionPackage',
      label: 'Definition-Paket',
      left: formatPackage(left.definitionPackage),
      right: formatPackage(right.definitionPackage),
      critical: true,
    },
    { field: 'adapter', label: 'Adapter', left: left.adapter ?? null, right: right.adapter ?? null, critical: false },
    { field: 'startedAt', label: 'Aufnahmebeginn', left: left.startedAt ?? null, right: right.startedAt ?? null, critical: false },
  ];
  return fields.map((entry) => ({ ...entry, same: entry.left === entry.right }));
}

function formatPackage(pkg: SessionComparisonSide['definitionPackage']): string | null {
  return pkg ? `${pkg.oem} ${pkg.version}` : null;
}

function compareDtcs(
  left: ReadonlyArray<DtcRecord & { description?: string }>,
  right: ReadonlyArray<DtcRecord & { description?: string }>,
): DtcDifference[] {
  const leftByCode = new Map(left.map((record) => [record.code, record]));
  const rightByCode = new Map(right.map((record) => [record.code, record]));
  const codes = Array.from(new Set([...leftByCode.keys(), ...rightByCode.keys()])).sort();
  const differences: DtcDifference[] = [];
  for (const code of codes) {
    const before = leftByCode.get(code);
    const after = rightByCode.get(code);
    if (before && !after) {
      differences.push({ code, kind: 'removed', left: dtcSide(before) });
      continue;
    }
    if (!before && after) {
      differences.push({ code, kind: 'added', right: dtcSide(after) });
      continue;
    }
    if (before && after && before.status !== after.status) {
      differences.push({ code, kind: 'status-changed', left: dtcSide(before), right: dtcSide(after) });
    }
  }
  return differences;
}

function dtcSide(record: DtcRecord & { description?: string }): { status: number; description?: string } {
  return {
    status: record.status,
    ...(record.description ? { description: record.description } : {}),
  };
}

function compareSignals(
  leftSamples: readonly MeasurementSample[],
  rightSamples: readonly MeasurementSample[],
  options: CompareSessionsOptions,
): SignalComparison[] {
  const filter = options.signalIds ? new Set(options.signalIds) : undefined;
  const leftStats = new Map(summarizeAllSamples(leftSamples).map((entry) => [entry.signal, entry]));
  const rightStats = new Map(summarizeAllSamples(rightSamples).map((entry) => [entry.signal, entry]));
  const tolerance = options.changeTolerancePercent ?? DEFAULT_TOLERANCE_PERCENT;

  const ids = Array.from(new Set([...leftStats.keys(), ...rightStats.keys()])).filter((id) => !filter || filter.has(id)).sort();
  return ids.map((signal) => {
    const left = leftStats.get(signal);
    const right = rightStats.get(signal);
    const name = right?.name ?? left?.name ?? signal;
    const unit = right?.unit ?? left?.unit;
    const delta: SignalDelta = {
      min: numericDelta(left?.min ?? null, right?.min ?? null),
      max: numericDelta(left?.max ?? null, right?.max ?? null),
      average: numericDelta(left?.average ?? null, right?.average ?? null),
    };
    const base = { signal, name, ...(unit ? { unit } : {}), ...(left ? { left } : {}), ...(right ? { right } : {}) };

    // Presence is decided by the *signal*, not by its numeric sample count:
    // a signal that exists on both sides but carries no numbers is reported as
    // stable-with-reason, never as "added" (the doc block above forbids
    // inferring data the recordings do not contain).
    if (!left) {
      return { ...base, delta, verdict: 'added' as const, reason: `nur in der rechten Aufnahme (${right?.samples ?? 0} Werte)` };
    }
    if (!right) {
      return { ...base, delta, verdict: 'removed' as const, reason: `nur in der linken Aufnahme (${left.samples} Werte)` };
    }
    const before = left.average;
    const after = right.average;
    if (before === null || after === null) {
      return { ...base, delta, verdict: 'stable' as const, reason: 'keine numerischen Werte vergleichbar' };
    }
    const absolute = after - before;
    const relative = before === 0 ? null : (Math.abs(absolute) / Math.abs(before)) * 100;
    if (relative !== null && relative <= tolerance) {
      return { ...base, delta, verdict: 'stable' as const, reason: `Mittelwert weicht um ${relative.toFixed(1)} % ab (Toleranz ${tolerance} %)` };
    }
    const percentText = relative === null ? 'prozentual nicht definiert (Ausgangswert 0)' : `${relative.toFixed(1)} %`;
    return {
      ...base,
      delta,
      verdict: 'changed' as const,
      reason: `Mittelwert ${formatNumber(before)} → ${formatNumber(after)} (${percentText})`,
    };
  });
}

function numericDelta(left: number | null, right: number | null): number | null {
  if (left === null || right === null) return null;
  return right - left;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}
