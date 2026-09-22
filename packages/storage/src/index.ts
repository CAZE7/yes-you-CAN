export * from "./integrity.js";
export * from "./manifest-signer.js";
export * from "./migrations.js";
export * from "./repository.js";
export * from "./zip.js";

/**
 * Persistence/export seam (ADR 0014 target graph): apps persist and export
 * sessions through this package and stay free of `@vdp/core` imports. The
 * session logger and the raw session/trace contracts belong to the
 * persistence surface; the implementations move down with roadmap steps 10–13.
 */
export {
  SessionLogger,
  signRawTraceManifest,
  traceIdFromManifest,
  verifyRawTraceManifest,
  verifyRawTraceManifestSignature,
} from "@vdp/core";
export type {
  IntegrityDigest,
  IntegrityPort,
  ManifestSigner,
  ManifestVerifier,
  RawTraceEntry,
  RawTraceManifest,
  RawTraceManifestIdentity,
  RawTraceSignature,
  VehicleSessionData,
} from "@vdp/core";
