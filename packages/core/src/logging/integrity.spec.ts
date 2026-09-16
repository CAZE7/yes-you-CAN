import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  createRawTraceManifest,
  hashRawTrace,
  verifyRawTraceManifest,
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
    const second = { ...first, timestamp: "another presentation", canIdHex: "0x7e8", payloadHex: "62F190" };
    assert.equal(hashRawTrace([first]), hashRawTrace([second]));
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
