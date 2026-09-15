/**
 * Signal-Analysis Engine (Task 5; Master Backlog #15; AGENTS 15, 16).
 *
 * Separates advanced mathematical, statistical, spectral, and anomaly analysis
 * from presentation/rendering. Provides:
 * 1. Higher-order statistical metrics (variance, std dev, skewness, kurtosis, percentiles).
 * 2. Spectral / FFT analysis (dominant frequency, power spectrum, SNR estimate).
 * 3. Digital signal filtering (Moving Average, Exponential Moving Average, Hampel/MAD outlier filtering).
 * 4. Cross-signal correlation (Pearson correlation coefficient, lead/lag relationships).
 * 5. Domain-driven anomaly detection (spikes, dropouts, frozen sensors, rate-of-change violations).
 */

import type { MeasurementSample } from "./types.js";

export interface AdvancedSignalStatistics {
  count: number;
  min: number;
  max: number;
  mean: number;
  median: number;
  variance: number;
  stdDev: number;
  /** Fisher-Pearson skewness: 0 for symmetric, >0 for right-skewed, <0 for left-skewed. */
  skewness: number;
  /** Excess kurtosis: 0 for normal distribution, >0 for heavy tails (leptokurtic). */
  kurtosis: number;
  percentiles: {
    p5: number;
    p25: number;
    p50: number;
    p75: number;
    p95: number;
    p99: number;
  };
  rateOfChange?: {
    min: number;
    max: number;
    avg: number;
  };
}

export interface FrequencySpectrum {
  frequencies: number[];
  magnitudes: number[];
  dominantFrequency: number;
  dominantMagnitude: number;
  snrDb: number;
}

export interface SignalCorrelationResult {
  pearsonR: number;
  sampleCount: number;
  interpretation:
    | "strong_positive"
    | "moderate_positive"
    | "weak"
    | "moderate_negative"
    | "strong_negative";
}

export type SignalAnomalyKind = "spike" | "dropout" | "frozen" | "rate_of_change";

export interface DetectedSignalAnomaly {
  kind: SignalAnomalyKind;
  signal: string;
  t: number;
  timestamp: string;
  value: number;
  severity: "info" | "warning" | "critical";
  description: string;
}

export interface AnomalyDetectionOptions {
  /** Maximum physically plausible rate of change per second (|dv/dt|). */
  maxRateOfChangePerSec?: number;
  /** Minimum expected standard deviation before flagging a sensor as frozen/stuck. Default 0.0001 */
  frozenThresholdStdDev?: number;
  /** Minimum consecutive milliseconds required before declaring a signal frozen. Default 3000ms */
  frozenDurationMs?: number;
  /** Value considered a dropout (e.g. exactly 0 for non-zero sensors like battery or fuel pressure). */
  dropoutValue?: number;
  /** Z-score threshold for spike detection (default 3.5). */
  spikeZScoreThreshold?: number;
}

/** Extracts numeric finite values. */
function extractNumbers(input: readonly (number | MeasurementSample)[]): number[] {
  const result: number[] = [];
  for (const item of input) {
    const val = typeof item === "number" ? item : item.value;
    if (typeof val === "number" && Number.isFinite(val)) {
      result.push(val);
    }
  }
  return result;
}

/** Compute percentile using linear interpolation between closest ranks. */
function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0] ?? 0;
  const index = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index - lower;
  return (sorted[lower] ?? 0) * (1 - weight) + (sorted[upper] ?? 0) * weight;
}

/**
 * Computes advanced statistical metrics over numeric values or measurement samples.
 */
