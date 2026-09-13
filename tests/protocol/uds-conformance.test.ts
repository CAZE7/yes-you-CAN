/**
 * UDS session conformance suite (ISO 14229-1 §10.2, ISO 14229-2 §7).
 *
 * One table of rules, driven against two backends that run the *same* ECU code:
 *
 *   - `UdsServer` — the ECU process itself, bytes handed straight to `handle()`
 *   - the virtual vehicle — the simulator that `@vdp/simulators` builds, driven
 *     end to end over virtual CAN + ISO-TP, exactly like a real vehicle
 *
 * The suite answers the two questions the platform asks a vehicle all the time:
 *
 *   1. Which service is allowed in which session? (the service × session matrix)
 *   2. Which session may be entered from which? (the transition matrix)
 *
 * The rule that matters most is the second one: **a transition that is not
 * defined is refused**. `default → programming` is the canonical case — the
 * programming session may only be entered from the extended session, and an ECU
 * that answers that request positively can be put into a state nobody intended.
 *
 * Timing (P2/P2*, S3) is exercised through the injected clock: the suite asserts
 * what happens after S3 expires without waiting five seconds for it.
 */

import assert from "node:assert/strict";
import { genericPackage } from "@vdp/definitions/generic";
import {
  DID,
  NRC,
  SESSION,
  SESSION_NAMES,
  SID,
  type ServerSecurityAccess,
  type SessionDefinition,
  UdsServer,
  type UdsServerOptions,
  parseSessionTiming,
  positiveResponseSid,
  simulatorSessions,
} from "@vdp/protocols-uds";
import { createLogger } from "@vdp/shared";
import { VirtualVehicle } from "@vdp/simulators";
import { IsoTpConnection } from "@vdp/transport-iso-tp";
import { afterEach, beforeEach, describe, test } from "vitest";

const logger = createLogger("uds-conformance", { level: "ERROR" });

/** Suppression bit (ISO 14229-1 §9.2.2): the positive response is not sent. */
const SUPPRESSED = 0x80;

const SECURITY: ServerSecurityAccess = {
  seed: () => new Uint8Array([0x11, 0x22]),
  verifyKey: (level, key) => key[0] === level,
};

/**
 * One ECU under test, however it is reached.
 *
 * `send()` returns the last response bytes or `null` when the ECU stayed silent
 * (a suppressed positive response); `request()` returns *every* response of one
 * request, because a pending answer (NRC 0x78) is two messages.
 */
interface Ecu {
  server: UdsServer;
  request(payload: number[]): Promise<Uint8Array[]>;
  send(payload: number[]): Promise<Uint8Array | null>;
  /** A read the ECU answers (which DID exists depends on the backend). */
  readRequest: number[];
  /** A write of that DID; only the session gate is asserted, not the value. */
  writeRequest: number[];
  dispose(): Promise<void>;
}

/* --------------------------------------------------------------- UdsServer */

function createEcu(options: Partial<UdsServerOptions> = {}, did = 0x0c00): Ecu {
  const sent: Uint8Array[] = [];
  let server: UdsServer;
  server = new UdsServer(
    {
      onMessage: () => () => undefined,
      send: async (payload) => {
        sent.push(payload.slice());
      },
    },
    {
      name: "conformance-ecu",
      logger,
      sessionDefinitions: simulatorSessions(),
      dids: [
        { did: DID.VEHICLE_IDENTIFIER_NUMBER, value: () => new Uint8Array([0x57, 0x56, 0x57]) },
        { did, value: () => new Uint8Array([0x09, 0x60]), writable: true },
        {
          did: DID.ACTIVE_DIAGNOSTIC_SESSION,
          // What a real ECU does: the DID reports the session it is in right now.
          value: () => new Uint8Array([server.sessions.sessionType]),
        },
      ],
      dtcs: [{ code: "P0420", status: 0x2f }],
      routines: [{ id: 0x0203, run: () => new Uint8Array([0x01]) }],
      securityAccess: SECURITY,
      ...options,
    },
  );
  const request = async (payload: number[]): Promise<Uint8Array[]> => {
    const before = sent.length;
    await server.handle(new Uint8Array(payload));
    return sent.slice(before);
  };
  return {
    server,
    request,
    send: async (payload: number[]): Promise<Uint8Array | null> => {
      const responses = await request(payload);
      return responses.length > 0 ? (responses[responses.length - 1] ?? null) : null;
    },
    readRequest: [SID.READ_DATA_BY_IDENTIFIER, did >> 8, did & 0xff],
    writeRequest: [SID.WRITE_DATA_BY_IDENTIFIER, did >> 8, did & 0xff, 0x00, 0x64],
    dispose: async () => undefined,
  };
}

