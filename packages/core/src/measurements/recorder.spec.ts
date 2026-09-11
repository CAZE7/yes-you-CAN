/**
 * MeasurementRecorder tests (AGENTS 15-17, 16).
 *
 * The recorder is the lossless memory of a session: raw and decoded values stay
 * separate, timestamps are injectable, and the merged view is sorted on the
 * shared time axis.
 */

import assert from "node:assert/strict";
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import type { DecodedSignal } from "./decoder.js";
import { MeasurementRecorder } from "./recorder.js";

function decoded(overrides: Partial<DecodedSignal> = {}): DecodedSignal {
  return {
    signalId: "engine.rpm",
    name: "Engine speed",
    raw: new Uint8Array([0x09, 0x60]),
    rawHex: "09 60",
    rawValue: 2400,
    value: 2400,
    unit: "rpm",
    outOfRange: false,
    did: 0x0c,
    ecu: "engine",
    ...overrides,
  };
}

describe("recording", () => {
  test("samples keep raw and decoded values separate (AGENTS 34.7)", () => {
    const recorder = new MeasurementRecorder(() => 1000);
    const sample = recorder.record(decoded({ value: 2400, rawValue: 2400, rawHex: "09 60" }));
    assert.equal(sample.value, 2400);
    assert.equal(sample.rawValue, 2400);
    assert.equal(sample.rawHex, "09 60");
    assert.equal(sample.t, 0, "the first sample starts the time axis");
  });

  test("t is relative to recorder start with an injectable clock", () => {
    let now = 1000;
    const recorder = new MeasurementRecorder(() => now);
    recorder.record(decoded(), now);
    now = 1500;
    const second = recorder.record(decoded(), now);
    assert.equal(second.t, 500);
    assert.equal(recorder.length, 2);
    assert.equal(recorder.startedAtMs, 1000);
  });

  test("recordRaw stores the hex form as both value and raw", () => {
    let now = 1000;
    const recorder = new MeasurementRecorder(() => now);
    now = 1250;
    recorder.recordRaw("vin.raw", "VIN (raw)", new Uint8Array([0x57, 0x56, 0x57]), now);
    const sample = recorder.samplesFor("vin.raw")[0] as ReturnType<MeasurementRecorder["record"]>;
    assert.equal(sample.value, "57 56 57");
    assert.equal(sample.rawValue, "57 56 57");
    assert.equal(sample.t, 250);
  });

  test("markers are sequenced, optionally detailed, and exported", () => {
    const recorder = new MeasurementRecorder(() => 5000);
    const marker = recorder.addMarker("Key ON", "user", "ignition detected", 5100);
    assert.equal(marker.id, "marker_1");
    assert.equal(recorder.addMarker("Scan", "note", undefined, 5200).id, "marker_2");
    const second = recorder.export().markers[1];
    assert.equal(second?.id, "marker_2");
    assert.equal(second?.label, "Scan");
    assert.equal(second?.kind, "note");
    assert.equal(second?.t, 200);
    assert.equal("detail" in (second ?? {}), false);
  });

  test("export() copies: mutating the export does not mutate the recording", () => {
    const recorder = new MeasurementRecorder(() => 1000);
    recorder.record(decoded());
    const exported = recorder.export();
    (exported.samples as unknown as unknown[]).length = 0;
    assert.equal(recorder.length, 1);
  });
});

describe("queries", () => {
  test("signalIds, samplesFor and the window filter", () => {
    const recorder = new MeasurementRecorder(() => 1000);
    recorder.record(decoded(), 1000);
    recorder.record(
      decoded({
        signalId: "engine.coolant",
        name: "Coolant",
        unit: "°C",
        value: 90,
        rawValue: 90,
        rawHex: "5A",
      }),
      2000,
    );
    recorder.record(decoded(), 3000);
    assert.deepEqual(recorder.signalIds(), ["engine.rpm", "engine.coolant"]);
    assert.equal(recorder.samplesFor("engine.rpm").length, 2);
    assert.equal(recorder.samplesFor("engine.rpm", { fromT: 500, toT: 2500 }).length, 1);
  });

  test("merged() interleaves signals sorted on the shared time axis (AGENTS 16)", () => {
    const recorder = new MeasurementRecorder(() => 1000);
    recorder.record(decoded(), 2000);
    recorder.record(decoded({ signalId: "engine.coolant" }), 1500);
    recorder.record(decoded(), 1800);
    const merged = recorder.merged(["engine.rpm", "engine.coolant"]);
    assert.deepEqual(
      merged.map((s) => s.t),
      [500, 800, 1000],
    );
  });

  test("statistics use the recorded names and units", () => {
    const recorder = new MeasurementRecorder(() => 1000);
    recorder.record(decoded(), 1000);
    recorder.record(decoded({ value: 2600, rawValue: 2600 }), 2000);
    const stats = recorder.statistics("engine.rpm");
    assert.equal(stats.name, "Engine speed");
    assert.equal(stats.unit, "rpm");
    assert.equal(stats.samples, 2);
    assert.equal(stats.delta, 200);
  });

  test("anomalies flag out-of-range samples and extreme deltas", () => {
    let now = 1000;
    const recorder = new MeasurementRecorder(() => now);
    for (let i = 0; i < 10; i++) {
      now += 100;
      recorder.record(decoded({ signalId: "engine.rpm", value: 2000, rawValue: 2000 }), now);
    }
    recorder.record(
      decoded({
        signalId: "engine.coolant",
        name: "Coolant",
        value: 250,
        rawValue: 250,
        outOfRange: true,
      }),
      now + 50,
    );
    recorder.record(
      decoded({
        signalId: "engine.coolant",
        name: "Coolant",
        value: 90,
        rawValue: 90,
        outOfRange: false,
      }),
      now + 60,
    );
    const anomalies = recorder.anomalies();
    assert.ok(
      anomalies.some(
        (entry) =>
          entry.signal === "engine.coolant" && entry.reason.includes("outside the declared range"),
      ),
    );
  });
});

describe("anomaly properties", () => {
  test("property: a flat recording produces no anomalies regardless of length", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 60 }), (count) => {
        const recorder = new MeasurementRecorder(() => 1000);
        for (let i = 0; i < count; i++)
          recorder.record(decoded({ value: 2000, rawValue: 2000 }), 1000 + i);
        expect(recorder.anomalies()).toEqual([]);
      }),
    );
  });
});
