/**
 * Evidence service: the runtime's read-only view of "what can be claimed".
 *
 * The workbench, a report and an analysis provider all need the same evidence set,
 * and none of them may assemble it themselves — assembling means deciding which
 * statement counts, and that decision has to happen once (AGENTS 24, master backlog
 * P0 #39). This service is that once: it reads the running session, the recorder's
 * statistics and the last stored scan, and hands out the IR shapes.
 *
 * It is a *service on the composition root*, not a method on the engine: the engine
 * owns the vehicle link, and an evidence view never needs it (AGENTS 1). And it
 * reads — `collect()` and `hypotheses()` send nothing, write nothing and audit
 * nothing, because an evidence set is a statement about what was seen
 * (AGENTS 25: writes go through the write chain, and this is not one).
 */

import {
  type DiagnosticEngine,
  type SamplePoint,
  collectEvidence,
  evaluateGuidedDiagnosis,
  rankHypotheses,
} from "@vdp/core";
import type { EvidenceSet, GuidedDiagnosisState, Hypothesis } from "@vdp/diagnostic-ir";

export interface EvidenceSnapshot {
  evidence: EvidenceSet;
  hypotheses: Hypothesis[];
}

export class EvidenceService {
  constructor(private readonly engine: DiagnosticEngine) {}

  /**
   * Collect the evidence set of the current session.
   *
   * `at` of every item is the session's own data, so calling this twice in a row
   * without a new scan or a new sample returns the same set — a claim an analysis
   * relies on when it cites item ids.
   */
  collect(): EvidenceSet {
    return this.snapshot().evidence;
  }

  /**
   * The documented patterns of the last scan, judged against the recording.
   *
   * Ranked by the confidence rule in `@vdp/core/src/evidence/hypotheses.ts` — a
   * heuristic with published numbers, not a score from a model.
   */
  hypotheses(): Hypothesis[] {
    return this.snapshot().hypotheses;
  }

  /**
   * Evaluates the active session through the guided diagnosis loop (Task 6).
   * Determines whether the diagnosis is in-progress, resolved, or inconclusive,
   * and recommends the next discriminating test.
   */
  guidedDiagnosis(stepsCompleted = 0): GuidedDiagnosisState {
    const session = this.engine.vehicleSession;
    if (session === null) throw new Error("no session — call vehicle.connect() first");
    const recorder = this.engine.recorder;
    const samplesOf = (signalId: string): readonly SamplePoint[] =>
      recorder
        .samplesFor(signalId)
        .filter((sample) => typeof sample.value === "number")
        .map((sample) => ({ at: sample.timestamp, value: sample.value as number }));
    const evidence = collectEvidence({
      session: session.data,
      statistics: recorder.statisticsForAll(),
      anomalies: recorder.anomalies(),
    });
    const dtcs = session.data.dtcSnapshots.at(-1)?.records ?? [];
    return evaluateGuidedDiagnosis({
      evidence,
      dtcs,
      samplesOf,
      stepsCompleted,
    });
  }

  /**
   * Both at once.
   *
   * A caller that wants hypotheses always wants the set too (the hypotheses cite
   * its item ids), and collecting twice would read the recorder twice — with a
   * live poll in between, the citations could point at a newer set than the one the
   * caller holds. So one read, one moment.
   */
  snapshot(): EvidenceSnapshot {
    const session = this.engine.vehicleSession;
    if (session === null) throw new Error("no session — call vehicle.connect() first");
    const recorder = this.engine.recorder;
    const samplesOf = (signalId: string): readonly SamplePoint[] =>
      recorder
        .samplesFor(signalId)
        .filter((sample) => typeof sample.value === "number")
        .map((sample) => ({ at: sample.timestamp, value: sample.value as number }));
    const evidence = collectEvidence({
      session: session.data,
      statistics: recorder.statisticsForAll(),
      anomalies: recorder.anomalies(),
    });
    const dtcs = session.data.dtcSnapshots.at(-1)?.records ?? [];
    return {
      evidence,
      hypotheses: rankHypotheses({ evidence, dtcs, samplesOf }),
    };
  }
}
