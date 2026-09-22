/**
 * The Node `ManifestSigner` (ADR 0051).
 *
 * The only place in the tree where a raw-trace signature is really produced, so
 * the tests here pin the things a double cannot: that the primitive is standard
 * ed25519 (measured against RFC 8032), that the bytes signed are exactly the
 * core's canonical binding, and that a `keyId` has the fingerprint form the
 * manifest promises. The contract tests for what is signed live with the
 * contract (`packages/core/src/logging/integrity.spec.ts`); everything below is
 * measurement against real keys.
 */

import assert from "node:assert/strict";
import {
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
} from "node:crypto";
import {
  type RawTraceManifest,
  canonicalManifestBinding,
  createRawTraceManifest,
  signRawTraceManifest,
  verifyRawTraceManifestSignature,
} from "@vdp/core";
import { test } from "vitest";
import { nodeIntegrityPort } from "./integrity.js";
import { createNodeManifestSigner, createNodeManifestVerifier } from "./manifest-signer.js";

function entry(payloadHex: string, t: number) {
  return {
    timestamp: new Date(1_700_000_000_000 + t).toISOString(),
    t,
    canId: 0x7e8,
    canIdHex: "0x7E8",
    direction: "rx" as const,
    dlc: payloadHex.length / 2,
    payload: Uint8Array.from(payloadHex.match(/../g) ?? [], (b) => Number.parseInt(b, 16)),
    payloadHex,
    channel: "can0",
    extended: false,
    fd: false,
  };
}

const TRACE = [entry("1003", 1), entry("5003", 2)];

test("the keyId is the key's fingerprint, in the form the manifest promises", () => {
  const signer = createNodeManifestSigner();
  assert.match(signer.keyId, /^ed25519:[0-9a-f]{16}$/);
  // Two processes, two keys — and the fingerprint says so instead of sharing a name.
  assert.notEqual(createNodeManifestSigner().keyId, signer.keyId);
});

test("it is standard ed25519 (RFC 8032), measured against a published vector", () => {
  // RFC 8032 §7.1 test 1: the empty message under a pinned keypair. This is
  // what makes `algorithm: "ed25519"` in a manifest a statement about the
  // algorithm the world knows, not about ours.
  const seed = Buffer.from(
    "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
    "hex",
  );
  const publicKeyBytes = Buffer.from(
    "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
    "hex",
  );
  const key = createPrivateKey({
    key: {
      kty: "OKP",
      crv: "Ed25519",
      d: seed.toString("base64url"),
      x: publicKeyBytes.toString("base64url"),
    },
    format: "jwk",
  });
  const signature = cryptoSign(null, Buffer.alloc(0), key).toString("hex");
  assert.equal(
    signature,
    "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc" +
      "61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
  );
});

test("the bytes signed are exactly the core's canonical binding", () => {
  // The one place where "sign(manifest)" is tied to what it must mean: verify the
  // produced signature against the binding string with raw node:crypto, no
  // helper of ours in the path.
  const signer = createNodeManifestSigner();
  const manifest = createRawTraceManifest(TRACE, nodeIntegrityPort);
  const signature = signer.sign(manifest);
  assert.deepEqual(Object.keys(signature).sort(), ["algorithm", "keyId", "value"]);
  assert.equal(signature.algorithm, "ed25519");
  assert.equal(signature.keyId, signer.keyId);
  const publicKey = createPublicKey({
    key: Buffer.from(signer.exportPublicKey(), "base64"),
    type: "spki",
    format: "der",
  });
  assert.equal(
    cryptoVerify(
      null,
      Buffer.from(canonicalManifestBinding(manifest), "utf8"),
      publicKey,
      Buffer.from(signature.value, "base64"),
    ),
    true,
  );
});

test("a signed manifest confirms against the public key that travels beside it", () => {
  const signer = createNodeManifestSigner();
  const signed = signRawTraceManifest(createRawTraceManifest(TRACE, nodeIntegrityPort), signer);
  assert.equal(signed.signature?.keyId, signer.keyId);
  assert.equal(signed.publicKey, signer.exportPublicKey());
  // An auditor who knows nothing but the manifest: key from the manifest, check.
  const verifier = createNodeManifestVerifier(signed.publicKey ?? "");
  assert.equal(verifier.keyId, signer.keyId, "the fingerprint is recomputed from the key bytes");
  assert.equal(verifyRawTraceManifestSignature(signed, verifier), true);
  // The signer can vouch for its own export at once (ADR 0051: the signature is
  // verified where it was produced).
  assert.equal(verifyRawTraceManifestSignature(signed, signer), true);
});

test("real falsification: any changed identity field stops confirming", () => {
  const signed = signRawTraceManifest(
    createRawTraceManifest(TRACE, nodeIntegrityPort),
    createNodeManifestSigner(),
  );
  const verifier = createNodeManifestVerifier(signed.publicKey ?? "");
  const tampered = (patch: Record<string, unknown>): RawTraceManifest =>
    JSON.parse(JSON.stringify({ ...signed, ...patch })) as RawTraceManifest;
  for (const patch of [
    { format: "other" },
    { version: 1 },
    { algorithm: "md5" },
    { entries: signed.entries + 1 },
    { sha256: signed.sha256.replace(/^./, "0") },
  ]) {
    assert.equal(
      verifyRawTraceManifestSignature(tampered(patch), verifier),
      false,
      `tampering with ${Object.keys(patch).join(",")} must falsify the attestation`,
    );
  }
});

test("a foreign key cannot vouch for this recording", () => {
  const signed = signRawTraceManifest(
    createRawTraceManifest(TRACE, nodeIntegrityPort),
    createNodeManifestSigner(),
  );
  const foreign = createNodeManifestSigner();
  assert.equal(verifyRawTraceManifestSignature(signed, foreign), false);
  // And the fingerprint half of that refusal: even a verifier rebuilt from the
  // manifest's own key is only accepted under its recomputed keyId.
  const verifier = createNodeManifestVerifier(signed.publicKey ?? "");
  const impersonating = {
    keyId: foreign.keyId,
    verify: verifier.verify.bind(verifier),
  };
  assert.equal(verifyRawTraceManifestSignature(signed, impersonating), false);
});
