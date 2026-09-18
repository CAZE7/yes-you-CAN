/**
 * Signal Analysis Engine Unit Tests (Task 5; Master Backlog #15).
 */

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  computeAdvancedStatistics,
  computeCrossCorrelation,
  computeFft,
  detectSignalAnomalies,
  filterExponentialSmoothing,
  filterHampelOutliers,
  filterMovingAverage,
} from "./signal-analysis.js";
import type { MeasurementSample } from "./types.js";

function makeSample(t: number, value: number, signal = "engine.speed"): MeasurementSample {
  return {
    t,
    timestamp: new Date(1700000000000 + t).toISOString(),
    signal,
    value,
    rawValue: value,
    rawHex: value.toString(16),
    outOfRange: false,
  };
}

describe("Signal Analysis: Higher-Order Statistics", () => {
  test("returns undefined for empty input or non-numeric input", () => {
    assert.equal(computeAdvancedStatistics([]), undefined);
    assert.equal(computeAdvancedStatistics([Number.NaN as unknown as number]), undefined);
  });

  test("handles single element dataset", () => {
    const stats = computeAdvancedStatistics([42]);
    assert.ok(stats);
    assert.equal(stats.count, 1);
    assert.equal(stats.min, 42);
    assert.equal(stats.max, 42);
    assert.equal(stats.mean, 42);
    assert.equal(stats.median, 42);
    assert.equal(stats.variance, 0);
    assert.equal(stats.stdDev, 0);
    assert.equal(stats.skewness, 0);
    assert.equal(stats.kurtosis, 0);
  });

  test("computes accurate moments, variance, std dev, and percentiles for skewed dataset", () => {
    // Right-skewed dataset
    const rightSkewed = [1, 2, 2, 3, 3, 3, 4, 10, 20];
    const statsR = computeAdvancedStatistics(rightSkewed);
    assert.ok(statsR);
    assert.ok(statsR.skewness > 0, "Right-skewed dataset must have positive skewness");

    // Left-skewed dataset
    const leftSkewed = [1, 10, 15, 17, 18, 18, 19, 20];
    const statsL = computeAdvancedStatistics(leftSkewed);
    assert.ok(statsL);
    assert.ok(statsL.skewness < 0, "Left-skewed dataset must have negative skewness");
  });

  test("calculates rate of change when samples with t are provided", () => {
    const samples = [
      makeSample(0, 100),
      makeSample(1000, 200), // +100/s
      makeSample(2000, 150), // -50/s
      makeSample(2000, 150), // dt = 0 ignored
    ];
    const stats = computeAdvancedStatistics(samples);
    assert.ok(stats?.rateOfChange);
    assert.equal(stats.rateOfChange.max, 100);
    assert.equal(stats.rateOfChange.min, -50);
    assert.equal(stats.rateOfChange.avg, 75);
  });
});

describe("Signal Analysis: Frequency Domain / FFT", () => {
  test("handles empty input and raw number arrays", () => {
    const empty = computeFft([]);
    assert.equal(empty.dominantFrequency, 0);
    assert.equal(empty.frequencies.length, 0);

    const rawNumbers = [10, 20, 10, 20, 10, 20, 10, 20];
    const spectrum = computeFft(rawNumbers, 10);
    assert.ok(spectrum.frequencies.length > 0);
  });

  test("infers sample rate from timestamps", () => {
    const samples = [
      { t: 0, value: 10 },
      { t: 100, value: 20 },
      { t: 200, value: 10 },
      { t: 300, value: 20 },
    ];
    const spectrum = computeFft(samples);
    assert.ok(spectrum.frequencies.length > 0);
  });

  test("handles all-zero signals and flat DC input in FFT", () => {
    const flatZero = [0, 0, 0, 0, 0, 0, 0, 0];
    const spec = computeFft(flatZero, 10);
    assert.equal(spec.dominantMagnitude, 0);
    assert.equal(spec.snrDb, 0);
  });

  test("handles non-numeric objects and boundary conditions in statistics", () => {
    // Non-numeric items in sample array
    const mixed = [
      makeSample(0, 10),
      { t: 100, value: "not-a-number" } as unknown as MeasurementSample,
      { t: 200, value: undefined } as unknown as MeasurementSample,
      makeSample(300, 20),
    ];
    const stats = computeAdvancedStatistics(mixed);
    assert.ok(stats);
    assert.equal(stats.count, 2);
  });

  test("evaluates anomalies with sub-millisecond timestamps and varying sensors", () => {
    // Two samples at exact same ms (dtSec <= 0.001)
    const sameMsSamples = [
      makeSample(100, 10),
      makeSample(100, 999), // same t!
      makeSample(200, 20),
    ];
    const anomalies = detectSignalAnomalies(sameMsSamples, { maxRateOfChangePerSec: 10 });
    assert.ok(anomalies);

    // Active varying sensor does NOT trigger frozen
    const varying = [
      makeSample(0, 10),
      makeSample(1000, 20),
      makeSample(2000, 30),
      makeSample(3000, 40),
    ];
    const frozenCheck = detectSignalAnomalies(varying, {
      frozenDurationMs: 2000,
      frozenThresholdStdDev: 0.1,
    });
    assert.equal(frozenCheck.filter((a) => a.kind === "frozen").length, 0);
  });

  test("identifies dominant frequency in a synthesized sinusoidal signal", () => {
    const sampleRate = 100;
    const durationSec = 1.0;
    const n = sampleRate * durationSec;
    const samples: { t: number; value: number }[] = [];

    for (let i = 0; i < n; i++) {
      const tSec = i / sampleRate;
      const val = 50 + 10 * Math.sin(2 * Math.PI * 5 * tSec);
      samples.push({ t: tSec * 1000, value: val });
    }

    const spectrum = computeFft(samples, sampleRate);

    assert.ok(spectrum.frequencies.length > 0);
    assert.ok(spectrum.magnitudes.length > 0);
    assert.ok(Math.abs(spectrum.dominantFrequency - 5) <= 1.0);
    assert.ok(spectrum.snrDb > 10, "SNR should clearly detect signal above noise floor");
  });
});