export function computeAdvancedStatistics(
  input: readonly (number | MeasurementSample)[],
): AdvancedSignalStatistics | undefined {
  const values = extractNumbers(input);
  if (values.length === 0) return undefined;

  const n = values.length;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let sum = 0;

  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }

  const mean = sum / n;

  // Second, third, and fourth central moments
  let m2 = 0;
  let m3 = 0;
  let m4 = 0;

  for (const v of values) {
    const diff = v - mean;
    const diff2 = diff * diff;
    m2 += diff2;
    m3 += diff2 * diff;
    m4 += diff2 * diff2;
  }

  const variance = n > 1 ? m2 / (n - 1) : 0;
  const stdDev = Math.sqrt(variance);

  // Skewness and Excess Kurtosis
  let skewness = 0;
  let kurtosis = 0;
  if (stdDev > 0 && n > 2) {
    const s2 = m2 / n;
    const s3 = m3 / n;
    const s4 = m4 / n;
    skewness = s3 / s2 ** 1.5;
    kurtosis = s4 / (s2 * s2) - 3;
  }

  // Sorted values for percentiles
  const sorted = [...values].sort((a, b) => a - b);
  const median = percentile(sorted, 50);

  // Rate of change if samples with time 't' are provided
  let rateOfChange: AdvancedSignalStatistics["rateOfChange"];
  const isSampleList = input.length > 1 && typeof input[0] !== "number" && "t" in (input[0] ?? {});
  if (isSampleList) {
    const samples = (input as readonly MeasurementSample[]).filter(
      (s): s is MeasurementSample & { value: number } =>
        typeof s.value === "number" && Number.isFinite(s.value),
    );
    if (samples.length >= 2) {
      let minRoc = Number.POSITIVE_INFINITY;
      let maxRoc = Number.NEGATIVE_INFINITY;
      let sumRoc = 0;
      let rocCount = 0;

      for (let i = 1; i < samples.length; i++) {
        const prev = samples[i - 1];
        const curr = samples[i];
        if (prev && curr) {
          const dtSec = (curr.t - prev.t) / 1000;
          if (dtSec > 0.0001) {
            const roc = (curr.value - prev.value) / dtSec;
            if (roc < minRoc) minRoc = roc;
            if (roc > maxRoc) maxRoc = roc;
            sumRoc += Math.abs(roc);
            rocCount++;
          }
        }
      }

      if (rocCount > 0) {
        rateOfChange = {
          min: minRoc,
          max: maxRoc,
          avg: sumRoc / rocCount,
        };
      }
    }
  }

  return {
    count: n,
    min,
    max,
    mean,
    median,
    variance,
    stdDev,
    skewness,
    kurtosis,
    percentiles: {
      p5: percentile(sorted, 5),
      p25: percentile(sorted, 25),
      p50: median,
      p75: percentile(sorted, 75),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
    },
    ...(rateOfChange ? { rateOfChange } : {}),
  };
}

/**
 * Computes frequency spectrum via Cooley-Tukey Radix-2 FFT or DFT.
 *
 * @param input Array of values or {t: number, value: number} objects.
 * @param sampleRateHz Optional sample rate in Hz (inferred from timestamps if omitted).
 */
export function computeFft(
  input: readonly (number | { t: number; value: number })[],
  sampleRateHz?: number,
): FrequencySpectrum {
  if (input.length === 0) {
    return {
      frequencies: [],
      magnitudes: [],
      dominantFrequency: 0,
      dominantMagnitude: 0,
      snrDb: 0,
    };
  }

  // Extract raw values and infer sample rate if needed
  let values: number[];
  let rate = sampleRateHz ?? 10; // Default 10 Hz

  if (typeof input[0] === "number") {
    values = input as number[];
  } else {
    const timePoints = input as readonly { t: number; value: number }[];
    values = timePoints.map((p) => p.value);
    if (!sampleRateHz && timePoints.length >= 2) {
      const first = timePoints[0]?.t ?? 0;
      const last = timePoints[timePoints.length - 1]?.t ?? 1000;
      const durationSec = (last - first) / 1000;
      if (durationSec > 0) {
        rate = (timePoints.length - 1) / durationSec;
      }
    }
  }

  // Next power of 2 for Radix-2 FFT
  const n = 1 << Math.ceil(Math.log2(Math.max(values.length, 8)));
  const real = new Float64Array(n);
  const imag = new Float64Array(n);

  // Copy with mean removal and Hann window (to suppress spectral leakage)
  const mean = values.reduce((sum, v) => sum + v, 0) / (values.length || 1);
  for (let i = 0; i < values.length; i++) {
    const hann =
      values.length > 1 ? 0.5 * (1 - Math.cos((2 * Math.PI * i) / (values.length - 1))) : 1;
    real[i] = ((values[i] ?? 0) - mean) * hann;
  }

  // In-place Bit-Reversal Permutation
  let j = 0;
  for (let i = 0; i < n - 1; i++) {
    if (i < j) {
      const tempR = real[i] ?? 0;
      real[i] = real[j] ?? 0;
      real[j] = tempR;
    }
    let k = n >> 1;
    while (k <= j) {
      j -= k;
      k >>= 1;
    }
    j += k;
  }

  // Cooley-Tukey Radix-2 Butterfly
  for (let len = 2; len <= n; len <<= 1) {
    const halfLen = len >> 1;
    const angle = (-2 * Math.PI) / len;
    const wStepR = Math.cos(angle);
    const wStepI = Math.sin(angle);

    for (let i = 0; i < n; i += len) {
      let wR = 1.0;
      let wI = 0.0;
      for (let k = 0; k < halfLen; k++) {
        const uR = real[i + k] ?? 0;
        const uI = imag[i + k] ?? 0;
        const vR = real[i + k + halfLen] ?? 0;
        const vI = imag[i + k + halfLen] ?? 0;
        const tR = wR * vR - wI * vI;
        const tI = wR * vI + wI * vR;

        real[i + k] = uR + tR;
        imag[i + k] = uI + tI;
        real[i + k + halfLen] = uR - tR;
        imag[i + k + halfLen] = uI - tI;

        const nextWR = wR * wStepR - wI * wStepI;
        wI = wR * wStepI + wI * wStepR;
        wR = nextWR;
      }
    }
  }

  // Compute positive frequency half spectrum
  const half = n >> 1;
  const frequencies: number[] = new Array(half);
  const magnitudes: number[] = new Array(half);

  let dominantFreq = 0;
  let dominantMag = 0;
  let noisePower = 0;

  for (let i = 0; i < half; i++) {
    frequencies[i] = (i * rate) / n;
    const rVal = real[i] ?? 0;
    const iVal = imag[i] ?? 0;
    const mag = Math.sqrt(rVal * rVal + iVal * iVal) / half;
    magnitudes[i] = mag;

    // Ignore very first bin (DC remnant) for dominant peak
    if (i > 0 && mag > dominantMag) {
      dominantMag = mag;
      dominantFreq = frequencies[i] ?? 0;
    }
  }

  // Estimate noise floor by excluding peak bin and immediate spectral leakage neighbors
  const dominantBin = frequencies.indexOf(dominantFreq);
  for (let i = 1; i < half; i++) {
    if (Math.abs(i - dominantBin) > 2) {
      const m = magnitudes[i] ?? 0;
      noisePower += m * m;
    }
  }

  const peakPower = dominantMag * dominantMag;
  const effectiveNoise = Math.max(noisePower, 1e-9);
  const snrDb = peakPower > 0 ? 10 * Math.log10(peakPower / effectiveNoise) : 0;

  return {
    frequencies,
    magnitudes,
    dominantFrequency: dominantFreq,
    dominantMagnitude: dominantMag,
    snrDb: Math.round(snrDb * 100) / 100,
  };
}

