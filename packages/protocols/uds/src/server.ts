/**
 * UDS ECU-side server.
 *
 * Purpose (AGENTS 32): a virtual ECU for development, tests and replay, so no
 * feature needs real vehicle hardware. It implements exactly the services the
 * client models — nothing more — and simulates real-world behaviour such as
 * Response Pending (NRC 0x78), session gating and negative responses.
 */

import { createLogger, toHex, type Logger } from '@vdp/shared';
import { NRC } from './nrc.js';
import { DTC_REPORT, NEGATIVE_RESPONSE_SID, SESSION, SID, SUPPRESS_POSITIVE_RESPONSE, positiveResponseSid } from './services.js';
import { encodeDtcToBytes } from './dtc.js';
import { DEFAULT_UDS_TIMING, type UdsTiming } from './timing.js';

export interface ServerDid {
  did: number;
  /** Function so live values can change between reads (simulator). */
  value: () => Uint8Array;
  writable?: boolean;
  /** Restrict to sessions; default: all. */
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
  sessions?: readonly number[];
  securityAccess?: ServerSecurityAccess;
  /** Services that answer with NRC 0x78 once before the real response. */
  pendingResponseServices?: readonly number[];
  pendingResponseDelayMs?: number;
  /** DTC availability mask reported by 0x19 responses. */
  dtcAvailabilityMask?: number;
}

export interface UdsServerStats {
  requests: number;
  positiveResponses: number;
  negativeResponses: number;
  pendingResponses: number;
}

export class UdsServer {
  readonly stats: UdsServerStats = { requests: 0, positiveResponses: 0, negativeResponses: 0, pendingResponses: 0 };

  private readonly options: UdsServerOptions;
  private readonly log: Logger;
  private readonly timing: UdsTiming;
  private readonly dids = new Map<number, ServerDid>();
  private readonly routines = new Map<number, ServerRoutine>();
  private dtcs: ServerDtc[];
  private sessions: number[];
  private activeSession: number = SESSION.DEFAULT;
  private unsubscribe: (() => void) | null = null;
  private securityFailures = 0;
  private lockedOutUntil = 0;

  constructor(private readonly link: UdsServerLink, options: UdsServerOptions) {
    this.options = options;
    this.log = (options.logger ?? createLogger('uds', { level: 'INFO' })).child('uds');
    this.timing = { ...DEFAULT_UDS_TIMING, ...(options.timing ?? {}) };
    for (const did of options.dids ?? []) this.dids.set(did.did, did);
    for (const routine of options.routines ?? []) this.routines.set(routine.id, routine);
    this.dtcs = [...(options.dtcs ?? [])];
    this.sessions = [...(options.sessions ?? [SESSION.DEFAULT, SESSION.EXTENDED])];
  }

  get name(): string {
    return this.options.name;
  }

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.link.onMessage((payload) => {
      void this.handle(payload);
    });
    this.log.debug('UDS server started', { ecu: this.name, dids: this.dids.size, dtcs: this.dtcs.length });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** Test/simulator helper: change a DTC status (e.g. to simulate a fault appearing). */
  setDtcStatus(code: string, status: number): void {
    const entry = this.dtcs.find((d) => d.code === code);
    if (entry) entry.status = status;
    else this.dtcs.push({ code, status });
  }

  resetSession(): void {
    this.activeSession = SESSION.DEFAULT;
  }

  async handle(payload: Uint8Array): Promise<void> {
    if (payload.length === 0) return;
    this.stats.requests++;
    const serviceId = payload[0] as number;
    this.log.raw('server rx', { ecu: this.name, payload: toHex(payload) });

    const respond = async (response: Uint8Array): Promise<void> => {
      const pending = (this.options.pendingResponseServices ?? []).includes(serviceId);
      if (pending) {
        this.stats.pendingResponses++;
        await this.link.send(new Uint8Array([NEGATIVE_RESPONSE_SID, serviceId, NRC.REQUEST_CORRECTLY_RECEIVED_RESPONSE_PENDING]));
        await delay(this.options.pendingResponseDelayMs ?? 30);
      }
      this.stats.positiveResponses++;
      this.log.raw('server tx', { ecu: this.name, payload: toHex(response) });
      await this.link.send(response);
    };

    try {
      const response = this.dispatch(serviceId, payload);
      if (!response) return; // suppressed positive response
      if ((response[0] ?? 0) === NEGATIVE_RESPONSE_SID) this.stats.negativeResponses++;
      await respond(response);
    } catch (error) {
      this.stats.negativeResponses++;
      this.log.error('server handler failed', { ecu: this.name, error: error instanceof Error ? error.message : String(error) });
      await this.link.send(negativeResponse(serviceId, NRC.GENERAL_REJECT));
    }
  }

