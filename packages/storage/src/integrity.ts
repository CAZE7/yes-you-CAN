/**
 * The Node implementation of the core's `IntegrityPort` (ADR 0047).
 *
 * `@vdp/core` owns *what* is hashed — the canonical raw-trace stream — and refuses to
 * own *how*, because it is a portable layer (`architecture/architecture.yaml` →
 * `rules.nodeBuiltins`). This file is the other half of that seam: the persistence
 * layer, which is the layer that writes the session export the manifest travels with,
 * supplies the digest over `node:crypto`.
 *
 * It is deliberately six lines of behaviour. A port implementation that adds policy —
 * a fallback algorithm, a cache, a "best effort" digest — would move a decision out of
 * the manifest and into a place no export ever records.
 */

import { createHash } from "node:crypto";
import { type IntegrityDigest, type IntegrityPort, RAW_TRACE_HASH_ALGORITHM } from "@vdp/core";

/**
 * SHA-256 over the canonical stream, as `@vdp/core` defines it. The `algorithm` is
 * read from the core's constant instead of restated, so the manifest, the port and the
 * verifier cannot disagree about which function produced a digest.
 */
export const nodeIntegrityPort: IntegrityPort = {
  algorithm: RAW_TRACE_HASH_ALGORITHM,
  createDigest(): IntegrityDigest {
    const hash = createHash(RAW_TRACE_HASH_ALGORITHM);
    return {
      update(chunk: string): void {
        hash.update(chunk, "utf8");
      },
      hex(): string {
        return hash.digest("hex");
      },
    };
  },
};
