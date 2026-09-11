/**
 * Measurement value types (AGENTS 15, 16).
 *
 * A sample always carries the decoded value *and* the raw value it came from, so
 * a report or a chart can show both and a suspicious decoding can be traced back
 * to bytes (AGENTS 5, 14). Kept in its own module so the recorder, the statistics
 * and the session comparison can share them without importing each other.
 */

export interface MeasurementSample {
  /** ISO-8601 with millisecond precision (AGENTS 15 requires precise timestamps). */
  timestamp: string;
  /** Monotonic milliseconds since recording start — used for the shared chart axis. */
  t: number;
  signal: string;
  value: number | string | boolean;
  rawValue: number | string | boolean;
  rawHex: string;
  unit?: string;
  enumText?: string;
  outOfRange: boolean;
}

export interface SignalStatistics {
  signal: string;
  name: string;
  unit?: string;
  samples: number;
  min: number | null;
  max: number | null;
  average: number | null;
  /** max - min over the recorded window (AGENTS 16 "Delta"). */
  delta: number | null;
  first: number | null;
  last: number | null;
  outOfRangeCount: number;
}

export interface Marker {
  id: string;
  t: number;
  timestamp: string;
  label: string;
  kind: "dtc" | "action" | "note" | "user";
  detail?: string;
}

export interface RecordingWindow {
  fromT: number;
  toT: number;
}
