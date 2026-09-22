/**
 * The one rule for turning a measured number into text.
 *
 * The regression this pins was measured in the workbench, not imagined: running
 * `alternator_failure` on the 5-ECU simulator printed
 * `batteryVoltage < 12 (gelesen 10.770000000000001)`. The check had already been
 * decided numerically — `passed` was `true` — so what leaked was the float format
 * inside a sentence an operator reads.
 */

import { describe, expect, test } from "vitest";
import { formatMeasuredValue } from "./format.js";

describe("formatMeasuredValue — the wording rule for measured numbers", () => {
  test("a double shows two decimals, not its binary seams", () => {
    // The value the simulator scenario actually produced.
    expect(formatMeasuredValue(10.770000000000001)).toBe("10.77");
    expect(formatMeasuredValue(11.5)).toBe("11.50");
    expect(formatMeasuredValue(0.1 + 0.2)).toBe("0.30");
  });

  test("an integer stays an integer — no 3.00 on a count or an identifier", () => {
    expect(formatMeasuredValue(3)).toBe("3");
    expect(formatMeasuredValue(0)).toBe("0");
    expect(formatMeasuredValue(-1)).toBe("-1");
    expect(formatMeasuredValue(2048)).toBe("2048");
  });

  test("negative values keep their sign", () => {
    expect(formatMeasuredValue(-40.5)).toBe("-40.50");
    expect(formatMeasuredValue(-0.004)).toBe("-0.00");
  });

  test("the text is locale-independent, because it is also a CSV cell", () => {
    // `Number.prototype.toFixed` takes no locale by construction (ECMA-262), so there
    // is no separator to leak into an export column — asserted, not assumed, because
    // the same string is pasted into protocol-adjacent prose.
    expect(formatMeasuredValue(1234.5)).toBe("1234.50");
    expect(formatMeasuredValue(1234.5)).not.toContain(",");
    expect(formatMeasuredValue(1234.5)).not.toContain(" ");
  });
});
