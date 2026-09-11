/**
 * Statistics over measurement samples.
 *
 * Extracted from the recorder so that the very same numbers are produced for a
 * live recording, a stored session and a session comparison. Two code paths that
 * each compute "the average of a signal" would eventually disagree, and a
 * comparison whose sides are computed differently is worthless (AGENTS 15, 16, 30).
 */

import type { MeasurementSample, SignalStatistics } from './types.js';

export interface SampleSummaryNames {
  readonly names?: ReadonlyMap<string, string>;
  readonly units?: ReadonlyMap<string, string>;
}

/** Samples that can take part in a numeric statistic. */
function numericValues(samples: readonly MeasurementSample[]): number[] {
  return samples.map((sample) => sample.value).filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
}

/**
 * Summarize the samples of exactly one signal.
 *
 * `samples` is expected to belong to a single signal; the function does not
 * filter, so a caller that passes a mixed list gets a mixed statistic — both
 * `summarizeSamples` and the recorder guarantee the grouping.
 */
export function summarizeSamples(
  signal: string,
  samples: readonly MeasurementSample[],
  names: SampleSummaryNames = {},
): SignalStatistics {
  const values = numericValues(samples);
  const unit = samples.find((sample) => sample.unit)?.unit ?? names.units?.get(signal);
  const name = names.names?.get(signal) ?? samples.find((sample) => sample.signal === signal)?.signal ?? signal;
  const outOfRangeCount = samples.filter((sample) => sample.outOfRange).length;
  const base = {
    signal,
    name,
    ...(unit ? { unit } : {}),
    outOfRangeCount,
  };
  if (values.length === 0) {
    return { ...base, samples: 0, min: null, max: null, average: null, delta: null, first: null, last: null };
  }
  // No spread here on purpose: `Math.min(...values)` passes every sample as a call
  // argument and exceeds the argument limit at roughly 100 000 samples, which is a
  // few minutes of a 100 Hz signal — a long recording would then be unsummarisable.
  let min = Infinity;
  let max = -Infinity;
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return {
    ...base,
    samples: values.length,
    min,
    max,
    average: values.reduce((sum, value) => sum + value, 0) / values.length,
    delta: max - min,
    first: values[0] ?? null,
    last: values[values.length - 1] ?? null,
  };
}

/** Summarize every signal of a mixed sample list, in first-appearance order. */
export function summarizeAllSamples(
  samples: readonly MeasurementSample[],
  names: SampleSummaryNames = {},
): SignalStatistics[] {
  const bySignal = new Map<string, MeasurementSample[]>();
  for (const sample of samples) {
    const list = bySignal.get(sample.signal) ?? [];
    list.push(sample);
    bySignal.set(sample.signal, list);
  }
  return Array.from(bySignal, ([signal, list]) => summarizeSamples(signal, list, names));
}
