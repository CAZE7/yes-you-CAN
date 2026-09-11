import assert from "node:assert/strict";
import { genericPackage } from "@vdp/definitions";
import type { DtcRecord } from "@vdp/protocols-uds";
import { test } from "vitest";
import { DtcScanner, DtcTracker } from "../index.js";

function record(code: string, status = 0x08): DtcRecord {
  return {
    code,
    raw: code,
    failureType: "00",
    status,
    statusBits: {
      testFailed: (status & 0x01) !== 0,
      testFailedThisOperationCycle: (status & 0x02) !== 0,
      pendingDtc: (status & 0x04) !== 0,
      confirmedDtc: (status & 0x08) !== 0,
      testNotCompletedSinceLastClear: (status & 0x10) !== 0,
      testFailedSinceLastClear: (status & 0x20) !== 0,
      testNotCompletedThisOperationCycle: (status & 0x40) !== 0,
      warningIndicatorRequested: (status & 0x80) !== 0,
    },
    severity: "major",
  };
}

/** Scanner with a controllable clock, so first/last seen are deterministic. */
function scannerWithClock(times: string[]) {
  let index = 0;
  return new DtcScanner({
    definitions: [genericPackage],
    clock: () => new Date(times[Math.min(index++, times.length - 1)] ?? "2026-01-01T00:00:00.000Z"),
  });
}

test("first and last seen are tracked per ECU and code (AGENTS 20)", () => {
  const scanner = scannerWithClock([
    "2026-01-01T10:00:00.000Z",
    "2026-01-01T10:05:00.000Z",
    "2026-01-01T10:10:00.000Z",
  ]);

  const first = scanner.enrich([record("P0420")], "Engine", "engine");
  assert.equal(first[0]?.firstSeen, "2026-01-01T10:00:00.000Z");
  assert.equal(first[0]?.lastSeen, "2026-01-01T10:00:00.000Z");
  assert.equal(
    first[0]?.firstSeenInThisScan,
    true,
    "the first scan that sees a code reports it as new",
  );

  const second = scanner.enrich([record("P0420"), record("P0300")], "Engine", "engine");
  const catalyst = second.find((dtc) => dtc.code === "P0420");
  const misfire = second.find((dtc) => dtc.code === "P0300");
  assert.equal(catalyst?.firstSeen, "2026-01-01T10:00:00.000Z", "the first sighting must not move");
  assert.equal(catalyst?.firstSeenInThisScan ?? false, false);
  assert.equal(catalyst?.lastSeen, "2026-01-01T10:05:00.000Z");
  assert.equal(
    misfire?.firstSeenInThisScan,
    true,
    "a code that appears later is new even though the ECU was scanned before",
  );

  const third = scanner.enrich([record("P0300")], "Engine", "engine");
  assert.equal(third[0]?.lastSeen, "2026-01-01T10:10:00.000Z");
  // The tracker keeps the history of a code that disappeared — "was present at
  // 10:05, gone at 10:10" is exactly what an operator needs after a repair.
  assert.deepEqual(
    scanner.tracker
      .snapshot()
      .map((entry) => `${entry.ecuId}:${entry.code}:${entry.scans}`)
      .sort(),
    ["engine:P0300:2", "engine:P0420:2"],
  );
});

test("the same code on two ECUs is tracked separately", () => {
  const scanner = scannerWithClock(["2026-01-01T10:00:00.000Z", "2026-01-01T10:01:00.000Z"]);
  scanner.enrich([record("U0100")], "Engine", "engine");
  const other = scanner.enrich([record("U0100")], "ABS", "abs");
  assert.equal(
    other[0]?.firstSeenInThisScan,
    true,
    "a shared code is a different occurrence per ECU",
  );
  assert.equal(scanner.tracker.occurrenceOf("engine", "U0100")?.scans, 1);
  assert.equal(scanner.tracker.occurrenceOf("abs", "U0100")?.scans, 1);
});

test("related signals come from the definition package, with their display names", () => {
  const scanner = scannerWithClock(["2026-01-01T10:00:00.000Z"]);
  const enriched = scanner.enrich([record("P0171")], "Engine", "engine");
  const related = enriched[0]?.relatedSignals ?? [];
  assert.ok(related.length >= 2, "the generic package documents related signals for P0171");
  assert.ok(related.some((entry) => entry.id === "engine.long_term_fuel_trim"));
  assert.ok(
    related.every((entry) => entry.name !== entry.id),
    "a related signal must carry the display name of the package, not just its id",
  );
});

test("a code the package does not document keeps an empty related list", () => {
  const scanner = scannerWithClock(["2026-01-01T10:00:00.000Z"]);
  const enriched = scanner.enrich([record("U9999")], "Unknown ECU", "unknown");
  assert.equal(enriched[0]?.description, undefined, "no invented description (AGENTS 24)");
  assert.equal(enriched[0]?.relatedSignals, undefined);
  assert.equal(enriched[0]?.firstSeen, "2026-01-01T10:00:00.000Z");
});

test("the tracker can be reset between sessions", () => {
  const tracker = new DtcTracker();
  tracker.record("engine", ["P0420"], "2026-01-01T10:00:00.000Z");
  assert.equal(tracker.isNewIn("engine", "P0420"), true);
  tracker.record("engine", ["P0420"], "2026-01-01T10:01:00.000Z");
  assert.equal(tracker.isNewIn("engine", "P0420"), false);
  tracker.reset();
  assert.equal(tracker.occurrenceOf("engine", "P0420"), undefined);
});
