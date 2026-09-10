/**
 * Measurement recording and statistics (AGENTS 15, 16, 17).
 *
 * Each sample carries a precise timestamp and keeps the raw value next to the
 * decoded one. Recording is append-only so replay and exports stay lossless.
 */

import { toHex } from '@vdp/shared';
import type { DecodedSignal } from './decoder.js';
import { summarizeSamples } from './statistics.js';
import type { MeasurementSample, Marker, RecordingWindow, SignalStatistics } from './types.js';

// Re-exported so the existing importers keep working; the definitions themselves
// live in `types.ts` to keep this module free of cycles (statistics.ts needs them).
export type { MeasurementSample, Marker, RecordingWindow, SignalStatistics } from './types.js';

export class MeasurementRecorder {
  private readonly samples: MeasurementSample[] = [];
  private readonly markerList: Marker[] = [];
  private readonly names = new Map<string, string>();
  private readonly units = new Map<string, string>();
  private readonly startedAt: number;
  private markerSequence = 0;

  constructor(private readonly clock: () => number = () => Date.now()) {
    this.startedAt = clock();
  }

  get startedAtMs(): number {
    return this.startedAt;
  }

  get length(): number {
    return this.samples.length;
  }

  get markers(): readonly Marker[] {
    return this.markerList;
  }

  record(decoded: DecodedSignal, timestampMs = this.clock()): MeasurementSample {
    const sample: MeasurementSample = {
      timestamp: new Date(timestampMs).toISOString(),
      t: timestampMs - this.startedAt,
      signal: decoded.signalId,
      value: decoded.value,
      rawValue: decoded.rawValue,
      rawHex: decoded.rawHex,
      ...(decoded.unit ? { unit: decoded.unit } : {}),
      ...(decoded.enumText ? { enumText: decoded.enumText } : {}),
      outOfRange: decoded.outOfRange,
    };
    this.samples.push(sample);
    this.names.set(decoded.signalId, decoded.name);
    if (decoded.unit) this.units.set(decoded.signalId, decoded.unit);
    return sample;
  }

  recordRaw(signalId: string, name: string, raw: Uint8Array, timestampMs = this.clock()): void {
    this.samples.push({
      timestamp: new Date(timestampMs).toISOString(),
      t: timestampMs - this.startedAt,
      signal: signalId,
      value: toHex(raw),
      rawValue: toHex(raw),
      rawHex: toHex(raw),
      outOfRange: false,
    });
    this.names.set(signalId, name);
  }

  addMarker(label: string, kind: Marker['kind'] = 'user', detail?: string, timestampMs = this.clock()): Marker {
    const marker: Marker = {
      id: `marker_${++this.markerSequence}`,
      t: timestampMs - this.startedAt,
      timestamp: new Date(timestampMs).toISOString(),
      label,
      kind,
      ...(detail ? { detail } : {}),
    };
    this.markerList.push(marker);
    return marker;
  }

  signalIds(): string[] {
    return Array.from(new Set(this.samples.map((s) => s.signal)));
  }

  samplesFor(signalId: string, window?: RecordingWindow): MeasurementSample[] {
    return this.samples.filter((s) => s.signal === signalId && (!window || (s.t >= window.fromT && s.t <= window.toT)));
  }

  /** Samples of several signals merged on the shared time axis (AGENTS 16). */
  merged(signalIds: readonly string[], window?: RecordingWindow): MeasurementSample[] {
    return this.samples
      .filter((s) => signalIds.includes(s.signal))
      .filter((s) => !window || (s.t >= window.fromT && s.t <= window.toT))
      .sort((a, b) => a.t - b.t);
  }

  statistics(signalId: string, window?: RecordingWindow): SignalStatistics {
    return summarizeSamples(signalId, this.samplesFor(signalId, window), { names: this.names, units: this.units });
  }

  statisticsForAll(window?: RecordingWindow): SignalStatistics[] {
    return this.signalIds().map((id) => this.statistics(id, window));
  }

  /**
   * Simple anomaly detection used by reports and the AI layer (AGENTS 21/22):
   * out-of-range samples or a delta far above the median delta of all signals.
   */
  anomalies(window?: RecordingWindow): Array<{ signal: string; reason: string; value?: number }> {
    const result: Array<{ signal: string; reason: string; value?: number }> = [];
    const stats = this.statisticsForAll(window);
    const deltas = stats.map((s) => s.delta ?? 0).sort((a, b) => a - b);
    const median = deltas.length > 0 ? (deltas[Math.floor(deltas.length / 2)] ?? 0) : 0;
    for (const stat of stats) {
      if (stat.outOfRangeCount > 0) {
        result.push({ signal: stat.signal, reason: `${stat.outOfRangeCount} samples outside the declared range` });
      }
      if (stat.delta !== null && median > 0 && stat.delta > median * 6 && stat.samples > 5) {
        result.push({ signal: stat.signal, reason: `delta ${stat.delta.toFixed(2)} is far above the median ${median.toFixed(2)}`, value: stat.delta });
      }
    }
    return result;
  }

  export(): { startedAt: number; samples: MeasurementSample[]; markers: Marker[] } {
    return { startedAt: this.startedAt, samples: [...this.samples], markers: [...this.markerList] };
  }
}
