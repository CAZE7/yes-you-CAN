/**
 * Cryptographic provenance for raw diagnostic recordings — through a port (ADR 0047).
 *
 * A decoder must never be the only witness for a diagnosis. This module hashes the
 * lossless raw CAN/UDS trace before projection and produces a small, portable manifest
 * that can be stored next to a session export. Hashing is deliberately based on a
 * canonical representation, not JSON.stringify of Uint8Array objects, so the same
 * recording has the same digest in Node, a replay worker, and an export pipeline.
 *
 * What this module does *not* own is the digest function. `@vdp/core` is a portable
 * layer (`architecture/architecture.yaml` → `rules.nodeBuiltins`): it defines what is
 * hashed — {@link canonicalRawTraceChunks} is the byte-exact contract — and what a
 * manifest means, and it asks an {@link IntegrityPort} for the hashing itself. The
 * Node implementation (`node:crypto`) lives with the layer that writes the export,
 * `@vdp/storage` (`nodeIntegrityPort`); a browser, a WASM host or a hardware security
 * module supplies its own. The seam is the reason a digest can never be produced by a
 * hidden platform default: a caller that wants a manifest has to name the hasher, and
 * a manifest carries the algorithm it was made with.
 */

import type { RawTraceEntry } from "./session-logger.js";

export const RAW_TRACE_HASH_ALGORITHM = "sha256" as const;
export type RawTraceHashAlgorithm = typeof RAW_TRACE_HASH_ALGORITHM;
export const RAW_TRACE_MANIFEST_VERSION = 1 as const;

/**
 * One running digest. Chunks are fed in order and the result is read once; a
 * streaming shape (instead of "hash this string") keeps a 200 000-frame trace out of
 * memory as one buffer, which is the cap `SessionLogger` enforces.
 */
export interface IntegrityDigest {
  /** Append one UTF-8 chunk. */
  update(chunk: string): void;
  /** The digest of everything appended so far, lowercase hexadecimal. */
  hex(): string;
}

/**
 * The hashing seam (ADR 0047). Implementations must be deterministic and must return
 * the algorithm they actually run: {@link verifyRawTraceManifest} refuses a manifest
 * whose `algorithm` is not the port's, so a re-hash with a different function can
 * never confirm an old witness.
 */
export interface IntegrityPort {
  readonly algorithm: RawTraceHashAlgorithm;
  createDigest(): IntegrityDigest;
}

export interface RawTraceManifest {
  format: "vdp.raw-trace-manifest";
  version: typeof RAW_TRACE_MANIFEST_VERSION;
  algorithm: RawTraceHashAlgorithm;
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

/**
 * The canonical stream of an ordered raw trace: one length-prefixed line per entry,
 * so a separator inside a value cannot make two different traces read the same.
 * This generator *is* the contract every {@link IntegrityPort} implementation hashes;
 * changing it changes every digest that was ever stored, which is why it is exported —
 * a change is reviewable instead of invisible inside `hashRawTrace`.
 */
export function* canonicalRawTraceChunks(
  entries: readonly RawTraceEntry[],
): Generator<string, void, undefined> {
  for (const entry of entries) {
    const line = canonicalEntry(entry);
    yield `${line.length}:${line}\n`;
  }
}

/** Return the stable SHA-256 digest for an ordered raw trace. */
export function hashRawTrace(entries: readonly RawTraceEntry[], port: IntegrityPort): string {
  const digest = port.createDigest();
  for (const chunk of canonicalRawTraceChunks(entries)) digest.update(chunk);
  return digest.hex();
}

/** Create the manifest that travels with a raw recording. */
export function createRawTraceManifest(
  entries: readonly RawTraceEntry[],
  port: IntegrityPort,
): RawTraceManifest {
  return {
    format: "vdp.raw-trace-manifest",
    version: RAW_TRACE_MANIFEST_VERSION,
    algorithm: port.algorithm,
    entries: entries.length,
    sha256: hashRawTrace(entries, port),
  };
}

/** Verify both the digest and the covered entry count. Never throws for bad input. */
export function verifyRawTraceManifest(
  entries: readonly RawTraceEntry[],
  manifest: RawTraceManifest,
  port: IntegrityPort,
): boolean {
  return (
    manifest.format === "vdp.raw-trace-manifest" &&
    manifest.version === RAW_TRACE_MANIFEST_VERSION &&
    manifest.algorithm === port.algorithm &&
    manifest.entries === entries.length &&
    manifest.sha256 === hashRawTrace(entries, port)
  );
}

/** Add a manifest to a session JSON payload without changing the raw trace itself. */
export function withRawTraceManifest<T extends { trace: readonly RawTraceEntry[] }>(
  payload: T,
  port: IntegrityPort,
): T & { rawTraceManifest: RawTraceManifest } {
  return { ...payload, rawTraceManifest: createRawTraceManifest(payload.trace, port) };
}
