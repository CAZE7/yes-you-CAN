/**
 * Evidence collection and hypothesis ranking (P0 #39/#40; AGENTS 22, 24).
 *
 * What these tests hold the code to:
 *
 * - every item is something the session already said, with the IR's own proof on it;
 * - an absent statement becomes an item of its own (`gap`), never a missing row;
 * - a check that was not measured is **untested** — not passed, not failed;
 * - the ranking cites item ids instead of restating statements;
 * - the confidence rule is arithmetic a reader can recompute, capped below certainty.
 */

import assert from "node:assert/strict";
import type { DtcKnowledgePattern } from "@vdp/definitions";
import {
  type EvidenceSet,
  type Hypothesis,
  isProven,
  itemsOf,
  proven,
  unproven,
  unprovenItems,
} from "@vdp/diagnostic-ir";
import type { AdapterInfo, TransportInfo } from "@vdp/transport-can";
import { describe, test } from "vitest";
import { type FixturePatch, patched } from "../../../../tests/helpers/fixture.js";
import type { DtcVariantKnowledge } from "../dtc/scanner.js";
import { createEcuSession, createSession, VehicleSession } from "../session/session.js";
import { collectEvidence, type EvidenceDtc } from "./collect.js";
import { confidenceOf, rankHypotheses, type SamplePoint } from "./hypotheses.js";

const adapter: AdapterInfo = {
  id: "virtual",
  kind: "virtual",
  name: "Virtual CAN",
  channels: ["vcan0"],
};
const transport: TransportInfo = { kind: "virtual", channel: "vcan0", mtu: 8 };

const AT = "2026-09-14T09:00:00.000Z";

function sessionData() {
  const session = new VehicleSession(createSession({ adapter, transport, id: "session_evidence" }));
  session.data.startedAt = AT;
  const ecu = createEcuSession({ name: "Engine", txId: 0x7e0, rxId: 0x7e8 });
  ecu.reachable = true;
  ecu.protocol = "uds";
  session.upsertEcu(ecu);
  session.data.endedAt = "2026-09-14T09:02:00.000Z";
  return session;
}

/** The determination's winning candidate, as the session would have stored it. */
const MATCH = {
  oem: "test",
  packageVersion: "1.0.0",
  vehicleId: "golf-5",
  brand: "VW",
  model: "Golf",
  score: 0.72,
  trust: 0.8,
  provenanceType: "licensed",
  engineIds: [],
  gearboxIds: [],
  ecus: { expected: 2, matched: 2, missing: [] },
  evidence: [],
  conflicts: [],
};

function pattern(overrides: FixturePatch<DtcKnowledgePattern> = {}): DtcKnowledgePattern {
  return patched(
    {
      id: "catalyst-aged",
      name: "Catalyst ageing",
      likelihood: "common",
      checks: [
        {
          signal: "engine.long_term_fuel_trim",
          signalName: "Long term fuel trim",
          expect: "stays neutral",
          min: -5,
          max: 5,
          measurable: true,
        },
      ],
      scope: "vehicle-engine",
    },
    overrides,
  );
}

function knowledge(
  patterns: DtcKnowledgePattern[],
  source: { provenanceType?: string; provenanceSource?: string } = {},
): DtcVariantKnowledge {
  return {
    scope: "vehicle-engine",
    vehicleId: "variant",
    patterns,
    ...(source.provenanceType === undefined ? {} : { provenanceType: source.provenanceType }),
    ...(source.provenanceSource === undefined ? {} : { provenanceSource: source.provenanceSource }),
    notes: [],
  };
}

function dtc(overrides: FixturePatch<EvidenceDtc> = {}): EvidenceDtc {
  return patched(
    {
      code: "P0420",
      ecuId: "engine",
      ecuName: "Engine",
      status: 0x2f,
      statusBits: {
        testFailed: true,
        testFailedThisOperationCycle: true,
        pendingDtc: true,
        confirmedDtc: true,
        testNotCompletedSinceLastClear: false,
        testFailedSinceLastClear: true,
        testNotCompletedThisOperationCycle: false,
        warningIndicatorRequested: false,
      },
      raw: "04202A",
      failureType: "2A",
      severity: "major",
      description: "Catalyst efficiency below threshold",
      evidence: `definition · ${AT} · engine · def 1.0.0`,
      enrichmentEvidence: proven({
        origin: "definition",
        at: AT,
        ecuId: "engine",
        definitionVersion: "1.0.0",
      }),
    },
    overrides,
  );
}