describe("Signal Analysis: Digital Filters", () => {
  test("Moving Average filter smooths out noise and handles boundary conditions", () => {
    assert.deepEqual(filterMovingAverage([]), []);
    assert.deepEqual(filterMovingAverage([1, 2, 3], 1), [1, 2, 3]);

    const noisy = [10, 12, 8, 11, 9, 13, 7];
    const filtered = filterMovingAverage(noisy, 3);
    assert.equal(filtered.length, noisy.length);
    assert.ok(Math.abs(filtered[2]! - 10.33) < 0.1);
  });

  test("Exponential Smoothing handles empty and step response", () => {
    assert.deepEqual(filterExponentialSmoothing([]), []);

    const step = [0, 0, 10, 10, 10, 10];
    const filtered = filterExponentialSmoothing(step, 0.5);
    assert.equal(filtered[0], 0);
    assert.equal(filtered[1], 0);
    assert.equal(filtered[2], 5);
    assert.equal(filtered[3], 7.5);
  });

  test("Hampel Outlier Filter replaces erratic spikes with median", () => {
    assert.deepEqual(filterHampelOutliers([]), { filtered: [], outlierIndices: [] });

    // Clean data without outliers
    const clean = [10, 10, 10, 10, 10];
    const cleanRes = filterHampelOutliers(clean, 5, 3);
    assert.deepEqual(cleanRes.outlierIndices, []);

    const data = [20, 21, 20, 999, 21, 20, 22];
    const { filtered, outlierIndices } = filterHampelOutliers(data, 5, 3);
    assert.deepEqual(outlierIndices, [3]);
    assert.ok(filtered[3]! < 30, "spike replaced by local median");
  });
});

describe("Signal Analysis: Cross-Signal Correlation", () => {
  test("handles short or zero-variance inputs", () => {
    const resShort = computeCrossCorrelation([1], [2]);
    assert.equal(resShort.interpretation, "weak");
    assert.equal(resShort.pearsonR, 0);

    const resFlat = computeCrossCorrelation([5, 5, 5, 5], [1, 2, 3, 4]);
    assert.equal(resFlat.interpretation, "weak");
    assert.equal(resFlat.pearsonR, 0);
  });

  test("computes strong, moderate, and weak correlations", () => {
    // Strong positive
    const pedal = [10, 20, 30, 40, 50, 60, 70];
    const throttle = [12, 22, 31, 41, 51, 62, 71];
    const strongPos = computeCrossCorrelation(pedal, throttle);
    assert.equal(strongPos.interpretation, "strong_positive");

    // Moderate positive
    const modA = [1, 2, 3, 4, 5, 6];
    const modB = [2, 1, 4, 3, 6, 4];
    const modPos = computeCrossCorrelation(modA, modB);
    assert.ok(["moderate_positive", "strong_positive"].includes(modPos.interpretation));

    // Strong negative
    const intakeVacuum = [100, 80, 60, 40, 20];
    const engineLoad = [10, 30, 50, 70, 90];
    const strongNeg = computeCrossCorrelation(intakeVacuum, engineLoad);
    assert.equal(strongNeg.interpretation, "strong_negative");

    // Moderate negative
    const modNegA = [10, 20, 30, 40, 50, 60];
    const modNegB = [50, 60, 30, 40, 10, 20];
    const modNeg = computeCrossCorrelation(modNegA, modNegB);
    assert.ok(["moderate_negative", "strong_negative"].includes(modNeg.interpretation));

    // Weak (orthogonal patterns)
    const weakA = [1, 0, -1, 0, 1, 0, -1, 0];
    const weakB = [0, 1, 0, -1, 0, 1, 0, -1];
    const weak = computeCrossCorrelation(weakA, weakB);
    assert.equal(weak.interpretation, "weak");
    assert.equal(weak.pearsonR, 0);
  });
});

