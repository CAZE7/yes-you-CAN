/**
 * Explicit ECU-side session state machine (ISO 14229-1 §10.2, ISO 14229-2 §7).
 *
 * Why a state machine instead of the bare number the server used before:
 *
 *  - **A session is a policy, not a number.** `activeSession = 0x03` said nothing
 *    about which services the ECU accepts there. Session gating was therefore
 *    scattered across individual handlers (`handleWriteDataByIdentifier` checked
 *    the default session, `handleClearDtc` did not), so "is this service allowed
 *    here?" had as many answers as there were handlers.
 *  - **A transition that is not written down is refused.** With a number field the
 *    implicit rule was "any listed session may be entered from any listed
 *    session" — a tester could jump straight into the programming session. Here
 *    every session declares `from`, and an undeclared transition is answered with
 *    `conditionsNotCorrect` instead of happening.
 *  - **S3Server is real ECU behaviour.** After S3 expires without a request the
 *    ECU falls back to the default session (and drops the security level). A
 *    simulator that keeps a session alive forever teaches the client a state
 *    machine no vehicle has.
 *
 * The machine is deliberately free of I/O and of the service implementations: it
 * answers three questions — may this session be entered, is this service allowed
 * here, has the session expired — and the server does the rest.
 */

import { ProtocolError } from "@vdp/shared";
import { NRC, nrcName } from "./nrc.js";
import { SESSION, SESSION_NAMES, SID } from "./services.js";
import { DEFAULT_UDS_TIMING, type UdsTiming } from "./timing.js";

/**
 * One session the ECU supports.
 *
 * `from` is required on purpose: "entered from anywhere" has to be written down
 * as such, so a definition package (or an OEM session) cannot inherit a
 * transition nobody declared.
 */
export interface SessionDefinition {
  /** Session type byte: 0x01 default, 0x02 programming, 0x03 extended, 0x40–0x5F OEM. */
  type: number;
  /** Diagnostic name, e.g. `extendedDiagnosticSession`. */
  name: string;
  /** Session types this session may be entered *from*. */
  from: readonly number[];
  /**
   * Services allowed in this session. `undefined` means "every service the ECU
   * implements" — that is what an ECU without write protection looks like, and it
   * has to be stated explicitly rather than assumed.
   */
  services?: readonly number[];
  /** P2Server_max for this session in ms (ISO 14229-2); default: the ECU's timing. */
  p2Ms?: number;
  /** P2*Server_max for this session in ms (Response Pending); default: the ECU's timing. */
  p2StarMs?: number;
  /** S3Server timeout for this session in ms; default: the ECU's timing. */
  s3Ms?: number;
}

/**
 * Services that must work in *every* session (ISO 14229-1 §10.2): the tester has
 * to be able to ask for another session, to reset the ECU and to keep the session
 * alive, whatever session is active. Everything else is the definition's call.
 */
export const ALWAYS_AVAILABLE_SERVICES: readonly number[] = [
  SID.DIAGNOSTIC_SESSION_CONTROL,
  SID.ECU_RESET,
  SID.TESTER_PRESENT,
];

/** Services that only read state; available in the default session. */
export const READ_SERVICES: readonly number[] = [
  SID.READ_DATA_BY_IDENTIFIER,
  SID.READ_DTC_INFORMATION,
];

/** Services that change ECU or vehicle state; they need a non-default session. */
export const WRITE_SERVICES: readonly number[] = [
  SID.CLEAR_DIAGNOSTIC_INFORMATION,
  SID.SECURITY_ACCESS,
  SID.WRITE_DATA_BY_IDENTIFIER,
  SID.INPUT_OUTPUT_CONTROL_BY_IDENTIFIER,
  SID.ROUTINE_CONTROL,
  SID.CONTROL_DTC_SETTING,
];

/** Every session type the shipped definitions know about. */
const KNOWN_SESSION_TYPES: readonly number[] = [
  SESSION.DEFAULT,
  SESSION.EXTENDED,
  SESSION.PROGRAMMING,
];

export interface SessionStateOptions {
  sessions: readonly SessionDefinition[];
  /** Session the ECU starts in and falls back to. Default: `0x01`. */
  defaultSession?: number;
  /** Services the ECU implements at all; used to answer with the right NRC. */
  implementedServices?: readonly number[];
  timing?: Partial<UdsTiming>;
  /** Injectable clock — session timing must be testable without waiting. */
  now?: () => number;
}

