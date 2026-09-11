// Cross-package test suites. Tests live in integration/, protocol/, replay/ and
// regression/ (AGENTS 31); this entry exists so the folder is a workspace package.
export const testSuites = ["integration", "protocol", "replay", "regression"] as const;
