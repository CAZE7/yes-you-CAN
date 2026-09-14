/**
 * The recipes the checked-in golden sessions were recorded from.
 *
 * A recipe is code, the recording is data (master backlog P0 #10). Everything a
 * fixture needs to be reproducible is here: which vehicle, which fault memory,
 * which defect is injected, and the timestamp that goes into the file. The
 * timestamps are fixed so re-recording a fixture produces an empty diff — if a
 * re-recording changes nothing, the recording was reproducible.
 *
 * The set covers the paths a real workshop session has to survive: an empty fault
 * memory, a stored one with freeze frames, an ECU that answers "pending" first,
 * and live signals that move.
 */

import type { GoldenRecipe } from "./record.js";

/** Fixed recording times: a re-recording must not churn the file. */
const RECORDED_AT = "2026-09-14T09:00:00.000Z";

export const GENERIC_PACKAGE_NAME = "generic";

export const STANDARD_RECIPES: readonly GoldenRecipe[] = [
  {
    id: "generic-baseline",
    title: "Generic hatchback — empty fault memory, static signals",
    note: "The calm case: every ECU answers, nothing is stored. Guards discovery, identification and decoding.",
    recordedAt: RECORDED_AT,
    vehicle: {
      dtcs: { engine: [], transmission: [], abs: [] },
      dynamic: false,
    },
  },
  {
    id: "generic-stored-dtcs",
    title: "Generic hatchback — stored codes with freeze frames on two ECUs",
    note: "The package’s own fault memory: an active code with a freeze frame and a confirmed-only code.",
    recordedAt: RECORDED_AT,
    vehicle: {
      dynamic: false,
    },
  },
  {
    id: "generic-pending-response",
    title: "Generic hatchback — an ECU answers 0x78 before the real response",
    note: "Exercises the ISO 14229-2 response-pending path end to end (P2 → P2*), which a replay has to reproduce byte for byte.",
    recordedAt: RECORDED_AT,
    vehicle: {
      pendingResponseServices: [0x22],
      dynamic: false,
    },
  },
  {
    id: "generic-live-signals",
    title: "Generic hatchback — signals that move during the session",
    note: "A seeded signal model: the expected values are ranges, not points, so the fixture also guards the window logic.",
    recordedAt: RECORDED_AT,
    vehicle: {
      dynamic: true,
      seed: 42,
    },
  },
];
