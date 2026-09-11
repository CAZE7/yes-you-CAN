/**
 * Session comparison tests (AGENTS 30).
 *
 * The comparison must never *infer*: a signal missing on one side is
 * added/removed, noise stays inside the tolerance, and critical metadata
 * differences are reported loudly instead of being mixed into the deltas.
 */

import assert from "node:assert/strict";
import type { DtcRecord } from "@vdp/protocols-uds";
import { describe, expect, test } from "vitest";
import type { MeasurementSample } from "../measurements/types.js";
import { type SessionComparisonSide, compareSessions } from "./compare.js";

function sample(
  signal: string,
  value: number | string,
  overrides: Partial<MeasurementSample> = {},
): MeasurementSample {
  return {
    timestamp: "2026-09-11T08:00:00.000Z",
    t: 0,
    signal,
    // String values model textual signals (door states etc.) — the wire type is
    // numeric, so the cast lives here and not at every call site.
    value: value as number,
    rawValue: value as number,
    rawHex: "00",
    outOfRange: false,
    ...overrides,
  };
}

const ALL_STATUS_BITS = {
  testFailed: false,
  testFailedThisOperationCycle: false,
  pendingDtc: false,
  confirmedDtc: false,
  testNotCompletedSinceLastClear: false,
  testFailedSinceLastClear: false,
  testNotCompletedThisOperationCycle: false,
  warningIndicatorRequested: false,
};

function dtc(code: string, status: number): DtcRecord {
  return {
    code,
    raw: code,
    failureType: "00",
    status,
    statusBits: { ...ALL_STATUS_BITS },
    severity: "info",
  };
}

function side(overrides: Partial<SessionComparisonSide> = {}): SessionComparisonSide {
  return {
    id: "s1",
    label: "vorher",
    vehicle: "Golf 8",
    vin: "1HGCM82633A004352",
    adapter: "ELM327",
    definitionPackage: { oem: "generic", version: "1.0.0" },
    dtcs: [],
    samples: [],
    ...overrides,
  };
}

describe("metadata comparison", () => {
  test("identical sessions have no critical findings", () => {
    const result = compareSessions(side(), side({ id: "s2", label: "nachher" }));
    assert.deepEqual(result.critical, []);
    assert.ok(result.metadata.every((entry) => entry.same));
  });

  test("a different VIN is critical and lands in the summary", () => {
    const result = compareSessions(
      side(),
      side({ id: "s2", label: "nachher", vin: "1HGCM82633A004353" }),
    );
    assert.equal(result.critical.length, 1);
    assert.equal(result.critical[0]?.field, "vin");
    assert.ok(
      result.summary.some((line) => line.includes("VIN")),
      "the summary must warn loudly",
    );
  });

  test("a definition package change is critical, an adapter change is not", () => {
    const result = compareSessions(
      side(),
      side({
        id: "s2",
        label: "nachher",
        definitionPackage: { oem: "generic", version: "2.0.0" },
        adapter: "SocketCAN",
      }),
    );
    assert.deepEqual(
      result.critical.map((entry) => entry.field),
      ["definitionPackage"],
    );
    const adapter = result.metadata.find((entry) => entry.field === "adapter");
    assert.equal(adapter?.same, false);
    assert.equal(adapter?.critical, false);
  });

  test("missing optional fields compare as null on both sides, not as a difference", () => {
    const bare = side({ startedAt: undefined, adapter: undefined });
    const result = compareSessions(bare, bare);
    assert.ok(result.metadata.every((entry) => entry.same));
  });
});