export interface SessionTransition {
  ok: boolean;
  /** Session type after the call; unchanged when the request was refused. */
  sessionType: number;
  /** True when this call actually changed the session. */
  switched: boolean;
  /** Why the transition was refused (only set when `ok` is false). */
  reason?: string;
  /** NRC the ECU must answer with (only set when `ok` is false). */
  nrc?: number;
}

export interface SessionExpiry {
  expired: boolean;
  from: number;
  to: number;
}

export class SessionStateMachine {
  private readonly definitions: Map<number, SessionDefinition>;
  private readonly defaultType: number;
  private readonly implemented: ReadonlySet<number>;
  private readonly fallbackTiming: UdsTiming;
  private readonly now: () => number;
  private current: SessionDefinition;
  private lastActivityAt: number;

  constructor(options: SessionStateOptions) {
    if (options.sessions.length === 0) {
      throw new ProtocolError("a session state machine needs at least one session definition");
    }
    this.definitions = new Map(options.sessions.map((session) => [session.type, session]));
    this.defaultType = options.defaultSession ?? SESSION.DEFAULT;
    const defaultDefinition = this.definitions.get(this.defaultType);
    if (!defaultDefinition) {
      throw new ProtocolError(
        `the default session 0x${hex(this.defaultType)} is not among the defined sessions (${this.describeTypes()})`,
      );
    }
    this.implemented = new Set(options.implementedServices ?? []);
    this.fallbackTiming = { ...DEFAULT_UDS_TIMING, ...(options.timing ?? {}) };
    this.now = options.now ?? (() => Date.now());
    this.current = defaultDefinition;
    this.lastActivityAt = this.now();
  }

  /** Session types the ECU defines, in declaration order. */
  get types(): number[] {
    return Array.from(this.definitions.keys());
  }

  get active(): SessionDefinition {
    return this.current;
  }

  get sessionType(): number {
    return this.current.type;
  }

  get sessionName(): string {
    return this.current.name;
  }

  /** P2Server_max of the active session. */
  get p2Ms(): number {
    return this.current.p2Ms ?? this.fallbackTiming.p2Ms;
  }

  /** P2*Server_max of the active session (the budget after a Response Pending). */
  get p2StarMs(): number {
    return this.current.p2StarMs ?? this.fallbackTiming.p2StarMs;
  }

  /** S3Server of the active session. */
  get s3Ms(): number {
    return this.current.s3Ms ?? this.fallbackTiming.s3Ms;
  }

  get lastActivity(): number {
    return this.lastActivityAt;
  }

  /**
   * Ask for a session. A type the ECU does not define is `subFunctionNotSupported`
   * (0x12); a defined session that may not be entered from the active one is
   * `conditionsNotCorrect` (0x22) — the ECU is not broken, the sequence is.
   */
  request(type: number, at?: number): SessionTransition {
    const definition = this.definitions.get(type);
    if (!definition) {
      return {
        ok: false,
        switched: false,
        sessionType: this.current.type,
        nrc: NRC.SUB_FUNCTION_NOT_SUPPORTED,
        reason: `session 0x${hex(type)} is not defined for this ECU (defined: ${this.describeTypes()})`,
      };
    }
    if (type !== this.current.type && !definition.from.includes(this.current.type)) {
      return {
        ok: false,
        switched: false,
        sessionType: this.current.type,
        nrc: NRC.CONDITIONS_NOT_CORRECT,
        reason: `session 0x${hex(type)} may only be entered from ${describeTypes(definition.from)}, not from 0x${hex(this.current.type)}`,
      };
    }
    const switched = type !== this.current.type;
    const at_ = at ?? this.now();
    this.current = definition;
    this.lastActivityAt = at_;
    return { ok: true, switched, sessionType: type };
  }

  /**
   * ECU reset (ISO 14229-1 §11.2): the ECU always returns to the default session.
   * This transition is defined for every ECU, so it is not part of the `from`
   * bookkeeping above.
   */
  reset(at?: number): number {
    const previous = this.current.type;
    this.current = this.require(this.defaultType);
    this.lastActivityAt = at ?? this.now();
    return previous;
  }

  /** Any request received resets S3Server (ISO 14229-2 §7.4). */
  activity(at?: number): void {
    this.lastActivityAt = at ?? this.now();
  }

