/**
 * SignalAnalysisService Unit Tests (Task 5; ADR 0014).
 */

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { createDiagnosticRuntime } from "./runtime.js";

describe("SignalAnalysisService", () => {
  test("analyzes recorded signal samples and computes correlation between signals", async () => {
    const runtime = createDiagnosticRuntime({});

    // Record sample data directly on the engine's recorder
    const recorder = runtime.measurements["engine"].recorder;
    for (let i = 0; i < 20; i++) {
      const t = 1000 + i * 100;
      recorder.record(
        {
          signalId: "engine.speed",
          name: "Engine Speed",
          raw: new Uint8Array([0x03, 0x20]),
          rawHex: "03 20",
          rawValue: 800,
          value: 800 + 50 * Math.sin((2 * Math.PI * i) / 10),
          unit: "rpm",
          outOfRange: false,
          did: 0x0100,
          ecu: "engine",
        },
        t,
      );
      recorder.record(
        {
          signalId: "engine.throttle",
          name: "Throttle Position",
          raw: new Uint8Array([0x0f]),
          rawHex: "0F",
          rawValue: 15,
          value: 15 + 2 * Math.sin((2 * Math.PI * i) / 10),
          unit: "%",
          outOfRange: false,
          did: 0x0101,
          ecu: "engine",
        },
        t,
      );
    }

    const analysis = runtime.signalAnalysis.analyze("engine.speed");
    assert.equal(analysis.signalId, "engine.speed");
    assert.equal(analysis.sampleCount, 20);
    assert.ok(analysis.statistics);
    assert.ok(analysis.statistics.mean > 700);
    assert.ok(analysis.spectrum.frequencies.length > 0);

    const correlation = runtime.signalAnalysis.correlate("engine.speed", "engine.throttle");
    assert.equal(correlation.sampleCount, 20);
    assert.ok(correlation.pearsonR > 0.9, "speed and throttle in phase have high correlation");

    await runtime.dispose();
  });
});
