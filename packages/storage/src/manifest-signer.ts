/**
 * The Node implementation of the core's `ManifestSigner` (ADR 0057).
 *
 * The core owns *what* is signed — {@link canonicalManifestBinding} is the
 * byte-exact contract — and refuses to own *how*, exactly as with the digest
 * (`IntegrityPort`). This file is the other half of that seam: the persistence
 * layer supplies the ed25519 signature over `node:crypto`.
 *
 * One signer per process, one fresh keypair at construction. The key never
 * leaves memory and is never persisted: a signature is evidence that *this
 * platform instance* attested the recording at sign time, not a long-lived
 * identity to be compromised later. What persists is the key fingerprint in the
 * manifest (`keyId`), which is why the log line at construction is not
 * diagnostic noise — it is the only record tying a stored `keyId` to a key, and
 * an operator who wants long-term verification keys them down from it. The
 * full public key travels via `exportPublicKey()` for exactly that purpose.
 */

import {
  createHash,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";
import {
  canonicalManifestBinding,
  type ManifestSigner,
  type ManifestVerifier,
  type RawTraceManifestIdentity,
  type RawTraceSignature,
} from "@vdp/core";
import type { Logger } from "@vdp/shared";

export interface NodeManifestSigner extends ManifestSigner, ManifestVerifier {
  /**
   * The public half of the keypair, SPKI base64 — printable at start, keyable
   * into a verification keyring later. Safe to persist; the private key is not.
   */
  exportPublicKey(): string;
}

/**
 * The key fingerprint: `ed25519:` + the first 16 hex of the SHA-256 over the
 * raw 32-byte public key. Computed from the raw key bytes (not the DER wrapper),
 * so the same key gets the same fingerprint in every tool that hashes it.
 */
export function manifestKeyId(rawPublicKey: Uint8Array): string {
  const digest = createHash("sha256").update(rawPublicKey).digest("hex");
  return `ed25519:${digest.slice(0, 16)}`;
}

/** Raw 32 bytes of an ed25519 public key (the JWK `x` value). */
function rawPublicKey(publicKey: KeyObject): Buffer {
  const jwk = publicKey.export({ format: "jwk" }) as { x: string };
  return Buffer.from(jwk.x, "base64url");
}

/** SPKI base64 of a public key — the portable form to hand to another verifier. */
function exportPublicKey(publicKey: KeyObject): string {
  return publicKey.export({ type: "spki", format: "der" }).toString("base64");
}

function verifyWith(publicKey: KeyObject, binding: string, signatureBase64: string): boolean {
  try {
    return cryptoVerify(
      null,
      Buffer.from(binding, "utf8"),
      publicKey,
      Buffer.from(signatureBase64, "base64"),
    );
  } catch {
    return false;
  }
}

/**
 * A process signer with a fresh ed25519 keypair. One per platform instance is
 * enough and is all there is: the constructor generates, `sign` attests,
 * `verify` confirms what this key attested (ADR 0057).
 */
export function createNodeManifestSigner(options: { logger?: Logger } = {}): NodeManifestSigner {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const keyId = manifestKeyId(rawPublicKey(publicKey));
  const spki = exportPublicKey(publicKey);
  // The one record tying this ephemeral key to its fingerprint (ADR 0057): an
  // operator who wants long-term verification keys the public half down here.
  options.logger?.info("manifest signer ready", { keyId, publicKey: spki });
  return {
    keyId,
    publicKey: spki,
    sign(identity: RawTraceManifestIdentity): RawTraceSignature {
      const value = cryptoSign(
        null,
        Buffer.from(canonicalManifestBinding(identity), "utf8"),
        privateKey,
      ).toString("base64");
      return { keyId, algorithm: "ed25519", value };
    },
    verify(binding: string, signatureBase64: string): boolean {
      return verifyWith(publicKey, binding, signatureBase64);
    },
    exportPublicKey(): string {
      return spki;
    },
  };
}

/**
 * A verifier for a key someone else attested with: the SPKI base64 from the
 * manifest's own `publicKey` field (or from the log line at the recording's
 * start). The `keyId` is recomputed from the key, so a name cannot lie about a
 * fingerprint — {@link verifyRawTraceManifestSignature} checks it against the
 * one the signature claims.
 */
export function createNodeManifestVerifier(spkiBase64: string): ManifestVerifier {
  const der = Buffer.from(spkiBase64, "base64");
  const publicKey = createPublicKey({ key: der, type: "spki", format: "der" });
  // A SPKI ed25519 key is a fixed 12-byte prefix plus the 32 raw key bytes;
  // hashing the DER would make the fingerprint format-shaped. Read the raw
  // bytes through the JWK view so the fingerprint matches manifestKeyId.
  const keyId = manifestKeyId(rawPublicKey(publicKey));
  return {
    keyId,
    verify(binding: string, signatureBase64: string): boolean {
      return verifyWith(publicKey, binding, signatureBase64);
    },
  };
}
