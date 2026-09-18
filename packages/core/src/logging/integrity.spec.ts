import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  type RawTraceManifest,
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

/**
 * Measured with `createHash("sha256")` over the canonical record stream of the two
 * entries below, on the implementation that hashed through `node:crypto` (before
 * ADR 0044 moved the digest into `@vdp/shared`). It is written here as a constant on
 * purpose: a manifest already stored in a session export must keep verifying after
 * the primitive moved, and only a value that does not come from this code proves it.
 */
const REFERENCE_DIGEST = "10c7b70ea301273a43b1653c9d6a252dfac044b5fc5cad687c6a6bf466ab263e";

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

  test("keeps the digest an already stored manifest carries", () => {
    const trace = [entry("62f190"), entry("1001", 0)];
    assert.equal(hashRawTrace(trace), REFERENCE_DIGEST);
    assert.equal(createRawTraceManifest(trace).sha256, REFERENCE_DIGEST);
  });

  test("detects tampering, reordering, and truncation", () => {
    const trace = [entry("1010", 0), entry("2101", 5)];
    const manifest = createRawTraceManifest(trace);
    assert.equal(verifyRawTraceManifest(trace, manifest), true);
    assert.equal(verifyRawTraceManifest([trace[1]!, trace[0]!], manifest), false);
    assert.equal(verifyRawTraceManifest([trace[0]!, entry("2102", 5)], manifest), false);
    assert.equal(verifyRawTraceManifest([trace[0]!], manifest), false);
  });

  test("hashes the wire format itself, not only the payload", () => {
    // `extended` and `fd` are the two bits a reader cannot recover from the payload
    // bytes. A trace replayed in the wrong frame format is a different recording, so
    // the digest has to change with them — otherwise the manifest would vouch for
    // bytes that the decoder never got back.
    const plain = entry("62f190");
    const digest = hashRawTrace([plain]);
    assert.notEqual(hashRawTrace([{ ...plain, extended: true }]), digest);
    assert.notEqual(hashRawTrace([{ ...plain, fd: true }]), digest);
    assert.notEqual(hashRawTrace([{ ...plain, channel: "vcan1" }]), digest);
    assert.notEqual(hashRawTrace([{ ...plain, dlc: 8 }]), digest);
  });

  test("refuses a manifest that is not this manifest format", () => {
    const trace = [entry("62f190")];
    const manifest = createRawTraceManifest(trace);
    // Every field is a claim the reader has to be able to distrust. `Object.assign`
    // is deliberate: a manifest arrives from a file, where the declared literal type
    // is worth nothing — the value is what the file held.
    const foreign = <K extends keyof RawTraceManifest>(key: K, value: unknown): RawTraceManifest =>
      Object.assign({}, manifest, { [key]: value });
    assert.equal(verifyRawTraceManifest(trace, foreign("format", "vdp.can-trace-manifest")), false);
    assert.equal(verifyRawTraceManifest(trace, foreign("version", 2)), false);
    assert.equal(verifyRawTraceManifest(trace, foreign("algorithm", "sha512")), false);
    assert.equal(verifyRawTraceManifest(trace, foreign("entries", 0)), false);
    assert.equal(verifyRawTraceManifest(trace, foreign("sha256", "0".repeat(64))), false);
    assert.equal(verifyRawTraceManifest(trace, foreign("format", "vdp.raw-trace-manifest")), true);
  });
});
