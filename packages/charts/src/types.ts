/**
 * Shared value types for the chart layer (AGENTS 16).
 *
 * This package is deliberately DOM-free: everything that can be computed
 * without a canvas lives here and is unit-tested, so the canvas renderer in the
 * web app stays a thin drawing shell (AGENTS 34.8, ADR 0002 — no dependency,
 * and a future renderer can be swapped in without touching the mathematics).
 *
 * Times are milliseconds on a shared axis. The convention across the platform
 * is "milliseconds since the recording started" (`MeasurementSample.t`), which
 * keeps every signal on the same axis regardless of which ECU it came from.
 */

export interface Point {
  /** Time on the shared axis (ms since recording start). */
  t: number;
  /**
   * Decoded physical value. The chart never rescales raw bytes — decoding is
   * done by the measurement engine (AGENTS 14/34.7).
   */
  value: number;
  /** Sample outside the range declared by the definition (AGENTS 14 min/max). */
  outOfRange?: boolean;
}

export interface TimeRange {
  /** Inclusive lower bound in ms. */
  from: number;
  /** Inclusive upper bound in ms. */
  to: number;
}

export type MarkerKind = 'dtc' | 'action' | 'note' | 'user' | 'anomaly';

export interface Marker {
  id: string;
  t: number;
  label: string;
  kind: MarkerKind;
  detail?: string;
}

/** Statistics over one visible window — AGENTS 16 requires Min/Max/Avg/Delta. */
export interface WindowStats {
  count: number;
  min: number | null;
  max: number | null;
  average: number | null;
  /** max - min over the window (AGENTS 16 "Delta"). */
  delta: number | null;
  first: number | null;
  last: number | null;
}