/* ----------------------------------------------------------- virtual vehicle */

/**
 * The same rules, end to end: a real `VirtualVehicle` on virtual CAN, driven by a
 * tester-side ISO-TP connection. Nothing is stubbed except the wire itself.
 */
async function createSimulatorEcu(
  options: { pendingResponseServices?: number[] } = {},
): Promise<Ecu> {
  const vehicle = new VirtualVehicle({
    definitions: genericPackage,
    logger,
    ...(options.pendingResponseServices
      ? { pendingResponseServices: options.pendingResponseServices }
      : {}),
  });
  await vehicle.start();
  const target = vehicle.ecus.find((entry) => entry.definition.address?.rxId === 0x7e8);
  assert.ok(target, "the generic package must contain an ECU answering on 0x7e8");

  const isoTp = new IsoTpConnection(
    vehicle.testerBus,
    {
      txId: target.definition.address?.txId ?? 0x7e0,
      rxId: target.definition.address?.rxId ?? 0x7e8,
      channel: "conformance",
    },
    logger,
  );

  // A DID the simulator serves from its signal model (read) — any test vehicle
  // has one; the write request is deliberately sent to a DID below 0xF000 that a
  // signal does not declare, because what this suite asserts is the *session*
  // gate (0x7F), not the outcome of the write itself.
  const signal = target.signals[0];
  assert.ok(signal, "the simulator ECU must own at least one signal");
  const readDid = signal.did;
  const writeDid = signal.did;

  const request = async (payload: number[]): Promise<Uint8Array[]> => {
    const first = await isoTp.request(new Uint8Array(payload), 2000);
    // ISO 14229-2 §7: a pending answer is a message of its own. Collect it so the
    // caller sees the pair, exactly like the direct backend does.
    if (first[0] !== 0x7f || first[2] !== NRC.REQUEST_CORRECTLY_RECEIVED_RESPONSE_PENDING) {
      return [first];
    }
    const final = await isoTp.receive(2000);
    return final ? [first, final] : [first];
  };

  return {
    server: target.server,
    request,
    send: async (payload: number[]): Promise<Uint8Array | null> => {
      const responses = await request(payload);
      return responses.length > 0 ? (responses[responses.length - 1] ?? null) : null;
    },
    readRequest: [SID.READ_DATA_BY_IDENTIFIER, readDid >> 8, readDid & 0xff],
    writeRequest: [SID.WRITE_DATA_BY_IDENTIFIER, writeDid >> 8, writeDid & 0xff, 0x00],
    dispose: async () => {
      isoTp.close();
      await vehicle.stop();
    },
  };
}

/* ------------------------------------------------------------------ harness */

const NRC_OF = (response: Uint8Array | null): number | null =>
  response && response[0] === 0x7f ? (response[2] ?? null) : null;

const POSITIVE = (response: Uint8Array | null): number | null =>
  response && response[0] !== 0x7f ? (response[0] ?? null) : null;

function format(response: Uint8Array | null): string {
  if (!response) return "(silence)";
  return Array.from(response)
    .map((byte) => byte.toString(16).padStart(2, "0").toUpperCase())
    .join(" ");
}

function nrcNameOf(nrc: number): string {
  const entry = Object.entries(NRC).find(([, value]) => value === nrc);
  return entry ? entry[0] : `NRC_0x${nrc.toString(16)}`;
}

const ALL_SESSIONS = [SESSION.DEFAULT, SESSION.EXTENDED, SESSION.PROGRAMMING];

/** Enter a session the way a tester has to: through the defined transitions. */
async function enter(ecu: Ecu, sessionType: number): Promise<void> {
  if (sessionType === SESSION.PROGRAMMING) await enter(ecu, SESSION.EXTENDED);
  const response = await ecu.send([SID.DIAGNOSTIC_SESSION_CONTROL, sessionType]);
  assert.equal(
    POSITIVE(response),
    positiveResponseSid(SID.DIAGNOSTIC_SESSION_CONTROL),
    `could not enter session 0x${sessionType.toString(16)}: ${format(response)}`,
  );
  assert.equal(ecu.server.sessions.sessionType, sessionType);
}

