/**
 * Session observations (P0 #6, ADR 0037): the stored session seen through the IR,
 * and the questions it leaves open.
 *
 * The tests are written around the one property that makes the projection worth
 * having: a live session and the same session reloaded from `session.json` answer
 * identically. Anything that is true only while the process runs would make a
 * report, a replay and an AI disagree about the same recording.
 */

import assert from "node:assert/strict";
import { isProven, reachableEcus, unreachableEcus } from "@vdp/diagnostic-ir";
import type { DtcRecord } from "@vdp/protocols-uds";
import type { AdapterInfo, TransportInfo } from "@vdp/transport-can";
import { describe, test } from "vitest";
import {
  dtcObservationsOf,
  ecuObservationOf,
  type SessionGap,
  sessionGapsOf,
  sessionObservationOf,
} from "./observation.js";
import {
  createEcuSession,
  createSession,
  VehicleSession,
  type VehicleSessionData,
} from "./session.js";

const adapter: AdapterInfo = {
  id: "virtual",
  kind: "virtual",
  name: "Virtual CAN",
  firmware: "1.4.2",
  channels: ["vcan0"],
};
const transport: TransportInfo = { kind: "virtual", channel: "vcan0", mtu: 8, txId: 0x7e0 };

const statusBits = {
  testFailed: true,
  testFailedThisOperationCycle: true,
  pendingDtc: true,
  confirmedDtc: true,
  testNotCompletedSinceLastClear: false,
  testFailedSinceLastClear: true,
  testNotCompletedThisOperationCycle: false,
  warningIndicatorRequested: false,
};

const documentedDtc = (code: string, description?: string): DtcRecord & { ecuId: string } => ({
  code,
  raw: "04202A",
  failureType: "2A",
  status: 0x2f,
  statusBits,
  severity: "critical",
  ecuId: "engine",
  ...(description === undefined ? {} : { description }),
});

function answeringEcu(): ReturnType<typeof createEcuSession> {
  const ecu = createEcuSession({
    name: "Engine",
    txId: 0x7e0,
    rxId: 0x7e8,
    definitionEcuId: "engine",
  });
  ecu.reachable = true;
  ecu.protocol = "uds";
  ecu.sessionType = 0x03;
  ecu.identification = [{ label: "part number", value: "06A906018", did: 0xf187 }];
  ecu.supportedServices = [0x19, 0x22];
  return ecu;
}

function silentEcu(): ReturnType<typeof createEcuSession> {
  const ecu = createEcuSession({ name: "ABS", txId: 0x7c0, rxId: 0x7c8 });
  ecu.reachable = false;
  ecu.lastError = "session request timed out";
  return ecu;
}

function sessionWith(records: readonly (DtcRecord & { ecuId: string })[]): VehicleSessionData {
  const session = new VehicleSession(
    createSession({
      adapter,
      transport,
      id: "session_test",
      definitionPackage: { oem: "vag", version: "1.2.0" },
    }),
  );
  session.data.startedAt = "2026-09-14T09:00:00.000Z";
  session.data.endedAt = "2026-09-14T09:01:00.000Z";
  session.upsertEcu(answeringEcu());
  session.upsertEcu(silentEcu());
  if (records.length > 0) session.addDtcSnapshot(records, "test scan");
  return session.data;
}

/** What `save` + `load` do to a session, without a file system in the way. */
function reloaded(data: VehicleSessionData): VehicleSessionData {
  return JSON.parse(JSON.stringify(data)) as VehicleSessionData;
}

