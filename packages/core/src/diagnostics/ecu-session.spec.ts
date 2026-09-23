/**
 * The per-ECU session: probes, identification fallbacks, write preconditions
 * (AGENTS 9, 12, 20, 26; 0.E E11).
 *
 * This was the thinnest-covered module in `packages/core` because nothing tested it
 * directly: its numbers came from integration and replay runs, which only ever walk the
 * happy path of a well-behaved ECU. Every branch that exists because a *real* ECU answers
 * unexpectedly — a DID it does not have, a negative response instead of a timeout, a
 * refused session switch — was unobserved, which means a change here could turn the file
 * red without a defect, or leave a defect in quietly.
 *
 * A stub client is enough for all of it: no hardware, no simulator. These paths are
 * decided by what the ECU answers, so the answer *is* the fixture.
 */

import assert from "node:assert/strict";
import { CURRENT_SCHEMA_VERSION, type DefinitionPackage } from "@vdp/definitions";
import { NRC, SID, type UdsClient, type UdsLink } from "@vdp/protocols-uds";
import { createLogger, MemorySink, UdsNegativeResponseError } from "@vdp/shared";
import { describe, test } from "vitest";
import { EcuDiagnosticSession } from "./ecu-session.js";

/** What the stub answers, and what it was asked. */
interface Stub {
  calls: Array<{ method: string; args: unknown[] }>;
  timing: { p2Ms: number; p2StarMs: number };
  readDid(did: number): Uint8Array | null;
  raw(request: Uint8Array): Uint8Array;
  updateTiming(timing: Record<string, number>): void;
  diagnosticSessionControl(sessionType: number): Promise<void>;
  clearDiagnosticInformation(group?: number): Promise<void>;
  readDtcSnapshotRecord(
    code: string,
    record: number,
  ): Promise<{ recordNumber: number; data: Uint8Array } | null>;
  readDtcReportByStatusMask(mask: number): Promise<{
    availabilityMask: number;
    records: unknown[];
  }>;
  readDtcSnapshotIdentification(code?: string): Promise<{
    availabilityMask: number;
    identifications: unknown[];
  }>;
}

function negative(serviceId: number, nrc: number): UdsNegativeResponseError {
  return new UdsNegativeResponseError(serviceId, nrc, `nrc 0x${nrc.toString(16)}`);
}

function stubClient(overrides: Partial<Stub> = {}): Stub {
  const calls: Stub["calls"] = [];
  const stub: Stub = {
    calls,
    timing: { p2Ms: 50, p2StarMs: 5_000 },
    readDid: () => null,
    raw: () => new Uint8Array(0),
    updateTiming: (timing) => {
      calls.push({ method: "updateTiming", args: [timing] });
    },
    diagnosticSessionControl: async (sessionType) => {
      calls.push({ method: "diagnosticSessionControl", args: [sessionType] });
      // A 0x50 response may carry new P2 values (ISO 14229-2 §7.2.2) — the fake moves
      // them so the test can see whether the session picked them up.
      stub.timing = { p2Ms: 25, p2StarMs: 2_000 };
    },
    clearDiagnosticInformation: async (group) => {
      calls.push({ method: "clearDiagnosticInformation", args: [group] });
    },
    readDtcSnapshotRecord: async () => null,
    readDtcReportByStatusMask: async (mask) => {
      calls.push({ method: "readDtcReportByStatusMask", args: [mask] });
      return { availabilityMask: 0xff, records: [] };
    },
    readDtcSnapshotIdentification: async () => ({ availabilityMask: 0xff, identifications: [] }),
    ...overrides,
  };
  return stub;
}

