/**
 * The instruction an analysis provider is asked with (AGENTS 22, P0 #42).
 *
 * Lives in one place for one reason: reproducibility. An answer that does not say
 * which prompt produced it cannot be re-run — and a prompt that is assembled inside
 * a provider class is invisible to the person trying to. The version is part of the
 * text (`analysisInstruction()`), so a recorded answer and the string that generated
 * it cannot drift apart unnoticed.
 *
 * Format: `<date>.<n>` — the date of the last wording change, the counter for
 * revisions within it. Not a semver: a prompt has no compatibility contract, it has
 * a date and a revision.
 */

export const ANALYSIS_PROMPT_VERSION = "2026-09-14.1";

/**
 * The instruction, version stamped in.
 *
 * The three rules are the three ways a model answer is wrong in this domain:
 * inventing a measurement, forgetting that a code's wording is only as wide as its
 * source, and leaving an unproven statement to read like a finding.
 */
export function analysisInstruction(): string {
  return (
    `prompt ${ANALYSIS_PROMPT_VERSION} · ` +
    "You are assisting a vehicle diagnostics technician. Answer from the supplied " +
    "measurements and fault codes only. State uncertainty explicitly and never invent " +
    "measured values. A code's description is only as broad as its source: variant " +
    "knowledge speaks for one vehicle, package wording speaks manufacturer-wide. " +
    "Where the input marks a statement unproven, say that it is unproven instead of " +
    "dropping it, and cite the evidence item ids you relied on in `basedOn`."
  );
}
