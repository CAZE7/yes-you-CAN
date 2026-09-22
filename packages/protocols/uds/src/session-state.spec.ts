/**
 * Session state machine unit tests (ISO 14229-1 §10.2, ISO 14229-2 §7).
 *
 * The conformance suite drives the same machine through a real ECU; this spec
 * pins the machine's own contract: which transition it refuses with which NRC,
 * what S3 expiry does, and how a service is judged against the active session.
 * Both use an injected clock, so nothing here waits for real time.
 */

import assert from "node:assert/strict";
import { ProtocolError } from "@vdp/shared";
import { describe, test } from "vitest";
import { NRC } from "./nrc.js";
import { SESSION, SID } from "./services.js";
import {
  ALWAYS_AVAILABLE_SERVICES,
  defaultSessionDefinition,
  extendedSessionDefinition,
  programmingSessionDefinition,
  type SessionDefinition,
  SessionStateMachine,
  simulatorSessions,
  standardSessions,
} from "./session-state.js";

const T0 = 1_000_000;

function machine(
  overrides: {
    sessions?: readonly SessionDefinition[];
    implemented?: readonly number[];
    timing?: { p2Ms?: number; p2StarMs?: number; s3Ms?: number };
    now?: () => number;
  } = {},
): { state: SessionStateMachine; setNow: (value: number) => void } {
  let now = T0;
  const state = new SessionStateMachine({
    sessions: overrides.sessions ?? simulatorSessions(),
    implementedServices: overrides.implemented ?? [
      SID.READ_DATA_BY_IDENTIFIER,
      SID.READ_DTC_INFORMATION,
      SID.CLEAR_DIAGNOSTIC_INFORMATION,
      SID.SECURITY_ACCESS,
      SID.WRITE_DATA_BY_IDENTIFIER,
      SID.ROUTINE_CONTROL,
      ...ALWAYS_AVAILABLE_SERVICES,
    ],
    ...(overrides.timing ? { timing: overrides.timing } : {}),
    now: overrides.now ?? (() => now),
  });
  return { state, setNow: (value: number) => (now = value) };
}