describe("fault code comparison", () => {
  test("added, removed and status-changed codes are each classified", () => {
    const result = compareSessions(
      side({ dtcs: [dtc("P0420", 0x08), dtc("P0301", 0x02), dtc("B1000", 0x09)] }),
      side({ id: "s2", label: "nachher", dtcs: [dtc("P0301", 0x09), dtc("U0155", 0x08)] }),
    );
    const kinds = new Map(result.dtcs.map((entry) => [entry.code, entry.kind]));
    assert.equal(kinds.get("P0420"), "removed");
    assert.equal(kinds.get("U0155"), "added");
    assert.equal(kinds.get("P0301"), "status-changed");
    assert.ok(result.summary.some((line) => line.includes("P0420")));
    assert.ok(result.summary.some((line) => line.includes("U0155")));
    assert.ok(result.summary.some((line) => line.includes("Status geändert")));
  });

  test("an unchanged fault memory is reported as such", () => {
    const result = compareSessions(
      side({ dtcs: [dtc("P0420", 0x08)] }),
      side({ id: "s2", label: "nachher", dtcs: [dtc("P0420", 0x08)] }),
    );
    assert.deepEqual(result.dtcs, []);
    assert.ok(result.summary.some((line) => line.includes("Fehlerspeicher unverändert")));
  });
});

describe("signal comparison", () => {
  test("a signal only present on one side is added/removed — never compared as 0", () => {
    const result = compareSessions(
      side({ samples: [sample("engine.rpm", 2000)] }),
      side({ id: "s2", label: "nachher", samples: [sample("engine.coolant", 90)] }),
    );
    const verdicts = new Map(result.signals.map((entry) => [entry.signal, entry.verdict]));
    assert.equal(verdicts.get("engine.rpm"), "removed");
    assert.equal(verdicts.get("engine.coolant"), "added");
  });

  test("property: within the tolerance everything is stable, beyond it changed", () => {
    expect(
      compareSessions(
        side({ samples: [sample("engine.rpm", 2000)] }),
        side({ id: "s2", label: "nachher", samples: [sample("engine.rpm", 2040)] }),
      ).signals[0]?.verdict,
    ).toBe("stable");
    expect(
      compareSessions(
        side({ samples: [sample("engine.rpm", 2000)] }),
        side({ id: "s2", label: "nachher", samples: [sample("engine.rpm", 2400)] }),
      ).signals[0]?.verdict,
    ).toBe("changed");
  });

  test("a 0 baseline has no defined relative change and is flagged, tolerance cannot hide it", () => {
    const left = side({ samples: [sample("engine.egr", 0)] });
    const right = side({ id: "s2", label: "nachher", samples: [sample("engine.egr", 500)] });
    const result = compareSessions(left, right, { changeTolerancePercent: 1000 });
    assert.equal(result.signals[0]?.verdict, "changed");
    assert.match(result.signals[0]?.reason ?? "", /Ausgangswert 0/);
  });

  test("signals without numeric values on either side are stable with an explicit reason", () => {
    const result = compareSessions(
      side({ samples: [sample("door.state", "closed")] }),
      side({ id: "s2", label: "nachher", samples: [sample("door.state", "open")] }),
    );
    assert.equal(result.signals[0]?.verdict, "stable");
    assert.match(result.signals[0]?.reason ?? "", /keine numerischen/);
  });

  test("signalIds restricts the comparison and deltas are right - left", () => {
    const result = compareSessions(
      side({ samples: [sample("engine.rpm", 2000), sample("engine.coolant", 80)] }),
      side({
        id: "s2",
        label: "nachher",
        samples: [sample("engine.rpm", 2100), sample("engine.coolant", 90)],
      }),
      { signalIds: ["engine.rpm"] },
    );
    assert.deepEqual(
      result.signals.map((entry) => entry.signal),
      ["engine.rpm"],
    );
    assert.equal(result.signals[0]?.delta.average, 100);
  });

  test("changed signals are listed in the summary by name", () => {
    const result = compareSessions(
      side({ samples: [sample("engine.rpm", 800)] }),
      side({ id: "s2", label: "nachher", samples: [sample("engine.rpm", 4000)] }),
    );
    assert.ok(result.summary.some((line) => line.includes("engine.rpm")));
  });
});
