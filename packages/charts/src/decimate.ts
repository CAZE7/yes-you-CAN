/**
 * Decimation: draw at most a few thousand points without lying about the data.
 *
 * A live recording produces far more samples than a chart has pixels. Naive
 * "every n-th sample" downsampling silently hides spikes — exactly what a
 * diagnostic tool must not do. Both algorithms here keep the visual extremes:
 *
 *  - `decimateMinMax` keeps the minimum AND maximum of every pixel column
 *    (lossless for peak detection, slightly noisy for smooth curves),
 *  - `decimateLttb` keeps the visually representative points
 *    (largest-triangle-three-buckets), which looks smoother.
 *
 * Both are pure and deterministic — the same input always yields the same
 * output, which keeps regression tests meaningful (AGENTS 31).
 */

import type { Point } from './types.js';

export type DecimationMode = 'minmax' | 'lttb';

/**
 * Reduce `points` to at most `maxPoints`, keeping extremes.
 * Returns the input array unchanged when it is already small enough.
 */
export function decimate(points: readonly Point[], maxPoints: number, mode: DecimationMode = 'minmax'): readonly Point[] {
  if (maxPoints <= 0) return [];
  if (points.length <= maxPoints) return points;
  return mode === 'lttb' ? decimateLttb(points, maxPoints) : decimateMinMax(points, maxPoints);
}

/**
 * Bucket by time (not by index) so unevenly sampled signals keep their shape:
 * every bucket covers the same time slice of the window.
 */
export function decimateMinMax(points: readonly Point[], maxPoints: number): readonly Point[] {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return [];

  const buckets = Math.max(1, Math.floor(maxPoints / 2));
  const span = last.t - first.t;
  if (span <= 0 || points.length <= maxPoints) return points;

  const out: Point[] = [first];
  const bucketOf = (t: number): number => Math.min(buckets - 1, Math.floor(((t - first.t) / span) * buckets));

  let current = 0;
  let minPoint: Point = first;
  let maxPoint: Point = first;
  for (const point of points) {
    const bucket = bucketOf(point.t);
    if (bucket !== current) {
      // Emit min and max in chronological order, whichever came first.
      if (minPoint.t <= maxPoint.t) appendIfNewer(out, minPoint, maxPoint);
      else appendIfNewer(out, maxPoint, minPoint);
      current = bucket;
      minPoint = point;
      maxPoint = point;
      continue;
    }
    if (point.value < minPoint.value) minPoint = point;
    if (point.value > maxPoint.value) maxPoint = point;
  }
  if (minPoint.t <= maxPoint.t) appendIfNewer(out, minPoint, maxPoint);
  else appendIfNewer(out, maxPoint, minPoint);

  appendIfNewer(out, last);
  return out;
}

/** Largest-triangle-three-buckets: visually faithful downsampling. */
export function decimateLttb(points: readonly Point[], maxPoints: number): readonly Point[] {
  if (points.length <= maxPoints || maxPoints < 3) return points;
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return [];

  const out: Point[] = [first];
  const bucketSize = (points.length - 2) / (maxPoints - 2);
  let previous: Point = first;

  for (let i = 0; i < maxPoints - 2; i++) {
    const start = Math.floor((i + 1) * bucketSize) + 1;
    const end = Math.min(points.length - 1, Math.floor((i + 2) * bucketSize) + 1);

    let averageT = 0;
    let averageValue = 0;
    let count = 0;
    for (let j = start; j < end; j++) {
      const point = points[j];
      if (!point) continue;
      averageT += point.t;
      averageValue += point.value;
      count++;
    }
    if (count === 0) continue;
    averageT /= count;
    averageValue /= count;

    const rangeStart = Math.floor(i * bucketSize) + 1;
    const rangeEnd = Math.floor((i + 1) * bucketSize) + 1;
    let chosen: Point | undefined;
    let bestArea = -1;
    for (let j = rangeStart; j < rangeEnd; j++) {
      const point = points[j];
      if (!point) continue;
      const area = Math.abs((previous.t - averageT) * (point.value - previous.value) - (previous.t - point.t) * (averageValue - previous.value));
      if (area > bestArea) {
        bestArea = area;
        chosen = point;
      }
    }
    if (chosen) {
      out.push(chosen);
      previous = chosen;
    }
  }

  out.push(last);
  return out;
}

function appendIfNewer(out: Point[], ...candidates: Point[]): void {
  for (const candidate of candidates) {
    const lastPoint = out[out.length - 1];
    // Skip duplicates: emitting the same point twice would draw a zero-length
    // segment and, for min === max buckets, double-count a sample.
    if (lastPoint && lastPoint.t === candidate.t && lastPoint.value === candidate.value) continue;
    out.push(candidate);
  }
}