  private dispatch(serviceId: number, payload: Uint8Array): Uint8Array | null {
    switch (serviceId) {
      case SID.TESTER_PRESENT:
        return this.handleTesterPresent(payload);
      case SID.DIAGNOSTIC_SESSION_CONTROL:
        return this.handleSessionControl(payload);
      case SID.ECU_RESET:
        return new Uint8Array([positiveResponseSid(SID.ECU_RESET), payload[1] ?? 0x01]);
      case SID.CLEAR_DIAGNOSTIC_INFORMATION:
        return this.handleClearDtc();
      case SID.READ_DTC_INFORMATION:
        return this.handleReadDtc(payload);
      case SID.READ_DATA_BY_IDENTIFIER:
        return this.handleReadDataByIdentifier(payload);
      case SID.WRITE_DATA_BY_IDENTIFIER:
        return this.handleWriteDataByIdentifier(payload);
      case SID.SECURITY_ACCESS:
        return this.handleSecurityAccess(payload);
      case SID.ROUTINE_CONTROL:
        return this.handleRoutineControl(payload);
      default:
        return negativeResponse(serviceId, NRC.SERVICE_NOT_SUPPORTED);
    }
  }

  private handleTesterPresent(payload: Uint8Array): Uint8Array | null {
    const subFunction = payload[1] ?? 0;
    if (subFunction & SUPPRESS_POSITIVE_RESPONSE) return null;
    return new Uint8Array([positiveResponseSid(SID.TESTER_PRESENT), 0x00]);
  }

  private handleSessionControl(payload: Uint8Array): Uint8Array {
    if (payload.length < 2) return negativeResponse(SID.DIAGNOSTIC_SESSION_CONTROL, NRC.INCORRECT_MESSAGE_LENGTH_OR_INVALID_FORMAT);
    const requested = (payload[1] ?? 0) & 0x7f;
    if (!this.sessions.includes(requested)) return negativeResponse(SID.DIAGNOSTIC_SESSION_CONTROL, NRC.SUB_FUNCTION_NOT_SUPPORTED);
    this.activeSession = requested;
    // [0x50, session, P2 (1 ms units), P2* (10 ms units)] — ISO 14229-2.
    const p2 = this.timing.p2Ms;
    const p2Star = Math.round(this.timing.p2StarMs / 10);
    return new Uint8Array([positiveResponseSid(SID.DIAGNOSTIC_SESSION_CONTROL), requested, (p2 >> 8) & 0xff, p2 & 0xff, (p2Star >> 8) & 0xff, p2Star & 0xff]);
  }

