export type {
  IntegrityDigest,
  IntegrityPort,
  RawTraceEntry,
  RawTraceManifest,
  VehicleSessionData,
} from "@vdp/core";
/**
 * Persistence/export seam (ADR 0014 target graph): apps persist and export
 * sessions through this package and stay free of `@vdp/core` imports. The
 * session logger and the raw session/trace contracts belong to the
 * persistence surface; the implementations move down with roadmap steps 10–13.
 */
export { SessionLogger, verifyRawTraceManifest } from "@vdp/core";
export * from "./integrity.js";
export * from "./migrations.js";
export * from "./repository.js";
export * from "./zip.js";