/**
 * Moving Average Filter with symmetrical window.
 */
export function filterMovingAverage(values: readonly number[], windowSize = 5): number[] {
  if (values.length === 0 || windowSize <= 1) return [...values];
  const result: number[] = new Array(values.length);
  const half = Math.floor(windowSize / 2);

  for (let i = 0; i < values.length; i++) {
    const start = Math.max(0, i - half);
    const end = Math.min(values.length, i + half + 1);
    let sum = 0;
    for (let k = start; k < end; k++) {
      sum += values[k] ?? 0;
    }
    result[i] = sum / (end - start);
  }

  return result;
}

/**
 * Exponential Moving Average (EMA) filter.
 *
 * @param alpha Smoothing factor 0 < alpha <= 1 (higher alpha = more weight to recent values).
 */
export function filterExponentialSmoothing(values: readonly number[], alpha = 0.2): number[] {
  if (values.length === 0) return [];
  const result: number[] = new Array(values.length);
  let current = values[0] ?? 0;
  result[0] = current;

  for (let i = 1; i < values.length; i++) {
    current = alpha * (values[i] ?? 0) + (1 - alpha) * current;
    result[i] = current;
  }

  return result;
}

/**
 * Hampel Filter: detects and filters outliers using Median Absolute Deviation (MAD).
 */
export function filterHampelOutliers(
  values: readonly number[],
  windowSize = 7,
  nSigma = 3,
): { filtered: number[]; outlierIndices: number[] } {
  if (values.length === 0) return { filtered: [], outlierIndices: [] };
  const filtered = [...values];
  const outlierIndices: number[] = [];
  const half = Math.floor(windowSize / 2);

  for (let i = 0; i < values.length; i++) {
    const start = Math.max(0, i - half);
    const end = Math.min(values.length, i + half + 1);
    const windowSlice = values.slice(start, end);
    const sorted = [...windowSlice].sort((a, b) => a - b);
    const med = percentile(sorted, 50);

    // Compute MAD
    const diffs = windowSlice.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
    const mad = percentile(diffs, 50);
    const threshold = 1.4826 * nSigma * mad;

    const current = values[i] ?? 0;
    if (Math.abs(current - med) > threshold && threshold > 1e-9) {
      filtered[i] = med;
      outlierIndices.push(i);
    }
  }

  return { filtered, outlierIndices };
}

/**
 * Computes Pearson correlation coefficient between two signals.
 */
