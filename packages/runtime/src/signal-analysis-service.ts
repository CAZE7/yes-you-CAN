/**
 * Signal analysis runtime service (Task 5; higher-order stats, spectral FFT, anomalies).
 */

export type {
  AdvancedSignalStatistics,
  DetectedSignalAnomaly,
  FrequencySpectrum,
  SignalCorrelationResult,
} from "@vdp/core";

import {
  type AdvancedSignalStatistics,
  computeAdvancedStatistics,
  computeCrossCorrelation,
  computeFft,
  type DetectedSignalAnomaly,
  type DiagnosticEngine,
  detectSignalAnomalies,
  type FrequencySpectrum,
  type MeasurementSample,
  type SignalCorrelationResult,
} from "@vdp/core";

export class SignalAnalysisService {
  constructor(private readonly engine: DiagnosticEngine) {}

  analyze(signalId: string): {
    signalId: string;
    sampleCount: number;
    statistics?: AdvancedSignalStatistics;
    spectrum: FrequencySpectrum;
    anomalies: DetectedSignalAnomaly[];
  } {
    const samples = this.engine.recorder.samplesFor(signalId);
    const numSamples = samples
      .filter(
        (s): s is MeasurementSample & { value: number } =>
          typeof s.value === "number" && Number.isFinite(s.value),
      )
      .map((s) => ({ t: s.t, value: s.value }));
    const statistics = computeAdvancedStatistics(samples);
    const spectrum = computeFft(numSamples);
    const anomalies = detectSignalAnomalies(samples);
    return {
      signalId,
      sampleCount: samples.length,
      ...(statistics !== undefined ? { statistics } : {}),
      spectrum,
      anomalies,
    };
  }

  correlate(signalIdA: string, signalIdB: string): SignalCorrelationResult {
    const samplesA = this.engine.recorder
      .samplesFor(signalIdA)
      .map((s) => (typeof s.value === "number" ? s.value : 0));
    const samplesB = this.engine.recorder
      .samplesFor(signalIdB)
      .map((s) => (typeof s.value === "number" ? s.value : 0));
    return computeCrossCorrelation(samplesA, samplesB);
  }
}
