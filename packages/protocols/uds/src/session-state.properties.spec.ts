/**
 * Property-based tests for the ECU session state machine (fast-check).
 *
 * ISO 14229-1 §10.2 (session transitions), §9.4 (SecurityAccess level),
 * ISO 14229-2 §7.4 (S3Server).
 *
 * `session-state.spec.ts` next door pins single named behaviours with examples.
 * This file pins the **rules** instead, because a session table is a graph and a
 * diagnosis is a *sequence*: which session the ECU is in, which services it
 * accepts there, whether S3 has expired and which security level is still
 * unlocked all depend on the order the requests arrived in. Examples cover the
 * orders somebody thought of; properties cover the orders nobody did.
 *
 * Method: model-based testing. An ECU is generated at random — session types,
 * declared `from` edges, per-session service lists, per-session P2, P2-star and
 * S3 overrides, the set of implemented services — and a random command sequence
 * (session request, reset, activity, idle time, S3 tick, unlock, lock, service
 * query) is applied to **both** the machine and a model written straight from the
 * standard. After every single step the two must agree on the session, the
 * security level, the activity clock and the NRC a refusal carries.
 *
 * A counterexample is reproducible: fast-check prints `seed` and `path` with the
 * failing input, and `fc.assert(property, { seed, path })` replays exactly it.
 */

import assert from "node:assert/strict";
import { createLogger, ProtocolError } from "@vdp/shared";
import fc from "fast-check";
import { describe, test } from "vitest";
import { NRC } from "./nrc.js";
import { UdsServer, type UdsServerLink } from "./server.js";
import { SESSION, SESSION_NAMES, SID } from "./services.js";
import {
  ALWAYS_AVAILABLE_SERVICES,
  defaultSessionDefinition,
  extendedSessionDefinition,
  programmingSessionDefinition,
  READ_SERVICES,
  type SessionDefinition,
  type SessionExpiry,
  SessionStateMachine,
  type SessionTransition,
  simulatorSessions,
  standardSessions,
  WRITE_SERVICES,
} from "./session-state.js";
import type { UdsTiming } from "./timing.js";

const logger = createLogger("uds-session-pbt", { level: "ERROR" });

/** Every service the session policy knows about, plus one the ECU never implements. */
const SERVICE_POOL: readonly number[] = [
  ...ALWAYS_AVAILABLE_SERVICES,
  ...READ_SERVICES,
  ...WRITE_SERVICES,
];
const UNIMPLEMENTED_SERVICE = SID.REQUEST_DOWNLOAD;

/** Session types a generated ECU may declare on top of the default session. */
const EXTRA_SESSION_TYPES: readonly number[] = [
  SESSION.PROGRAMMING,
  SESSION.EXTENDED,
  0x40,
  0x41,
  0x5f,
];
/** Session types no generated ECU declares — asking for one is 0x12. */
const UNKNOWN_SESSION_TYPES: readonly number[] = [0x04, 0x42, 0x60, 0x7e];

// ------------------------------------------------------------------ generation

/** A generated ECU: its session graph, its service table and its base timing. */
interface GeneratedEcu {
  sessions: readonly SessionDefinition[];
  types: readonly number[];
  byType: Map<number, SessionDefinition>;
  implemented: readonly number[];
  timing: UdsTiming;
  defaultSession: number;
}

/** What the generator decides per session, before it becomes a definition. */
interface SessionShape {
  from: readonly number[];
  services: readonly number[] | undefined;
  p2Ms: number | undefined;
  p2StarMs: number | undefined;
  s3Ms: number | undefined;
}

const timingArb: fc.Arbitrary<UdsTiming> = fc.record({
  p2Ms: fc.integer({ min: 1, max: 400 }),
  p2StarMs: fc.integer({ min: 1, max: 6000 }),
  s3Ms: fc.integer({ min: 1, max: 6000 }),
});

function sessionShapeArb(types: readonly number[]): fc.Arbitrary<SessionShape> {
  return fc.record({
    from: fc.uniqueArray(fc.constantFrom(...types), { maxLength: types.length }),
    // `undefined` is a meaning of its own here: "every implemented service is
    // allowed" — an ECU without write protection, stated explicitly.
    services: fc.option(
      fc.uniqueArray(fc.constantFrom(...SERVICE_POOL), { maxLength: SERVICE_POOL.length }),
      {
        nil: undefined,
      },
    ),
    p2Ms: fc.option(fc.integer({ min: 1, max: 400 }), { nil: undefined }),
    p2StarMs: fc.option(fc.integer({ min: 1, max: 6000 }), { nil: undefined }),
    s3Ms: fc.option(fc.integer({ min: 1, max: 6000 }), { nil: undefined }),
  });
}

function definitionOf(type: number, shape: SessionShape): SessionDefinition {
  return {
    type,
    name: SESSION_NAMES[type] ?? `oemSession_0x${type.toString(16)}`,
    from: [...shape.from],
    ...(shape.services === undefined ? {} : { services: [...shape.services] }),
    ...(shape.p2Ms === undefined ? {} : { p2Ms: shape.p2Ms }),
    ...(shape.p2StarMs === undefined ? {} : { p2StarMs: shape.p2StarMs }),
    ...(shape.s3Ms === undefined ? {} : { s3Ms: shape.s3Ms }),
  };
}

