/**
 * Axis mathematics: tick generation, range padding and label formatting.
 *
 * Pure functions — no canvas, no DOM. A renderer asks for ticks and gets plain
 * numbers back; what it draws with them is its own business.
 */

/** Human-friendly tick steps: 1, 2, 2.5, 5, 10 times a power of ten. */
export function niceStep(rough: number): number {
  if (!Number.isFinite(rough) || rough <= 0) return 1;
  const exponent = Math.floor(Math.log10(rough));
  const magnitude = 10 ** exponent;
  const normalized = rough / magnitude;
  let factor = 10;
  if (normalized <= 1) factor = 1;
  else if (normalized <= 2) factor = 2;
  else if (normalized <= 2.5) factor = 2.5;
  else if (normalized <= 5) factor = 5;
  return factor * magnitude;
}

/**
 * Ticks inside [min, max], including both ends when they land on a step.
 * `target` is the desired count — the actual count is close to it, never zero.
 */
export function niceTicks(min: number, max: number, target = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return [min];
  const step = niceStep((max - min) / Math.max(1, target));
  const ticks: number[] = [];
  // Start at the first multiple of `step` at or above min, with a tolerance so
  // floating point noise does not drop the lowest tick.
  const first = Math.ceil(min / step - 1e-9) * step;
  for (let value = first; value <= max + step * 1e-9; value += step) {
    // Snap to the step grid to avoid 0.30000000000000004 style labels.
    ticks.push(Math.abs(value) < step * 1e-9 ? 0 : roundTo(value, decimalsFor(step)));
    if (ticks.length > 1000) break;
  }
  return ticks;
}

export interface YRangeOptions {
  /** Hard limits from the definition package, e.g. a temperature sensor range. */
  min?: number;
  max?: number;
  /** Relative padding around the data so the line never touches the border. */
  padFraction?: number;
}

export interface YRange {
  min: number;
  max: number;
}

/**
 * Y-axis range for a set of values.
 *
 * Falls back to a 0…1 range for an empty series and widens a degenerate range
 * (min === max) so a flat line is still drawn in the middle of the plot.
 */
export function computeYRange(values: readonly number[], options: YRangeOptions = {}): YRange {
  const padFraction = options.padFraction ?? 0.08;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    if (value < min) min = value;
    if (value > max) max = value;
  }

  if (min === Number.POSITIVE_INFINITY || max === Number.NEGATIVE_INFINITY) {
    min = options.min ?? 0;
    max = options.max ?? (options.min === undefined ? 1 : options.min + 1);
    return padTo({ min, max }, padFraction, options);
  }

  // Definition limits win over the observed data: a signal that stayed inside
  // its range must not look like it filled the whole plot (AGENTS 13/14).
  if (options.min !== undefined) min = Math.min(min, options.min);
  if (options.max !== undefined) max = Math.max(max, options.max);
  return padTo({ min, max }, padFraction, options);
}

function padTo(range: YRange, padFraction: number, options: YRangeOptions): YRange {
  const span = range.max - range.min;
  const pad = span > 0 ? span * padFraction : Math.max(1, Math.abs(range.max) * 0.05);
  return {
    min: options.min !== undefined ? Math.min(options.min, range.min - pad) : range.min - pad,
    max: options.max !== undefined ? Math.max(options.max, range.max + pad) : range.max + pad,
  };
}

function decimalsFor(step: number): number {
  if (step >= 1) return 0;
  return Math.min(6, Math.ceil(-Math.log10(step)));
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Adaptive value formatting: enough decimals to be readable, never more.
 * Used by axis labels and the cursor readout.
 */
export function formatValue(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs >= 10_000) return Math.round(value).toLocaleString("de-DE");
  if (abs >= 100) return value.toFixed(0);
  if (abs >= 10) return value.toFixed(1);
  if (abs >= 1) return value.toFixed(2);
  if (abs === 0) return "0";
  return value.toFixed(3);
}

/** "1,5 s", "250 ms", "1:05,250" style duration for axis labels and deltas. */
export function formatDuration(ms: number): string {
  const abs = Math.abs(ms);
  if (abs < 1) return `${roundTo(ms, 3)} ms`;
  if (abs < 1000) return `${roundTo(ms, 0)} ms`;
  if (abs < 60_000) return `${roundTo(ms / 1000, abs < 10_000 ? 2 : 1)} s`;
  const minutes = Math.floor(abs / 60_000);
  const seconds = roundTo((abs % 60_000) / 1000, 1);
  return `${ms < 0 ? "-" : ""}${minutes}:${seconds.toFixed(1).padStart(4, "0")} min`;
}

/** Short clock label (mm:ss.mmm) for the shared time axis of a recording. */
export function formatClock(ms: number): string {
  const sign = ms < 0 ? "-" : "";
  const abs = Math.abs(ms);
  const minutes = Math.floor(abs / 60_000);
  const seconds = Math.floor((abs % 60_000) / 1000);
  const millis = Math.floor(abs % 1000);
  return `${sign}${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

/**
 * Time ticks for a window: builds on `niceTicks` but works in milliseconds and
 * keeps at most `target` labels so the axis never becomes unreadable.
 */
export function niceTimeTicks(from: number, to: number, target = 6): number[] {
  if (!(to > from)) return [from];
  const step = niceStep((to - from) / Math.max(1, target));
  const first = Math.ceil(from / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let value = first; value <= to + step * 1e-9; value += step) {
    // Same near-zero snap as niceTicks — a "-0" label on a time axis is noise.
    ticks.push(Math.abs(value) < step * 1e-9 ? 0 : roundTo(value, 6));
    if (ticks.length > 500) break;
  }
  return ticks;
}
