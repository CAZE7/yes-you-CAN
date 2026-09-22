/**
 * The diagnostic IR: observations with evidence (master backlog P0 #6).
 *
 * What these tests pin down is not the shape of the types but the two properties
 * the rest of the platform relies on:
 *
 * 1. an observation that could not be taken is **data** ({@link SignalGap}), not a
 *    missing entry — a report can name the missing measurement instead of
 *    silently dropping it,
 * 2. every value carries where it came from, and knowledge about a value carries
 *    its own provenance (a code nobody documented says so).
 */

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  compareDtcObservations,
  type DtcObservation,
  describeEvidence,
  dtcEnrichment,
  dtcKey,
  dtcObservation,
  type EvidenceSet,
  ecuObservation,
  evidenceItemId,
  gaps,
  isProven,
  itemById,
  itemsOf,
  measurementWindow,
  proven,
  reachableEcus,
  readings,
  sessionObservation,
  signalGap,
  signalReading,
  summariseWindow,
  unproven,
  unprovenItems,
  unreachableEcus,
} from "./index.js";

const AT = "2026-09-14T10:00:00.000Z";

function statusBits(testFailed: boolean) {
  return {
    testFailed,
    testFailedThisOperationCycle: testFailed,
    pendingDtc: false,
    confirmedDtc: !testFailed,
    testNotCompletedSinceLastClear: false,
    testFailedSinceLastClear: testFailed,
    testNotCompletedThisOperationCycle: false,
    warningIndicatorRequested: false,
  };
}

describe("evidence", () => {
  test("proven evidence records origin, time and the bytes it came from", () => {
    const evidence = proven({
      origin: "ecu-response",
      at: AT,
      ecuId: "ecu_1",
      did: 0x0c00,
      raw: "0C 30",
      definitionVersion: "3.1.0",
    });
    assert.equal(evidence.kind, "proven");
    assert.equal(isProven(evidence), true);
    assert.equal(evidence.provenance.at, AT);
    assert.match(describeEvidence(evidence), /ecu-response · 2026-09-14T10:00:00\.000Z · ecu_1/);
    assert.match(describeEvidence(evidence), /DID 0xC00/);
  });

  test("proven evidence without a timestamp is stamped now, never left open", () => {
    const before = Date.now();
    const evidence = proven({ origin: "derived" });
    assert.ok(Date.parse(evidence.provenance.at) >= before - 1_000);
  });

  test("unproven evidence says what was attempted and why it failed", () => {
    const evidence = unproven("the ECU did not answer the DID read", {
      at: AT,
      ecuId: "ecu_1",
      did: 0x0c00,
    });
    assert.equal(evidence.kind, "unproven");
    assert.equal(isProven(evidence), false);
    assert.equal(evidence.reason, "the ECU did not answer the DID read");
    assert.equal(
      describeEvidence(evidence),
      "not proven (ecu_1): the ECU did not answer the DID read",
    );
    assert.equal(describeEvidence(unproven("nothing read")), "not proven: nothing read");
  });
});

