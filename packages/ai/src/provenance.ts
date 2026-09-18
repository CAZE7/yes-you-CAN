/**
 * Citations and versions for an analysis answer (AGENTS 22, 24; P0 #42).
 *
 * Both providers need the same two rules, and a rule that lives in one provider is
 * a rule the other one can forget:
 *
 * 1. **A citation must exist.** A gateway may answer with `"basedOn": ["dtc:P0420"]`
 *    and mean it, or invent an id that reads just as well. Only ids the caller
 *    actually handed out survive, so a citation is a pointer a reader can open —
 *    never a decoration.
 * 2. **Versions come from the request, never from the answer.** An outside answer
 *    that reports its own prompt version is a claim; the versions the platform sent
 *    are a fact. So the provenance is assembled here from the input, and a field of
 *    the same name in a gateway's JSON is ignored.
 */

import type { AnalysisInput, AnalysisProvenance, AnalysisVersions } from "./types.js";

/** The ids the given input can be cited against — empty when no set came in. */
export function citableIds(input: AnalysisInput): ReadonlySet<string> {
  return new Set((input.evidence?.items ?? []).map((item) => item.id));
}

/**
 * Keep only citations the input actually offered.
 *
 * An answer with `basedOn: []` after filtering is *not* rewritten into "no
 * citations": the empty list is the finding's own statement, and a provider that
 * dropped all of them has to stay visible as that.
 */
export function knownCitations(ids: unknown, citable: ReadonlySet<string>): string[] | undefined {
  if (!Array.isArray(ids)) return undefined;
  return ids.filter((id): id is string => typeof id === "string" && citable.has(id));
}

/**
 * The provenance of one answer.
 *
 * `evidence` is every item id of the set the caller handed in — the whole recording,
 * not a selection. A per-finding selection is what `basedOn` is for; an answer that
 * cites nothing anywhere still rested on the set it was given, and saying so is more
 * honest than an empty list that reads as "this rests on nothing".
 */
export function provenanceOf(
  input: AnalysisInput,
  options: { provider: string; model?: string },
): AnalysisProvenance {
  const versions: AnalysisVersions = input.versions ?? {
    // No versions in the input is a wiring mistake upstream, not a fact about the
    // session — so it is named instead of quietly filled with "unknown".
    promptVersion: "not provided",
    runtimeVersion: "not provided",
  };
  return {
    ...versions,
    provider: options.provider,
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(input.recordingId !== undefined ? { recordingId: input.recordingId } : {}),
    evidence: (input.evidence?.items ?? []).map((item) => item.id),
  };
}