  private handleClearDtc(): Uint8Array {
    this.dtcs = this.dtcs.map((dtc) => ({ ...dtc, status: dtc.status & ~0x0f }));
    this.log.info('DTCs cleared', { ecu: this.name, count: this.dtcs.length });
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
        return new Uint8Array([positiveResponseSid(SID.READ_DTC_INFORMATION), subFunction, availabilityMask, ...bytes]);
      }
      case DTC_REPORT.REPORT_SUPPORTED_DTC:
        return new Uint8Array([positiveResponseSid(SID.READ_DTC_INFORMATION), subFunction, availabilityMask, ...list()]);
      case DTC_REPORT.REPORT_NUMBER_OF_DTC_BY_STATUS_MASK: {
        const mask = payload[2] ?? 0xff;
        const count = this.dtcs.filter((dtc) => (dtc.status & mask) !== 0).length;
        return new Uint8Array([positiveResponseSid(SID.READ_DTC_INFORMATION), subFunction, availabilityMask, (count >> 8) & 0xff, count & 0xff]);
      }
      case DTC_REPORT.REPORT_DTC_SNAPSHOT_RECORD_BY_DTC_NUMBER: {
        const requested = payload.subarray(2, 5);
        const record = this.dtcs.find((dtc) => {
          const encoded = encodeDtcToBytes(dtc.code);
          return encoded[0] === requested[0] && encoded[1] === requested[1];
        });
        if (!record) return negativeResponse(SID.READ_DTC_INFORMATION, NRC.REQUEST_OUT_OF_RANGE);
        const snapshot = record.snapshot ?? new Uint8Array();
        return new Uint8Array([positiveResponseSid(SID.READ_DTC_INFORMATION), subFunction, requested[0] ?? 0, requested[1] ?? 0, requested[2] ?? 0, record.status & 0xff, payload[5] ?? 0xff, ...snapshot]);
      }
      case DTC_REPORT.REPORT_DTC_EXTENDED_DATA_RECORD_BY_DTC_NUMBER: {
        const requested = payload.subarray(2, 5);
        const record = this.dtcs.find((dtc) => {
          const encoded = encodeDtcToBytes(dtc.code);
          return encoded[0] === requested[0] && encoded[1] === requested[1];
        });
        if (!record) return negativeResponse(SID.READ_DTC_INFORMATION, NRC.REQUEST_OUT_OF_RANGE);
        const data = record.extendedData ?? new Uint8Array();
        return new Uint8Array([positiveResponseSid(SID.READ_DTC_INFORMATION), subFunction, requested[0] ?? 0, requested[1] ?? 0, requested[2] ?? 0, record.status & 0xff, payload[5] ?? 0x01, ...data]);
      }
      default:
        return negativeResponse(SID.READ_DTC_INFORMATION, NRC.SUB_FUNCTION_NOT_SUPPORTED);
    }
  }

  private handleReadDataByIdentifier(payload: Uint8Array): Uint8Array {
    if (payload.length < 3 || (payload.length - 1) % 2 !== 0) return negativeResponse(SID.READ_DATA_BY_IDENTIFIER, NRC.INCORRECT_MESSAGE_LENGTH_OR_INVALID_FORMAT);
    const out: number[] = [positiveResponseSid(SID.READ_DATA_BY_IDENTIFIER)];
    let matched = 0;
    for (let offset = 1; offset + 1 < payload.length; offset += 2) {
      const did = ((payload[offset] ?? 0) << 8) | (payload[offset + 1] ?? 0);
      const definition = this.dids.get(did);
      if (!definition) continue;
      if (definition.sessions && !definition.sessions.includes(this.activeSession)) continue;
      const value = definition.value();
      out.push((did >> 8) & 0xff, did & 0xff, ...value);
      matched++;
    }
    if (matched === 0) return negativeResponse(SID.READ_DATA_BY_IDENTIFIER, NRC.REQUEST_OUT_OF_RANGE);
    return new Uint8Array(out);
  }

  private handleWriteDataByIdentifier(payload: Uint8Array): Uint8Array {
    if (payload.length < 4) return negativeResponse(SID.WRITE_DATA_BY_IDENTIFIER, NRC.INCORRECT_MESSAGE_LENGTH_OR_INVALID_FORMAT);
    if (this.activeSession === SESSION.DEFAULT) return negativeResponse(SID.WRITE_DATA_BY_IDENTIFIER, NRC.SERVICE_NOT_SUPPORTED_IN_ACTIVE_SESSION);
    const did = ((payload[1] ?? 0) << 8) | (payload[2] ?? 0);
    const definition = this.dids.get(did);
    if (!definition) return negativeResponse(SID.WRITE_DATA_BY_IDENTIFIER, NRC.REQUEST_OUT_OF_RANGE);
    if (!definition.writable) return negativeResponse(SID.WRITE_DATA_BY_IDENTIFIER, NRC.CONDITIONS_NOT_CORRECT);
    // Keep the write observable for the simulator/tests.
    this.dids.set(did, { ...definition, value: () => payload.subarray(3).slice() });
    return new Uint8Array([positiveResponseSid(SID.WRITE_DATA_BY_IDENTIFIER), (did >> 8) & 0xff, did & 0xff]);
  }

  private handleSecurityAccess(payload: Uint8Array): Uint8Array {
    const access = this.options.securityAccess;
    if (!access) return negativeResponse(SID.SECURITY_ACCESS, NRC.SERVICE_NOT_SUPPORTED);
    const level = payload[1] ?? 0;
    if (Date.now() < this.lockedOutUntil) return negativeResponse(SID.SECURITY_ACCESS, NRC.REQUIRED_TIME_DELAY_NOT_EXPIRED);
    if (level % 2 === 1) {
      const seed = access.seed();
      return new Uint8Array([positiveResponseSid(SID.SECURITY_ACCESS), level, ...seed]);
    }
    const key = payload.subarray(2);
    if (!access.verifyKey(level, key)) {
      this.securityFailures++;
      if (this.securityFailures >= 3 && access.lockoutMs) this.lockedOutUntil = Date.now() + access.lockoutMs;
      return negativeResponse(SID.SECURITY_ACCESS, this.securityFailures >= 3 ? NRC.EXCEED_NUMBER_OF_ATTEMPTS : NRC.INVALID_KEY);
    }
    this.securityFailures = 0;
    return new Uint8Array([positiveResponseSid(SID.SECURITY_ACCESS), level]);
  }

  private handleRoutineControl(payload: Uint8Array): Uint8Array {
    if (payload.length < 4) return negativeResponse(SID.ROUTINE_CONTROL, NRC.INCORRECT_MESSAGE_LENGTH_OR_INVALID_FORMAT);
    const controlType = payload[1] ?? 0;
    const routineId = ((payload[2] ?? 0) << 8) | (payload[3] ?? 0);
    const routine = this.routines.get(routineId);
    if (!routine) return negativeResponse(SID.ROUTINE_CONTROL, NRC.REQUEST_OUT_OF_RANGE);
    const result = routine.run(payload.subarray(4));
    return new Uint8Array([positiveResponseSid(SID.ROUTINE_CONTROL), controlType, (routineId >> 8) & 0xff, routineId & 0xff, ...result]);
  }
}

export function negativeResponse(serviceId: number, nrc: number): Uint8Array {
  return new Uint8Array([NEGATIVE_RESPONSE_SID, serviceId, nrc]);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