describe("ecuObservationOf", () => {
  test("an ECU that answers carries its addresses, timing and identification", () => {
    const observation = ecuObservationOf(answeringEcu(), "2026-09-14T09:01:00.000Z");
    assert.equal(observation.name, "Engine");
    assert.equal(observation.definitionEcuId, "engine");
    assert.equal(observation.txId, 0x7e0);
    assert.equal(observation.rxId, 0x7e8);
    assert.equal(observation.sessionType, 0x03);
    assert.equal(observation.telemetry.p2Ms, 50);
    assert.deepEqual(observation.supportedServices, [0x19, 0x22]);
    assert.deepEqual(observation.identification, [
      { label: "part number", value: "06A906018", did: 0xf187 },
    ]);
    assert.equal(observation.at, "2026-09-14T09:01:00.000Z");
    assert.ok(isProven(observation.evidence));
  });

  test("an ECU that stays silent keeps its reason instead of becoming an empty record", () => {
    const observation = ecuObservationOf(silentEcu());
    assert.equal(observation.reachable, false);
    assert.equal(observation.lastError, "session request timed out");
    assert.equal(observation.evidence.kind, "unproven");
    if (observation.evidence.kind === "unproven") {
      assert.equal(observation.evidence.reason, "session request timed out");
    }
  });
});

describe("sessionObservationOf", () => {
  test("the observation names how the session was measured", () => {
    const observation = sessionObservationOf(sessionWith([]));
    assert.equal(observation.kind, "session");
    assert.equal(observation.sessionId, "session_test");
    assert.deepEqual(
      { ...observation.adapter, channels: [...observation.adapter.channels] },
      {
        kind: "virtual",
        id: "virtual",
        name: "Virtual CAN",
        firmware: "1.4.2",
        channels: ["vcan0"],
      },
    );
    assert.equal(observation.transport.mtu, 8);
    assert.equal(observation.transport.txId, 0x7e0);
    assert.equal(observation.startedAt, "2026-09-14T09:00:00.000Z");
    assert.equal(observation.endedAt, "2026-09-14T09:01:00.000Z");
    assert.equal(reachableEcus(observation).length, 1);
    assert.equal(unreachableEcus(observation).length, 1);
  });

  test("the observation does not alias the session: writing to it cannot change the record", () => {
    const data = sessionWith([]);
    const observation = sessionObservationOf(data);
    observation.adapter.channels = ["other"];
    observation.ecus[0]!.name = "Renamed";
    assert.deepEqual(data.adapter.channels, ["vcan0"]);
    assert.equal(data.ecus[0]?.name, "Engine");
  });

  test("an ECU observation of a closed session is stamped with the end of the window", () => {
    const observation = sessionObservationOf(sessionWith([]));
    assert.equal(observation.ecus[0]?.at, "2026-09-14T09:01:00.000Z");
    const open = new VehicleSession(createSession({ adapter, transport }));
    open.upsertEcu(answeringEcu());
    assert.equal(
      sessionObservationOf(open.data).ecus[0]?.at,
      open.data.startedAt,
      "a running session has no end, so the window's start is the honest answer",
    );
  });

  test("a reloaded session answers exactly like the live one", () => {
    const live = sessionWith([documentedDtc("P0420", "Catalyst efficiency below threshold")]);
    const stored = reloaded(live);
    assert.notEqual(
      JSON.stringify(live),
      undefined,
      "sanity: the round trip is a string comparison of the same shape",
    );
    assert.deepEqual(sessionObservationOf(stored), sessionObservationOf(live));
    assert.deepEqual(dtcObservationsOf(stored), dtcObservationsOf(live));
  });

  test("a freeze frame survives the round trip as bytes, not as an object", () => {
    const data = sessionWith([]);
    const withBytes = structuredClone(data);
    withBytes.dtcSnapshots[0] ??= {
      id: "dtc_1",
      takenAt: "2026-09-14T09:00:30.000Z",
      records: [{ ...documentedDtc("P0420"), snapshot: new Uint8Array([0x0c, 0x30]) }],
    };
    const [observation] = dtcObservationsOf(reloaded(withBytes));
    assert.ok(observation?.snapshot instanceof Uint8Array);
    assert.deepEqual(Array.from(observation.snapshot), [0x0c, 0x30]);
  });

  test("a stored field that is not a byte list is refused, not reinterpreted", () => {
    const data = sessionWith([]);
    const hostile = structuredClone(data);
    hostile.dtcSnapshots[0] = {
      id: "dtc_1",
      takenAt: "2026-09-14T09:00:30.000Z",
      records: [
        { ...documentedDtc("P0420"), snapshot: { label: "0c30" } as unknown as Uint8Array },
      ],
    };
    const [observation] = dtcObservationsOf(hostile);
    assert.equal(
      observation && "snapshot" in observation,
      false,
      "an object with named keys is not a byte list - guessing would invent a freeze frame",
    );
  });
});

