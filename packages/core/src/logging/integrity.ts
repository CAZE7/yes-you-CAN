/**
 * Cryptographic provenance for raw diagnostic recordings.
 *
 * A decoder must never be the only witness for a diagnosis. This module hashes the
 * lossless raw CAN/UDS trace before projection and produces a small, portable manifest
 * that can be stored next to a session export. Hashing is deliberately based on a
 * canonical representation, not JSON.stringify of Uint8Array objects, and on the
 * dependency-free SHA-256 in `@vdp/shared` instead of `node:crypto` — so the same
 * recording has the same digest in Node, a replay worker, and an export pipeline,
 * and this portable layer imports no `node:` builtin (architecture.yaml).
 */

import { sha256HexUtf8 } from "@vdp/shared";
import type { RawTraceEntry } from "./session-logger.js";

export const RAW_TRACE_HASH_ALGORITHM = "sha256" as const;
export const RAW_TRACE_MANIFEST_VERSION = 1 as const;

export interface RawTraceManifest {
  format: "vdp.raw-trace-manifest";
  version: typeof RAW_TRACE_MANIFEST_VERSION;
  algorithm: typeof RAW_TRACE_HASH_ALGORITHM;
  /** Number of entries covered by the digest. */
  entries: number;
  /** Digest of the canonical raw trace, lowercase hexadecimal. */
  sha256: string;
}

/** Fields that define a raw frame. Presentation fields (ISO timestamps and hex ids)
 * are excluded because they are derived and may be formatted differently by exports. */
function canonicalEntry(entry: RawTraceEntry): string {
  return [
    entry.t,
    entry.canId,
    entry.direction,
    entry.dlc,
    entry.payloadHex.toLowerCase(),
    entry.channel,
    entry.extended ? 1 : 0,
    entry.fd ? 1 : 0,
  ].join("|");
}

/** Return the stable SHA-256 digest for an ordered raw trace. */
export function hashRawTrace(entries: readonly RawTraceEntry[]): string {
  // Length-prefix each record so separators cannot create an ambiguous stream.
  // Hashing the joined stream equals feeding each line to `hash.update`: SHA-256
  // is a Merkle–Damgård hash, so the digest only sees the concatenated bytes.
  const stream = entries
    .map((entry) => {
      const line = canonicalEntry(entry);
      return `${line.length}:${line}\n`;
    })
    .join("");
  return sha256HexUtf8(stream);
}

/** Create the manifest that travels with a raw recording. */
export function createRawTraceManifest(entries: readonly RawTraceEntry[]): RawTraceManifest {
  return {
    format: "vdp.raw-trace-manifest",
    version: RAW_TRACE_MANIFEST_VERSION,
    algorithm: RAW_TRACE_HASH_ALGORITHM,
    entries: entries.length,
    sha256: hashRawTrace(entries),
  };
}

/** Verify both the digest and the covered entry count. Never throws for bad input. */
export function verifyRawTraceManifest(
  entries: readonly RawTraceEntry[],
  manifest: RawTraceManifest,
): boolean {
  return (
    manifest.format === "vdp.raw-trace-manifest" &&
    manifest.version === RAW_TRACE_MANIFEST_VERSION &&
    manifest.algorithm === RAW_TRACE_HASH_ALGORITHM &&
    manifest.entries === entries.length &&
    manifest.sha256 === hashRawTrace(entries)
  );
}

/** Add a manifest to a session JSON payload without changing the raw trace itself. */
export function withRawTraceManifest<T extends { trace: readonly RawTraceEntry[] }>(
  payload: T,
): T & { rawTraceManifest: RawTraceManifest } {
  return { ...payload, rawTraceManifest: createRawTraceManifest(payload.trace) };
}