  /**
   * S3Server expired? Falls back to the default session and reports the change.
   *
   * The server calls this before handling a request, which makes the fallback
   * observable without a background timer — and therefore reproducible in tests.
   */
  tick(at?: number): SessionExpiry {
    const now = at ?? this.now();
    if (this.current.type === this.defaultType) {
      return { expired: false, from: this.current.type, to: this.current.type };
    }
    if (now - this.lastActivityAt < this.s3Ms) {
      return { expired: false, from: this.current.type, to: this.current.type };
    }
    const from = this.current.type;
    this.reset(now);
    return { expired: true, from, to: this.defaultType };
  }

  /**
   * NRC for a service in the active session, or `null` when it is allowed.
   *
   * A service the ECU does not implement at all is *not* answered here: that is
   * `serviceNotSupported` (0x11) and belongs to the service table, not to the
   * session policy. This split is what makes the two refusals distinguishable.
   */
  serviceRefusal(serviceId: number): number | null {
    if (!this.implemented.has(serviceId)) return null;
    if (ALWAYS_AVAILABLE_SERVICES.includes(serviceId)) return null;
    const allowed = this.current.services;
    if (!allowed) return null;
    return allowed.includes(serviceId) ? null : NRC.SERVICE_NOT_SUPPORTED_IN_ACTIVE_SESSION;
  }

  /** True when the service may be used right now (implemented and allowed here). */
  isServiceAllowed(serviceId: number): boolean {
    return this.implemented.has(serviceId) && this.serviceRefusal(serviceId) === null;
  }

  /** Reason text for a refusal, for logs and error messages. */
  describeRefusal(serviceId: number): string {
    if (!this.implemented.has(serviceId)) {
      return `service 0x${hex(serviceId)} is not implemented by this ECU`;
    }
    const nrc = this.serviceRefusal(serviceId);
    if (nrc === null) return `service 0x${hex(serviceId)} is allowed in ${this.current.name}`;
    return `service 0x${hex(serviceId)} is not available in ${this.current.name} (NRC ${nrcName(nrc)})`;
  }

  private require(type: number): SessionDefinition {
    const definition = this.definitions.get(type);
    if (!definition) {
      throw new ProtocolError(`session 0x${hex(type)} is not defined for this ECU`);
    }
    return definition;
  }

  private describeTypes(): string {
    return describeTypes(this.types);
  }
}

function describeTypes(types: readonly number[]): string {
  return types.map((type) => `0x${hex(type)}`).join(", ");
}

function hex(value: number): string {
  return value.toString(16).toUpperCase().padStart(2, "0");
}

/** The default session: read-only services, reachable from every session. */
export function defaultSessionDefinition(): SessionDefinition {
  return {
    type: SESSION.DEFAULT,
    name: SESSION_NAMES[SESSION.DEFAULT] ?? "defaultSession",
    from: [...KNOWN_SESSION_TYPES],
    services: [...ALWAYS_AVAILABLE_SERVICES, ...READ_SERVICES],
  };
}

/**
 * The extended diagnostic session: the session a write is performed in
 * (AGENTS 29 / ADR 0029 — no write happens in the default session).
 */
export function extendedSessionDefinition(): SessionDefinition {
  return {
    type: SESSION.EXTENDED,
    name: SESSION_NAMES[SESSION.EXTENDED] ?? "extendedDiagnosticSession",
    from: [...KNOWN_SESSION_TYPES],
    services: [...ALWAYS_AVAILABLE_SERVICES, ...READ_SERVICES, ...WRITE_SERVICES],
  };
}

/**
 * The programming session (flashing). It is reachable **only from the extended
 * session**: jumping from the default session is the transition that must be
 * refused, and an ECU that declares it otherwise says so explicitly.
 */
export function programmingSessionDefinition(): SessionDefinition {
  return {
    type: SESSION.PROGRAMMING,
    name: SESSION_NAMES[SESSION.PROGRAMMING] ?? "programmingSession",
    from: [SESSION.EXTENDED],
    services: [...ALWAYS_AVAILABLE_SERVICES, ...READ_SERVICES, ...WRITE_SERVICES],
  };
}

/** What an ECU without further configuration supports: default + extended. */
export function standardSessions(): SessionDefinition[] {
  return [defaultSessionDefinition(), extendedSessionDefinition()];
}

/** What the simulator's ECUs support: default + extended + programming. */
export function simulatorSessions(): SessionDefinition[] {
  return [defaultSessionDefinition(), extendedSessionDefinition(), programmingSessionDefinition()];
}