describe("signal observations", () => {
  test("a reading keeps the raw bytes, the decoded value and its provenance", () => {
    const reading = signalReading({
      signalId: "engine.rpm",
      name: "Engine speed",
      ecuId: "ecu_1",
      did: 0x0c00,
      raw: Uint8Array.from([0x0c, 0x30]),
      rawHex: "0C 30",
      rawValue: 3120,
      value: 780,
      unit: "rpm",
      outOfRange: false,
      at: AT,
      definitionVersion: "3.1.0",
    });

    assert.equal(reading.kind, "signal");
    assert.equal(reading.value, 780);
    assert.equal(reading.rawHex, "0C 30");
    assert.equal(reading.unit, "rpm");
    assert.ok(isProven(reading.evidence), "a decoded value is a proven observation");
    assert.equal(reading.evidence.provenance.did, 0x0c00);
    assert.equal(reading.evidence.provenance.raw, "0C 30");
    assert.equal(reading.evidence.provenance.definitionVersion, "3.1.0");
  });

  test("absent optional parts stay absent instead of becoming undefined fields", () => {
    const reading = signalReading({
      signalId: "abs.lamp",
      ecuId: "ecu_2",
      did: 0x2200,
      raw: Uint8Array.from([0x01]),
      rawHex: "01",
      rawValue: true,
      value: true,
      outOfRange: false,
      at: AT,
    });
    assert.equal("unit" in reading, false);
    assert.equal("name" in reading, false);
    assert.equal("enumText" in reading, false);
  });

  test("a reading that could not be taken is a gap, not a missing entry", () => {
    const gap = signalGap({
      signalId: "engine.rpm",
      name: "Engine speed",
      ecuId: "ecu_1",
      did: 0x0c00,
      reason: "the ECU did not answer the DID read",
      at: AT,
    });
    assert.equal(gap.kind, "signal-gap");
    assert.equal(gap.evidence.kind, "unproven");
    assert.equal(gap.evidence.reason, "the ECU did not answer the DID read");
    assert.equal(gap.evidence.did, 0x0c00);

    const list = [
      signalReading({
        signalId: "engine.rpm",
        ecuId: "ecu_1",
        did: 0x0c00,
        raw: Uint8Array.from([0x00, 0x10]),
        rawHex: "00 10",
        rawValue: 16,
        value: 4,
        at: AT,
        outOfRange: false,
      }),
      gap,
    ];
    assert.deepEqual(
      readings(list).map((entry) => entry.signalId),
      ["engine.rpm"],
    );
    assert.deepEqual(
      gaps(list).map((entry) => entry.reason),
      ["the ECU did not answer the DID read"],
    );
  });
});

