/**
 * Id generation (AGENTS 34.8: everything is testable, ids included).
 *
 * Ids appear in sessions, ECU records, actions, notes and DTC snapshots, and the
 * clock is injectable precisely so a test can pin the result down. What has to
 * hold is: the id is readable, it carries the time it was created, it does not
 * repeat while ids are minted for the same millisecond, and the documented bound
 * of that scheme — a 16 bit rolling counter — is honoured.
 */

import assert from "node:assert/strict";
import fc from "fast-check";
import { describe, test } from "vitest";
import { createId, nowIso, systemClock } from "./ids.js";

/** Splits `prefix_time_counter` into its parts. */
function partsOf(id: string): { prefix: string; time: number; counter: number } {
  const [prefix = "", time = "", counter = ""] = id.split("_");
  return { prefix, time: Number.parseInt(time, 36), counter: Number.parseInt(counter, 36) };
}

describe("createId", () => {
  test('the default prefix is "id" and the shape is prefix_time_counter', () => {
    assert.match(
      createId(undefined, () => 0),
      /^id_0_[0-9a-z]+$/,
    );
  });

  test("the clock is embedded in base 36, so the creation time can be read back", () => {
    const at = Date.UTC(2026, 8, 11, 7, 30, 15);
    const { prefix, time } = partsOf(createId("session", () => at));
    assert.equal(prefix, "session");
    assert.equal(time, at, "the timestamp round trips through the id");
  });

  test("two ids from the same millisecond differ by the counter alone", () => {
    const frozen = (): number => 1_700_000_000_000;
    const first = createId("ecu", frozen);
    const second = createId("ecu", frozen);
    assert.notEqual(first, second);
    assert.equal(
      partsOf(second).counter - partsOf(first).counter,
      1,
      "the counter advances by one per id",
    );
    assert.equal(partsOf(first).time, partsOf(second).time);
  });

  test("the prefix may contain underscores; the two id parts stay at the end", () => {
    const prefix = "dtc_snapshot";
    const id = createId(prefix, () => 5);
    assert.ok(id.startsWith(`${prefix}_`), id);
    const [time, counter, ...rest] = id.slice(prefix.length + 1).split("_");
    assert.equal(rest.length, 0, "everything after the prefix is time and counter");
    assert.equal(time, (5).toString(36));
    assert.match(counter ?? "", /^[0-9a-z]+$/);
  });

  test("ids are unique inside one clock tick and the counter advances by one", () => {
    const count = 5_000;
    const ids = new Set<string>();
    let previous: number | undefined;
    for (let i = 0; i < count; i++) {
      const id = createId("burst", () => 42);
      ids.add(id);
      const { counter } = partsOf(id);
      if (previous !== undefined) {
        // Wrap-safe: modulo the period every step is exactly one, across the rollover too.
        assert.equal(
          (counter - previous + 0xffff) % 0xffff,
          1,
          "the counter advances by one per id",
        );
      }
      previous = counter;
    }
    assert.equal(ids.size, count, "a frozen clock leaves the counter as the only differentiator");
  });

  test("the counter rolls over at 0xffff — the documented bound of a frozen clock", () => {
    const first = createId("wrap", () => 7);
    // The counter cycles with a period of 0xffff, so after a whole cycle the same
    // id comes out again. Acceptable for a diagnostics session (no session mints
    // 65k ids inside one millisecond) and asserted here so the bound is visible.
    for (let i = 0; i < 0xffff - 1; i++) createId("wrap", () => 7);
    assert.equal(
      createId("wrap", () => 7),
      first,
      "the counter restarts after a full cycle",
    );
  });

  test("an advancing clock keeps ids apart across the rollover", () => {
    const seen = new Set<string>();
    let at = 0;
    for (let i = 0; i < 0xffff + 10; i++) seen.add(createId("tick", () => ++at));
    assert.equal(seen.size, 0xffff + 10, "time plus counter never repeats while the clock moves");
  });

  test("property: every generated id is unique and carries prefix and clock", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("session", "ecu", "act", "note", "dtc", "trace"),
        fc.nat({ max: 1e12 }),
        fc.integer({ min: 1, max: 20 }),
        (prefix, at, count) => {
          const ids = Array.from({ length: count }, () => createId(prefix, () => at));
          assert.equal(new Set(ids).size, count);
          for (const id of ids) {
            assert.ok(id.startsWith(`${prefix}_`), id);
            assert.equal(partsOf(id).time, at, "the injected clock is the one that is encoded");
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  test("the system clock is the default and its value is embedded", () => {
    const before = Date.now();
    const { time } = partsOf(createId("live"));
    const after = Date.now();
    assert.ok(time >= before && time <= after, `embedded ${time} not in [${before}, ${after}]`);
    assert.equal(typeof systemClock(), "number");
  });
});

describe("nowIso", () => {
  test("the injected clock decides the timestamp, in UTC with milliseconds", () => {
    assert.equal(
      nowIso(() => Date.UTC(2026, 0, 2, 3, 4, 5, 678)),
      "2026-01-02T03:04:05.678Z",
    );
  });

  test("epoch 0 is a date, not an empty string", () => {
    assert.equal(
      nowIso(() => 0),
      "1970-01-01T00:00:00.000Z",
    );
  });

  test("the default clock is the wall clock", () => {
    const at = Date.now();
    assert.ok(new Date(nowIso()).getTime() >= at);
  });
});
