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
/**
 * The version this build creates (ADR 0057): v2 adds the optional signature.
 * v1 witnesses keep verifying — the golden digest over a pinned trace is the
 * cross-language anchor and it does not move with the version.
 */
export const RAW_TRACE_MANIFEST_VERSION = 2 as const;
/** Versions the verifier accepts (ADR 0057): new builds create v2, v1 stays valid. */
export const SUPPORTED_RAW_TRACE_MANIFEST_VERSIONS = [1, 2] as const;
export type SupportedRawTraceManifestVersion =
  (typeof SUPPORTED_RAW_TRACE_MANIFEST_VERSIONS)[number];

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

/**
 * The signature of a v2 manifest (ADR 0057): an ed25519 signature over the
 * canonical binding of the manifest's identity fields. The `keyId` is the
 * fingerprint of the public key (`ed25519:` + the first 16 hex of its SHA-256),
 * so a verifier can say which key attested the recording without trusting a name.
 */
export interface RawTraceSignature {
  keyId: string;
  algorithm: "ed25519";
  /** base64-encoded signature. */
  value: string;
}

export interface RawTraceManifest {
  format: "vdp.raw-trace-manifest";
  /** v1 (digest only, still valid) or v2 (digest + optional signature). */
  version: SupportedRawTraceManifestVersion;
  algorithm: RawTraceHashAlgorithm;
  /** Number of entries covered by the digest. */
  entries: number;
  /** Digest of the canonical raw trace, lowercase hexadecimal. */
  sha256: string;
  /** v2 only (ADR 0057): absent means "no attestation beyond the digest". */
  signature?: RawTraceSignature;
  /**
   * SPKI base64 of the signing key, beside the signature (ADR 0057: the keypair
   * never leaves the process, but the public half goes into the manifest). A
   * verifier recomputes the `keyId` from these bytes — a name cannot lie about a
   * fingerprint — and then confirms the signature.
   */
  publicKey?: string;
}

/** The fields a signature attests to — exactly the fields a digest covers. */
export type RawTraceManifestIdentity = Pick<
  RawTraceManifest,
  "format" | "version" | "algorithm" | "entries" | "sha256"
>;

/**
 * The signing seam (ADR 0057, the same port pattern as {@link IntegrityPort}):
 * core names *what* is signed — {@link canonicalManifestBinding} is the byte-exact
 * contract — and asks a signer for the signature itself. The Node implementation
 * (ed25519 over `node:crypto`) lives in `@vdp/storage` (`nodeManifestSigner`);
 * a hardware security module or a cloud KMS supplies its own.
 */
export interface ManifestSigner {
  /** Fingerprint of the signing key: `ed25519:` + 16 hex of its SHA-256. */
  readonly keyId: string;
  /** SPKI base64 of the public half — travels in the manifest beside the signature. */
  readonly publicKey: string;
  /** Sign the canonical binding of a manifest's identity fields, base64. */
  sign(identity: RawTraceManifestIdentity): RawTraceSignature;
}

/** Confirms signatures made by one known key. */
export interface ManifestVerifier {
  /** The keyId this verifier can confirm. */
  readonly keyId: string;
  /** Confirm a signature over a binding string. Never throws for bad input. */
  verify(binding: string, signatureBase64: string): boolean;
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

/**
 * The canonical binding of a manifest: exactly the fields a signature attests to
 * (ADR 0057) — `format|version|algorithm|entries|sha256`, in that fixed order.
 * The signature itself is excluded — signing a signature is circular — and the
 * format comes first, so bytes signed here cannot collide with any other signed
 * artifact this platform produces. This is the cross-language contract a
 * verifier feeds its signature check: change it and every stored signature
 * stops confirming, which is why it is exported and pinned by tests.
 */
export function canonicalManifestBinding(manifest: RawTraceManifestIdentity): string {
  return [
    manifest.format,
    manifest.version,
    manifest.algorithm,
    manifest.entries,
    manifest.sha256,
  ].join("|");
}

/**
 * Content-addressed trace identity (ADR 0057): `t-` + the first 16 hex of the
 * manifest's digest. The same recording carries the same id in every build —
 * and the full digest stays in the manifest for a complete check.
 */
export function traceIdFromManifest(manifest: { sha256: string }): string {
  return `t-${manifest.sha256.slice(0, 16)}`;
}

/** Create the manifest that travels with a raw recording (v2, unsigned). */
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

/**
 * Sign an unsigned manifest (v1 or v2) into an attested v2 one (ADR 0057):
 * the signature covers {@link canonicalManifestBinding} of the identity fields,
 * and the public key travels beside it. Changing one byte of the digest, the
 * entry count or the algorithm afterwards makes the signature stop confirming.
 */
export function signRawTraceManifest(
  manifest: RawTraceManifestIdentity,
  signer: ManifestSigner,
): RawTraceManifest {
  return {
    format: manifest.format,
    version: RAW_TRACE_MANIFEST_VERSION,
    algorithm: manifest.algorithm,
    entries: manifest.entries,
    sha256: manifest.sha256,
    signature: signer.sign(manifest),
    publicKey: signer.publicKey,
  };
}

/**
 * Does the manifest carry a signature the verifier confirms? Digest verification
 * is separate — {@link verifyRawTraceManifest} — because "unchanged" and
 * "attested by a key I know" are different claims (ADR 0057). The caller builds
 * the verifier from the manifest's own `publicKey` (`createNodeManifestVerifier`
 * in `@vdp/storage`); the keyId equality check is what binds that key to the
 * fingerprint the signature claims.
 */
export function verifyRawTraceManifestSignature(
  manifest: RawTraceManifest,
  verifier: ManifestVerifier,
): boolean {
  const signature = manifest.signature;
  if (!signature || manifest.publicKey === undefined) return false;
  if (signature.algorithm !== "ed25519" || signature.keyId !== verifier.keyId) return false;
  return verifier.verify(canonicalManifestBinding(manifest), signature.value);
}

/** Verify both the digest and the covered entry count. Never throws for bad input. */
export function verifyRawTraceManifest(
  entries: readonly RawTraceEntry[],
  manifest: RawTraceManifest,
  port: IntegrityPort,
): boolean {
  return (
    manifest.format === "vdp.raw-trace-manifest" &&
    (SUPPORTED_RAW_TRACE_MANIFEST_VERSIONS as readonly number[]).includes(manifest.version) &&
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
