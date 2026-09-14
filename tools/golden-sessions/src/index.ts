/**
 * Golden sessions (master backlog P0 #10).
 *
 * Recording a workshop session once, keeping the expectation with it, and replaying
 * it as a regression: that is the difference between "it worked on the bench" and
 * "this is what the vehicle did, and it must still do it".
 */

export {
  GOLDEN_FORMAT,
  GOLDEN_FORMAT_VERSION,
  VIN_PATTERN,
  VIN_PLACEHOLDER,
  type GoldenCheck,
  type GoldenDefinitionRef,
  type GoldenDtcExpectation,
  type GoldenEcuExpectation,
  type GoldenExpectations,
  type GoldenIdentityExpectation,
  type GoldenProvenance,
  type GoldenRecording,
  type GoldenRunResult,
  type GoldenSession,
  type GoldenSignalExpectation,
  type GoldenSource,
  type GoldenTraceEntry,
} from "./format.js";
export {
  GoldenSessionFormatError,
  goldenSessionToJson,
  parseGoldenSession,
  summariseChecks,
} from "./parse.js";
export { resolveStableEcuId, stableEcuId, type EcuIdentityLike } from "./ecu-identity.js";
export {
  applyReplacements,
  bytesToHex,
  containsInMessages,
  findBytesInMessages,
  frameBytes,
  reassemble,
  type ByteHit,
  type ReassembledMessage,
} from "./isobytes.js";
export {
  assertGoldenRedacted,
  assertNoVinLikeTokens,
  assertVinGone,
  findVinLikeTokens,
  findVinOccurrences,
  redactedVinBytes,
  redactGoldenSession,
  redactRecording,
  redactText,
  vinHexForms,
} from "./redact.js";
export {
  GOLDEN_CONNECT_OPTIONS,
  type GoldenRecipe,
  type RecordGoldenOptions,
  type RecordedGolden,
  recordGoldenSession,
  signalExpectations,
} from "./record.js";
export { type RunGoldenOptions, runGoldenSession } from "./run.js";
export { GENERIC_PACKAGE_NAME, STANDARD_RECIPES } from "./recipes.js";