describe("dtcObservationsOf", () => {
  test("no snapshot stored is no observation, and never an empty claim", () => {
    const data = new VehicleSession(createSession({ adapter, transport })).data;
    assert.deepEqual(dtcObservationsOf(data), []);
  });

  test("the last scan is the default, an explicit snapshot answers for that scan", () => {
    const session = new VehicleSession(createSession({ adapter, transport }));
    session.addDtcSnapshot([documentedDtc("P0420")], "first");
    session.addDtcSnapshot([documentedDtc("P0171")], "second");
    assert.deepEqual(
      dtcObservationsOf(session.data).map((observation) => observation.code),
      ["P0171"],
    );
    assert.deepEqual(
      dtcObservationsOf(session.data, session.data.dtcSnapshots[0]).map((entry) => entry.code),
      ["P0420"],
    );
    const [observation] = dtcObservationsOf(session.data, session.data.dtcSnapshots[0]);
    assert.equal(observation?.at, session.data.dtcSnapshots[0]?.takenAt);
    assert.equal(observation?.ecuId, "engine");
    assert.ok(observation !== undefined && isProven(observation.evidence));
  });
});

describe("sessionGapsOf", () => {
  const kindsOf = (gaps: readonly SessionGap[]): string[] => gaps.map((gap) => gap.kind);

  test("a silent ECU and an undocumented code are findings, not blanks", () => {
    const gaps = sessionGapsOf(sessionWith([documentedDtc("P0420")]));
    assert.ok(kindsOf(gaps).includes("ecu-unreachable"));
    assert.ok(kindsOf(gaps).includes("dtc-undocumented"));
    assert.ok(kindsOf(gaps).includes("no-measurements"));
    const unreachable = gaps.find((gap) => gap.kind === "ecu-unreachable");
    assert.equal(unreachable?.subject, "ABS");
    assert.equal(unreachable?.detail, "session request timed out");
  });

  test("a documented code is not an open question, and a full session has none of those", () => {
    const data = sessionWith([documentedDtc("P0420", "Catalyst efficiency below threshold")]);
    data.measurements = [{ signalId: "engine.rpm", name: "Engine speed", samples: 10 }];
    data.dtcSnapshots.push({ ...data.dtcSnapshots[0]!, id: "dtc_2" });
    const gaps = sessionGapsOf(data);
    assert.ok(
      gaps.every((gap) => gap.kind !== "dtc-undocumented" && gap.kind !== "no-measurements"),
      `expected no measurement or knowledge gap, got ${JSON.stringify(gaps)}`,
    );
  });

  test('a single scan cannot decide "new", and the gap says so', () => {
    const gaps = sessionGapsOf(sessionWith([documentedDtc("P0420")]));
    const history = gaps.find((gap) => gap.kind === "no-scan-history");
    assert.ok(history, "one scan is not a history");
    assert.match(history.detail, /1 scan\(s\) stored/);
  });

  test("a scan that stored no code raises no knowledge gap", () => {
    const session = new VehicleSession(createSession({ adapter, transport }));
    session.upsertEcu(answeringEcu());
    session.data.measurements = [{ signalId: "engine.rpm", name: "Engine speed", samples: 3 }];
    session.upsertEcu(silentEcu());
    session.addDtcSnapshot([], "nothing stored");
    // No codes, so nothing could be called "new" — the history gap is about a code
    // a reader might misread, not about the scan counter itself.
    assert.deepEqual(kindsOf(sessionGapsOf(session.data)), ["ecu-unreachable"]);
  });
});
