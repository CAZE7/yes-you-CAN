/**
 * UDS ECU-side server.
 *
 * Purpose (AGENTS 32): a virtual ECU for development, tests and replay, so no
 * feature needs real vehicle hardware. It implements exactly the services the
 * client models — nothing more — and simulates real-world behaviour such as
 * Response Pending (NRC 0x78), session gating and negative responses.
 */

import { createLogger, type Logger, messageOf, toHex } from "@vdp/shared";
import { encodeDtcToBytes } from "./dtc.js";
import { NRC } from "./nrc.js";
import {
  DTC_GROUP_ALL,
  DTC_REPORT,
  NEGATIVE_RESPONSE_SID,
  positiveResponseSid,
  RESET_TYPE,
  SID,
  SUPPRESS_POSITIVE_RESPONSE,
} from "./services.js";
import { type SessionDefinition, SessionStateMachine, standardSessions } from "./session-state.js";
import type { UdsTiming } from "./timing.js";

/**
 * The write hook of a writable DID (ISO 14229-1 §11.6).
 *
 * Two spellings are accepted on purpose: a handler that answers with an NRC refuses the
 * write and the server replies with that code, and a handler that just stores the bytes
 * returns nothing and the write is accepted. A handler that *throws* is a bug and not a
 * refusal — the server answers `generalReject` (0x10) and logs it, exactly as it does for
 * a failing read.
 *
 * This is a union of two signatures rather than `number | void` in one, because Biome is
 * right that a `void` inside a union is confusing — and both spellings have to stay
 * writable, or every simulator that stores a value in a block body gets a type error.
 */
export type ServerDidWriteHook = (payload: Uint8Array) => number | undefined;

export interface ServerDid {
  did: number;
  /** Function so live values can change between reads (simulator). */
  value: () => Uint8Array;
  writable?: boolean;
  /** Restrict to sessions; default: all. */
  sessions?: readonly number[];
  /**
   * Store what the tester wrote (ISO 14229-1 §11.6).
   *
   * A DID that is *computed* — a coding block in flash emulation, an adaptation
   * value the ECU keeps in its own memory — cannot be modelled by replacing the
   * read closure, because the closure is what computes the live value. The hook
   * is the official way in: `registerWritableDid()` exists so a simulator never
   * has to reach into the server's map.
   */
  write?: ServerDidWriteHook;
}

/** A DID the tester may write: the hook is required, so `writable` cannot be forgotten. */
export interface WritableServerDid {
  did: number;
  /** The value a read answers with — live, so the write may be validated against it. */
  value: () => Uint8Array;
  /** Store the payload; answer an NRC to refuse it, `undefined` to accept it. */
  write: ServerDidWriteHook;
  /**
   * Restrict the identifier to sessions; default: all. Which sessions may *write* at
   * all is the session machine's decision (`SessionDefinition.services`), so this
   * list is only for a DID that is readable in one session and not in another.
   */
  sessions?: readonly number[];
}

export interface ServerDtc {
  code: string;
  status: number;
  /** Freeze frame / environment data (record 0x01). */
  snapshot?: Uint8Array;
  extendedData?: Uint8Array;
}

export interface ServerRoutine {
  id: number;
  run: (data: Uint8Array) => Uint8Array;
}

export interface ServerSecurityAccess {
  seed: () => Uint8Array;
  verifyKey: (level: number, key: Uint8Array) => boolean;
  /** Delay before the seed may be requested again after a wrong key. */
  lockoutMs?: number;
}

/** Transport binding for the server side; `IsoTpConnection` adapts to this. */
export interface UdsServerLink {
  onMessage(listener: (payload: Uint8Array) => void): () => void;
  send(payload: Uint8Array): Promise<void>;
}