/** A random ECU. The default session always exists — its absence is tested separately. */
const ecuArb: fc.Arbitrary<GeneratedEcu> = fc
  .uniqueArray(fc.constantFrom(...EXTRA_SESSION_TYPES), { maxLength: EXTRA_SESSION_TYPES.length })
  .chain((extra) => {
    const types = [SESSION.DEFAULT, ...extra];
    return fc
      .tuple(
        fc.array(sessionShapeArb(types), { minLength: types.length, maxLength: types.length }),
        fc.uniqueArray(fc.constantFrom(...SERVICE_POOL), { maxLength: SERVICE_POOL.length }),
        timingArb,
      )
      .map(([shapes, implemented, timing]) => {
        const sessions = types.map((type, index) =>
          definitionOf(type, shapes[index] as SessionShape),
        );
        return {
          sessions,
          types,
          byType: new Map(sessions.map((session) => [session.type, session])),
          implemented,
          timing,
          defaultSession: SESSION.DEFAULT,
        } satisfies GeneratedEcu;
      });
  });

/** One step of a diagnosis: what a tester can do to an ECU between two answers. */
type Command =
  | { kind: "request"; type: number }
  | { kind: "reset" }
  | { kind: "activity" }
  | { kind: "idle"; delta: number }
  | { kind: "tick"; delta: number }
  | { kind: "unlock"; level: number }
  | { kind: "lock" }
  | { kind: "refusal"; service: number };

function commandArb(ecu: GeneratedEcu): fc.Arbitrary<Command> {
  return fc.oneof(
    fc.record({
      kind: fc.constant("request" as const),
      type: fc.constantFrom(...ecu.types, ...UNKNOWN_SESSION_TYPES),
    }),
    fc.constant({ kind: "reset" as const }),
    fc.constant({ kind: "activity" as const }),
    fc.record({ kind: fc.constant("idle" as const), delta: fc.integer({ min: 0, max: 9000 }) }),
    fc.record({ kind: fc.constant("tick" as const), delta: fc.integer({ min: 0, max: 9000 }) }),
    fc.record({ kind: fc.constant("unlock" as const), level: fc.integer({ min: 1, max: 0x7e }) }),
    fc.constant({ kind: "lock" as const }),
    fc.record({
      kind: fc.constant("refusal" as const),
      service: fc.constantFrom(...SERVICE_POOL, UNIMPLEMENTED_SERVICE),
    }),
  );
}

/** An ECU plus a command sequence to run against it. */
const scenarioArb: fc.Arbitrary<{ ecu: GeneratedEcu; commands: Command[] }> = ecuArb
  .chain((ecu) =>
    fc.tuple(fc.constant(ecu), fc.array(commandArb(ecu), { minLength: 1, maxLength: 40 })),
  )
  .map(([ecu, commands]) => ({ ecu, commands }));

// ----------------------------------------------------------------------- model

/** What the standard says an ECU holds: session, unlock, activity clock. */
interface ModelState {
  session: number;
  unlocked: number;
  lastActivity: number;
}

/** Everything one step reports, from the machine or from the model. */
interface StepOutcome {
  state: ModelState;
  transition?: SessionTransition;
  expiry?: SessionExpiry;
  resetFrom?: number;
  refusal?: number | null;
}

function activeDefinition(ecu: GeneratedEcu, state: ModelState): SessionDefinition {
  const definition = ecu.byType.get(state.session);
  assert.ok(definition, `the model left the session graph: 0x${state.session.toString(16)}`);
  return definition;
}

/** S3Server of the active session: its own override, or the ECU's timing. */
function s3Of(ecu: GeneratedEcu, state: ModelState): number {
  return activeDefinition(ecu, state).s3Ms ?? ecu.timing.s3Ms;
}

/**
 * The oracle: one step of ISO 14229 session behaviour, written from the standard
 * and not from `session-state.ts`.
 */