const READ_SERVICES: ReadonlyArray<{ name: string; request: (ecu: Ecu) => number[] }> = [
  {
    name: "0x10 DiagnosticSessionControl",
    request: () => [SID.DIAGNOSTIC_SESSION_CONTROL, SESSION.DEFAULT],
  },
  { name: "0x11 ECUReset", request: () => [SID.ECU_RESET, 0x01] },
  {
    name: "0x19 ReadDtcInformation",
    request: () => [SID.READ_DTC_INFORMATION, 0x02, 0xff],
  },
  { name: "0x22 ReadDataByIdentifier", request: (ecu) => ecu.readRequest },
  { name: "0x3E TesterPresent", request: () => [SID.TESTER_PRESENT, 0x00] },
];

const WRITE_SERVICES: ReadonlyArray<{ name: string; request: (ecu: Ecu) => number[] }> = [
  {
    name: "0x14 ClearDiagnosticInformation",
    request: () => [SID.CLEAR_DIAGNOSTIC_INFORMATION, 0xff, 0xff, 0xff],
  },
  { name: "0x27 SecurityAccess", request: () => [SID.SECURITY_ACCESS, 0x01] },
  { name: "0x2E WriteDataByIdentifier", request: (ecu) => ecu.writeRequest },
  {
    name: "0x31 RoutineControl",
    request: () => [SID.ROUTINE_CONTROL, 0x01, 0x02, 0x03],
  },
];

const TRANSITIONS: ReadonlyArray<{ from: number; request: number; expect: "allowed" | number }> = [
  { from: SESSION.DEFAULT, request: SESSION.DEFAULT, expect: "allowed" },
  { from: SESSION.DEFAULT, request: SESSION.EXTENDED, expect: "allowed" },
  // The rule of this step: programming is not reachable from the default session.
  { from: SESSION.DEFAULT, request: SESSION.PROGRAMMING, expect: NRC.CONDITIONS_NOT_CORRECT },
  { from: SESSION.DEFAULT, request: 0x60, expect: NRC.SUB_FUNCTION_NOT_SUPPORTED },
  { from: SESSION.EXTENDED, request: SESSION.PROGRAMMING, expect: "allowed" },
  { from: SESSION.EXTENDED, request: SESSION.DEFAULT, expect: "allowed" },
  { from: SESSION.PROGRAMMING, request: SESSION.DEFAULT, expect: "allowed" },
  { from: SESSION.PROGRAMMING, request: SESSION.EXTENDED, expect: "allowed" },
  { from: SESSION.PROGRAMMING, request: 0x61, expect: NRC.SUB_FUNCTION_NOT_SUPPORTED },
];

/* ------------------------------------------------------------------- suites */

/**
 * Register one suite of conformance rules for one backend. Every backend runs the
 * identical rules — that is the point: the simulator must not be more permissive
 * than the ECU process, and the ECU process must not be more permissive than the
 * simulator. A new adapter that carries a UDS server belongs here.
 */