/** One item out of a set, failing loudly when it is not there. */
function item(set: EvidenceSet, id: string) {
  const found = set.items.find((entry) => entry.id === id);
  assert.ok(found, `expected item ${id} in ${set.items.map((i) => i.id).join(", ")}`);
  return found;
}

describe("collectEvidence", () => {
  test("one scan becomes one cited statement per part of what it says", () => {
    const session = sessionData();
    const withKnowledge = dtc({
      knowledge: knowledge([pattern()], {
        provenanceType: "licensed",
        provenanceSource: "workshop manual",
      }),
    });
    const set = collectEvidence({
      session: session.data,
      dtcs: [withKnowledge],
      collectedAt: AT,
    });
    assert.equal(set.kind, "evidence");
    assert.equal(set.sessionId, "session_evidence");
    assert.deepEqual(
      set.items.map((entry) => entry.id).sort(),
      [
        "dtc:P0420@engine",
        "gap:no-measurements:signals",
        "pattern:P0420/catalyst-aged@engine",
      ].sort(),
      "a signal item appears only when a statistic was handed in - no reading, no item; " +
        "the missing measurement is its own gap item",
    );

    const dtcItem = item(set, "dtc:P0420@engine");
    assert.equal(dtcItem.statement, "Catalyst efficiency below threshold (Engine, severity major)");
    assert.ok(isProven(dtcItem.evidence));
    if (dtcItem.evidence.kind === "proven") {
      // The wording's own source, not "the ECU answered": a description comes from a
      // package, and only the package can say whether it wrote one (ADR 0038).
      assert.equal(dtcItem.evidence.provenance.origin, "definition");
      assert.equal(dtcItem.evidence.provenance.definitionVersion, "1.0.0");
    }

    const patternItem = item(set, "pattern:P0420/catalyst-aged@engine");
    assert.equal(patternItem.subject, "P0420/catalyst-aged");
    if (patternItem.evidence.kind === "proven") {
      assert.equal(patternItem.evidence.provenance.origin, "definition");
      assert.match(
        patternItem.evidence.provenance.note ?? "",
        /variant knowledge \(vehicle-engine\) · source: workshop manual \(licensed\)/,
      );
    }
  });

  test("a record without enrichment evidence says the wording cannot be sourced", () => {
    const set = collectEvidence({
      session: sessionData().data,
      dtcs: [dtc({ evidence: undefined, enrichmentEvidence: undefined })],
      collectedAt: AT,
    });
    const entry = item(set, "dtc:P0420@engine");
    assert.equal(entry.evidence.kind, "unproven");
    if (entry.evidence.kind === "unproven") {
      assert.match(entry.evidence.reason, /no enrichment evidence/);
    }
  });

  test("an undocumented code and a variant pattern for it are a conflict, not a winner", () => {
    const set = collectEvidence({
      session: sessionData().data,
      dtcs: [
        dtc({
          description: undefined,
          evidence: undefined,
          enrichmentEvidence: unproven(
            "no description, hint, severity or related signal is documented for this code",
            { at: AT, ecuId: "engine" },
          ),
          knowledge: knowledge([pattern()]),
        }),
      ],
      collectedAt: AT,
    });
    assert.equal(set.conflicts.length, 1);
    const [conflict] = set.conflicts;
    assert.equal(conflict?.subject, "P0420");
    assert.equal(conflict?.left, "dtc:P0420@engine");
    assert.equal(conflict?.right, "pattern:P0420/catalyst-aged@engine");
    assert.match(conflict?.note ?? "", /while variant knowledge describes a failure pattern/);
  });

  test("a freeze frame is reported as presence and length, never decoded", () => {
    const set = collectEvidence({
      session: sessionData().data,
      dtcs: [dtc({ snapshot: new Uint8Array([0x0c, 0x30, 0x41]) })],
      collectedAt: AT,
    });
    const frame = item(set, "freeze-frame:P0420@engine");
    assert.equal(frame.statement, "3 snapshot byte(s) stored with the record");
    assert.ok(!frame.statement.includes("0x0c"), "no byte is interpreted here");
  });

  test("a bare record, a package-wide pattern and a source-less match all stay sayable", () => {
    const session = sessionData();
    // No `endedAt`: the set falls back to the session's start, and an item never
    // invents a moment the session does not hold.
    delete session.data.endedAt;
    const bare = dtc({
      ecuId: undefined,
      ecuName: undefined,
      enrichmentEvidence: unproven("nothing is documented for this code", { at: AT }),
      description: undefined,
      knowledge: {
        scope: "package",
        patterns: [pattern({ likelihood: undefined, scope: "package" })],
        notes: [],
      },
    });
    const set = collectEvidence({
      session: session.data,
      dtcs: [
        bare,
        dtc({
          ecuId: "abs",
          knowledge: knowledge([pattern({ likelihood: undefined, scope: "package" })]),
        }),
      ],
      anomalies: [{ signal: "engine.rpm", reason: "spike" }],
    });
    assert.equal(set.collectedAt, AT, "the session's own start, not a fresh clock read");

    const bareItem = item(set, "dtc:P0420");
    assert.equal("ecuId" in bareItem, false, "no ECU id, no ECU in the item");
    assert.match(bareItem.statement, /unknown ECU/);
    // A pattern's source is the package, whatever the code's own wording looks like:
    // "this is a known pattern" is a documented statement even when nobody wrote a
    // description of the code. Collapsing the two would hide the package's claim
    // behind the ECU's answer (AGENTS 24).
    for (const id of ["pattern:P0420/catalyst-aged", "pattern:P0420/catalyst-aged@abs"]) {
      const patternItem = item(set, id);
      assert.equal(patternItem.evidence.kind, "proven", id);
      if (patternItem.evidence.kind === "proven") {
        assert.equal(
          patternItem.evidence.provenance.note,
          "package-wide wording, nothing variant-specific",
          "no provenance source named, so the note says only what the scope says",
        );
      }
    }
    assert.equal(
      set.conflicts.length,
      1,
      "undocumented code, sourced pattern — the asymmetry is the finding",
    );
    assert.equal(item(set, "anomaly:engine.rpm").statement, "engine.rpm: spike");

    session.data.determination = {
      resolvedAt: AT,
      notes: [],
      unexplained: [],
      alternatives: [],
      match: patched(MATCH, { provenanceType: undefined }),
    };
    const vehicleOnly = collectEvidence({ session: session.data, dtcs: [], collectedAt: AT });
    const hit = item(vehicleOnly, "vehicle:golf-5");
    assert.equal(
      "note" in (hit.evidence.kind === "proven" ? hit.evidence.provenance : {}),
      false,
      "no source type, no source sentence - the score alone is the claim",
    );
    assert.doesNotMatch(hit.statement, /source/);
    // Two items about P0420 on different ECUs, one unproven: no conflict, because
    // the pattern belongs to the *other* ECU's record.
    assert.deepEqual(
      collectEvidence({
        session: session.data,
        dtcs: [
          dtc({
            ecuId: "engine",
            description: undefined,
            enrichmentEvidence: unproven("nothing documented", { at: AT, ecuId: "engine" }),
          }),
          dtc({ ecuId: "abs", knowledge: knowledge([pattern()]) }),
        ],
        collectedAt: AT,
      }).conflicts,
      [],
    );
  });

  test("a stored snapshot's bytes are counted as bytes, and an empty one stays empty", () => {
    const session = sessionData();
    session.addDtcSnapshot(
      [
        patched(dtc(), {
          enrichmentEvidence: proven({ origin: "definition", at: AT }),
          snapshot: new Uint8Array([0x0c, 0x30]),
        }),
        patched(dtc({ code: "P0171" }), { snapshot: new Uint8Array(0) }),
      ],
      "stored",
    );
    const set = collectEvidence({ session: session.data, collectedAt: AT });
    assert.equal(
      item(set, "freeze-frame:P0420@engine").statement,
      "2 snapshot byte(s) stored with the record",
    );
    assert.equal(
      item(set, "freeze-frame:P0171@engine").statement,
      "0 snapshot byte(s) stored with the record",
      "an empty snapshot is a fact, not an absent one",
    );
  });

  test("the open questions of the session are items with unproven evidence", () => {
    const session = sessionData();
    const silent = createEcuSession({ name: "ABS", txId: 0x7c0, rxId: 0x7c8 });
    silent.reachable = false;
    silent.lastError = "session request timed out";
    session.upsertEcu(silent);
    const set = collectEvidence({ session: session.data, dtcs: [dtc()], collectedAt: AT });
    const gaps = unprovenItems(set);
    assert.ok(
      gaps.some((entry) => entry.kind === "gap" && entry.subject === "ABS"),
      gaps.map((entry) => `${entry.kind}/${entry.subject}`).join(" | "),
    );
    assert.equal(itemsOf(set, "gap").length, 2, "the unreachable ECU and the missing measurements");
  });

  test("statistics and anomalies become cited statements of their own", () => {
    const set = collectEvidence({
      session: sessionData().data,
      dtcs: [],
      statistics: [
        {
          signal: "engine.rpm",
          name: "Engine speed",
          unit: "1/min",
          samples: 12,
          min: 700,
          max: 6400,
          average: 2200,
          delta: 5700,
          first: 720,
          last: 780,
          outOfRangeCount: 1,
        },
      ],
      anomalies: [{ signal: "engine.rpm", reason: "delta exceeds 3x the average", value: 6400 }],
      collectedAt: AT,
    });
    const signal = item(set, "signal:engine.rpm");
    assert.match(
      signal.statement,
      /12 sample\(s\), min 700 \/ max 6400 \/ avg 2200 1\/min, 1 out of range/,
    );
    assert.ok(isProven(signal.evidence));
    if (signal.evidence.kind === "proven") {
      assert.equal(
        signal.evidence.provenance.origin,
        "derived",
        "a statistic is computed from readings, not a reading itself",
      );
    }
    assert.equal(
      item(set, "anomaly:engine.rpm").statement,
      "engine.rpm: delta exceeds 3x the average (value 6400)",
    );
  });

  test("the determination is an item, and a missing one is an unproven item", () => {
    const session = sessionData();
    const without = collectEvidence({ session: session.data, dtcs: [], collectedAt: AT });
    assert.deepEqual(itemsOf(without, "vehicle"), []);
    session.data.determination = {
      resolvedAt: AT,
      reason: "no candidate had positive evidence",
      notes: [],
      unexplained: [],
      alternatives: [],
    };
    const unresolved = collectEvidence({ session: session.data, dtcs: [], collectedAt: AT });
    const entry = item(unresolved, "vehicle:determination");
    assert.equal(entry.evidence.kind, "unproven");
    assert.equal(entry.statement, "no candidate had positive evidence");

    session.data.determination = {
      resolvedAt: AT,
      notes: [],
      unexplained: [],
      alternatives: [],
      match: {
        oem: "test",
        packageVersion: "1.0.0",
        vehicleId: "golf-5",
        brand: "VW",
        model: "Golf",
        score: 0.72,
        trust: 0.8,
        provenanceType: "licensed",
        engineIds: [],
        gearboxIds: [],
        ecus: { expected: 2, matched: 2, missing: [] },
        evidence: [],
        conflicts: [],
      },
    };
    const matched = collectEvidence({ session: session.data, dtcs: [], collectedAt: AT });
    const hit = item(matched, "vehicle:golf-5");
    assert.match(hit.statement, /matched on 72 % of the evaluated criteria · source licensed/);
    if (hit.evidence.kind === "proven") {
      assert.equal(hit.evidence.provenance.origin, "definition");
      assert.match(hit.evidence.provenance.note ?? "", /score 72 %/);
    }
  });

  test("without a live scan the last stored one is what gets cited", () => {
    const session = sessionData();
    session.addDtcSnapshot(
      [
        patched(dtc(), {
          evidence: undefined,
          enrichmentEvidence: undefined,
          firstSeenInThisScan: true,
        }),
      ],
      "recorded scan",
    );
    const set = collectEvidence({ session: session.data, collectedAt: AT });
    const entry = item(set, "dtc:P0420@engine");
    assert.equal(
      entry.evidence.kind,
      "unproven",
      "a record that names no proof gets 'we cannot tell', never a default of proven",
    );
  });
});