describe("session state machine", () => {
  test("starts in the default session and knows what it defines", () => {
    const { state } = machine();
    assert.equal(state.sessionType, SESSION.DEFAULT);
    assert.equal(state.sessionName, "defaultSession");
    assert.equal(state.active.type, SESSION.DEFAULT);
    assert.deepEqual(state.types, [SESSION.DEFAULT, SESSION.EXTENDED, SESSION.PROGRAMMING]);
    assert.equal(state.lastActivity, T0);
  });

  test("switching to a defined session reports the change", () => {
    const { state } = machine();
    const transition = state.request(SESSION.EXTENDED, T0 + 10);
    assert.deepEqual(transition, { ok: true, switched: true, sessionType: SESSION.EXTENDED });
    assert.equal(state.sessionType, SESSION.EXTENDED);
    assert.equal(state.lastActivity, T0 + 10, "entering a session counts as activity");
  });

  test("asking for the active session again is allowed but not a switch", () => {
    const { state } = machine();
    state.request(SESSION.EXTENDED);
    const again = state.request(SESSION.EXTENDED);
    assert.equal(again.ok, true);
    assert.equal(again.switched, false);
  });

  test("an undefined session type is subFunctionNotSupported and names the defined ones", () => {
    const { state } = machine({ sessions: standardSessions() });
    const refused = state.request(SESSION.PROGRAMMING);
    assert.equal(refused.ok, false);
    assert.equal(refused.nrc, NRC.SUB_FUNCTION_NOT_SUPPORTED);
    assert.equal(refused.sessionType, SESSION.DEFAULT, "the session does not move");
    assert.match(refused.reason ?? "", /0x02 is not defined/);
    assert.match(refused.reason ?? "", /0x01, 0x03/);
  });

  test("a defined session that may not be entered from here is conditionsNotCorrect", () => {
    const { state } = machine();
    const refused = state.request(SESSION.PROGRAMMING);
    assert.equal(refused.nrc, NRC.CONDITIONS_NOT_CORRECT);
    assert.match(refused.reason ?? "", /may only be entered from 0x03, not from 0x01/);

    // …and the declared way in works.
    state.request(SESSION.EXTENDED);
    assert.equal(state.request(SESSION.PROGRAMMING).ok, true);
  });

  test("an ECU reset returns to the default session and reports where it came from", () => {
    const { state } = machine();
    state.request(SESSION.EXTENDED);
    assert.equal(state.reset(T0 + 5), SESSION.EXTENDED);
    assert.equal(state.sessionType, SESSION.DEFAULT);
    assert.equal(state.lastActivity, T0 + 5);
  });

  test("S3 expiry falls back to the default session exactly at the limit", () => {
    const { state, setNow } = machine({ timing: { s3Ms: 100 } });
    state.request(SESSION.EXTENDED);

    setNow(T0 + 99);
    assert.deepEqual(state.tick(), {
      expired: false,
      from: SESSION.EXTENDED,
      to: SESSION.EXTENDED,
    });

    setNow(T0 + 100);
    assert.deepEqual(state.tick(), {
      expired: true,
      from: SESSION.EXTENDED,
      to: SESSION.DEFAULT,
    });
    assert.equal(state.sessionType, SESSION.DEFAULT);
  });

  test("activity postpones the expiry, and the default session never expires", () => {
    const { state, setNow } = machine({ timing: { s3Ms: 100 } });
    state.request(SESSION.EXTENDED);
    setNow(T0 + 90);
    state.activity();
    setNow(T0 + 150);
    assert.equal(state.tick().expired, false, "activity moved the deadline");
    setNow(T0 + 190);
    assert.equal(state.tick().expired, true);
    assert.equal(state.tick().expired, false, "already in the default session");
  });

  test("a session can bring its own P2/P2* and S3", () => {
    const definitions = simulatorSessions().map((session) =>
      session.type === SESSION.EXTENDED
        ? { ...session, p2Ms: 30, p2StarMs: 3000, s3Ms: 60 }
        : session,
    );
    const { state, setNow } = machine({
      sessions: definitions,
      timing: { p2Ms: 50, p2StarMs: 5000, s3Ms: 5000 },
    });
    assert.equal(state.p2Ms, 50, "the default session uses the ECU timing");
    state.request(SESSION.EXTENDED);
    assert.equal(state.p2Ms, 30);
    assert.equal(state.p2StarMs, 3000);
    assert.equal(state.s3Ms, 60);
    setNow(T0 + 61);
    assert.equal(state.tick().expired, true, "the session's own S3 applies");
  });

  test("serviceRefusal judges only what the ECU implements", () => {
    const { state } = machine({ implemented: [SID.READ_DATA_BY_IDENTIFIER] });
    assert.equal(
      state.serviceRefusal(0x77),
      null,
      "an unimplemented service is the service table's 0x11, not a session decision",
    );
    assert.equal(state.isServiceAllowed(0x77), false);
    assert.equal(state.serviceRefusal(SID.READ_DATA_BY_IDENTIFIER), null);
    assert.equal(state.isServiceAllowed(SID.READ_DATA_BY_IDENTIFIER), true);
  });

  test("write services are refused in the default session with 0x7F", () => {
    const { state } = machine();
    for (const service of [
      SID.CLEAR_DIAGNOSTIC_INFORMATION,
      SID.SECURITY_ACCESS,
      SID.WRITE_DATA_BY_IDENTIFIER,
      SID.ROUTINE_CONTROL,
    ]) {
      assert.equal(
        state.serviceRefusal(service),
        NRC.SERVICE_NOT_SUPPORTED_IN_ACTIVE_SESSION,
        `service 0x${service.toString(16)} must need a non-default session`,
      );
    }
    state.request(SESSION.EXTENDED);
    for (const service of [
      SID.CLEAR_DIAGNOSTIC_INFORMATION,
      SID.SECURITY_ACCESS,
      SID.WRITE_DATA_BY_IDENTIFIER,
      SID.ROUTINE_CONTROL,
    ]) {
      assert.equal(state.serviceRefusal(service), null);
    }
  });

  test("session control, reset and tester present work in every session", () => {
    const { state } = machine();
    for (const type of [SESSION.DEFAULT, SESSION.EXTENDED, SESSION.PROGRAMMING]) {
      state.reset();
      if (type !== SESSION.DEFAULT) state.request(SESSION.EXTENDED);
      if (type === SESSION.PROGRAMMING) state.request(SESSION.PROGRAMMING);
      for (const service of ALWAYS_AVAILABLE_SERVICES) {
        assert.equal(state.serviceRefusal(service), null, `session 0x${type.toString(16)}`);
      }
    }
  });

  test("a session without a service list allows everything the ECU implements", () => {
    const { services: _ignored, ...withoutList } = defaultSessionDefinition();
    const permissive: SessionDefinition[] = [withoutList, extendedSessionDefinition()];
    const { state } = machine({ sessions: permissive });
    assert.equal(state.serviceRefusal(SID.CLEAR_DIAGNOSTIC_INFORMATION), null);
    assert.equal(state.isServiceAllowed(SID.CLEAR_DIAGNOSTIC_INFORMATION), true);
  });

  test("describeRefusal explains all three outcomes", () => {
    const { state } = machine({ implemented: [SID.READ_DATA_BY_IDENTIFIER] });
    assert.match(state.describeRefusal(0x77), /not implemented/);
    assert.match(
      state.describeRefusal(SID.READ_DATA_BY_IDENTIFIER),
      /is allowed in defaultSession/,
    );
    state.request(SESSION.EXTENDED);
    assert.match(state.describeRefusal(SID.READ_DATA_BY_IDENTIFIER), /is allowed/);
    // A write service is allowed in the extended session, so use an ECU whose
    // extended session only allows reading.
    const restricted = new SessionStateMachine({
      sessions: [
        defaultSessionDefinition(),
        { ...extendedSessionDefinition(), services: [SID.READ_DATA_BY_IDENTIFIER] },
      ],
      implementedServices: [SID.READ_DATA_BY_IDENTIFIER, SID.CLEAR_DIAGNOSTIC_INFORMATION],
      now: () => T0,
    });
    restricted.request(SESSION.EXTENDED);
    assert.match(
      restricted.describeRefusal(SID.CLEAR_DIAGNOSTIC_INFORMATION),
      /not available in extendedDiagnosticSession \(NRC serviceNotSupportedInActiveSession\)/,
    );
  });

  test("a definition without a default session cannot be built", () => {
    assert.throws(
      () =>
        new SessionStateMachine({
          sessions: [programmingSessionDefinition()],
          now: () => T0,
        }),
      (error: unknown) => {
        assert.ok(error instanceof ProtocolError);
        assert.match(error.message, /default session 0x01 is not among the defined sessions/);
        return true;
      },
    );
  });

  test("an empty definition list is refused", () => {
    assert.throws(
      () => new SessionStateMachine({ sessions: [], now: () => T0 }),
      /at least one session definition/,
    );
  });

  test("a custom default session is honoured", () => {
    const state = new SessionStateMachine({
      sessions: [
        { ...defaultSessionDefinition(), from: [0x01, 0x60] },
        { ...extendedSessionDefinition(), type: 0x60, from: [0x01, 0x60] },
      ],
      defaultSession: 0x60,
      now: () => T0,
    });
    assert.equal(state.sessionType, 0x60);
    assert.equal(
      state.tick(T0 + 10_000).expired,
      false,
      "the default session is not a session to leave",
    );
    assert.equal(state.request(0x01).ok, true);
    assert.equal(state.sessionType, 0x01);
    assert.equal(state.tick(T0 + 20_000).expired, true, "0x01 is not this ECU's default");
  });

  test("a session that was never declared cannot be entered, even as the default", () => {
    assert.throws(
      () =>
        new SessionStateMachine({
          sessions: standardSessions(),
          defaultSession: 0x60,
          now: () => T0,
        }),
      /default session 0x60/,
    );
  });

  test("without an injected clock the machine still works (real time)", () => {
    const state = new SessionStateMachine({
      sessions: standardSessions(),
      implementedServices: [SID.READ_DATA_BY_IDENTIFIER],
    });
    assert.equal(state.sessionType, SESSION.DEFAULT);
    assert.equal(state.tick().expired, false, "the default session never times out");
    assert.equal(state.request(SESSION.EXTENDED).ok, true);
    assert.equal(typeof state.lastActivity, "number");
  });
});
