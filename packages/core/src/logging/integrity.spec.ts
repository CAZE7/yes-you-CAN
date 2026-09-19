/**
 * Raw-trace integrity tests (AGENTS 18, 24; ADR 0047).
 *
 * Two things are pinned here, and they are deliberately different things:
 *
 *  1. the **canonical stream** — the exact text every hasher is fed. It is the
 *     contract between the core and any `IntegrityPort`, so a change to it changes
 *     every digest that was ever stored and has to be visible in a diff;
 *  2. the **port seam** — the core computes no digest itself. Every test below runs
 *     against a deterministic double, which is the proof that no `node:crypto` is
 *     hiding behind the API: a package that needed Node to hash could not be tested
 *     this way. The real SHA-256 is asserted where the implementation lives
 *     (`packages/storage/src/integrity.spec.ts`).
 */

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  type IntegrityPort,
  RAW_TRACE_HASH_ALGORITHM,
  RAW_TRACE_MANIFEST_VERSION,
  type RawTraceManifest,
  canonicalRawTraceChunks,
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

/**
 * A digest double: FNV-1a over the chunks, plus how many chunks it saw. The chunk
 * count is part of the result on purpose — it is what proves the port is fed one
 * length-prefixed line per entry instead of one concatenated blob.
 */
function testPort(tag = "double"): IntegrityPort {
  return {
    algorithm: RAW_TRACE_HASH_ALGORITHM,
    createDigest() {
      let hash = 0x811c9dc5;
      let chunks = 0;
      return {
        update(chunk: string): void {
          chunks += 1;
          for (let i = 0; i < chunk.length; i += 1) {
            hash ^= chunk.charCodeAt(i);
            hash = Math.imul(hash, 0x01000193) >>> 0;
          }
        },
        hex(): string {
          return `${tag}:${chunks}:${hash.toString(16).padStart(8, "0")}`;
        },
      };
    },
  };
}

describe("the canonical stream (the contract every hasher implementation feeds on)", () => {
  test("one length-prefixed line per entry, presentation fields excluded", () => {
    const chunks = Array.from(canonicalRawTraceChunks([entry("62f190")]));
    assert.deepEqual(chunks, ["28:10|2024|rx|3|62f190|can0|0|0\n"]);
  });

  test("extended and FD flags are part of the identity of a frame", () => {
    const classic = Array.from(canonicalRawTraceChunks([entry("0102")]))[0];
    const fd = Array.from(
      canonicalRawTraceChunks([{ ...entry("0102"), fd: true, extended: true }]),
    )[0];
    assert.ok(classic?.endsWith("|0|0\n"), String(classic));
    assert.ok(fd?.endsWith("|1|1\n"), String(fd));
  });

  test("an empty trace hashes to the digest of nothing, not to a sentinel", () => {
    assert.deepEqual(Array.from(canonicalRawTraceChunks([])), []);
    assert.equal(hashRawTrace([], testPort()), "double:0:811c9dc5");
  });
});

