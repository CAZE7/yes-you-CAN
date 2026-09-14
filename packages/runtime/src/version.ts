/**
 * The platform version an analysis cites (master backlog P0 #42, AGENTS 13).
 *
 * Reproducibility needs a version for the *software*, not only for the data: the
 * same session, analysed by a different build, can legitimately answer differently,
 * and an answer that does not say which build made it cannot be compared with a
 * later one. There is no build stamp in this repository (no bundler, no code
 * generation), so the honest floor is the workspace version every package carries —
 * and a guard test (`tests/architecture/manifests.test.ts`) pins this constant
 * against `package.json`, because a constant nobody checks is a constant that drifts.
 */
export const PLATFORM_VERSION = "0.1.0";