export function computeCrossCorrelation(
  signalA: readonly number[],
  signalB: readonly number[],
): SignalCorrelationResult {
  const n = Math.min(signalA.length, signalB.length);
  if (n < 2) {
    return {
      pearsonR: 0,
      sampleCount: n,
      interpretation: "weak",
    };
  }

  let sumA = 0;
  let sumB = 0;
  for (let i = 0; i < n; i++) {
    sumA += signalA[i] ?? 0;
    sumB += signalB[i] ?? 0;
  }

  const meanA = sumA / n;
  const meanB = sumB / n;

  let num = 0;
  let denA = 0;
  let denB = 0;

  for (let i = 0; i < n; i++) {
    const diffA = (signalA[i] ?? 0) - meanA;
    const diffB = (signalB[i] ?? 0) - meanB;
    num += diffA * diffB;
    denA += diffA * diffA;
    denB += diffB * diffB;
  }

  const denom = Math.sqrt(denA * denB);
  const r = denom > 1e-12 ? Math.max(-1, Math.min(1, num / denom)) : 0;

  let interpretation: SignalCorrelationResult["interpretation"];
  if (r >= 0.7) interpretation = "strong_positive";
  else if (r >= 0.3) interpretation = "moderate_positive";
  else if (r <= -0.7) interpretation = "strong_negative";
  else if (r <= -0.3) interpretation = "moderate_negative";
  else interpretation = "weak";

  return {
    pearsonR: Math.round(r * 1000) / 1000,
    sampleCount: n,
    interpretation,
  };
}

/**
 * Inspects a series of measurement samples to detect physical or transport anomalies.
 */
export function detectSignalAnomalies(
  samples: readonly MeasurementSample[],
  options: AnomalyDetectionOptions = {},
): DetectedSignalAnomaly[] {
  if (samples.length === 0) return [];

  const anomalies: DetectedSignalAnomaly[] = [];
  const signal = samples[0]?.signal ?? "unknown";

  const numSamples = samples.filter(
    (s): s is MeasurementSample & { value: number } =>
      typeof s.value === "number" && Number.isFinite(s.value),
  );

  if (numSamples.length < 2) return [];

  const values = numSamples.map((s) => s.value);
  const stats = computeAdvancedStatistics(values);

  // 1. Spike detection using Z-score or Hampel
  const zThresh = options.spikeZScoreThreshold ?? 3.5;
  if (stats && stats.stdDev > 1e-6) {
    for (const sample of numSamples) {
      const z = Math.abs(sample.value - stats.mean) / stats.stdDev;
      if (z > zThresh) {
        anomalies.push({
          kind: "spike",
          signal,
          t: sample.t,
          timestamp: sample.timestamp,
          value: sample.value,
          severity: "warning",
          description: `Sudden spike observed: value ${sample.value} deviates by ${z.toFixed(1)} standard deviations from mean ${stats.mean.toFixed(2)}`,
        });
      }
    }
  }

  // 2. Physical rate of change violation
  if (options.maxRateOfChangePerSec !== undefined) {
    const maxRoc = options.maxRateOfChangePerSec;
    for (let i = 1; i < numSamples.length; i++) {
      const prev = numSamples[i - 1];
      const curr = numSamples[i];
      if (!prev || !curr) continue;
      const dtSec = (curr.t - prev.t) / 1000;
      if (dtSec > 0.001) {
        const roc = Math.abs(curr.value - prev.value) / dtSec;
        if (roc > maxRoc) {
          anomalies.push({
            kind: "rate_of_change",
            signal,
            t: curr.t,
            timestamp: curr.timestamp,
            value: curr.value,
            severity: "critical",
            description: `Physical rate of change violation: ${roc.toFixed(1)}/s exceeds maximum permitted ${maxRoc}/s`,
          });
        }
      }
    }
  }

  // 3. Sensor dropout detection
  if (options.dropoutValue !== undefined) {
    const dropoutVal = options.dropoutValue;
    for (const sample of numSamples) {
      if (Math.abs(sample.value - dropoutVal) < 1e-6) {
        anomalies.push({
          kind: "dropout",
          signal,
          t: sample.t,
          timestamp: sample.timestamp,
          value: sample.value,
          severity: "critical",
          description: `Sensor dropout detected: value plunged to dropout threshold ${dropoutVal}`,
        });
      }
    }
  }

  // 4. Frozen sensor detection (signal stuck over duration)
  const frozenDuration = options.frozenDurationMs ?? 3000;
  const frozenStdDev = options.frozenThresholdStdDev ?? 1e-4;

  const firstSample = numSamples[0];
  const lastSample = numSamples[numSamples.length - 1];
  if (firstSample && lastSample) {
    const firstT = firstSample.t;
    const lastT = lastSample.t;
    if (lastT - firstT >= frozenDuration && stats && stats.stdDev <= frozenStdDev) {
      anomalies.push({
        kind: "frozen",
        signal,
        t: lastT,
        timestamp: lastSample.timestamp,
        value: stats.mean,
        severity: "warning",
        description: `Sensor flatline / frozen reading: stdDev (${stats.stdDev.toFixed(6)}) below sensitivity threshold across ${lastT - firstT}ms`,
      });
    }
  }

  return anomalies;
}