export interface UdsServerOptions {
  name: string;
  logger?: Logger;
  timing?: Partial<UdsTiming>;
  dids?: readonly ServerDid[];
  dtcs?: readonly ServerDtc[];
  routines?: readonly ServerRoutine[];
  /**
   * Sessions the ECU supports, with their services and entry conditions
   * (ISO 14229-1 §10.2). Default: default + extended (see `standardSessions()`).
   */
  sessionDefinitions?: readonly SessionDefinition[];
  /**
   * Injectable clock for session timing (S3Server) and security lockout. Defaults
   * to `Date.now()`; tests pass a controllable clock instead of waiting.
   */
  clock?: () => number;
  securityAccess?: ServerSecurityAccess;
  /** Services that answer with NRC 0x78 once before the real response. */
  pendingResponseServices?: readonly number[];
  pendingResponseDelayMs?: number;
  /** DTC availability mask reported by 0x19 responses. */
  dtcAvailabilityMask?: number;
  /**
   * DTC format identifier reported by `0x19 0x01` (ISO 14229-1 §8.1). Defaults to
   * 0x00, the ISO 14229-1 DTC format this server implements; a simulator modelling
   * a legacy ECU can state another value, and a client must not assume one.
   */
  dtcFormatIdentifier?: number;
}

export interface UdsServerStats {
  requests: number;
  positiveResponses: number;
  negativeResponses: number;
  pendingResponses: number;
}

export class UdsServer {
  readonly stats: UdsServerStats = {
    requests: 0,
    positiveResponses: 0,
    negativeResponses: 0,
    pendingResponses: 0,
  };

  private readonly options: UdsServerOptions;
  private readonly log: Logger;
  private readonly dids = new Map<number, ServerDid>();
  private readonly routines = new Map<number, ServerRoutine>();
  private readonly handlers: Map<number, (payload: Uint8Array) => Uint8Array | null>;
  private readonly session: SessionStateMachine;
  private readonly now: () => number;
  private dtcs: ServerDtc[];
  private unsubscribe: (() => void) | null = null;
  private securityFailures = 0;
  private lockedOutUntil = 0;

  constructor(
    private readonly link: UdsServerLink,
    options: UdsServerOptions,
  ) {
    this.options = options;
    this.log = (options.logger ?? createLogger("uds", { level: "INFO" })).child("uds");
    this.now = options.clock ?? (() => Date.now());
    for (const did of options.dids ?? []) this.registerDid(did);
    for (const routine of options.routines ?? []) this.routines.set(routine.id, routine);
    this.dtcs = [...(options.dtcs ?? [])];
    // The service table is the single source for "what does this ECU implement":
    // the dispatcher answers 0x11 for anything that is not in here, and the session
    // machine answers 0x7F for a service that exists but is not allowed right now.
    this.handlers = new Map<number, (payload: Uint8Array) => Uint8Array | null>([
      [SID.TESTER_PRESENT, (payload) => this.handleTesterPresent(payload)],
      [SID.DIAGNOSTIC_SESSION_CONTROL, (payload) => this.handleSessionControl(payload)],
      [SID.ECU_RESET, (payload) => this.handleEcuReset(payload)],
      [SID.CLEAR_DIAGNOSTIC_INFORMATION, (payload) => this.handleClearDtc(payload)],
      [SID.READ_DTC_INFORMATION, (payload) => this.handleReadDtc(payload)],
      [SID.READ_DATA_BY_IDENTIFIER, (payload) => this.handleReadDataByIdentifier(payload)],
      [SID.WRITE_DATA_BY_IDENTIFIER, (payload) => this.handleWriteDataByIdentifier(payload)],
      [SID.ROUTINE_CONTROL, (payload) => this.handleRoutineControl(payload)],
    ]);
    // Security access only exists as a service when the ECU has an algorithm to
    // offer: without one the honest answer is `serviceNotSupported` (0x11) in every
    // session, not `serviceNotSupportedInActiveSession` (0x7F).
    const securityAccess = options.securityAccess;
    if (securityAccess) {
      this.handlers.set(SID.SECURITY_ACCESS, (payload) =>
        this.handleSecurityAccess(securityAccess, payload),
      );
    }
    this.session = new SessionStateMachine({
      sessions: options.sessionDefinitions ?? standardSessions(),
      implementedServices: [...this.handlers.keys()],
      ...(options.timing ? { timing: options.timing } : {}),
      now: this.now,
    });
  }