function registerConformance(create: () => Promise<Ecu>): void {
  let ecu: Ecu;
  beforeEach(async () => {
    ecu = await create();
  });
  // A backend that failed to come up leaves nothing behind: dispose is guarded.
  afterEach(async () => {
    await ecu?.dispose();
  });

  for (const service of READ_SERVICES) {
    test(`${service.name} is available in every session`, async () => {
      for (const sessionType of ALL_SESSIONS) {
        await enter(ecu, sessionType);
        const response = await ecu.send(service.request(ecu));
        assert.notEqual(
          NRC_OF(response),
          NRC.SERVICE_NOT_SUPPORTED_IN_ACTIVE_SESSION,
          `${service.name} must not be refused in session 0x${sessionType.toString(16)}: ${format(response)}`,
        );
      }
    });
  }

  for (const service of WRITE_SERVICES) {
    test(`${service.name} needs a non-default session`, async () => {
      const refused = await ecu.send(service.request(ecu));
      assert.equal(
        NRC_OF(refused),
        NRC.SERVICE_NOT_SUPPORTED_IN_ACTIVE_SESSION,
        `a write service answered ${format(refused)} in the default session`,
      );

      await enter(ecu, SESSION.EXTENDED);
      const allowed = await ecu.send(service.request(ecu));
      assert.notEqual(
        NRC_OF(allowed),
        NRC.SERVICE_NOT_SUPPORTED_IN_ACTIVE_SESSION,
        `${service.name} must be available in the extended session, got ${format(allowed)}`,
      );
    });
  }

  test("an unimplemented service is 0x11 in every session, never 0x7F", async () => {
    for (const sessionType of ALL_SESSIONS) {
      await enter(ecu, sessionType);
      const response = await ecu.send([0x77]);
      assert.equal(
        NRC_OF(response),
        NRC.SERVICE_NOT_SUPPORTED,
        `service 0x77 in session 0x${sessionType.toString(16)}: ${format(response)}`,
      );
    }
  });

  for (const entry of TRANSITIONS) {
    const label = `0x${entry.from.toString(16)} → 0x${entry.request.toString(16)}`;
    const expectation =
      entry.expect === "allowed" ? "allowed" : `refused with ${nrcNameOf(entry.expect)}`;
    test(`${label} is ${expectation}`, async () => {
      await enter(ecu, entry.from);
      const response = await ecu.send([SID.DIAGNOSTIC_SESSION_CONTROL, entry.request]);
      if (entry.expect === "allowed") {
        assert.equal(
          POSITIVE(response),
          positiveResponseSid(SID.DIAGNOSTIC_SESSION_CONTROL),
          format(response),
        );
        assert.equal(ecu.server.sessions.sessionType, entry.request & 0x7f);
        return;
      }
      assert.equal(NRC_OF(response), entry.expect, format(response));
      // A refused transition must not move the ECU: the session it was in stays.
      assert.equal(
        ecu.server.sessions.sessionType,
        entry.from,
        "a refused transition changed the session",
      );
    });
  }

  test("an ECU reset returns to the default session immediately", async () => {
    await enter(ecu, SESSION.EXTENDED);
    const response = await ecu.send([SID.ECU_RESET, 0x01]);
    assert.equal(POSITIVE(response), positiveResponseSid(SID.ECU_RESET));
    assert.equal(ecu.server.sessions.sessionType, SESSION.DEFAULT);
  });
}

describe("session conformance — UdsServer", () => {
  registerConformance(() => Promise.resolve(createEcu()));

  test("a session the ECU does not define is refused, not silently accepted", async () => {
    const ecu = createEcu({
      sessionDefinitions: [sessionDefinition(SESSION.DEFAULT), sessionDefinition(SESSION.EXTENDED)],
    });
    const response = await ecu.send([SID.DIAGNOSTIC_SESSION_CONTROL, SESSION.PROGRAMMING]);
    assert.equal(NRC_OF(response), NRC.SUB_FUNCTION_NOT_SUPPORTED);
    assert.equal(ecu.server.sessions.types.length, 2);
  });

  test("the response reports the timing of the session it entered", async () => {
    const definitions = simulatorSessions().map((session) =>
      session.type === SESSION.EXTENDED ? { ...session, p2Ms: 25, p2StarMs: 2500 } : session,
    );
    const ecu = createEcu({ sessionDefinitions: definitions });
    const response = await ecu.send([SID.DIAGNOSTIC_SESSION_CONTROL, SESSION.EXTENDED]);
    assert.ok(response);
    assert.deepEqual(parseSessionTiming(response), { p2Ms: 25, p2StarMs: 2500 });
    assert.equal(ecu.server.sessions.p2Ms, 25, "the machine follows the entered session");
  });
});

/**
 * The simulator, driven over the wire — the acceptance criterion of this step
 * ("conformance suite against the simulator"). The same rules, no injected clock
 * (the simulator runs in real time) and no guard-rail cases (those are about the
 * ECU process, which this backend also uses underneath).
 */
describe("session conformance — virtual vehicle over CAN", () => {
  registerConformance(() => createSimulatorEcu());

  test("a definition without the default session cannot be built", () => {
    assert.throws(
      () => createEcu({ sessionDefinitions: [sessionDefinition(0x60)] }),
      /default session/,
    );
  });

  test("an empty definition list is refused", () => {
    assert.throws(() => createEcu({ sessionDefinitions: [] }), /at least one session/);
  });
});