const pkg: DefinitionPackage = {
  schemaVersion: CURRENT_SCHEMA_VERSION,
  oem: "fixture",
  name: "ecu-session fixture",
  version: "1.0.0",
  provenance: { sourceType: "own", source: "test fixture" },
  ecus: [
    {
      id: "engine",
      name: "Engine Control Unit",
      protocol: "uds",
      address: { txId: 0x7e0, rxId: 0x7e8 },
      identification: [
        { label: "VIN", did: 0xf190, encoding: "ascii" },
        { label: "Spare part number", did: 0xf187, encoding: "ascii" },
        // A DID below 0xF180 with no declared encoding — the raw-hex arm.
        { label: "Freeze frame support", did: 0x0100 },
      ],
      timing: { p2Ms: 30, p2StarMs: 900 },
      dtcs: [{ code: "P0420", description: "Catalyst efficiency", severity: "major" }],
    },
  ],
  signals: [
    {
      id: "engine.rpm",
      name: "RPM",
      ecu: "engine",
      did: 0xf010,
      byteOffset: 0,
      length: 2,
      encoding: "uint16",
    },
    {
      id: "engine.load",
      name: "Load",
      ecu: "engine",
      did: 0xf010,
      byteOffset: 2,
      length: 1,
      encoding: "uint8",
    },
    {
      id: "engine.temp",
      name: "Temperature",
      ecu: "engine",
      did: 0xf011,
      byteOffset: 0,
      length: 1,
      encoding: "uint8",
    },
  ],
};

function session(stub: Stub, options: { sessionType?: number } = {}): EcuDiagnosticSession {
  const ecu = new EcuDiagnosticSession({} as UdsLink, stub as unknown as UdsClient, {
    txId: 0x7e0,
    rxId: 0x7e8,
    definitionPackage: pkg,
    definitionEcuId: "engine",
    logger: createLogger("ecu-session-spec", { level: "DEBUG" }, [new MemorySink()]),
  });
  if (options.sessionType !== undefined) ecu.record.sessionType = options.sessionType;
  return ecu;
}

describe("didPlan", () => {
  test("signals of one DID are grouped into one read", () => {
    const plan = session(stubClient()).didPlan();
    assert.deepEqual([...plan.keys()], [0xf010, 0xf011]);
    assert.deepEqual(
      plan.get(0xf010)?.map((signal) => signal.id),
      ["engine.rpm", "engine.load"],
      "two signals, one 0x22 request (AGENTS 12)",
    );
    assert.deepEqual(
      plan.get(0xf011)?.map((signal) => signal.id),
      ["engine.temp"],
    );
  });

  test("an ECU without a definition plans nothing and is named by its address", () => {
    const ecu = new EcuDiagnosticSession({} as UdsLink, stubClient() as unknown as UdsClient, {
      txId: 0x7d1,
      rxId: 0x7d9,
    });
    assert.equal(ecu.didPlan().size, 0);
    assert.equal(ecu.record.name, "ECU 0x7d1", "no name is invented for an unknown ECU");
    assert.deepEqual([...ecu.signals], []);
    // `uds` here is not a claim about the ECU: this object *is* a UDS session, and the
    // protocol field says how the record is being talked to. Discovery labels what it
    // cannot identify as "unknown" — attaching by address is a different decision.
    assert.equal(ecu.record.protocol, "uds");
  });
});

describe("readIdentification", () => {
  test("a DID the ECU does not answer is skipped, a refusal is logged, neither is fatal", async () => {
    const stub = stubClient({
      readDid: (did) => {
        if (did === 0xf190) return new TextEncoder().encode("1HGCM82633A004352");
        if (did === 0xf187) return null;
        throw negative(SID.READ_DATA_BY_IDENTIFIER, NRC.SUB_FUNCTION_NOT_SUPPORTED);
      },
    });
    const ecu = session(stub);
    const values = await ecu.readIdentification();
    assert.deepEqual(
      values.map((entry) => `${entry.label}:${entry.did?.toString(16)}`),
      ["VIN:f190"],
      "one answered, one silent, one refused — the answer is one entry, not an error",
    );
    assert.equal(ecu.record.reachable, true);
    assert.deepEqual(ecu.record.identification, values);
  });

  test("ASCII identification is cut at the first NUL, a low DID stays hex", async () => {
    // ISO 14229-1 App A: identification DIDs from 0xF180 up carry text, so the reader
    // treats them as ASCII even when a package forgets to say so — and a padded VIN
    // must not arrive with the padding in it. A DID below that range with no declared
    // encoding is bytes, and bytes are shown as hex, never as invented characters.
    const stub = stubClient({
      readDid: (did) =>
        did === 0xf190
          ? new Uint8Array([...new TextEncoder().encode("WVW"), 0, 0, 0])
          : did === 0xf187
            ? new TextEncoder().encode("03C906000AA\0")
            : new Uint8Array([0xde, 0xad]),
    });
    const values = await session(stub).readIdentification();
    assert.equal(values.find((entry) => entry.label === "VIN")?.value, "WVW");
    assert.equal(values.find((entry) => entry.label === "Spare part number")?.value, "03C906000AA");
    assert.equal(
      values.find((entry) => entry.label === "Freeze frame support")?.value,
      "DE AD",
      "hex bytes are upper case and space separated — the same shape the raw trace uses",
    );
  });

  test("an ECU without a definition falls back to the VIN DID alone", async () => {
    const stub = stubClient({ readDid: () => new TextEncoder().encode("1HGCM82633A004352") });
    const ecu = new EcuDiagnosticSession({} as UdsLink, stub as unknown as UdsClient, {
      txId: 0x7d1,
      rxId: 0x7d9,
    });
    const values = await ecu.readIdentification();
    assert.deepEqual(
      values.map((entry) => entry.label),
      ["VIN"],
      "one known request, not a guess list",
    );
    assert.equal(values[0]?.did, 0xf190);
  });
});