describe("fault-memory observations", () => {
  const observation = dtcObservation({
    code: "P0420",
    raw: "P0420",
    failureType: "00",
    status: 0x2f,
    statusBits: statusBits(true),
    ecuId: "ecu_1",
    ecuName: "Engine control unit",
    at: AT,
    definitionVersion: "3.1.0",
  });

  test("an observation records what the ECU said, with the service that asked", () => {
    assert.equal(observation.kind, "dtc");
    assert.equal(observation.status, 0x2f);
    assert.equal(observation.statusBits.testFailed, true);
    assert.ok(isProven(observation.evidence));
    assert.equal(observation.evidence.provenance.serviceId, 0x19);
    assert.equal(observation.evidence.provenance.ecuId, "ecu_1");
  });

  test("knowledge about a code carries its own provenance", () => {
    const documented = dtcEnrichment({
      code: "P0420",
      ecuId: "ecu_1",
      description: "Catalyst efficiency below threshold",
      relatedSignals: [{ id: "engine.rpm", name: "Engine speed" }],
      at: AT,
      definitionVersion: "3.1.0",
    });
    assert.ok(isProven(documented.evidence), "documented knowledge is proven");
    assert.equal(documented.evidence.provenance.origin, "definition");

    // The interesting case: nobody documented this code. That is an observation
    // too, and it is unproven — not an empty enrichment.
    const undocumented = dtcEnrichment({ code: "P0999", ecuId: "ecu_1", at: AT });
    assert.equal(undocumented.evidence.kind, "unproven");
    assert.equal("description" in undocumented, false);
    // The reason lists every field that would have made the claim proven — since
    // P0 #6 (ADR 0037) that includes the severity a package may declare on its own.
    assert.match(
      described(undocumented.evidence),
      /no description, hint, severity or related signal/,
    );
  });

  test("a snapshot record and a definition version travel with the observation", () => {
    const withSnapshot = dtcObservation({
      code: "P0420",
      raw: "P0420",
      failureType: "00",
      status: 0x2f,
      statusBits: statusBits(true),
      ecuId: "ecu_1",
      ecuName: "Engine control unit",
      at: AT,
      snapshot: Uint8Array.from([0x0c, 0x30]),
    });
    assert.deepEqual(withSnapshot.snapshot, Uint8Array.from([0x0c, 0x30]));
    assert.equal("snapshot" in observation, false, "an ECU that sent no snapshot leaves none");

    const withVersion = dtcObservation({
      code: "P0420",
      raw: "P0420",
      failureType: "00",
      status: 0x2f,
      statusBits: statusBits(true),
      ecuId: "ecu_1",
      ecuName: "Engine control unit",
      at: AT,
      definitionVersion: "3.1.0",
    });
    assert.ok(isProven(withVersion.evidence));
    assert.equal(withVersion.evidence.provenance.definitionVersion, "3.1.0");
  });

  test("a classification and the bytes beside it travel with the observation", () => {
    const observation = dtcObservation({
      code: "P0420",
      raw: "04202A",
      failureType: "2A",
      status: 0x2f,
      statusBits: statusBits(true),
      ecuId: "ecu_1",
      ecuName: "Engine control unit",
      at: AT,
      severity: "major",
      snapshot: new Uint8Array([0x0c, 0x30]),
      extendedData: new Uint8Array([0x01]),
    });
    assert.equal(observation.severity, "major");
    assert.deepEqual(Array.from(observation.snapshot ?? []), [0x0c, 0x30]);
    assert.deepEqual(Array.from(observation.extendedData ?? []), [0x01]);
    // The raw DTC value belongs to the provenance as much as to the record: an
    // audit that knows the code but not the bytes cannot re-derive the claim.
    if (isProven(observation.evidence)) {
      assert.equal(observation.evidence.provenance.raw, "04202A");
    }

    const bare = dtcObservation({
      code: "P0420",
      raw: "",
      failureType: "2A",
      status: 0x2f,
      statusBits: statusBits(true),
      ecuId: "ecu_1",
      ecuName: "Engine",
      at: AT,
    });
    assert.equal("severity" in bare, false, "an unclassified code stays unclassified");
    assert.equal("snapshot" in bare, false);
    assert.equal("extendedData" in bare, false);
    if (isProven(bare.evidence)) {
      assert.equal(
        "raw" in bare.evidence.provenance,
        false,
        "no bytes, no raw entry - an empty string would read as a claim",
      );
    }
  });

  test("a severity the package declares on its own is documentation", () => {
    const severityOnly = dtcEnrichment({
      code: "P0420",
      ecuId: "ecu_1",
      severity: "minor",
      at: AT,
    });
    assert.ok(isProven(severityOnly.evidence), "saying how bad it is, is saying something");
    assert.equal(severityOnly.severity, "minor");
  });

  test("knowledge counts as documented as soon as one part of it exists", () => {
    const hintOnly = dtcEnrichment({
      code: "P0420",
      ecuId: "ecu_1",
      hint: "Check the post-catalyst sensor",
      at: AT,
    });
    assert.ok(isProven(hintOnly.evidence), "a hint is documentation");
    assert.equal(hintOnly.evidence.provenance.note, "Check the post-catalyst sensor");

    const emptyRelated = dtcEnrichment({
      code: "P0420",
      ecuId: "ecu_1",
      relatedSignals: [],
      at: AT,
    });
    assert.equal(
      emptyRelated.evidence.kind,
      "unproven",
      "an empty list documents nothing - it is not a note that everything is fine",
    );
    assert.equal("relatedSignals" in emptyRelated, true, "the empty list is kept as read");
  });

  test("the same code on two ECUs is two identities", () => {
    // A scan of several ECUs is the normal case. Keying on the bare code would
    // turn "the transmission also reports P0700" into one disappearance and one
    // appearance of a code that never moved (P0 #6, ADR 0037).
    const forEcu = (ecuId: string, name: string, status: number): DtcObservation =>
      dtcObservation({
        code: "P0700",
        raw: "047000",
        failureType: "00",
        status,
        statusBits: statusBits(status === 0x2f),
        ecuId,
        ecuName: name,
        at: AT,
      });
    const before = [forEcu("engine", "Engine", 0x2f), forEcu("gearbox", "Gearbox", 0x2f)];
    const after = [forEcu("engine", "Engine", 0x2f)];
    const comparison = compareDtcObservations(before, after);
    assert.deepEqual(comparison.changed, []);
    assert.equal(comparison.unchanged.length, 1);
    assert.deepEqual(
      comparison.removed.map((entry) => entry.ecuId),
      ["gearbox"],
    );

    assert.equal(dtcKey({ ecuId: "engine", code: " p0420 " }), "engine:P0420");
    assert.deepEqual(
      compareDtcObservations(
        [forEcu("engine", "Engine", 0x2f)],
        [
          {
            ...forEcu("engine", "Engine", 0x2f),
            code: "P0700 ".padEnd(6, " "),
            raw: "047000",
            statusBits: statusBits(true),
          },
        ],
      ).unchanged.length,
      1,
      "identity is the code within its ECU - surrounding space and case are spelling, not another fault",
    );
  });

  test("a comparison names what stayed, changed, appeared and disappeared", () => {
    const stayed = dtcObservation({
      code: "P0420",
      raw: "P0420",
      failureType: "00",
      status: 0x2f,
      statusBits: statusBits(true),
      ecuId: "ecu_1",
      ecuName: "Engine control unit",
      at: AT,
    });
    const storedOnly = dtcObservation({
      code: "P0300",
      raw: "P0300",
      failureType: "00",
      status: 0x08,
      statusBits: statusBits(false),
      ecuId: "ecu_1",
      ecuName: "Engine control unit",
      at: AT,
    });
    const newCode = dtcObservation({
      code: "P0171",
      raw: "P0171",
      failureType: "00",
      status: 0x04,
      statusBits: statusBits(false),
      ecuId: "ecu_1",
      ecuName: "Engine control unit",
      at: AT,
    });
    const after = { ...stayed, at: "2026-09-14T10:05:00.000Z", status: 0x03 };

    const comparison = compareDtcObservations([stayed, storedOnly], [after, newCode]);
    assert.deepEqual(
      comparison.removed.map((entry) => entry.code),
      ["P0300"],
    );
    assert.deepEqual(
      comparison.changed.map((entry) => entry.code),
      ["P0420"],
    );
    assert.deepEqual(
      comparison.added.map((entry) => entry.code),
      ["P0171"],
    );
    assert.deepEqual(comparison.unchanged, []);

    const untouched = compareDtcObservations([stayed], [stayed]);
    assert.deepEqual(
      untouched.unchanged.map((entry) => entry.code),
      ["P0420"],
    );
    assert.deepEqual(untouched.changed, []);
  });
});