describe("rankHypotheses", () => {
  const samples = (values: Array<[string, number]>): ((id: string) => readonly SamplePoint[]) => {
    const points = values.map(([at, value]) => ({ at, value }));
    return () => points;
  };

  function ranked(
    options: {
      patterns?: DtcKnowledgePattern[];
      samplesOf?: (id: string) => readonly SamplePoint[];
      dtc?: FixturePatch<EvidenceDtc>;
    } = {},
  ): Hypothesis[] {
    const session = sessionData();
    const entry = dtc({ knowledge: knowledge(options.patterns ?? [pattern()]), ...options.dtc });
    const evidence = collectEvidence({
      session: session.data,
      dtcs: [entry],
      collectedAt: AT,
    });
    return rankHypotheses({
      evidence,
      dtcs: [entry],
      ...(options.samplesOf === undefined ? {} : { samplesOf: options.samplesOf }),
    });
  }

  test("values inside the documented window confirm the pattern", () => {
    const [hypothesis] = ranked({
      samplesOf: samples([
        ["2026-09-14T09:01:55.000Z", 1],
        ["2026-09-14T09:01:59.000Z", -2],
      ]),
    });
    assert.equal(hypothesis?.outcome, "confirmed");
    assert.equal(hypothesis?.code, "P0420");
    assert.equal(
      hypothesis?.confidence,
      0.9,
      "0.6 prior + 0.25 confirmed + 0.05 conclusive, at the cap",
    );
    assert.deepEqual(hypothesis?.evidence, [
      "dtc:P0420@engine",
      "pattern:P0420/catalyst-aged@engine",
    ]);
    assert.equal(hypothesis?.nextTest, undefined, "nothing left to measure");
    assert.match(hypothesis?.reason ?? "", /confirmed on 2 reading\(s\) between/);
  });

  test("a value outside the bounds refutes it — and keeps the pattern visible", () => {
    const [hypothesis] = ranked({
      samplesOf: samples([["2026-09-14T09:01:59.000Z", 14]]),
    });
    assert.equal(hypothesis?.outcome, "refuted");
    assert.equal(
      hypothesis?.confidence,
      0.2,
      "0.6 prior x 0.25 for a refutation + 0.05 for a conclusive window - demoted, never zeroed",
    );
    assert.match(hypothesis?.reason ?? "", /14…14/);
  });

  test("no reading in the window is untested, and never a pass", () => {
    const [hypothesis] = ranked({});
    assert.equal(hypothesis?.outcome, "untested");
    assert.match(
      hypothesis?.reason ?? "",
      /no reading of engine.long_term_fuel_trim in the documented window/,
    );
    assert.deepEqual(hypothesis?.nextTest, {
      signal: "engine.long_term_fuel_trim",
      name: "Long term fuel trim",
      expect: "stays neutral",
      min: -5,
      max: 5,
      measurable: true,
    });
  });

  test("a pattern without checks decides nothing, and is not quietly confirmed", () => {
    const [hypothesis] = ranked({
      patterns: [pattern({ checks: [] })],
      samplesOf: samples([["2026-09-14T09:01:59.000Z", 1]]),
    });
    assert.equal(hypothesis?.outcome, "untested");
    assert.equal(hypothesis?.confidence, 0.45, "0.6 prior - 0.1 untested - 0.05 no window");
    assert.match(hypothesis?.reason ?? "", /documents no check at all/);
  });

  test("a check on an enum signal has no number to compare, so it stays open", () => {
    // `min`/`max` are documented, the recorded values are strings: the window has
    // readings, but none of them is a number - "no verdict" is the only honest answer.
    const [hypothesis] = ranked({
      patterns: [
        pattern({
          checks: [
            {
              signal: "engine.state",
              signalName: "Engine state",
              expect: "running",
              min: 1,
              max: 3,
              measurable: true,
            },
          ],
        }),
      ],
      samplesOf: () => [{ at: "2026-09-14T09:01:59.000Z", value: Number.NaN }],
    });
    assert.equal(hypothesis?.outcome, "untested");
    assert.equal(hypothesis?.checks[0]?.window?.samples, 1, "the reading was there");
    assert.match(hypothesis?.reason ?? "", /window exists but holds no value/);
  });

  test("prose without a number cannot be decided by a window", () => {
    const [hypothesis] = ranked({
      patterns: [
        pattern({
          checks: [
            {
              signal: "engine.rpm",
              signalName: "Engine speed",
              expect: "steady",
              measurable: false,
            },
          ],
        }),
      ],
      samplesOf: samples([["2026-09-14T09:01:59.000Z", 800]]),
    });
    assert.equal(hypothesis?.outcome, "untested");
    assert.match(hypothesis?.reason ?? "", /documents prose only/);
  });

  test("the window is the last windowMs, not the whole recording", () => {
    const [hypothesis] = ranked({
      patterns: [
        pattern({
          checks: [
            {
              signal: "engine.rpm",
              signalName: "Engine speed",
              expect: "idle",
              min: 600,
              max: 900,
              windowMs: 2_000,
              measurable: true,
            },
          ],
        }),
      ],
      samplesOf: samples([
        // Far outside the last two seconds and way beyond the bound: a window that
        // ignored `windowMs` would call this refuted.
        ["2026-09-14T08:00:00.000Z", 5_000],
        ["2026-09-14T09:01:59.000Z", 750],
        ["2026-09-14T09:01:59.500Z", 780],
      ]),
    });
    assert.equal(hypothesis?.outcome, "confirmed");
    assert.equal(hypothesis?.checks[0]?.window?.samples, 2);
    assert.equal(hypothesis?.checks[0]?.window?.max, 780);
  });

  test("the worst check decides the pattern, and each verdict stays visible", () => {
    const [hypothesis] = ranked({
      patterns: [
        pattern({
          checks: [
            { signal: "a", signalName: "A", expect: "low", max: 10, measurable: true },
            { signal: "b", signalName: "B", expect: "high", min: 10, measurable: true },
          ],
        }),
      ],
      samplesOf: (id) =>
        id === "a"
          ? [{ at: "2026-09-14T09:01:59.000Z", value: 1 }]
          : [{ at: "2026-09-14T09:01:59.000Z", value: 1 }],
    });
    assert.equal(hypothesis?.outcome, "refuted", "check b's minimum is not met");
    assert.deepEqual(
      hypothesis?.checks.map((check) => [check.test.signal, check.outcome]),
      [
        ["a", "confirmed"],
        ["b", "refuted"],
      ],
      "both verdicts are readable, so the refutation can be traced to one check",
    );
    assert.equal(
      hypothesis?.nextTest,
      undefined,
      "both checks are decided - a refuted one is an answer, not a task",
    );
  });

  test("only codes with knowledge produce hypotheses", () => {
    const session = sessionData();
    const entry = dtc({ knowledge: undefined });
    const evidence = collectEvidence({ session: session.data, dtcs: [entry], collectedAt: AT });
    assert.deepEqual(rankHypotheses({ evidence, dtcs: [entry] }), []);
    assert.deepEqual(
      evidence.items.map((each) => each.kind),
      ["dtc", "gap"],
      "the code stays an item and the missing measurement stays a gap; no pattern is invented",
    );
  });

  test("an undocumented code lowers the score, because its wording has no source", () => {
    const withSource = ranked({ samplesOf: samples([["2026-09-14T09:01:59.000Z", 1]]) });
    const without = ranked({
      dtc: {
        description: undefined,
        evidence: undefined,
        enrichmentEvidence: unproven("no description, hint, severity or related signal", {
          at: AT,
          ecuId: "engine",
        }),
      },
      samplesOf: samples([["2026-09-14T09:01:59.000Z", 1]]),
    });
    assert.ok(
      (without[0]?.confidence ?? 0) < (withSource[0]?.confidence ?? 0),
      `${without[0]?.confidence} vs ${withSource[0]?.confidence}`,
    );
  });

  test("the ranking is deterministic: equal scores order by code, not by arrival", () => {
    const session = sessionData();
    const entries = [
      dtc({ code: "P0500", knowledge: knowledge([pattern({ id: "x" })]) }),
      dtc({ code: "P0420", knowledge: knowledge([pattern({ id: "y" })]) }),
    ];
    const evidence = collectEvidence({ session: session.data, dtcs: entries, collectedAt: AT });
    const rankedEntries = rankHypotheses({ evidence, dtcs: entries });
    assert.deepEqual(
      rankedEntries.map((entry) => entry.id),
      ["y", "x"],
      "both score the same, so the tie-break is the code (P0420 before P0500) - a rerun prints the same list, and so does a reordered scan",
    );
    assert.deepEqual(
      rankHypotheses({
        evidence: collectEvidence({
          session: sessionData().data,
          dtcs: [...entries].reverse(),
          collectedAt: AT,
        }),
        dtcs: [...entries].reverse(),
      }).map((entry) => entry.id),
      ["y", "x"],
    );
  });

  test("confidenceOf is the arithmetic it documents", () => {
    assert.equal(
      confidenceOf({ prior: 0.6, outcome: "confirmed", conclusive: true, codeDocumented: true }),
      0.9,
      "the cap, not 0.90",
    );
    assert.equal(
      confidenceOf({ prior: 0.25, outcome: "refuted", conclusive: false, codeDocumented: true }),
      0.05,
      "0.25 × 0.25 - 0.05 - 0.15 lands on the floor",
    );
    assert.equal(
      confidenceOf({ prior: 0.45, outcome: "untested", conclusive: false, codeDocumented: true }),
      0.3,
      "no measurement, no claim",
    );
  });
});