describe("Signal Analysis: Anomaly Detection", () => {
  test("handles empty and single sample input", () => {
    assert.deepEqual(detectSignalAnomalies([]), []);
    assert.deepEqual(detectSignalAnomalies([makeSample(0, 100)]), []);
  });

  test("detects sensor spike, rate of change violation, and flatline frozen sensor", () => {
    const normalSamples = [
      makeSample(0, 90),
      makeSample(1000, 91),
      makeSample(2000, 90),
      makeSample(3000, 90),
      makeSample(4000, 90),
    ];

    // 1. Frozen sensor
    const frozenAnomalies = detectSignalAnomalies(normalSamples, {
      frozenDurationMs: 3000,
      frozenThresholdStdDev: 1.0,
    });
    assert.ok(frozenAnomalies.some((a) => a.kind === "frozen"));

    // 2. Physical Rate of change violation
    const rocSamples = [makeSample(0, 80), makeSample(100, 140)];
    const rocAnomalies = detectSignalAnomalies(rocSamples, {
      maxRateOfChangePerSec: 50,
    });
    assert.ok(rocAnomalies.some((a) => a.kind === "rate_of_change"));

    // 3. Sensor dropout
    const dropoutSamples = [makeSample(0, 14.2), makeSample(500, 0), makeSample(1000, 14.1)];
    const dropAnomalies = detectSignalAnomalies(dropoutSamples, {
      dropoutValue: 0,
    });
    assert.ok(dropAnomalies.some((a) => a.kind === "dropout"));

    // 4. Spike detection with custom threshold
    const spikeSamples = [
      makeSample(0, 10),
      makeSample(100, 10.1),
      makeSample(200, 9.9),
      makeSample(300, 10.0),
      makeSample(400, 50.0), // Spike!
      makeSample(500, 10.1),
    ];
    const spikeAnomalies = detectSignalAnomalies(spikeSamples, {
      spikeZScoreThreshold: 2.0,
    });
    assert.ok(spikeAnomalies.some((a) => a.kind === "spike"));

    // 5. Short duration does not trigger frozen sensor
    const shortSamples = [makeSample(0, 90), makeSample(500, 90)];
    const noFrozen = detectSignalAnomalies(shortSamples, { frozenDurationMs: 3000 });
    assert.equal(noFrozen.length, 0);

    // 6. Zero standard deviation ignores spike detection
    const zeroStdDevSamples = [makeSample(0, 50), makeSample(100, 50)];
    const noSpikes = detectSignalAnomalies(zeroStdDevSamples);
    assert.equal(noSpikes.length, 0);
  });
});

describe("Signal Analysis: Boundary Inputs", () => {
  test("statistics without two finite samples carry no rate of change", () => {
    const stats = computeAdvancedStatistics([
      makeSample(0, 1),
      { ...makeSample(1000, 0), value: Number.NaN },
    ]);
    assert.ok(stats);
    assert.equal(stats.count, 1);
    assert.ok(!("rateOfChange" in stats));
  });

  test("statistics over simultaneous samples carry no rate of change", () => {
    const stats = computeAdvancedStatistics([makeSample(5, 1), makeSample(5, 3)]);
    assert.ok(stats);
    assert.equal(stats.count, 2);
    assert.ok(!("rateOfChange" in stats), "a zero time delta has no rate");
  });

  test("fft over simultaneous timestamps falls back to the default sample rate", () => {
    const spectrum = computeFft([
      { t: 5, value: 1 },
      { t: 5, value: 2 },
      { t: 5, value: 3 },
    ]);
    // 10 Hz default over an 8-point transform: bins sit at multiples of 1.25 Hz.
    assert.equal(spectrum.frequencies[1], 1.25);
  });

  test("fft of a single value is a flat zero spectrum", () => {
    const spectrum = computeFft([5]);
    assert.equal(spectrum.magnitudes.length, 4);
    assert.equal(spectrum.dominantMagnitude, 0);
  });

  test("correlation names the moderate band on both sides", () => {
    const rising = [1, 2, 3, 4, 5, 6, 7, 8];
    const looselyFollowing = [2, 5, 1, 6, 3, 8, 4, 7];
    const positive = computeCrossCorrelation(rising, looselyFollowing);
    assert.ok(positive.pearsonR >= 0.3 && positive.pearsonR < 0.7);
    assert.equal(positive.interpretation, "moderate_positive");

    const looselyOpposing = [5, 8, 3, 7, 2, 6, 1, 4];
    const negative = computeCrossCorrelation(rising, looselyOpposing);
    assert.ok(negative.pearsonR > -0.7 && negative.pearsonR <= -0.3);
    assert.equal(negative.interpretation, "moderate_negative");
  });

  test("a gentle slope within the limit raises no rate-of-change anomaly", () => {
    const ramp = [makeSample(0, 0), makeSample(1000, 1), makeSample(2000, 2), makeSample(3000, 3)];
    assert.deepEqual(detectSignalAnomalies(ramp, { maxRateOfChangePerSec: 10 }), []);
  });
});