function modelStep(
  ecu: GeneratedEcu,
  before: ModelState,
  command: Command,
  at: number,
): StepOutcome {
  switch (command.kind) {
    case "request": {
      const definition = ecu.byType.get(command.type);
      // §10.2: a session type the ECU does not define is subFunctionNotSupported.
      if (!definition) {
        return {
          state: before,
          transition: {
            ok: false,
            switched: false,
            sessionType: before.session,
            nrc: NRC.SUB_FUNCTION_NOT_SUPPORTED,
          },
        };
      }
      // An undeclared transition is conditionsNotCorrect: the ECU is fine, the
      // sequence is not. Asking for the session that is already active is not a
      // transition at all, so it needs no `from` edge.
      if (command.type !== before.session && !definition.from.includes(before.session)) {
        return {
          state: before,
          transition: {
            ok: false,
            switched: false,
            sessionType: before.session,
            nrc: NRC.CONDITIONS_NOT_CORRECT,
          },
        };
      }
      const switched = command.type !== before.session;
      return {
        // A real transition starts locked again (§10.2); a repeated request for
        // the active session changes nothing and keeps the unlock.
        state: {
          session: command.type,
          unlocked: switched ? 0 : before.unlocked,
          lastActivity: at,
        },
        transition: { ok: true, switched, sessionType: command.type },
      };
    }
    case "reset":
      // §11.2: an ECU reset always returns to the default session, whatever the
      // graph declares, and takes the unlock with it.
      return {
        state: { session: ecu.defaultSession, unlocked: 0, lastActivity: at },
        resetFrom: before.session,
      };
    case "activity":
      // §7.4: any request resets S3Server — the session and the unlock survive.
      return { state: { ...before, lastActivity: at } };
    case "idle":
      // Time passes without a request; nothing is decided yet.
      return { state: before };
    case "tick": {
      const from = before.session;
      if (from === ecu.defaultSession) {
        // The default session has no S3 to expire.
        return { state: before, expiry: { expired: false, from, to: from } };
      }
      if (at - before.lastActivity < s3Of(ecu, before)) {
        return { state: before, expiry: { expired: false, from, to: from } };
      }
      return {
        state: { session: ecu.defaultSession, unlocked: 0, lastActivity: at },
        expiry: { expired: true, from, to: ecu.defaultSession },
      };
    }
    case "unlock":
      // §9.4: the level is recorded; recording it is not a request, so S3 does not
      // move — an unlock must never extend a session by itself.
      return { state: { ...before, unlocked: command.level } };
    case "lock":
      return { state: { ...before, unlocked: 0 } };
    case "refusal": {
      // A service the ECU does not implement is the service table's answer (0x11),
      // not the session policy's — the two refusals must stay distinguishable.
      if (!ecu.implemented.includes(command.service)) return { state: before, refusal: null };
      if (ALWAYS_AVAILABLE_SERVICES.includes(command.service))
        return { state: before, refusal: null };
      const allowed = activeDefinition(ecu, before).services;
      if (!allowed) return { state: before, refusal: null };
      return {
        state: before,
        refusal: allowed.includes(command.service)
          ? null
          : NRC.SERVICE_NOT_SUPPORTED_IN_ACTIVE_SESSION,
      };
    }
  }
}

/** The same step against the real machine. */
function machineStep(machine: SessionStateMachine, command: Command, at: number): StepOutcome {
  const readState = (): ModelState => ({
    session: machine.sessionType,
    unlocked: machine.securityLevel,
    lastActivity: machine.lastActivity,
  });
  switch (command.kind) {
    case "request": {
      // Mutate first, then read — object-literal evaluation order would otherwise
      // capture the pre-transition state and silently lose the result.
      const transition = machine.request(command.type, at);
      return { state: readState(), transition };
    }
    case "reset": {
      // `reset` returns the previous session type — capture it before the state
      // changes, then read the post-reset state. Object-literal evaluation order
      // would otherwise bind `state` first and silently lose the activity clock.
      const previous = machine.reset(at);
      return { state: readState(), resetFrom: previous };
    }
    case "activity":
      machine.activity(at);
      return { state: readState() };
    case "idle":
      return { state: readState() };
    case "tick": {
      const expiry = machine.tick(at);
      return { state: readState(), expiry };
    }
    case "unlock":
      machine.unlock(command.level);
      return { state: readState() };
    case "lock":
      machine.lock();
      return { state: readState() };
    case "refusal":
      return { state: readState(), refusal: machine.serviceRefusal(command.service) };
  }
}

function machineOf(ecu: GeneratedEcu): SessionStateMachine {
  return new SessionStateMachine({
    sessions: ecu.sessions,
    defaultSession: ecu.defaultSession,
    implementedServices: ecu.implemented,
    timing: ecu.timing,
    now: () => 0,
  });
}

function describeCommand(command: Command): string {
  switch (command.kind) {
    case "request":
      return `request(0x${command.type.toString(16)})`;
    case "refusal":
      return `serviceRefusal(0x${command.service.toString(16)})`;
    case "unlock":
      return `unlock(${command.level})`;
    case "idle":
    case "tick":
      return `${command.kind}(+${command.delta}ms)`;
    default:
      return command.kind;
  }
}

/** Sessions reachable from the default session over the declared `from` edges. */
function reachableFrom(ecu: GeneratedEcu, start: number): Set<number> {
  const seen = new Set<number>([start]);
  const queue = [start];
  for (const type of queue) {
    for (const candidate of ecu.types) {
      if (seen.has(candidate)) continue;
      const definition = ecu.byType.get(candidate);
      if (definition?.from.includes(type)) {
        seen.add(candidate);
        queue.push(candidate);
      }
    }
  }
  return seen;
}

