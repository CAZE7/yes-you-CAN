/**
 * Cryptographic provenance for raw diagnostic recordings.
 *
 * A decoder must never be the only witness for a diagnosis. This module hashes the
 * lossless raw CAN/UDS trace before projection and produces a small, portable manifest
 * that can be stored next to a session export. Hashing is deliberately based on a
 * canonical representation, not JSON.stringify of Uint8Array objects, so the same
 * recording has the same digest in Node, a replay worker, and an export pipeline.
 *
 * The digest itself is the portable `sha256Hex` primitive of `@vdp/shared` — this layer
 * stays free of `node:` builtins (AGENTS 28, `architecture/architecture.yaml` →
 * `rules.nodeBuiltins`), and `node:crypto` is a builtin; ADR 0044 records why the
 * primitive sits in the foundation package instead of a dependency here. The canonical
 * stream is byte-for-byte the one `createHash("sha256")` used to receive, so a manifest
 * written before that switch still verifies (pinned in `integrity.spec.ts`).
 */

import { sha256Hex } from "@vdp/shared";
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

/** The one record format the digest covers: length-prefixed, so separators cannot
 * create an ambiguous stream (a `|` inside a channel name changes no boundary). */
function canonicalRecord(entry: RawTraceEntry): string {
  const line = canonicalEntry(entry);
  return `${line.length}:${line}\n`;
}

/** Return the stable SHA-256 digest for an ordered raw trace. */
export function hashRawTrace(entries: readonly RawTraceEntry[]): string {
  // SHA-256 of the concatenated records is the same value as feeding the records to
  // one hash in order, so the portable primitive needs no streaming API of its own.
  return sha256Hex(entries.map(canonicalRecord).join(""));
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
