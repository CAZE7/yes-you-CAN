/**
 * Measurement windows (master backlog P0 #6; AGENTS 16, #23 "Messfenster").
 *
 * A window is the smallest thing a diagnosis can judge: a signal, a time span,
 * the readings inside it and — this is the part that used to be implicit — the
 * gaps. A failure pattern that says "rail pressure must stay above 150 bar for
 * two seconds" is only decidable if the window reports *how much of it was
 * actually observed* (AGENTS 24: no judgement without evidence).
 */

import type { ObservationValue, SignalGap, SignalReading } from "./signal.js";

export interface MeasurementWindow {
  kind: "window";
  signalId: string;
  /** Inclusive start of the window (ISO-8601). */
  from: string;
  /** Inclusive end of the window (ISO-8601). */
  to: string;
  /** Number of readings inside the window. */
  samples: number;
  min?: number;
  max?: number;
  mean?: number;
  unit?: string;
  /** Readings that could not be taken inside the window, with their reasons. */
  gaps: SignalGap[];
  /**
   * True when the window is complete enough to judge: at least one sample and no
   * gap that covers the whole window. A window of gaps is data, not a verdict.
   */
  conclusive: boolean;
}

/** Only numbers can be min/max/mean'd; enums and booleans are counts, not values. */
function numeric(value: ObservationValue | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export interface WindowOptions {
  signalId: string;
  from: string;
  to: string;
  unit?: string;
}

/** One point of a series: when it was observed and what it was. */
export interface WindowPoint {
  at: string;
  /** Anything an observation can hold — only numbers contribute to min/max/mean. */
  value: ObservationValue;
}

function insideSpan(at: string, from: number, to: number): boolean {
  const time = Date.parse(at);
  return Number.isFinite(time) && time >= from && time <= to;
}

/**
 * The one computation behind every window: statistics, gaps and the verdict.
 *
 * Lives here (not in a copy per caller) because `conclusive` is the load-bearing
 * rule — a window of gaps is not a measurement — and a second implementation of it
 * is a second opinion about the same recording.
 */
export function summariseWindow(
  points: readonly WindowPoint[],
  gaps: readonly SignalGap[],
  options: WindowOptions,
): MeasurementWindow {
  const from = Date.parse(options.from);
  const to = Date.parse(options.to);
  const inside = points.filter((point) => insideSpan(point.at, from, to));
  const gapList = gaps.filter((gap) => insideSpan(gap.at, from, to));

  const values = inside
    .map((point) => numeric(point.value))
    .filter((value): value is number => value !== undefined);
  const sum = values.reduce((total, value) => total + value, 0);
  const window: MeasurementWindow = {
    kind: "window",
    signalId: options.signalId,
    from: options.from,
    to: options.to,
    samples: inside.length,
    gaps: gapList,
    conclusive: inside.length > 0 && gapList.length === 0,
  };
  if (values.length > 0) {
    window.min = Math.min(...values);
    window.max = Math.max(...values);
    window.mean = sum / values.length;
  }
  if (options.unit !== undefined) window.unit = options.unit;
  return window;
}

/**
 * Build a window from the observations that belong to it.
 *
 * Observations outside `[from, to]` are ignored; the caller decides the span (a
 * live poll round, a recording segment, a replay step). Gaps for the same signal
 * inside the span are attached, so the verdict can be "not observable" instead of
 * "not observed".
 */
export function measurementWindow(
  readings: readonly SignalReading[],
  gaps: readonly SignalGap[],
  options: WindowOptions,
): MeasurementWindow {
  const mine = readings.filter((reading) => reading.signalId === options.signalId);
  const unit = mine.find((reading) => reading.unit !== undefined)?.unit ?? options.unit;
  return summariseWindow(
    mine.map((reading) => ({ at: reading.at, value: reading.value })),
    gaps.filter((gap) => gap.signalId === options.signalId),
    {
      signalId: options.signalId,
      from: options.from,
      to: options.to,
      ...(unit !== undefined ? { unit } : {}),
    },
  );
}
