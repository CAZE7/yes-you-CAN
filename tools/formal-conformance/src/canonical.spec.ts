import assert from "node:assert/strict";
import { describe, test } from "vitest";
import type { IsoTpFrame } from "./canonical.js";
import {
  FrameError,
  canonicalJson,
  decodeCapturedFrames,
  decodeFrame,
  diffPaths,
  encodeFrame,
} from "./canonical.js";

describe("canonical frame codec", () => {
  test("single frames round trip through the codec, declared length first", () => {
    const frame: IsoTpFrame = { pci: "single", payload: [0x22, 0xf1, 0x90] };
    const bytes = encodeFrame(frame);
    assert.deepEqual(bytes, [3, 0x22, 0xf1, 0x90]);
    assert.deepEqual(decodeFrame(bytes), frame);
  });

  test("first frames carry the 12-bit length across the PCI boundary", () => {
    const frame: IsoTpFrame = { pci: "first", totalLength: 4095, payload: [1, 2, 3, 4, 5, 6] };
    const bytes = encodeFrame(frame);
    assert.equal(bytes[0], 0x10 | (4095 >> 8));
    assert.equal(bytes[1], 4095 & 0xff);
    assert.deepEqual(decodeFrame(bytes), { ...frame });
  });

  test("a single-frame length in a first frame is a codec refusal, never a truncation", () => {
    assert.throws(() => encodeFrame({ pci: "first", totalLength: 7, payload: [1] }), FrameError);
    assert.equal(decodeFrame([0x10, 0x07, 1, 2]), null);
  });

  test("escape forms are outside the modelled codec", () => {
    assert.throws(() => encodeFrame({ pci: "first", totalLength: 4096, payload: [1] }), FrameError);
    // A single frame with no data would need the FD escape form: refused.
    assert.throws(() => encodeFrame({ pci: "single", payload: [] }), FrameError);
    assert.equal(decodeFrame([0x10, 0x00, 0, 0, 0x10, 0]), null);
  });

  test("sequence numbers survive the wrap at 16", () => {
    const bytes = encodeFrame({ pci: "consecutive", sn: 0, payload: [9] });
    assert.equal(bytes[0], 0x20);
    assert.throws(
      () => encodeFrame({ pci: "consecutive", sn: 16, payload: [9] } as never),
      FrameError,
    );
  });

  test("flow control frames round trip status, block size and STmin", () => {
    const bytes = encodeFrame({ pci: "flow-control", status: 1, blockSize: 8, stMin: 20 });
    assert.deepEqual(bytes, [0x31, 8, 20]);
    assert.deepEqual(decodeFrame(bytes), {
      pci: "flow-control",
      status: 1,
      blockSize: 8,
      stMin: 20,
    });
  });

  test("unknown PCIs decode to null instead of guessing", () => {
    assert.equal(decodeFrame([]), null);
    assert.equal(decodeFrame([0x40, 1, 2, 3]), null);
  });

  test("captured-frame decoding refuses a frame the codec cannot name", () => {
    assert.deepEqual(decodeCapturedFrames([[0x30, 0, 0]]), [
      { pci: "flow-control", status: 0, blockSize: 0, stMin: 0 },
    ]);
    assert.throws(() => decodeCapturedFrames([[0x40, 1]]), /unknown PCI/);
  });
});

describe("canonical result comparison", () => {
  test("canonicalJson removes key order, not meaning", () => {
    const a = canonicalJson({ b: 1, a: [1, { d: 2, c: 3 }] });
    const b = canonicalJson({ a: [1, { c: 3, d: 2 }], b: 1 });
    assert.equal(a, b);
  });

  test("diffPaths names each field that moved", () => {
    const paths = diffPaths(
      { ok: true, counters: { seq: 0, to: 1 }, frames: [[1, 2], [3]] },
      { ok: false, counters: { seq: 0, to: 2 }, frames: [[1, 2]] },
    );
    assert.deepEqual(paths, ["counters.to", "frames[1]", "ok"]);
  });

  test("arrays of unequal length report the surplus entries", () => {
    assert.deepEqual(diffPaths({ xs: [1, 2] }, { xs: [1] }), ["xs[1]"]);
    assert.deepEqual(diffPaths({ xs: [1] }, { xs: [1, 2] }), ["xs[1]"]);
  });
});
