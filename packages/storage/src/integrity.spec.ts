/**
 * The Node `IntegrityPort` (ADR 0047).
 *
 * This is the only place in the tree where a raw-trace digest is really computed, so
 * the tests here are the ones that pin real SHA-256 values: published vectors for the
 * hash itself, and one golden manifest over a pinned trace. That golden digest is the
 * cross-language anchor — the same canonical stream and the same number have to come
 * out of any other implementation of the port (a browser, a WASM host, the Rust or
 * Haskell reference), which is what makes the manifest portable instead of Node-shaped.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  canonicalRawTraceChunks,
  createRawTraceManifest,
  hashRawTrace,
  RAW_TRACE_HASH_ALGORITHM,
  type RawTraceEntry,
  type RawTraceManifest,
  verifyRawTraceManifest,
} from "@vdp/core";
import { test } from "vitest";
import { nodeIntegrityPort } from "./integrity.js";

function entry(payloadHex: string, t: number): RawTraceEntry {
  return {
    timestamp: new Date(1_700_000_000_000 + t).toISOString(),
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

/** The pinned trace the golden digest below is measured over. */
const GOLDEN_TRACE = [
  { ...entry("1003", 1), direction: "tx" as const, canId: 0x7e0 },
  entry("5003", 2),
  entry("62f19057414d45524943414e", 3),
];

test("the port names the algorithm the core's manifest format requires", () => {
  assert.equal(nodeIntegrityPort.algorithm, RAW_TRACE_HASH_ALGORITHM);
  assert.equal(nodeIntegrityPort.algorithm, "sha256");
});

test("it is SHA-256, measured against published vectors", () => {
  // FIPS 180-4 examples: the empty string and "abc".
  const empty = nodeIntegrityPort.createDigest();
  assert.equal(empty.hex(), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  const abc = nodeIntegrityPort.createDigest();
  abc.update("abc");
  assert.equal(abc.hex(), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("chunks are fed one by one and the result is the digest of their concatenation", () => {
  const chunks = Array.from(canonicalRawTraceChunks(GOLDEN_TRACE));
  assert.equal(chunks.length, GOLDEN_TRACE.length);
  const streamed = nodeIntegrityPort.createDigest();
  for (const chunk of chunks) streamed.update(chunk);
  const atOnce = createHash("sha256").update(chunks.join(""), "utf8").digest("hex");
  assert.equal(streamed.hex(), atOnce, "streaming must not change the digest");
});

test("a UTF-8 channel name reaches the digest as bytes, not as code units", () => {
  const umlaut = [{ ...entry("01", 1), channel: "can°" }];
  const expected = createHash("sha256")
    .update(Array.from(canonicalRawTraceChunks(umlaut)).join(""), "utf8")
    .digest("hex");
  assert.equal(hashRawTrace(umlaut, nodeIntegrityPort), expected);
});

test("the canonical stream, byte for byte — the cross-language anchor", () => {
  // This is the text any other implementation of the port (browser, WASM, the Rust or
  // Haskell reference) has to feed its hash function to arrive at the golden digest.
  assert.deepEqual(Array.from(canonicalRawTraceChunks(GOLDEN_TRACE)), [
    "25:1|2016|tx|2|1003|can0|0|0\n",
    "25:2|2024|rx|2|5003|can0|0|0\n",
    "46:3|2024|rx|12|62f19057414d45524943414e|can0|0|0\n",
  ]);
});

test("the golden manifest: a digest any implementation of the port has to reproduce", () => {
  // Measured over GOLDEN_TRACE with the canonical stream of `@vdp/core`, 2026-09-19.
  // If this number moves, a stored witness stopped verifying — that is a contract
  // change (ADR 0047), not a test to update in passing.
  const golden: RawTraceManifest = {
    format: "vdp.raw-trace-manifest",
    version: 1,
    algorithm: "sha256",
    entries: 3,
    sha256: "8600983efbd90138bc603449abf03aa606f571272451cd2c9df8dd38af748172",
  };
  // ADR 0057: what is created now is v2 — but the digest is the digest of the
  // *trace*, not of the manifest, so the number does not move with the version.
  // What was stored as v1 keeps verifying; what is created now carries the same
  // witness under the version this build writes.
  const created = createRawTraceManifest(GOLDEN_TRACE, nodeIntegrityPort);
  assert.deepEqual(created, { ...golden, version: 2 });
  assert.equal(verifyRawTraceManifest(GOLDEN_TRACE, golden, nodeIntegrityPort), true);
  assert.equal(verifyRawTraceManifest(GOLDEN_TRACE, created, nodeIntegrityPort), true);
  assert.equal(
    verifyRawTraceManifest(GOLDEN_TRACE.slice(0, 2), golden, nodeIntegrityPort),
    false,
    "a truncated trace is not the witness it claims to be",
  );
});