  get name(): string {
    return this.options.name;
  }

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.link.onMessage((payload) => {
      void this.handle(payload);
    });
    this.log.debug("UDS server started", {
      ecu: this.name,
      dids: this.dids.size,
      dtcs: this.dtcs.length,
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /**
   * Register (or replace) one data identifier.
   *
   * The constructor's `dids` option is the declarative form of the same thing; this
   * is the imperative form a simulator needs when a value only becomes observable
   * after the vehicle model is wired up. Registering is the *official* way — poking
   * the server's map through a cast is not, and a cast hides a rename of the
   * private field from the compiler forever.
   */
  registerDid(definition: ServerDid): void {
    this.dids.set(definition.did, definition);
    this.log.debug("DID registered", { ecu: this.name, did: `0x${definition.did.toString(16)}` });
  }

  /** Register a DID the tester may write, with the ECU's own store hook. */
  registerWritableDid(definition: WritableServerDid): void {
    this.registerDid({
      did: definition.did,
      value: definition.value,
      writable: true,
      write: definition.write,
      ...(definition.sessions ? { sessions: definition.sessions } : {}),
    });
  }

  /** Remove a DID again. Returns whether one was registered. */
  unregisterDid(did: number): boolean {
    return this.dids.delete(did);
  }

  /** Whether this ECU answers the identifier at all. */
  hasDid(did: number): boolean {
    return this.dids.has(did);
  }

  /** Every registered identifier, ascending — the ECU's own answer to "what do you have?". */
  get registeredDids(): readonly number[] {
    return Array.from(this.dids.keys()).sort((a, b) => a - b);
  }

  /**
   * Upsert a fault-memory entry (simulator helper for tests and fixtures).
   *
   * A monitor that fires records a code *with* the operating point it fired at, so
   * this — and not `setDtcStatus()` alone — is the form a vehicle model uses.
   * Declared fields survive an update: a status change must not silently drop the
   * freeze frame the definition carries, and a re-raised fault keeps its snapshot
   * unless the caller passes a new one.
   */
  setDtc(dtc: ServerDtc): void {
    const entry = this.dtcs.find((candidate) => candidate.code === dtc.code);
    if (!entry) {
      this.dtcs.push({ ...dtc });
      return;
    }
    this.dtcs[this.dtcs.indexOf(entry)] = {
      ...entry,
      ...dtc,
      status: dtc.status,
      ...(dtc.snapshot === undefined ? { snapshot: entry.snapshot } : {}),
      ...(dtc.extendedData === undefined ? { extendedData: entry.extendedData } : {}),
    };
  }

  /** Test/simulator helper: change a DTC status (e.g. to simulate a fault appearing). */
  setDtcStatus(code: string, status: number): void {
    this.setDtc({ code, status });
  }

  /**
   * Take a code out of the fault memory entirely (simulator helper).
   *
   * This is not clearing: `0x14` resets statuses and leaves a still-present fault
   * in place (ISO 14229-1 §11.3), while a healed fault disappears from memory only
   * after the ECU's own aging counter expires. A model that recovers has to be able
   * to express that difference.
   */
  removeDtc(code: string): boolean {
    const index = this.dtcs.findIndex((dtc) => dtc.code === code);
    if (index < 0) return false;
    this.dtcs.splice(index, 1);
    return true;
  }

  /** The fault memory as this ECU holds it, newest entry last. */
  get dtcMemory(): readonly ServerDtc[] {
    return this.dtcs;
  }

  /** Back to the default session (simulator helper for tests and fixtures). */
  resetSession(): void {
    this.session.reset(this.now());
  }

  /** The session state machine — for tests, tooling and the workbench. */
  get sessions(): SessionStateMachine {
    return this.session;
  }

  /**
   * Security level this ECU is unlocked at, `0` while it is locked.
   *
   * Session state, so it is the session machine's to keep: a transition, an S3
   * expiry and a reset all drop it (ISO 14229-1 §10.2).
   */
  get securityLevel(): number {
    return this.session.securityLevel;
  }

  async handle(payload: Uint8Array): Promise<void> {
    if (payload.length === 0) return;
    this.stats.requests++;
    const serviceId = payload[0] as number;
    // S3Server (ISO 14229-2 §7.4): any request resets the session timer, and a
    // session that timed out before this request arrived is gone — the request is
    // answered by the default session, which is what a real ECU does.
    const now = this.now();
    const expiry = this.session.tick(now);
    if (expiry.expired) {
      this.log.info("session timed out, back to the default session", {
        ecu: this.name,
        from: `0x${expiry.from.toString(16)}`,
      });
    }
    this.session.activity(now);
    this.log.raw("server rx", { ecu: this.name, payload: toHex(payload) });

    const respond = async (response: Uint8Array): Promise<void> => {
      const pending = (this.options.pendingResponseServices ?? []).includes(serviceId);
      if (pending) {
        this.stats.pendingResponses++;
        await this.link.send(
          new Uint8Array([
            NEGATIVE_RESPONSE_SID,
            serviceId,
            NRC.REQUEST_CORRECTLY_RECEIVED_RESPONSE_PENDING,
          ]),
        );
        await delay(this.options.pendingResponseDelayMs ?? 30);
      }
      this.log.raw("server tx", { ecu: this.name, payload: toHex(response) });
      await this.link.send(response);
    };

    try {
      const response = this.dispatch(serviceId, payload);
      if (!response) return; // suppressed positive response
      if ((response[0] ?? 0) === NEGATIVE_RESPONSE_SID) this.stats.negativeResponses++;
      else this.stats.positiveResponses++;
      await respond(response);
    } catch (error) {
      this.stats.negativeResponses++;
      this.log.error("server handler failed", {
        ecu: this.name,
        error: messageOf(error),
      });
      // Reporting the failure must not fail on its own: the transport is what broke
      // here, and `start()` calls us as `void this.handle(payload)` — a rejection on
      // this path would be an unhandled rejection, i.e. a dead process instead of a log.
      try {
        await this.link.send(negativeResponse(serviceId, NRC.GENERAL_REJECT));
      } catch (sendError) {
        this.log.warn("could not report the failure to the caller", {
          ecu: this.name,
          error: messageOf(sendError),
        });
      }
    }
  }

  /**
   * Service table plus session policy.
   *
   * The two refusals stay distinguishable: a service this ECU does not implement
   * is `serviceNotSupported` (0x11), a service that exists but is not allowed in
   * the active session is `serviceNotSupportedInActiveSession` (0x7F).
   */
  private dispatch(serviceId: number, payload: Uint8Array): Uint8Array | null {
    const handler = this.handlers.get(serviceId);
    if (!handler) return negativeResponse(serviceId, NRC.SERVICE_NOT_SUPPORTED);
    const refusal = this.session.serviceRefusal(serviceId);
    if (refusal !== null) {
      this.log.debug("service refused in the active session", {
        ecu: this.name,
        reason: this.session.describeRefusal(serviceId),
      });
      return negativeResponse(serviceId, refusal);
    }
    return handler(payload);
  }

  private handleTesterPresent(payload: Uint8Array): Uint8Array | null {
    const subFunction = payload[1] ?? 0;
    if (subFunction & SUPPRESS_POSITIVE_RESPONSE) return null;
    return new Uint8Array([positiveResponseSid(SID.TESTER_PRESENT), 0x00]);
  }

  private handleSessionControl(payload: Uint8Array): Uint8Array {
    if (payload.length < 2)
      return negativeResponse(
        SID.DIAGNOSTIC_SESSION_CONTROL,
        NRC.INCORRECT_MESSAGE_LENGTH_OR_INVALID_FORMAT,
      );
    const requested = (payload[1] ?? 0) & 0x7f;
    const transition = this.session.request(requested, this.now());
    if (!transition.ok) {
      this.log.info("session request refused", {
        ecu: this.name,
        reason: transition.reason,
      });
      return negativeResponse(
        SID.DIAGNOSTIC_SESSION_CONTROL,
        transition.nrc ?? NRC.SUB_FUNCTION_NOT_SUPPORTED,
      );
    }
    if (transition.switched) {
      this.log.info("session changed", {
        ecu: this.name,
        session: this.session.sessionName,
      });
    }
    // [0x50, session, P2 (1 ms units), P2* (10 ms units)] — ISO 14229-2. The
    // reported timing belongs to the session the ECU is now in.
    const p2 = this.session.p2Ms;
    const p2Star = Math.round(this.session.p2StarMs / 10);
    return new Uint8Array([
      positiveResponseSid(SID.DIAGNOSTIC_SESSION_CONTROL),
      requested,
      (p2 >> 8) & 0xff,
      p2 & 0xff,
      (p2Star >> 8) & 0xff,
      p2Star & 0xff,
    ]);
  }

  /**
   * ECU reset (ISO 14229-1 §11.2).
   *
   * The reset type is validated before anything happens: a server that answers
   * every reset request with a positive response would make a tester believe an
   * invalid request did something. Type 0x00 is not assigned and must be
   * rejected with subFunctionNotSupported.
   */
  private handleEcuReset(payload: Uint8Array): Uint8Array {
    if (payload.length < 2)
      return negativeResponse(SID.ECU_RESET, NRC.INCORRECT_MESSAGE_LENGTH_OR_INVALID_FORMAT);
    const resetType = (payload[1] ?? 0) & 0x7f;
    if (
      resetType !== RESET_TYPE.HARD_RESET &&
      resetType !== RESET_TYPE.KEY_OFF_ON_RESET &&
      resetType !== RESET_TYPE.SOFT_RESET
    ) {
      return negativeResponse(SID.ECU_RESET, NRC.SUB_FUNCTION_NOT_SUPPORTED);
    }
    this.session.reset(this.now());
    return new Uint8Array([positiveResponseSid(SID.ECU_RESET), resetType]);
  }

  /**
   * Clear diagnostic information (ISO 14229-1 §11.3).
   *
   * The request always carries a three byte groupOfDTC; a shorter request is a
   * format error and must not be interpreted as "clear everything". This matters
   * beyond spec compliance: a probe with a truncated request would otherwise
   * wipe the fault memory of every ECU it touches.
   */
  private handleClearDtc(payload: Uint8Array): Uint8Array {
    if (payload.length < 4)
      return negativeResponse(
        SID.CLEAR_DIAGNOSTIC_INFORMATION,
        NRC.INCORRECT_MESSAGE_LENGTH_OR_INVALID_FORMAT,
      );
    const group = ((payload[1] ?? 0) << 16) | ((payload[2] ?? 0) << 8) | (payload[3] ?? 0);
    if (group !== DTC_GROUP_ALL && group !== 0) {
      // Grouped clearing is manufacturer specific; an unknown group is out of range.
      const known = this.dtcs.some(
        (dtc) =>
          (((encodeDtcToBytes(dtc.code)[0] ?? 0) << 16) |
            ((encodeDtcToBytes(dtc.code)[1] ?? 0) << 8)) ===
          group,
      );
      if (!known)
        return negativeResponse(SID.CLEAR_DIAGNOSTIC_INFORMATION, NRC.REQUEST_OUT_OF_RANGE);
    }
    // ISO 14229-1 §11.3: clearing resets the DTC status information. A fault that
    // is still present sets testFailed (bit 0) and testFailedThisOperationCycle
    // (bit 1) again immediately; everything else leaves the fault memory, which is
    // what makes a cleared ECU distinguishable from an ECU that ignored the clear.
    // (A production ECU may additionally raise the two "test not completed" bits;
    // that is a readiness statement, not a stored fault.)
    this.dtcs = this.dtcs
      .map((dtc) => ({ ...dtc, status: (dtc.status & 0x01) !== 0 ? 0x03 : 0x00 }))
      .filter((dtc) => dtc.status !== 0x00);
    this.log.info("DTCs cleared", { ecu: this.name, count: this.dtcs.length });
    return new Uint8Array([positiveResponseSid(SID.CLEAR_DIAGNOSTIC_INFORMATION)]);
  }

  private handleReadDtc(payload: Uint8Array): Uint8Array {
    const subFunction = payload[1] ?? 0;
    const availabilityMask = this.options.dtcAvailabilityMask ?? 0xff;
    const list = (): number[] => {
      const bytes: number[] = [];
      for (const dtc of this.dtcs) {
        const encoded = encodeDtcToBytes(dtc.code);
        bytes.push(encoded[0] ?? 0, encoded[1] ?? 0, encoded[2] ?? 0, dtc.status & 0xff);
      }
      return bytes;
    };

    switch (subFunction) {
      case DTC_REPORT.REPORT_DTC_BY_STATUS_MASK: {
        const mask = payload[2] ?? 0xff;
        const bytes: number[] = [];
        for (const dtc of this.dtcs) {
          if ((dtc.status & mask) === 0) continue;
          const encoded = encodeDtcToBytes(dtc.code);
          bytes.push(encoded[0] ?? 0, encoded[1] ?? 0, encoded[2] ?? 0, dtc.status & 0xff);
        }
        return new Uint8Array([
          positiveResponseSid(SID.READ_DTC_INFORMATION),
          subFunction,
          availabilityMask,
          ...bytes,
        ]);
      }
      case DTC_REPORT.REPORT_SUPPORTED_DTC:
        return new Uint8Array([
          positiveResponseSid(SID.READ_DTC_INFORMATION),
          subFunction,
          availabilityMask,
          ...list(),
        ]);
      case DTC_REPORT.REPORT_NUMBER_OF_DTC_BY_STATUS_MASK: {
        const mask = payload[2] ?? 0xff;
        const count = this.dtcs.filter((dtc) => (dtc.status & mask) !== 0).length;
        // Six bytes, not five: ISO 14229-1 §11.3.4.2 puts the DTC format identifier
        // between the availability mask and the count. The byte was missing here
        // until 2026-09-23, so the simulator answered with a layout no real ECU uses
        // and a standard-conformant client read the count from the wrong offset.
        return new Uint8Array([
          positiveResponseSid(SID.READ_DTC_INFORMATION),
          subFunction,
          availabilityMask,
          this.options.dtcFormatIdentifier ?? 0x00,
          (count >> 8) & 0xff,
          count & 0xff,
        ]);
      }
      case DTC_REPORT.REPORT_DTC_SNAPSHOT_IDENTIFICATION: {
        // ISO 14229-1 §11.3.4.4: one 6-byte record per code — DTC(3), status(1),
        // numberOfIdentifiedSnapshotRecords(1) — optionally filtered by the DTC
        // named in the request. The count is what the standard specifies; the
        // record numbers themselves are only discoverable by asking for them.
        const wanted = payload.length >= 4 ? payload.subarray(2, 4) : undefined;
        const bytes: number[] = [];
        for (const dtc of this.dtcs) {
          const encoded = encodeDtcToBytes(dtc.code);
          if (wanted && (encoded[0] !== wanted[0] || encoded[1] !== wanted[1])) {
            continue;
          }
          const records = dtc.snapshot !== undefined && dtc.snapshot.length > 0 ? 1 : 0;
          bytes.push(encoded[0] ?? 0, encoded[1] ?? 0, encoded[2] ?? 0, dtc.status & 0xff, records);
        }
        return new Uint8Array([
          positiveResponseSid(SID.READ_DTC_INFORMATION),
          subFunction,
          availabilityMask,
          ...bytes,
        ]);
      }
      case DTC_REPORT.REPORT_DTC_SNAPSHOT_RECORD_BY_DTC_NUMBER: {
        const requested = payload.subarray(2, 5);
        // The DTC number is two bytes here; the third request byte is the DTCStatus of
        // the request, echoed back in the response, not part of the identity
        // (ISO 14229-1 §10.2.9). Matching it would refuse every record a real tester asks for.
        const record = this.dtcs.find((dtc) => {
          const encoded = encodeDtcToBytes(dtc.code);
          return encoded[0] === requested[0] && encoded[1] === requested[1];
        });
        if (!record) return negativeResponse(SID.READ_DTC_INFORMATION, NRC.REQUEST_OUT_OF_RANGE);
        const snapshot = record.snapshot ?? new Uint8Array();
        return new Uint8Array([
          positiveResponseSid(SID.READ_DTC_INFORMATION),
          subFunction,
          requested[0] ?? 0,
          requested[1] ?? 0,
          requested[2] ?? 0,
          record.status & 0xff,
          payload[5] ?? 0xff,
          ...snapshot,
        ]);
      }
      case DTC_REPORT.REPORT_DTC_EXTENDED_DATA_RECORD_BY_DTC_NUMBER: {
        const requested = payload.subarray(2, 5);
        const record = this.dtcs.find((dtc) => {
          const encoded = encodeDtcToBytes(dtc.code);
          return encoded[0] === requested[0] && encoded[1] === requested[1];
        });
        if (!record) return negativeResponse(SID.READ_DTC_INFORMATION, NRC.REQUEST_OUT_OF_RANGE);
        const data = record.extendedData ?? new Uint8Array();
        return new Uint8Array([
          positiveResponseSid(SID.READ_DTC_INFORMATION),
          subFunction,
          requested[0] ?? 0,
          requested[1] ?? 0,
          requested[2] ?? 0,
          record.status & 0xff,
          payload[5] ?? 0x01,
          ...data,
        ]);
      }
      default:
        return negativeResponse(SID.READ_DTC_INFORMATION, NRC.SUB_FUNCTION_NOT_SUPPORTED);
    }
  }

  private handleReadDataByIdentifier(payload: Uint8Array): Uint8Array {
    if (payload.length < 3 || (payload.length - 1) % 2 !== 0)
      return negativeResponse(
        SID.READ_DATA_BY_IDENTIFIER,
        NRC.INCORRECT_MESSAGE_LENGTH_OR_INVALID_FORMAT,
      );
    const out: number[] = [positiveResponseSid(SID.READ_DATA_BY_IDENTIFIER)];
    let matched = 0;
    for (let offset = 1; offset + 1 < payload.length; offset += 2) {
      const did = ((payload[offset] ?? 0) << 8) | (payload[offset + 1] ?? 0);
      const definition = this.dids.get(did);
      if (!definition) continue;
      if (definition.sessions && !definition.sessions.includes(this.session.sessionType)) continue;
      const value = definition.value();
      out.push((did >> 8) & 0xff, did & 0xff, ...value);
      matched++;
    }
    if (matched === 0)
      return negativeResponse(SID.READ_DATA_BY_IDENTIFIER, NRC.REQUEST_OUT_OF_RANGE);
    return new Uint8Array(out);
  }

  private handleWriteDataByIdentifier(payload: Uint8Array): Uint8Array {
    if (payload.length < 4)
      return negativeResponse(
        SID.WRITE_DATA_BY_IDENTIFIER,
        NRC.INCORRECT_MESSAGE_LENGTH_OR_INVALID_FORMAT,
      );
    // Session gating is not duplicated here: `SessionStateMachine.serviceRefusal`
    // answers 0x7F before this handler runs, and a second copy would be the kind
    // of check that drifts away from the first one.
    const did = ((payload[1] ?? 0) << 8) | (payload[2] ?? 0);
    const definition = this.dids.get(did);
    if (!definition)
      return negativeResponse(SID.WRITE_DATA_BY_IDENTIFIER, NRC.REQUEST_OUT_OF_RANGE);
    if (!definition.writable)
      return negativeResponse(SID.WRITE_DATA_BY_IDENTIFIER, NRC.CONDITIONS_NOT_CORRECT);
    // A DID with a write hook stores the payload itself, and stays *live* afterwards:
    // replacing the read closure (the form without a hook) would freeze a computed
    // value at what the tester happened to write. The hook may refuse — a coding
    // block with the wrong length or an adaptation outside its range is a
    // `requestOutOfRange`/`conditionsNotCorrect` answer, not a silent success.
    if (definition.write) {
      let refusal: number | undefined;
      try {
        refusal = definition.write(payload.subarray(3).slice());
      } catch (error) {
        this.log.error("DID write handler failed", {
          ecu: this.name,
          did: `0x${did.toString(16)}`,
          error: messageOf(error),
        });
        return negativeResponse(SID.WRITE_DATA_BY_IDENTIFIER, NRC.GENERAL_REJECT);
      }
      if (typeof refusal === "number")
        return negativeResponse(SID.WRITE_DATA_BY_IDENTIFIER, refusal);
    } else {
      // Keep the write observable for the simulator/tests.
      this.dids.set(did, { ...definition, value: () => payload.subarray(3).slice() });
    }
    this.log.info("DID written", { ecu: this.name, did: `0x${did.toString(16)}`, writable: true });
    return new Uint8Array([
      positiveResponseSid(SID.WRITE_DATA_BY_IDENTIFIER),
      (did >> 8) & 0xff,
      did & 0xff,
    ]);
  }

  private handleSecurityAccess(access: ServerSecurityAccess, payload: Uint8Array): Uint8Array {
    const level = payload[1] ?? 0;
    if (this.now() < this.lockedOutUntil)
      return negativeResponse(SID.SECURITY_ACCESS, NRC.REQUIRED_TIME_DELAY_NOT_EXPIRED);
    if (level % 2 === 1) {
      const seed = access.seed();
      return new Uint8Array([positiveResponseSid(SID.SECURITY_ACCESS), level, ...seed]);
    }
    const key = payload.subarray(2);
    if (!access.verifyKey(level, key)) {
      this.securityFailures++;
      if (this.securityFailures >= 3 && access.lockoutMs)
        this.lockedOutUntil = this.now() + access.lockoutMs;
      return negativeResponse(
        SID.SECURITY_ACCESS,
        this.securityFailures >= 3 ? NRC.EXCEED_NUMBER_OF_ATTEMPTS : NRC.INVALID_KEY,
      );
    }
    this.securityFailures = 0;
    // The unlock is recorded in the session machine, not here: it must not survive
    // the next session transition, expiry or reset (ISO 14229-1 §10.2).
    this.session.unlock(level);
    this.log.info("security access granted", { ecu: this.name, level });
    return new Uint8Array([positiveResponseSid(SID.SECURITY_ACCESS), level]);
  }

  private handleRoutineControl(payload: Uint8Array): Uint8Array {
    if (payload.length < 4)
      return negativeResponse(SID.ROUTINE_CONTROL, NRC.INCORRECT_MESSAGE_LENGTH_OR_INVALID_FORMAT);
    const controlType = payload[1] ?? 0;
    const routineId = ((payload[2] ?? 0) << 8) | (payload[3] ?? 0);
    const routine = this.routines.get(routineId);
    if (!routine) return negativeResponse(SID.ROUTINE_CONTROL, NRC.REQUEST_OUT_OF_RANGE);
    const result = routine.run(payload.subarray(4));
    return new Uint8Array([
      positiveResponseSid(SID.ROUTINE_CONTROL),
      controlType,
      (routineId >> 8) & 0xff,
      routineId & 0xff,
      ...result,
    ]);
  }
}

export function negativeResponse(serviceId: number, nrc: number): Uint8Array {
  return new Uint8Array([NEGATIVE_RESPONSE_SID, serviceId, nrc]);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