describe("probeSupportedServices", () => {
  test("the four answers of a real ECU produce four different statements", async () => {
    const stub = stubClient({
      raw: (request) => {
        const service = request[0] ?? 0;
        if (service === SID.READ_DATA_BY_IDENTIFIER) return new Uint8Array([0x62]);
        if (service === SID.CLEAR_DIAGNOSTIC_INFORMATION) {
          throw negative(SID.CLEAR_DIAGNOSTIC_INFORMATION, NRC.SERVICE_NOT_SUPPORTED);
        }
        if (service === SID.WRITE_DATA_BY_IDENTIFIER) {
          throw new Error("no response within P2*");
        }
        throw negative(service, NRC.REQUEST_OUT_OF_RANGE);
      },
    });
    const ecu = session(stub);
    const probes = await ecu.probeSupportedServices([
      SID.READ_DATA_BY_IDENTIFIER,
      SID.ECU_RESET,
      SID.WRITE_DATA_BY_IDENTIFIER,
      0x21,
      SID.CLEAR_DIAGNOSTIC_INFORMATION,
      SID.SECURITY_ACCESS,
    ]);
    const byService = new Map(probes.map((probe) => [probe.service, probe]));

    assert.equal(byService.get(SID.READ_DATA_BY_IDENTIFIER)?.outcome, "supported");
    assert.equal(
      byService.get(SID.ECU_RESET)?.outcome,
      "supported",
      "an unassigned sub-function answered negatively proves the service is there",
    );
    assert.match(byService.get(SID.ECU_RESET)?.detail ?? "", /proves the service exists/);
    assert.equal(byService.get(0x21)?.outcome, "not-probed", "no safe probe is known for it");
    assert.match(byService.get(0x21)?.detail ?? "", /no safe probe/);
    assert.equal(byService.get(SID.CLEAR_DIAGNOSTIC_INFORMATION)?.outcome, "not-probed");
    assert.match(
      byService.get(SID.CLEAR_DIAGNOSTIC_INFORMATION)?.detail ?? "",
      /destroys diagnostic history/,
      "the reason is the answer, not a stack trace",
    );
    assert.equal(
      byService.get(SID.SECURITY_ACCESS)?.outcome,
      "not-probed",
      "a lockout counter is not a test target",
    );
    assert.equal(
      byService.get(SID.WRITE_DATA_BY_IDENTIFIER)?.outcome,
      "unsupported",
      "a timeout is not evidence of support",
    );
    assert.match(byService.get(SID.WRITE_DATA_BY_IDENTIFIER)?.detail ?? "", /P2\*/);
    assert.deepEqual(ecu.record.supportedServices, [SID.READ_DATA_BY_IDENTIFIER, SID.ECU_RESET]);
    assert.deepEqual(ecu.record.serviceProbes, probes);
  });

  test("the default list probes nothing that can change vehicle state", async () => {
    const ecu = session(stubClient());
    const probes = await ecu.probeSupportedServices();
    assert.ok(probes.length > 0);
    for (const probe of probes) {
      if (
        probe.service === SID.CLEAR_DIAGNOSTIC_INFORMATION ||
        probe.service === SID.SECURITY_ACCESS
      ) {
        assert.equal(
          probe.outcome,
          "not-probed",
          `0x${probe.service.toString(16)} must never be probed`,
        );
      }
      assert.ok(probe.detail.length > 0, "every probe says what it concluded and why");
    }
  });
});