describe("session observations", () => {
  test("a discovered ECU that does not answer keeps its reason", () => {
    const ecu = ecuObservation({
      ecuId: "ecu_9",
      name: "ABS",
      protocol: "uds",
      txId: 0x733,
      rxId: 0x77b,
      reachable: false,
      lastError: "session request timed out",
      at: AT,
    });
    assert.equal(ecu.reachable, false);
    assert.equal(ecu.evidence.kind, "unproven");
    assert.equal(ecu.evidence.reason, "session request timed out");
    assert.equal(ecu.telemetry.p2Ms, 50, "a default timing is declared, not left out");

    const session = sessionObservation({
      sessionId: "sess_1",
      adapter: { kind: "virtual", channels: ["vcan0"] },
      transport: { kind: "can", channel: "vcan0", mtu: 8 },
      startedAt: AT,
      ecus: [
        ecuObservation({
          ecuId: "ecu_1",
          name: "Engine",
          protocol: "uds",
          txId: 0x7e0,
          rxId: 0x7e8,
          at: AT,
        }),
        ecu,
      ],
    });
    assert.equal(session.ecus.length, 2);
    assert.deepEqual(
      reachableEcus(session).map((entry) => entry.ecuId),
      ["ecu_1"],
    );
    assert.deepEqual(
      unreachableEcus(session).map((entry) => entry.ecuId),
      ["ecu_9"],
    );
    assert.match(describeEvidence(session.evidence), /session on virtual \(vcan0\)/);
  });

  test("an ECU comes with everything the definition and the probe found", () => {
    const ecu = ecuObservation({
      ecuId: "ecu_1",
      definitionEcuId: "engine",
      name: "Engine",
      protocol: "uds",
      txId: 0x7e0,
      rxId: 0x7e8,
      extended: true,
      sessionType: 0x03,
      p2Ms: 25,
      p2StarMs: 5000,
      supportedServices: [0x10, 0x22],
      identification: [{ label: "VIN", value: "WVWZZZ1JZXW000001", did: 0xf190 }],
      at: AT,
    });
    assert.equal(ecu.definitionEcuId, "engine");
    assert.equal(ecu.sessionType, 0x03);
    assert.equal(ecu.telemetry.p2Ms, 25);
    assert.equal(ecu.telemetry.p2StarMs, 5000);
    assert.deepEqual(ecu.supportedServices, [0x10, 0x22]);
    assert.equal(ecu.identification?.[0]?.did, 0xf190);
    assert.equal(ecu.extended, true);
    assert.equal(ecu.reachable, true, "reachable is the default and has to say so");

    const bare = ecuObservation({
      ecuId: "ecu_2",
      name: "Gateway",
      protocol: "unknown",
      txId: 0x710,
      rxId: 0x718,
      reachable: false,
      at: AT,
    });
    assert.equal("definitionEcuId" in bare, false);
    assert.equal("sessionType" in bare, false);
    assert.equal("supportedServices" in bare, false);
    assert.equal("identification" in bare, false);
    assert.equal(bare.evidence.kind, "unproven");
    assert.equal(bare.evidence.reason, "the ECU did not answer");
  });

  test("a finished session keeps its end, and none of them hides its ECUs", () => {
    const session = sessionObservation({
      sessionId: "sess_3",
      adapter: { kind: "virtual", channels: ["vcan0"] },
      transport: { kind: "can", channel: "vcan0" },
      startedAt: AT,
      endedAt: "2026-09-14T10:30:00.000Z",
      ecus: [
        ecuObservation({
          ecuId: "ecu_1",
          name: "Engine",
          protocol: "uds",
          txId: 0x7e0,
          rxId: 0x7e8,
          at: AT,
        }),
      ],
    });
    assert.equal(session.endedAt, "2026-09-14T10:30:00.000Z");
    assert.equal(unreachableEcus(session).length, 0);
    assert.equal(reachableEcus(session).length, 1);
  });

  test("a session without a channel says so instead of leaving the note empty", () => {
    const session = sessionObservation({
      sessionId: "sess_2",
      adapter: { kind: "generic", channels: [] },
      transport: { kind: "can", channel: "" },
      startedAt: AT,
    });
    assert.match(describeEvidence(session.evidence), /no channel/);
    assert.deepEqual(session.ecus, []);
  });
});