describe("raw trace integrity", () => {
  test("is deterministic and independent of presentation formatting", () => {
    const first = entry("62f190");
    const second = {
      ...first,
      timestamp: "another presentation",
      canIdHex: "0x7e8",
      payloadHex: "62F190",
    };
    assert.equal(hashRawTrace([first], testPort()), hashRawTrace([second], testPort()));
  });

  test("the digest changes with every field that defines a frame", () => {
    const base = hashRawTrace([entry("62f190")], testPort());
    const variants: readonly [string, RawTraceEntry][] = [
      ["t", { ...entry("62f190"), t: 11 }],
      ["canId", { ...entry("62f190"), canId: 0x7e9 }],
      ["direction", { ...entry("62f190"), direction: "tx" }],
      ["dlc", { ...entry("62f190"), dlc: 4 }],
      ["payload", entry("62f191")],
      ["channel", { ...entry("62f190"), channel: "can1" }],
    ];
    for (const [name, variant] of variants) {
      assert.notEqual(hashRawTrace([variant], testPort()), base, `${name} must reach the digest`);
    }
  });

  test("every chunk is self-describing: the prefix is the length of what follows", () => {
    // That is what the prefix buys — a value carrying the field separator cannot make
    // a reader guess where the record ends, because the record says so itself.
    const odd = { ...entry("aa"), channel: "can0|with|separators" };
    const chunks = Array.from(canonicalRawTraceChunks([odd, entry("bb")]));
    assert.equal(chunks.length, 2, "one chunk per entry, however the values read");
    for (const chunk of chunks) {
      const colon = chunk.indexOf(":");
      assert.ok(chunk.endsWith("\n"), chunk);
      assert.equal(
        chunk.length - colon - 2,
        Number(chunk.slice(0, colon)),
        `the declared length is the length of the line: ${chunk}`,
      );
    }
  });

  test("detects tampering, reordering, and truncation", () => {
    const trace = [entry("1010", 0), entry("2101", 5)];
    const port = testPort();
    const manifest = createRawTraceManifest(trace, port);
    assert.equal(verifyRawTraceManifest(trace, manifest, port), true);
    assert.equal(verifyRawTraceManifest([trace[1]!, trace[0]!], manifest, port), false);
    assert.equal(verifyRawTraceManifest([trace[0]!, entry("2102", 5)], manifest, port), false);
    assert.equal(verifyRawTraceManifest([trace[0]!], manifest, port), false);
    assert.equal(verifyRawTraceManifest([], manifest, port), false);
  });

  test("the manifest names the algorithm and version it was made with", () => {
    const trace = [entry("1010")];
    const port = testPort();
    const manifest = createRawTraceManifest(trace, port);
    assert.equal(manifest.format, "vdp.raw-trace-manifest");
    assert.equal(manifest.version, RAW_TRACE_MANIFEST_VERSION);
    assert.equal(manifest.algorithm, "sha256", "the port's algorithm, not a restated constant");
    assert.equal(manifest.entries, 1);
    assert.equal(manifest.sha256, hashRawTrace(trace, port));
    assert.deepEqual(
      Object.keys(manifest).sort(),
      ["algorithm", "entries", "format", "sha256", "version"],
      "the manifest is the five fields an export can carry — nothing platform-shaped",
    );
  });

  test("a manifest is refused when any of its own claims is wrong", () => {
    const trace = [entry("1010", 0)];
    const port = testPort();
    const manifest = createRawTraceManifest(trace, port);
    // Manifests are read back from JSON exports, so every field is untrusted input:
    // the check has to be on the data, not on the type.
    const tampered = (patch: Record<string, unknown>): RawTraceManifest =>
      JSON.parse(JSON.stringify({ ...manifest, ...patch })) as RawTraceManifest;
    assert.equal(verifyRawTraceManifest(trace, tampered({ format: "other" }), port), false);
    assert.equal(
      verifyRawTraceManifest(trace, tampered({ version: RAW_TRACE_MANIFEST_VERSION + 1 }), port),
      false,
    );
    assert.equal(verifyRawTraceManifest(trace, tampered({ algorithm: "md5" }), port), false);
    assert.equal(verifyRawTraceManifest(trace, tampered({ entries: 2 }), port), false);
    assert.equal(verifyRawTraceManifest(trace, tampered({ sha256: "0".repeat(64) }), port), false);
  });

  test("a digest from another port implementation is not the same witness", () => {
    const trace = [entry("1010", 0), entry("2101", 5)];
    const manifest = createRawTraceManifest(trace, testPort("first"));
    assert.notEqual(hashRawTrace(trace, testPort("second")), manifest.sha256);
  });

  test("withRawTraceManifest adds the witness and leaves the trace itself alone", () => {
    const trace = [entry("1010", 0), entry("2101", 5)];
    const payload = { format: "vdp.session" as const, trace };
    const port = testPort();
    const withManifest = withRawTraceManifest(payload, port);
    assert.equal(withManifest.trace, trace, "the trace is passed through, not copied or rewritten");
    assert.equal(withManifest.format, "vdp.session");
    assert.deepEqual(withManifest.rawTraceManifest, createRawTraceManifest(trace, port));
    assert.equal(
      verifyRawTraceManifest(withManifest.trace, withManifest.rawTraceManifest, port),
      true,
    );
  });
});
