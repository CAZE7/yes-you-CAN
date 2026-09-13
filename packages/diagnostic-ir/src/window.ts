/**
 * Measurement windows (master backlog P0 #6; AGENTS 16, #23 "Messfenster").
 *
 * A window is the smallest thing a diagnosis can judge: a signal, a time span,
 * the readings inside it and — this is the part that used to be implicit — the
 * gaps. A failure pattern that says "rail pressure must stay above 150 bar for
 * two seconds" is only decidable if the window reports *how much of it was
 * actually observed* (AGENTS 24: no judgement without evidence).
 */

import type { SignalGap, SignalReading } from "./signal.js";
import type { ObservationValue } from "./signal.js";

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
  const from = Date.parse(options.from);
  const to = Date.parse(options.to);
  const inside = readings.filter((reading) => {
    if (reading.signalId !== options.signalId) return false;
    const at = Date.parse(reading.at);
    return Number.isFinite(at) && at >= from && at <= to;
  });
  const gapList = gaps.filter((gap) => {
    if (gap.signalId !== options.signalId) return false;
    const at = Date.parse(gap.at);
    return Number.isFinite(at) && at >= from && at <= to;
  });

  const values = inside
    .map((reading) => numeric(reading.value))
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
  const unit = inside.find((reading) => reading.unit !== undefined)?.unit ?? options.unit;
  if (unit !== undefined) window.unit = unit;
  return window;
}