describe("readDtcSnapshot", () => {
  test("requestOutOfRange means no snapshot, and is not an error", async () => {
    const stub = stubClient({
      readDtcSnapshotRecord: async () => {
        throw negative(SID.READ_DTC_INFORMATION, NRC.REQUEST_OUT_OF_RANGE);
      },
    });
    assert.equal(await session(stub).readDtcSnapshot("P0420"), null);
  });

  test("any other refusal is rethrown, not folded into 'no snapshot'", async () => {
    const stub = stubClient({
      readDtcSnapshotRecord: async () => {
        throw negative(SID.READ_DTC_INFORMATION, NRC.SECURITY_ACCESS_DENIED);
      },
    });
    await assert.rejects(() => session(stub).readDtcSnapshot("P0420"), UdsNegativeResponseError);
  });

  test("an ECU that answers with nothing yields no frame", async () => {
    assert.equal(await session(stubClient()).readDtcSnapshot("P0420"), null);
  });
});

describe("ensureWritableSession", () => {
  test("an ECU already outside the default session is left alone", async () => {
    const stub = stubClient();
    const ecu = session(stub, { sessionType: 0x03 });
    assert.deepEqual(await ecu.ensureWritableSession(), { switched: false, sessionType: 0x03 });
    assert.equal(
      stub.calls.some((call) => call.method === "diagnosticSessionControl"),
      false,
    );
  });

  test("a successful switch takes the timing the ECU reported with it", async () => {
    const stub = stubClient();
    const ecu = session(stub);
    assert.deepEqual(await ecu.ensureWritableSession(), { switched: true, sessionType: 0x03 });
    assert.deepEqual(
      stub.calls
        .filter((call) => call.method === "diagnosticSessionControl")
        .map((call) => call.args[0]),
      [0x03],
    );
    assert.deepEqual(
      { ...ecu.record.timing },
      { p2Ms: 25, p2StarMs: 2_000 },
      "ISO 14229-2 §7.2.2: the 0x50 response may carry new P2 values; a session that keeps the old ones times out on a slow ECU",
    );
    assert.equal(ecu.record.sessionType, 0x03);
  });

  test("a refused switch is reported, not worked around", async () => {
    const stub = stubClient({
      diagnosticSessionControl: async () => {
        throw negative(SID.DIAGNOSTIC_SESSION_CONTROL, NRC.SECURITY_ACCESS_DENIED);
      },
    });
    const ecu = session(stub);
    await assert.rejects(
      () => ecu.ensureWritableSession(),
      (error: unknown) => {
        assert.ok(error instanceof UdsNegativeResponseError, String(error));
        assert.equal(
          error.nrc,
          NRC.SECURITY_ACCESS_DENIED,
          "the ECU's reason survives instead of being flattened into one error",
        );
        assert.match(
          JSON.stringify(error.details ?? {}),
          /does not bypass security access/,
          "and it says what the platform deliberately did not do (AGENTS 29, 34.12)",
        );
        return true;
      },
    );
    assert.equal(ecu.record.sessionType, 0x01, "the record keeps the session the ECU is in");
  });

  test("a refusal without an NRC still names a reason", async () => {
    const stub = stubClient({
      diagnosticSessionControl: async () => {
        throw new Error("port closed");
      },
    });
    await assert.rejects(
      () => session(stub).ensureWritableSession(),
      (error: unknown) => {
        assert.ok(error instanceof UdsNegativeResponseError);
        assert.equal(
          error.nrc,
          NRC.CONDITIONS_NOT_CORRECT,
          "a bare failure is not silently a timeout",
        );
        assert.match(
          JSON.stringify(error.details ?? {}),
          /port closed/,
          "the original reason is kept",
        );
        return true;
      },
    );
  });
});