describe("measurement windows", () => {
  const readingAt = (value: number, at: string) =>
    signalReading({
      signalId: "rail.pressure",
      ecuId: "ecu_1",
      did: 0x2200,
      raw: Uint8Array.from([0x01]),
      rawHex: "01",
      rawValue: 1,
      value,
      unit: "bar",
      outOfRange: false,
      at,
    });

  test("a window reports count, extremes and mean of the readings inside it", () => {
    const window = measurementWindow(
      [readingAt(120, "2026-09-14T10:00:00.000Z"), readingAt(160, "2026-09-14T10:00:01.000Z")],
      [],
      {
        signalId: "rail.pressure",
        from: "2026-09-14T09:59:59.000Z",
        to: "2026-09-14T10:00:02.000Z",
      },
    );
    assert.equal(window.samples, 2);
    assert.equal(window.min, 120);
    assert.equal(window.max, 160);
    assert.equal(window.mean, 140);
    assert.equal(window.unit, "bar");
    assert.equal(window.conclusive, true);
  });

  test("readings outside the window are ignored, gaps inside make it inconclusive", () => {
    const window = measurementWindow(
      [
        readingAt(120, "2026-09-14T10:00:00.000Z"),
        readingAt(999, "2026-09-14T10:00:05.000Z"),
        readingAt(999, "not a timestamp"),
      ],
      [
        signalGap({
          signalId: "rail.pressure",
          reason: "the ECU did not answer",
          at: "2026-09-14T10:00:01.000Z",
        }),
        signalGap({
          signalId: "rail.pressure",
          reason: "outside the window",
          at: "2026-09-14T11:00:00.000Z",
        }),
      ],
      {
        signalId: "rail.pressure",
        from: "2026-09-14T09:59:59.000Z",
        to: "2026-09-14T10:00:02.000Z",
      },
    );
    assert.equal(window.samples, 1);
    assert.equal(window.min, 120);
    assert.deepEqual(
      window.gaps.map((gap) => gap.reason),
      ["the ECU did not answer"],
      "only the gap inside the window counts",
    );
    assert.equal(
      window.conclusive,
      false,
      "one gap is enough to make a window a picture, not proof",
    );
  });

  test("a window with no readings is inconclusive and invents no statistics", () => {
    const window = measurementWindow([], [], {
      signalId: "rail.pressure",
      from: "2026-09-14T10:00:00.000Z",
      to: "2026-09-14T10:00:01.000Z",
    });
    assert.equal(window.samples, 0);
    assert.equal(window.conclusive, false);
    assert.equal("min" in window, false);
    assert.equal("max" in window, false);
    assert.equal("mean" in window, false);
  });

  test("non-numeric readings count as samples but produce no statistics", () => {
    const window = measurementWindow(
      [
        signalReading({
          signalId: "engine.state",
          ecuId: "ecu_1",
          did: 0x2201,
          raw: Uint8Array.from([0x02]),
          rawHex: "02",
          rawValue: "RUNNING",
          value: "RUNNING",
          enumText: "RUNNING",
          outOfRange: false,
          at: "2026-09-14T10:00:00.000Z",
        }),
      ],
      [],
      {
        signalId: "engine.state",
        from: "2026-09-14T09:59:00.000Z",
        to: "2026-09-14T10:01:00.000Z",
      },
    );
    assert.equal(window.samples, 1);
    assert.equal(window.conclusive, true);
    assert.equal("mean" in window, false);
  });
});