/** One path from the default session to `target`, or `null` when there is none. */
function pathTo(ecu: GeneratedEcu, target: number): number[] | null {
  const queue: number[][] = [[ecu.defaultSession]];
  const seen = new Set<number>([ecu.defaultSession]);
  for (const path of queue) {
    const last = path[path.length - 1] as number;
    if (last === target) return path;
    for (const candidate of ecu.types) {
      if (seen.has(candidate) && candidate !== target) continue;
      const definition = ecu.byType.get(candidate);
      if (candidate === last || !definition?.from.includes(last)) continue;
      seen.add(candidate);
      queue.push([...path, candidate]);
    }
  }
  return null;
}

// ------------------------------------------------------------------ properties

describe("session state machine — properties", () => {
  test("machine and ISO model agree after every step of a random diagnosis", () => {
    fc.assert(
      fc.property(scenarioArb, ({ ecu, commands }) => {
        const machine = machineOf(ecu);
        let model: ModelState = { session: ecu.defaultSession, unlocked: 0, lastActivity: 0 };
        let clock = 0;
        const history: string[] = [];

        for (const command of commands) {
          // Idle time moves the clock without asking the ECU anything; every other
          // command is a request or a query at the current time.
          if (command.kind === "idle" || command.kind === "tick") clock += command.delta;
          const expected = modelStep(ecu, model, command, clock);
          const actual = machineStep(machine, command, clock);
          history.push(`${describeCommand(command)} @${clock}ms`);
          const where = `step ${history.length} (${history[history.length - 1]}):\n  ${history.join("\n  ")}`;

          model = expected.state;
          assert.deepEqual(actual.state, expected.state, `state diverged at ${where}`);
          assert.equal(machine.sessionType, model.session, `session diverged at ${where}`);
          assert.equal(
            machine.securityLevel,
            model.unlocked,
            `security level diverged at ${where}`,
          );
          assert.equal(machine.isUnlocked, model.unlocked !== 0, `isUnlocked diverged at ${where}`);
          assert.equal(
            machine.lastActivity,
            model.lastActivity,
            `activity clock diverged at ${where}`,
          );

          if (expected.transition || actual.transition) {
            // The machine explains a refusal in prose; the model only owes the NRC.
            assert.deepEqual(
              stripReason(actual.transition),
              stripReason(expected.transition),
              `transition diverged at ${where}`,
            );
          }
          if (expected.expiry || actual.expiry) {
            assert.deepEqual(actual.expiry, expected.expiry, `expiry diverged at ${where}`);
          }
          if (expected.resetFrom !== undefined || actual.resetFrom !== undefined) {
            assert.equal(actual.resetFrom, expected.resetFrom, `reset diverged at ${where}`);
          }
          if ("refusal" in expected || "refusal" in actual) {
            assert.equal(actual.refusal, expected.refusal, `service refusal diverged at ${where}`);
          }

          // The session's own timing always wins over the ECU's, in every session.
          const active = ecu.byType.get(model.session) as SessionDefinition;
          assert.equal(machine.p2Ms, active.p2Ms ?? ecu.timing.p2Ms, `P2 diverged at ${where}`);
          assert.equal(
            machine.p2StarMs,
            active.p2StarMs ?? ecu.timing.p2StarMs,
            `P2* diverged at ${where}`,
          );
          assert.equal(machine.s3Ms, active.s3Ms ?? ecu.timing.s3Ms, `S3 diverged at ${where}`);
          assert.equal(machine.sessionName, active.name, `session name diverged at ${where}`);
          assert.equal(machine.active, active, `active definition diverged at ${where}`);
        }
      }),
      { numRuns: 1000 },
    );
  });

  test("the machine never enters a session the declared graph does not allow", () => {
    fc.assert(
      fc.property(scenarioArb, ({ ecu, commands }) => {
        const machine = machineOf(ecu);
        const allowed = reachableFrom(ecu, ecu.defaultSession);
        let previous = ecu.defaultSession;
        let clock = 0;
        const entered: string[] = [];

        for (const command of commands) {
          if (command.kind === "idle" || command.kind === "tick") clock += command.delta;
          machineStep(machine, command, clock);
          const now = machine.sessionType;
          assert.ok(
            allowed.has(now),
            `session 0x${now.toString(16)} is not reachable from the default session over the declared edges`,
          );
          if (now !== previous) {
            const definition = ecu.byType.get(now) as SessionDefinition;
            // Every change is either a declared transition, a reset to the default
            // session, or an S3 expiry — there is no fourth way to move.
            const declared = definition.from.includes(previous);
            const isFallback = now === ecu.defaultSession;
            assert.ok(
              declared || isFallback,
              `moved 0x${previous.toString(16)} → 0x${now.toString(16)} without a declared edge`,
            );
            entered.push(`0x${previous.toString(16)}→0x${now.toString(16)}`);
          }
          previous = now;
        }
      }),
      { numRuns: 500 },
    );
  });

  test("every declared-reachable session is reachable, and only by a declared path", () => {
    fc.assert(
      fc.property(ecuArb, (ecu) => {
        const allowed = reachableFrom(ecu, ecu.defaultSession);
        for (const type of ecu.types) {
          const path = pathTo(ecu, type);
          if (!allowed.has(type)) {
            assert.equal(path, null, `0x${type.toString(16)} is unreachable but a path was found`);
            continue;
          }
          assert.ok(path, `0x${type.toString(16)} is reachable but no path was found`);
          // Walk the path on the real machine: every step must be accepted.
          const machine = machineOf(ecu);
          for (const step of (path as number[]).slice(1)) {
            const transition = machine.request(step, 0);
            assert.equal(
              transition.ok,
              true,
              `path ${path?.map((t) => `0x${t.toString(16)}`).join("→")} was refused at 0x${step.toString(16)}: ${transition.reason ?? ""}`,
            );
          }
          assert.equal(machine.sessionType, type);
        }
      }),
      { numRuns: 400 },
    );
  });

  test("S3Server expires exactly at the limit, never before, and takes the unlock with it", () => {
    fc.assert(
      fc.property(ecuArb, fc.integer({ min: 1, max: 0x7e }), (ecu, level) => {
        // Find a session that is not the default one and can be entered.
        const found = ecu.types.find((type) => type !== ecu.defaultSession && pathTo(ecu, type));
        fc.pre(found !== undefined);
        const target = found as number;
        const path = pathTo(ecu, target) as number[];

        const machine = machineOf(ecu);
        for (const step of path.slice(1)) assert.equal(machine.request(step, 0).ok, true);
        machine.unlock(level);
        const s3 = machine.s3Ms;

        // One millisecond before the limit nothing happens — not the session, not
        // the unlock, not the activity clock.
        const before = machine.tick(machine.lastActivity + s3 - 1);
        assert.deepEqual(before, { expired: false, from: target, to: target });
        assert.equal(machine.sessionType, target);
        assert.equal(machine.securityLevel, level);

        // At the limit the ECU is back in the default session and locked.
        const at = machine.tick(machine.lastActivity + s3);
        assert.deepEqual(at, { expired: true, from: target, to: ecu.defaultSession });
        assert.equal(machine.sessionType, ecu.defaultSession);
        assert.equal(machine.securityLevel, 0, "an expired session must not keep an unlock");
        assert.equal(machine.lastActivity, s3, "the expiry is the last activity the ECU saw");

        // The default session itself never expires, however long the bus is quiet.
        machine.unlock(level);
        const idle = machine.tick(machine.lastActivity + s3 * 1000);
        assert.deepEqual(idle, {
          expired: false,
          from: ecu.defaultSession,
          to: ecu.defaultSession,
        });
        assert.equal(machine.securityLevel, level);
      }),
      { numRuns: 500 },
    );
  });

  test("service gating is exactly the declared policy — 0x7F, 0x11 or allowed", () => {
    fc.assert(
      fc.property(scenarioArb, ({ ecu, commands }) => {
        const machine = machineOf(ecu);
        let clock = 0;
        for (const command of commands) {
          if (command.kind === "idle" || command.kind === "tick") clock += command.delta;
          machineStep(machine, command, clock);

          const active = machine.active;
          for (const service of [...SERVICE_POOL, UNIMPLEMENTED_SERVICE]) {
            const refusal = machine.serviceRefusal(service);
            const implemented = ecu.implemented.includes(service);
            if (!implemented) {
              // Not the session policy's business: the service table answers 0x11.
              assert.equal(refusal, null, `0x${service.toString(16)} is not implemented`);
              assert.equal(machine.isServiceAllowed(service), false);
              assert.match(machine.describeRefusal(service), /is not implemented by this ECU/);
              continue;
            }
            const alwaysAvailable = ALWAYS_AVAILABLE_SERVICES.includes(service);
            const allowedHere = active.services === undefined || active.services.includes(service);
            const expected =
              alwaysAvailable || allowedHere ? null : NRC.SERVICE_NOT_SUPPORTED_IN_ACTIVE_SESSION;
            assert.equal(refusal, expected, `0x${service.toString(16)} in ${active.name}`);
            assert.equal(machine.isServiceAllowed(service), expected === null);
            assert.ok(
              machine
                .describeRefusal(service)
                .includes(`0x${service.toString(16).toUpperCase().padStart(2, "0")}`),
              "a refusal must name the service it refuses",
            );
            if (expected !== null) {
              assert.equal(
                expected,
                0x7f,
                "a session refusal is always serviceNotSupportedInActiveSession",
              );
            }
          }
        }
      }),
      { numRuns: 120 },
    );
  });

  test("session control, ECU reset and TesterPresent are refused in no session at all", () => {
    fc.assert(
      fc.property(ecuArb, (ecu) => {
        const implemented = [...SERVICE_POOL];
        const machine = new SessionStateMachine({
          sessions: ecu.sessions,
          implementedServices: implemented,
          timing: ecu.timing,
          now: () => 0,
        });
        for (const type of ecu.types) {
          const path = pathTo(ecu, type);
          if (!path) continue;
          // Each type from a fresh default session — a session that is reachable
          // from the default must be enterable, not "enterable from whatever
          // session the previous type left us in".
          // `reset()` returns to the default session unconditionally — requesting it may
          // not, because the default session itself may declare an empty `from`.
          machine.reset(0);
          for (const step of path.slice(1)) machine.request(step, 0);
          assert.equal(machine.sessionType, type);
          for (const service of ALWAYS_AVAILABLE_SERVICES) {
            assert.equal(
              machine.serviceRefusal(service),
              null,
              `0x${service.toString(16)} must work in ${machine.sessionName} (ISO 14229-1 §10.2)`,
            );
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  test("an unlock survives a repeated request but dies on every real transition", () => {
    fc.assert(
      fc.property(ecuArb, fc.integer({ min: 1, max: 0x7e }), (ecu, level) => {
        const machine = machineOf(ecu);
        machine.unlock(level);
        assert.equal(machine.securityLevel, level);

        // Asking for the session the ECU is already in is not a transition.
        const same = machine.request(machine.sessionType, 10);
        assert.deepEqual({ ok: same.ok, switched: same.switched }, { ok: true, switched: false });
        assert.equal(machine.securityLevel, level, "a repeated request must not drop the unlock");

        // Recording an unlock is not a request: S3 must not move because of it.
        const activityBefore = machine.lastActivity;
        machine.unlock(level);
        assert.equal(machine.lastActivity, activityBefore, "an unlock must never extend a session");

        // Every real transition, every reset and every expiry starts locked.
        const other = ecu.types.find((type) => type !== machine.sessionType && pathTo(ecu, type));
        if (other !== undefined) {
          const path = pathTo(ecu, other) as number[];
          machine.request(ecu.defaultSession, 20);
          machine.unlock(level);
          for (const step of path.slice(1)) machine.request(step, 30);
          if (machine.sessionType === other) {
            assert.equal(
              machine.securityLevel,
              0,
              "a transition into another session drops the unlock",
            );
          }
        }
        machine.unlock(level);
        machine.reset(40);
        assert.equal(machine.securityLevel, 0, "an ECU reset drops the unlock");
        assert.equal(machine.sessionType, ecu.defaultSession);
        machine.unlock(level);
        machine.lock();
        assert.equal(machine.securityLevel, 0, "lock() is the explicit way out");
        assert.equal(machine.isUnlocked, false);
      }),
      { numRuns: 400 },
    );
  });

  test("a session table without its default session cannot be built", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.constantFrom(...EXTRA_SESSION_TYPES), {
          minLength: 1,
          maxLength: EXTRA_SESSION_TYPES.length,
        }),
        timingArb,
        (extra, timing) => {
          const sessions = extra.map((type) =>
            definitionOf(type, {
              from: [...extra],
              services: undefined,
              p2Ms: undefined,
              p2StarMs: undefined,
              s3Ms: undefined,
            }),
          );
          assert.throws(
            () =>
              new SessionStateMachine({
                sessions,
                defaultSession: SESSION.DEFAULT,
                timing,
                now: () => 0,
              }),
            (error: unknown) =>
              error instanceof ProtocolError &&
              /is not among the defined sessions/.test(error.message),
          );
          // An empty table is refused for the same reason: nothing to fall back to.
          assert.throws(
            () => new SessionStateMachine({ sessions: [], timing, now: () => 0 }),
            (error: unknown) =>
              error instanceof ProtocolError && /at least one session/.test(error.message),
          );
          // A custom default is honoured — and then *it* is the session that never expires.
          const custom = extra[0] as number;
          const withDefault = [
            definitionOf(custom, {
              from: [custom],
              services: undefined,
              p2Ms: undefined,
              p2StarMs: undefined,
              s3Ms: undefined,
            }),
            ...sessions.filter((session) => session.type !== custom),
          ];
          const machine = new SessionStateMachine({
            sessions: withDefault,
            defaultSession: custom,
            timing,
            now: () => 0,
          });
          assert.equal(machine.sessionType, custom);
          assert.deepEqual(machine.tick(timing.s3Ms * 100), {
            expired: false,
            from: custom,
            to: custom,
          });
          machine.unlock(2);
          machine.tick(timing.s3Ms * 100);
          assert.equal(
            machine.securityLevel,
            2,
            "the default session keeps its unlock — it has no S3",
          );
        },
      ),
      { numRuns: 200 },
    );
  });

  test("the shipped session tables behave the way the definitions promise", () => {
    // Not generated: these three tables ship, so their graph is pinned by hand —
    // the programming session is reachable only from the extended one (§10.2), and
    // write services stay out of the default session (AGENTS 29 / ADR 29).
    for (const sessions of [standardSessions(), simulatorSessions()]) {
      const types = sessions.map((session) => session.type);
      const machine = new SessionStateMachine({
        sessions,
        implementedServices: [...SERVICE_POOL],
        now: () => 0,
      });
      assert.equal(machine.sessionType, SESSION.DEFAULT);
      assert.deepEqual(machine.types, types);

      for (const service of WRITE_SERVICES) {
        assert.equal(
          machine.serviceRefusal(service),
          NRC.SERVICE_NOT_SUPPORTED_IN_ACTIVE_SESSION,
          `0x${service.toString(16)} must be refused in the default session`,
        );
      }
      for (const service of READ_SERVICES) {
        assert.equal(machine.serviceRefusal(service), null, "reads work in the default session");
      }

      // The forbidden jump: default → programming.
      if (sessions.some((session) => session.type === SESSION.PROGRAMMING)) {
        const jump = machine.request(SESSION.PROGRAMMING, 0);
        assert.deepEqual(
          { ok: jump.ok, switched: jump.switched, nrc: jump.nrc, sessionType: jump.sessionType },
          {
            ok: false,
            switched: false,
            nrc: NRC.CONDITIONS_NOT_CORRECT,
            sessionType: SESSION.DEFAULT,
          },
        );
        assert.match(jump.reason ?? "", /may only be entered from 0x03/);
        assert.equal(machine.securityLevel, 0);

        // The allowed way in: default → extended → programming.
        machine.unlock(2);
        assert.equal(machine.request(SESSION.EXTENDED, 1).ok, true);
        assert.equal(machine.securityLevel, 0, "the transition into extended dropped the unlock");
        machine.unlock(2);
        assert.equal(machine.request(SESSION.PROGRAMMING, 2).ok, true);
        assert.equal(machine.sessionType, SESSION.PROGRAMMING);
        assert.equal(
          machine.securityLevel,
          0,
          "the transition into programming dropped the unlock",
        );
        for (const service of WRITE_SERVICES) {
          assert.equal(machine.serviceRefusal(service), null, "flashing needs the write services");
        }
      }

      // Every shipped definition declares where it may be entered from.
      for (const session of sessions) {
        assert.ok(session.from.length > 0, `${session.name} declares no entry transition`);
        assert.ok(
          session.services === undefined || session.services.length > 0,
          `${session.name} declares an empty service list`,
        );
      }
      assert.deepEqual(defaultSessionDefinition().services, [
        ...ALWAYS_AVAILABLE_SERVICES,
        ...READ_SERVICES,
      ]);
      assert.deepEqual(programmingSessionDefinition().from, [SESSION.EXTENDED]);
      assert.deepEqual(extendedSessionDefinition().from, [
        SESSION.DEFAULT,
        SESSION.EXTENDED,
        SESSION.PROGRAMMING,
      ]);
    }
  });
});

// ------------------------------------------------------- the server end to end

/** Commands a tester can send a real `UdsServer`, with the session they need. */
type ServerCommand =
  | { kind: "enter"; session: number }
  | { kind: "unlock" }
  | { kind: "keepAlive" }
  | { kind: "idle"; delta: number }
  | { kind: "resetSession" };

const serverCommandArb: fc.Arbitrary<ServerCommand> = fc.oneof(
  fc.record({
    kind: fc.constant("enter" as const),
    session: fc.constantFrom(SESSION.DEFAULT, SESSION.EXTENDED, SESSION.PROGRAMMING),
  }),
  fc.constant({ kind: "unlock" as const }),
  fc.constant({ kind: "keepAlive" as const }),
  fc.record({ kind: fc.constant("idle" as const), delta: fc.integer({ min: 0, max: 12000 }) }),
  fc.constant({ kind: "resetSession" as const }),
);

interface ServerHarness {
  server: UdsServer;
  sent: Uint8Array[];
  advance(ms: number): void;
  stop(): void;
}

function serverHarness(s3Ms: number): ServerHarness {
  const sent: Uint8Array[] = [];
  const link: UdsServerLink = {
    onMessage: () => () => undefined,
    send: async (payload) => {
      sent.push(payload);
    },
  };
  let clock = 0;
  const server = new UdsServer(link, {
    name: "pbt-ecu",
    logger,
    clock: () => clock,
    sessionDefinitions: simulatorSessions(),
    timing: { p2Ms: 50, p2StarMs: 5000, s3Ms },
    // XOR-free and value-free on purpose: the key is right when it echoes the
    // level, so the property tests the *state*, not an algorithm (AGENTS 34.12 —
    // no real seed&key here or anywhere else in the repository).
    securityAccess: {
      seed: () => new Uint8Array([0x11, 0x22]),
      verifyKey: (level, key) => key[0] === level,
    },
  });
  server.start();
  return {
    server,
    sent,
    advance: (ms) => {
      clock += ms;
    },
    stop: () => server.stop(),
  };
}

describe("UdsServer — the unlock is session state, not handler state", () => {
  test("a granted SecurityAccess never survives a transition, an expiry or a reset", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 6000 }),
        fc.array(serverCommandArb, { minLength: 1, maxLength: 14 }),
        async (s3Ms, commands) => {
          const harness = serverHarness(s3Ms);
          // The simulator table: programming only from extended, default/extended
          // from anywhere (see the pinned property above).
          const from = new Map<number, readonly number[]>(
            simulatorSessions().map((session) => [session.type, session.from]),
          );
          let model: ModelState = { session: SESSION.DEFAULT, unlocked: 0, lastActivity: 0 };
          let clock = 0;
          const history: string[] = [];
          try {
            for (const command of commands) {
              if (command.kind === "idle") {
                clock += command.delta;
                harness.advance(command.delta);
                history.push(`idle(+${command.delta}ms) → ${clock}ms`);
                continue;
              }
              if (command.kind === "resetSession") {
                harness.server.resetSession();
                model = { session: SESSION.DEFAULT, unlocked: 0, lastActivity: clock };
                history.push(`resetSession() @${clock}ms`);
              } else {
                // Every request the server handles runs the same three steps: S3
                // check, activity, then the service (ISO 14229-2 §7.4).
                if (model.session !== SESSION.DEFAULT && clock - model.lastActivity >= s3Ms) {
                  model = { session: SESSION.DEFAULT, unlocked: 0, lastActivity: clock };
                }
                model = { ...model, lastActivity: clock };
                if (command.kind === "enter") {
                  const allowed =
                    command.session === model.session ||
                    (from.get(command.session) ?? []).includes(model.session);
                  if (allowed) {
                    const switched = command.session !== model.session;
                    model = {
                      ...model,
                      session: command.session,
                      unlocked: switched ? 0 : model.unlocked,
                    };
                  }
                  await harness.server.handle(
                    new Uint8Array([SID.DIAGNOSTIC_SESSION_CONTROL, command.session]),
                  );
                  history.push(`enter(0x${command.session.toString(16)}) @${clock}ms`);
                } else if (command.kind === "keepAlive") {
                  await harness.server.handle(new Uint8Array([SID.TESTER_PRESENT, 0x00]));
                  history.push(`keepAlive() @${clock}ms`);
                } else {
                  // SecurityAccess: refused in the default session (write service),
                  // and only a verified key unlocks.
                  await harness.server.handle(new Uint8Array([SID.SECURITY_ACCESS, 0x01]));
                  const refusedInDefaultSession = model.session === SESSION.DEFAULT;
                  await harness.server.handle(new Uint8Array([SID.SECURITY_ACCESS, 0x02, 0x02]));
                  if (!refusedInDefaultSession) model = { ...model, unlocked: 0x02 };
                  history.push(`unlock() @${clock}ms`);
                }
              }

              const where = `step ${history.length}:\n  ${history.join("\n  ")}`;
              assert.equal(
                harness.server.securityLevel,
                model.unlocked,
                `security level diverged at ${where}`,
              );
              assert.equal(
                harness.server.sessions.sessionType,
                model.session,
                `session diverged at ${where}`,
              );
              assert.equal(harness.server.sessions.lastActivity, model.lastActivity, where);
            }
          } finally {
            harness.stop();
          }
        },
      ),
      { numRuns: 250 },
    );
  });

  test("the unlock is visible on the wire and in the state, and gone after a session change", async () => {
    const harness = serverHarness(5000);
    try {
      await harness.server.handle(new Uint8Array([SID.SECURITY_ACCESS, 0x01]));
      assert.equal(harness.server.securityLevel, 0, "a seed alone unlocks nothing");
      assert.deepEqual([...(harness.sent.at(-1) ?? [])], [0x7f, SID.SECURITY_ACCESS, 0x7f]);

      await harness.server.handle(
        new Uint8Array([SID.DIAGNOSTIC_SESSION_CONTROL, SESSION.EXTENDED]),
      );
      await harness.server.handle(new Uint8Array([SID.SECURITY_ACCESS, 0x01]));
      await harness.server.handle(new Uint8Array([SID.SECURITY_ACCESS, 0x02, 0x02]));
      assert.equal(harness.server.securityLevel, 0x02);
      assert.deepEqual([...(harness.sent.at(-1) ?? [])], [0x67, 0x02]);

      await harness.server.handle(
        new Uint8Array([SID.DIAGNOSTIC_SESSION_CONTROL, SESSION.DEFAULT]),
      );
      assert.equal(
        harness.server.securityLevel,
        0,
        "back in the default session the ECU is locked",
      );

      await harness.server.handle(
        new Uint8Array([SID.DIAGNOSTIC_SESSION_CONTROL, SESSION.EXTENDED]),
      );
      await harness.server.handle(new Uint8Array([SID.SECURITY_ACCESS, 0x02, 0x02]));
      assert.equal(harness.server.securityLevel, 0x02);
      harness.advance(5000);
      await harness.server.handle(new Uint8Array([SID.READ_DATA_BY_IDENTIFIER, 0xf1, 0x90]));
      assert.equal(
        harness.server.sessions.sessionType,
        SESSION.DEFAULT,
        "S3 expired while the bus was quiet",
      );
      assert.equal(harness.server.securityLevel, 0, "and the expiry took the unlock with it");
    } finally {
      harness.stop();
    }
  });
});

/** The machine reports a `reason` the model does not; compare the rest. */
function stripReason(transition: SessionTransition | undefined): SessionTransition | undefined {
  if (!transition) return undefined;
  const { reason: _reason, ...rest } = transition;
  return rest;
}