describe("reads, writes and lookups", () => {
  test("the definition's timing is handed to the client when the session is built", () => {
    const stub = stubClient();
    session(stub);
    assert.deepEqual(
      stub.calls.find((call) => call.method === "updateTiming")?.args[0],
      { p2Ms: 30, p2StarMs: 900 },
      "a package that names per-ECU timing must not be ignored until the first request (AGENTS 9)",
    );
  });

  test("a signal group that fails costs only its own signals", async () => {
    const stub = stubClient({
      readDid: (did) => {
        if (did === 0xf010) throw negative(SID.READ_DATA_BY_IDENTIFIER, NRC.REQUEST_OUT_OF_RANGE);
        return new Uint8Array([42, 0, 0]);
      },
    });
    const ecu = session(stub);
    const decoded = await ecu.readAllSignals();
    assert.deepEqual(
      decoded.map((value) => `${value.signalId}=${value.value}`),
      ["engine.temp=42"],
      "one unsupported DID must not cost the whole snapshot",
    );
    assert.equal(ecu.signalById("engine.temp")?.name, "Temperature");
    assert.equal(ecu.signalById("nope"), undefined);
  });

  test("a fault definition is found regardless of how the code is written", () => {
    const ecu = session(stubClient());
    assert.equal(ecu.dtcDefinition("p0420")?.severity, "major");
    assert.equal(ecu.dtcDefinition("P0420")?.description, "Catalyst efficiency");
    assert.equal(ecu.dtcDefinition("P0421"), undefined, "undocumented stays undocumented");
  });

  test("clearing sends the group when one is given and none when it is not", async () => {
    const stub = stubClient();
    const ecu = session(stub);
    await ecu.clearDiagnosticInformation();
    await ecu.clearDiagnosticInformation(0x000000);
    assert.deepEqual(
      stub.calls
        .filter((call) => call.method === "clearDiagnosticInformation")
        .map((call) => call.args[0]),
      [undefined, 0],
      "no group means all, and that difference is a request-level one (ISO 14229-1 §11.3)",
    );
  });

  test("a scan stores the raw records on the ECU record", async () => {
    const records = [
      {
        code: "P0420",
        raw: "042000",
        failureType: "00",
        status: 0x24,
        statusBits: {
          testFailed: true,
          testFailedThisOperationCycle: true,
          pendingDtc: false,
          confirmedDtc: true,
          testNotCompletedSinceLastClear: false,
          testFailedSinceLastClear: true,
          testNotCompletedThisOperationCycle: false,
          warningIndicatorRequested: false,
        },
        severity: "major",
      },
    ];
    const stub = stubClient({
      readDtcReportByStatusMask: async (mask) => {
        stub.calls.push({ method: "readDtcReportByStatusMask", args: [mask] });
        return { availabilityMask: 0x24, records };
      },
    });
    const ecu = session(stub);
    const read = await ecu.readDtcs(0x09);
    assert.deepEqual(read, records);
    assert.deepEqual(ecu.record.dtcs, records, "the record keeps the protocol truth (ADR 0004)");
    assert.equal(
      ecu.record.dtcAvailabilityMask,
      0x24,
      "the ECU's own statement about its status bits stays with the session (ADR 0058)",
    );
    assert.deepEqual(
      stub.calls
        .filter((call) => call.method === "readDtcReportByStatusMask")
        .map((c) => c.args[0]),
      [0x09],
    );
  });

  test("snapshot identifications come back as data, and a refusal is an answer not a failure", async () => {
    const identifications = [{ code: "P0420", snapshotRecordCount: 1 }];
    const ecu = session(
      stubClient({
        readDtcSnapshotIdentification: async () => ({
          availabilityMask: 0x2f,
          identifications,
        }),
      }),
    );
    assert.deepEqual(await ecu.readDtcSnapshotIdentifications(), identifications);
    assert.equal(ecu.record.dtcAvailabilityMask, 0x2f);

    // An ECU that does not implement 0x19 0x03 answers with an NRC; that is a fact
    // about the vehicle, so the read yields an empty list instead of throwing.
    for (const nrc of [0x31, 0x12]) {
      const refusing = session(
        stubClient({
          readDtcSnapshotIdentification: async () => {
            throw negative(0x19, nrc);
          },
        }),
      );
      assert.deepEqual(await refusing.readDtcSnapshotIdentifications(), []);
    }

    // Anything else (timeout, session, security) is a real error and must surface.
    const failing = session(
      stubClient({
        readDtcSnapshotIdentification: async () => {
          throw new Error("no response within 75 ms");
        },
      }),
    );
    await assert.rejects(() => failing.readDtcSnapshotIdentifications(), /no response within/);
  });
});