describe("session timeout (S3Server, ISO 14229-2 §7)", () => {
  function createClockEcu(s3Ms: number): { ecu: Ecu; advance: (ms: number) => void } {
    let now = 1_000_000;
    const ecu = createEcu({
      clock: () => now,
      sessionDefinitions: simulatorSessions().map((session) => ({ ...session, s3Ms })),
    });
    return { ecu, advance: (ms: number) => (now += ms) };
  }

  test("an expired session falls back to the default session", async () => {
    const { ecu, advance } = createClockEcu(5000);
    await enter(ecu, SESSION.EXTENDED);
    advance(5001);

    // The next request is answered by the default session again — and it says so.
    const response = await ecu.send([SID.READ_DATA_BY_IDENTIFIER, 0xf1, 0x86]);
    assert.equal(ecu.server.sessions.sessionType, SESSION.DEFAULT);
    assert.equal(response?.[3], SESSION.DEFAULT, `active session DID said ${format(response)}`);
    // …and the write service is refused again, because the ECU is in default.
    const cleared = await ecu.send([SID.CLEAR_DIAGNOSTIC_INFORMATION, 0xff, 0xff, 0xff]);
    assert.equal(NRC_OF(cleared), NRC.SERVICE_NOT_SUPPORTED_IN_ACTIVE_SESSION);
  });

  test("any request resets S3: TesterPresent keeps the session alive", async () => {
    const { ecu, advance } = createClockEcu(5000);
    await enter(ecu, SESSION.EXTENDED);
    advance(4000);
    // A suppressed TesterPresent is still a request — it keeps the session alive.
    const keepAlive = await ecu.send([SID.TESTER_PRESENT, SUPPRESSED]);
    assert.equal(keepAlive, null, "suppressed positive response stays silent");
    advance(4000);
    await ecu.send([SID.READ_DATA_BY_IDENTIFIER, 0x0c, 0x00]);
    assert.equal(ecu.server.sessions.sessionType, SESSION.EXTENDED, "the session survived");
    advance(6000);
    await ecu.send([SID.READ_DATA_BY_IDENTIFIER, 0x0c, 0x00]);
    assert.equal(ecu.server.sessions.sessionType, SESSION.DEFAULT, "and it expires when it should");
  });
});

describe("response pending inside a session", () => {
  test("NRC 0x78 is sent before the real answer, in the session that allowed it", async () => {
    const ecu = createEcu({
      pendingResponseServices: [SID.READ_DATA_BY_IDENTIFIER],
      pendingResponseDelayMs: 5,
    });
    await enter(ecu, SESSION.EXTENDED);
    const responses = await ecu.request([SID.READ_DATA_BY_IDENTIFIER, 0x0c, 0x00]);
    assert.equal(responses.length, 2, "a pending notice and then the real answer");
    assert.equal(responses[0]?.[0], 0x7f);
    assert.equal(responses[0]?.[2], NRC.REQUEST_CORRECTLY_RECEIVED_RESPONSE_PENDING);
    assert.equal(POSITIVE(responses[1] ?? null), positiveResponseSid(SID.READ_DATA_BY_IDENTIFIER));
  });

  test("the virtual vehicle reports pending over ISO-TP too", async () => {
    const ecu = await createSimulatorEcu({
      pendingResponseServices: [SID.READ_DATA_BY_IDENTIFIER],
    });
    try {
      await enter(ecu, SESSION.EXTENDED);
      const responses = await ecu.request(ecu.readRequest);
      assert.equal(responses.length, 2, "a pending notice and then the real answer");
      assert.equal(responses[0]?.[2], NRC.REQUEST_CORRECTLY_RECEIVED_RESPONSE_PENDING);
      assert.equal(
        POSITIVE(responses[1] ?? null),
        positiveResponseSid(SID.READ_DATA_BY_IDENTIFIER),
      );
    } finally {
      await ecu.dispose();
    }
  });
});

/**
 * Minimal definition for the guard-rail tests: a session that may be entered from
 * anywhere and allows every service the ECU implements.
 */
function sessionDefinition(type: number): SessionDefinition {
  return {
    type,
    name: SESSION_NAMES[type] ?? `session_0x${type.toString(16)}`,
    from: ALL_SESSIONS,
    // No `services` list: this session allows every service the ECU implements.
  };
}
