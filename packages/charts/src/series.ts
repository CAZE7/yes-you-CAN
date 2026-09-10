/**
 * One measurement series plus the window queries the charts need.
 *
 * Points are kept sorted by time and trimmed to a bounded memory window, so a
 * long recording cannot grow without limit. Every window query is a binary
 * search — the charts ask for slices on every frame.
 */

import type { Point, TimeRange, WindowStats } from './types.js';

export interface SeriesOptions {
  id: string;
  name?: string;
  unit?: string;
  color?: string;
  visible?: boolean;
  /** Declared value range from the definition package (AGENTS 14). */
  min?: number;
  max?: number;
  /** Ring-buffer size; oldest points fall out first. */
  maxPoints?: number;
}

export class Series {
  readonly id: string;
  readonly name: string;
  readonly unit?: string;
  readonly color?: string;
  readonly min?: number;
  readonly max?: number;
  visible: boolean;

  private points: Point[] = [];
  private readonly maxPoints: number;

  constructor(options: SeriesOptions) {
    this.id = options.id;
    this.name = options.name ?? options.id;
    if (options.unit !== undefined) this.unit = options.unit;
    if (options.color !== undefined) this.color = options.color;
    if (options.min !== undefined) this.min = options.min;
    if (options.max !== undefined) this.max = options.max;
    this.visible = options.visible ?? true;
    this.maxPoints = options.maxPoints ?? 200_000;
  }

  get length(): number {
    return this.points.length;
  }

  get all(): readonly Point[] {
    return this.points;
  }

  get first(): Point | undefined {
    return this.points[0];
  }

  get last(): Point | undefined {
    return this.points[this.points.length - 1];
  }

  /** Append one sample. Out-of-order samples are inserted, never dropped. */
  push(point: Point): void {
    const last = this.points[this.points.length - 1];
    if (!last || point.t >= last.t) {
      this.points.push(point);
    } else {
      const index = lowerBound(this.points, point.t);
      this.points.splice(index, 0, point);
    }
    this.trim();
  }

  pushMany(points: readonly Point[]): void {
    if (points.length === 0) return;
    // Fast path: a sorted batch (the normal case for live samples).
    const last = this.points[this.points.length - 1];
    let sorted = !last || (points[0]?.t ?? 0) >= last.t;
    if (sorted) {
      for (let i = 1; i < points.length; i++) {
        const previous = points[i - 1];
        const current = points[i];
        if (!previous || !current || current.t < previous.t) {
          sorted = false;
          break;
        }
      }
    }
    if (sorted) this.points.push(...(points as Point[]));
    else for (const point of points) this.push(point);
    this.trim();
  }

  clear(): void {
    this.points = [];
  }

  /** Drop the oldest samples once the ring buffer is full. */
  private trim(): void {
    if (this.points.length <= this.maxPoints) return;
    this.points.splice(0, this.points.length - this.maxPoints);
  }

  /** Time extent of this series (optionally restricted to a window). */
  extent(range?: TimeRange): TimeRange | null {
    if (this.points.length === 0) return null;
    if (!range) return { from: this.points[0]?.t ?? 0, to: this.points[this.points.length - 1]?.t ?? 0 };
    const slice = this.slice(range);
    if (slice.length === 0) return null;
    return { from: slice[0]?.t ?? range.from, to: slice[slice.length - 1]?.t ?? range.to };
  }

  /** All points within [range.from, range.to], inclusive. */
  slice(range: TimeRange): readonly Point[] {
    if (this.points.length === 0 || range.to < range.from) return [];
    const start = lowerBound(this.points, range.from);
    const end = upperBound(this.points, range.to);
    return this.points.slice(start, end);
  }

  /**
   * Sample nearest to `t` — the value the cursor readout shows.
   * Returns null when the series is empty or `t` is outside the recording by
   * more than `toleranceMs` (a cursor in empty space shows nothing instead of
   * a misleading stale value).
   */
  valueAt(t: number, toleranceMs = Infinity): Point | null {
    if (this.points.length === 0) return null;
    const index = lowerBound(this.points, t);
    const after = this.points[index];
    const before = this.points[index - 1];
    let best: Point | undefined;
    let bestDistance = Infinity;
    if (before) {
      const distance = Math.abs(before.t - t);
      if (distance <= bestDistance) {
        best = before;
        bestDistance = distance;
      }
    }
    if (after) {
      const distance = Math.abs(after.t - t);
      if (distance < bestDistance) {
        best = after;
        bestDistance = distance;
      }
    }
    if (!best || bestDistance > toleranceMs) return null;
    return best;
  }

  /** Min/Max/Average/Delta/First/Last over a window (AGENTS 16). */
  stats(range?: TimeRange): WindowStats {
    const points = range ? this.slice(range) : this.points;
    return statsOf(points);
  }
}

export function statsOf(points: readonly Point[]): WindowStats {
  if (points.length === 0) {
    return { count: 0, min: null, max: null, average: null, delta: null, first: null, last: null };
  }
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const point of points) {
    if (!Number.isFinite(point.value)) continue;
    if (point.value < min) min = point.value;
    if (point.value > max) max = point.value;
    sum += point.value;
  }
  if (min === Infinity) {
    return { count: points.length, min: null, max: null, average: null, delta: null, first: null, last: null };
  }
  return {
    count: points.length,
    min,
    max,
    average: sum / points.length,
    delta: max - min,
    first: points[0]?.value ?? null,
    last: points[points.length - 1]?.value ?? null,
  };
}

function lowerBound(points: readonly Point[], t: number): number {
  let low = 0;
  let high = points.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    const point = points[mid];
    if (point && point.t < t) low = mid + 1;
    else high = mid;
  }
  return low;
}

function upperBound(points: readonly Point[], t: number): number {
  let low = 0;
  let high = points.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    const point = points[mid];
    if (point && point.t <= t) low = mid + 1;
    else high = mid;
  }
  return low;
}
