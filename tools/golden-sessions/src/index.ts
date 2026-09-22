/**
 * Golden sessions (master backlog P0 #10).
 *
 * Recording a workshop session once, keeping the expectation with it, and replaying
 * it as a regression: that is the difference between "it worked on the bench" and
 * "this is what the vehicle did, and it must still do it".
 */

export { type EcuIdentityLike, resolveStableEcuId, stableEcuId } from "./ecu-identity.js";
export {
  GOLDEN_FORMAT,
  GOLDEN_FORMAT_VERSION,
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
  VIN_PATTERN,
  VIN_PLACEHOLDER,
} from "./format.js";
export {
  applyReplacements,
  type ByteHit,
  bytesToHex,
  containsInMessages,
  findBytesInMessages,
  frameBytes,
  type ReassembledMessage,
  reassemble,
} from "./isobytes.js";
export {
  GoldenSessionFormatError,
  goldenSessionToJson,
  parseGoldenSession,
  summariseChecks,
} from "./parse.js";
export { GENERIC_PACKAGE_NAME, STANDARD_RECIPES } from "./recipes.js";
export {
  GOLDEN_CONNECT_OPTIONS,
  type GoldenRecipe,
  type RecordedGolden,
  type RecordGoldenOptions,
  recordGoldenSession,
  signalExpectations,
} from "./record.js";
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
export { type RunGoldenOptions, runGoldenSession } from "./run.js";