describe("evidence items and windows", () => {
  const set: EvidenceSet = {
    kind: "evidence",
    sessionId: "session_1",
    collectedAt: AT,
    items: [
      {
        id: evidenceItemId("dtc", " p0420 ", "engine"),
        kind: "dtc",
        subject: "P0420",
        statement: "catalyst efficiency below threshold",
        at: AT,
        ecuId: "engine",
        evidence: proven({ origin: "ecu-response", at: AT }),
      },
      {
        id: evidenceItemId("gap", "no-measurements:signals"),
        kind: "gap",
        subject: "signals",
        statement: "no signal was recorded",
        at: AT,
        evidence: unproven("no signal was recorded", { at: AT }),
      },
    ],
    conflicts: [],
  };

  test("an item id is a key, not a sentence", () => {
    assert.equal(
      evidenceItemId("dtc", " p0420 ", "engine"),
      "dtc:p0420@engine",
      "surrounding space is trimmed, the subject is not otherwise rewritten — the collector's words are its own",
    );
    assert.equal(evidenceItemId("signal", "engine.rpm"), "signal:engine.rpm");
  });

  test("a set answers the three questions a consumer asks", () => {
    assert.deepEqual(
      itemsOf(set, "dtc").map((item) => item.id),
      ["dtc:p0420@engine"],
    );
    assert.equal(itemById(set, "nope"), undefined);
    assert.deepEqual(
      unprovenItems(set).map((item) => item.subject),
      ["signals"],
    );
  });

  test("the window computation is one place, whichever shape comes in", () => {
    const readings = [
      signalReading({
        signalId: "engine.rpm",
        ecuId: "engine",
        did: 0xf40c,
        raw: new Uint8Array([0x02]),
        rawHex: "02",
        rawValue: 2,
        value: 2000,
        unit: "1/min",
        outOfRange: false,
        at: AT,
      }),
      signalReading({
        signalId: "engine.load",
        ecuId: "engine",
        did: 0xf40d,
        raw: new Uint8Array([0x05]),
        rawHex: "05",
        rawValue: 5,
        value: 50,
        outOfRange: false,
        at: AT,
      }),
    ];
    const viaReadings = measurementWindow(readings, [], {
      signalId: "engine.rpm",
      from: "2026-09-14T09:00:00.000Z",
      to: "2026-09-14T11:00:00.000Z",
    });
    const viaPoints = summariseWindow([{ at: AT, value: 2000 }], [], {
      signalId: "engine.rpm",
      from: "2026-09-14T09:00:00.000Z",
      to: "2026-09-14T11:00:00.000Z",
      unit: "1/min",
    });
    assert.deepEqual(viaReadings, viaPoints, "readings are points with more history around them");
    assert.equal(viaReadings.unit, "1/min");
  });

  test("a window counts what it cannot average, and says so", () => {
    const window = summariseWindow(
      [
        { at: "2026-09-14T09:30:00.000Z", value: "engaging" },
        { at: "2026-09-14T10:30:00.000Z", value: 3_000 },
        { at: "2026-09-14T12:30:00.000Z", value: 9_000 },
      ],
      [signalGap({ signalId: "engine.rpm", ecuId: "engine", reason: "no answer", at: AT })],
      {
        signalId: "engine.rpm",
        from: "2026-09-14T09:00:00.000Z",
        to: "2026-09-14T11:00:00.000Z",
      },
    );
    assert.equal(window.samples, 2, "the outside point is out of the span, the enum is in it");
    assert.equal(window.min, 3_000, "only numbers contribute");
    assert.equal(window.max, 3_000);
    assert.equal(window.conclusive, false, "a gap in the span stops the window from judging");
    assert.equal(window.gaps.length, 1);
  });

  test("guided diagnosis types model in-progress, resolved and inconclusive states", () => {
    const state: import("./evidence.js").GuidedDiagnosisState = {
      sessionId: "session-test",
      status: "in-progress",
      hypotheses: [],
      evidenceCount: 4,
      evidenceIds: ["dtc:P0420@engine", "pattern:P0420/cat-efficiency@engine"],
      stepsCompleted: 1,
      summary: "Diagnosing P0420",
      nextRecommendedTest: {
        hypothesisId: "cat-efficiency",
        test: {
          signal: "engine.short_term_fuel_trim",
          expect: "Normal fuel trim oscillation",
          measurable: true,
        },
        rationale: "Tests catalyst efficiency",
        discriminatesAgainst: ["exhaust-leak"],
        uncertaintyReduction: 0.6,
      },
    };
    assert.equal(state.status, "in-progress");
    assert.equal(state.nextRecommendedTest?.discriminatesAgainst?.[0], "exhaust-leak");
    assert.equal(
      state.evidenceIds.length,
      2,
      "the state carries the ids a step diff is taken over",
    );
  });
});

/** Local shorthand so the assertions read like sentences. */
function described(evidence: Parameters<typeof describeEvidence>[0]): string {
  return describeEvidence(evidence);
}
