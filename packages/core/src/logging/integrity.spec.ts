import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  createRawTraceManifest,
  hashRawTrace,
  verifyRawTraceManifest,
  withRawTraceManifest,
} from "./integrity.js";
import type { RawTraceEntry } from "./session-logger.js";

function entry(payloadHex: string, t = 10): RawTraceEntry {
  return {
    timestamp: "2026-09-16T00:00:00.000Z",
    t,
    canId: 0x7e8,
    canIdHex: "0x7E8",
    direction: "rx",
    dlc: payloadHex.length / 2,
    payload: Uint8Array.from(payloadHex.match(/../g) ?? [], (b) => Number.parseInt(b, 16)),
    payloadHex,
    channel: "can0",
    extended: false,
    fd: false,
  };
}

describe("raw trace integrity", () => {
  test("is deterministic and independent of presentation formatting", () => {
    const first = entry("62f190");
    const second = {
      ...first,
      timestamp: "another presentation",
      canIdHex: "0x7e8",
      payloadHex: "62F190",
    };
    assert.equal(hashRawTrace([first]), hashRawTrace([second]));
  });

  test("pins the digest so a manifest stays verifiable across runtimes", () => {
    // Computed with node:crypto before the portable hash landed; the value is
    // the contract, not the implementation behind it.
    assert.equal(
      hashRawTrace([entry("62f190")]),
      "070a82e0bc3f124be00254d4bcea1cc95d4f843375551c15cf41f7b53bcac141",
    );
  });

  test("covers extended and CAN-FD frames in the canonical form", () => {
    const frame = {
      ...entry("1122334455667788"),
      canId: 0x1fffffff,
      canIdHex: "0x1FFFFFFF",
      extended: true,
      fd: true,
    };
    const manifest = createRawTraceManifest([frame]);
    assert.equal(verifyRawTraceManifest([frame], manifest), true);
    assert.notEqual(hashRawTrace([frame]), hashRawTrace([entry("1122334455667788")]));
  });

  test("attaches a manifest to a session payload without touching the trace", () => {
    const payload = { trace: [entry("62f190")], note: "untouched" };
    const withManifest = withRawTraceManifest(payload);
    assert.equal(withManifest.note, "untouched");
    assert.equal(withManifest.trace, payload.trace);
    assert.equal(verifyRawTraceManifest(withManifest.trace, withManifest.rawTraceManifest), true);
  });

  test("detects tampering, reordering, and truncation", () => {
    const trace = [entry("1010", 0), entry("2101", 5)];
    const manifest = createRawTraceManifest(trace);
    assert.equal(verifyRawTraceManifest(trace, manifest), true);
    assert.equal(verifyRawTraceManifest([trace[1]!, trace[0]!], manifest), false);
    assert.equal(verifyRawTraceManifest([trace[0]!, entry("2102", 5)], manifest), false);
    assert.equal(verifyRawTraceManifest([trace[0]!], manifest), false);
  });
});
