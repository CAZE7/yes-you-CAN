/**
 * KWP2000 client (ISO 14230).
 *
 * Deliberately small: enough to identify an ECU, read and clear fault codes and
 * keep a session alive. Read-only first (AGENTS 34.11); writes exist but must go
 * through the SafetyManager like any other write (AGENTS 26).
 */

import { ProtocolError, createLogger, toHex, type Logger } from '@vdp/shared';
import { NRC, nrcName, type UdsLink } from '@vdp/protocols-uds';
import { UdsNegativeResponseError } from '@vdp/shared';
import { KWP_LOCAL_ID, KWP_SID, kwpServiceName } from './services.js';

export interface KwpFaultRecord {
  /** Raw two-byte fault code as transmitted. */
  raw: string;
  /** Status byte. */
  status: number;
  /** Fault presence bits decoded. */
  confirmed: boolean;
  pending: boolean;
  testFailed: boolean;
}

export interface Kwp2000Options {
  /** P3 response timeout in ms (KWP2000's equivalent of UDS P2). */
  p3Ms?: number;
  logger?: Logger;
  name?: string;
  sleep?: (ms: number) => Promise<void>;
}

export interface Kwp2000Stats {
  requests: number;
  responses: number;
  negativeResponses: number;
}

export class Kwp2000Client {
  readonly stats: Kwp2000Stats = { requests: 0, responses: 0, negativeResponses: 0 };
  private readonly log: Logger;
  private readonly p3Ms: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private testerPresentTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly link: UdsLink, private readonly options: Kwp2000Options = {}) {
    this.log = (options.logger ?? createLogger('uds', { level: 'INFO' })).child('uds');
    this.p3Ms = options.p3Ms ?? 200;
    this.sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  get name(): string {
    return this.options.name ?? 'kwp2000-ecu';
  }

  /** Generic request with KWP2000 negative response handling. */
  async request(serviceId: number, data: readonly number[] = [], timeoutMs?: number): Promise<Uint8Array> {
    this.stats.requests++;
    const payload = new Uint8Array([serviceId, ...data]);
    this.log.raw('kwp tx', { ecu: this.name, service: kwpServiceName(serviceId), payload: toHex(payload) });
    const response = await this.link.request(payload, timeoutMs ?? this.p3Ms + 50);
    this.stats.responses++;
    this.log.raw('kwp rx', { ecu: this.name, payload: toHex(response) });

    if ((response[0] ?? 0) === 0x7f) {
      const nrc = response[2] ?? 0;
      this.stats.negativeResponses++;
      throw new UdsNegativeResponseError(serviceId, nrc, nrcName(nrc), { protocol: 'kwp2000', ecu: this.name });
    }
    if ((response[0] ?? 0) !== serviceId + 0x40) {
      throw new ProtocolError(`unexpected KWP2000 response for ${kwpServiceName(serviceId)}: ${toHex(response)}`, { ecu: this.name });
    }
    return response;
  }

  /** Start a diagnostic session (KWP2000 0x10). */
  async startDiagnosticSession(sessionType = 0x89): Promise<number> {
    const response = await this.request(KWP_SID.START_DIAGNOSTIC_SESSION, [sessionType]);
    return response[1] ?? sessionType;
  }

  async stopDiagnosticSession(): Promise<void> {
    await this.request(KWP_SID.STOP_DIAGNOSTIC_SESSION);
  }

  /** Read one identification value by local identifier (KWP2000 0x21). */
  async readLocalIdentifier(localId: number): Promise<Uint8Array | null> {
    try {
      const response = await this.request(KWP_SID.READ_DATA_BY_LOCAL_IDENTIFIER, [localId]);
      return response.subarray(2).slice();
    } catch (error) {
      if (error instanceof UdsNegativeResponseError && (error.nrc === NRC.REQUEST_OUT_OF_RANGE || error.nrc === NRC.SUB_FUNCTION_NOT_SUPPORTED)) {
        return null;
      }
      throw error;
    }
  }

  async readVin(): Promise<string | null> {
    const data = await this.readLocalIdentifier(KWP_LOCAL_ID.VEHICLE_IDENTIFICATION_NUMBER);
    return data ? decodeAscii(data) : null;
  }

  async readEcuIdentificationCode(): Promise<string | null> {
    const data = await this.readLocalIdentifier(KWP_LOCAL_ID.ECU_IDENTIFICATION_CODE);
    return data ? decodeAscii(data) : null;
  }

  /**
   * Fault codes (KWP2000 0x18).
   *
   * Response layout per ISO 14230-1 §11.2.2: [0x58, subFunction, (DTC high, DTC low,
   * statusByte)*]. Records therefore start at offset 2 — the sub-function echo is
   * not part of the first record. Where a manufacturer deviates, the deviation
   * belongs into a definition package rather than into this parser (AGENTS 34.18).
   */
  async readFaultCodes(subFunction = 0x01): Promise<KwpFaultRecord[]> {
    const response = await this.request(KWP_SID.READ_DIAGNOSTIC_TROUBLE_CODES, [subFunction]);
    const records: KwpFaultRecord[] = [];
    for (let offset = 2; offset + 2 < response.length; offset += 3) {
      const high = response[offset] ?? 0;
      const low = response[offset + 1] ?? 0;
      const status = response[offset + 2] ?? 0;
      records.push({
        raw: `${high.toString(16).padStart(2, '0')}${low.toString(16).padStart(2, '0')}`.toUpperCase(),
        status,
        confirmed: (status & 0x08) !== 0,
        pending: (status & 0x04) !== 0,
        testFailed: (status & 0x01) !== 0,
      });
    }
    return records;
  }

  async clearFaultCodes(): Promise<void> {
    await this.request(KWP_SID.CLEAR_DIAGNOSTIC_INFORMATION, [0x01]);
  }

  async testerPresent(): Promise<void> {
    await this.request(KWP_SID.TESTER_PRESENT, [0x00]);
  }

  /** KWP2000 sessions are shorter lived than UDS ones — keep-alive interval defaults to 1 s. */
  startTesterPresent(intervalMs = 1000): void {
    this.stopTesterPresent();
    this.testerPresentTimer = setInterval(() => {
      void this.testerPresent().catch((error) => {
        this.log.warn('KWP2000 TesterPresent failed', { ecu: this.name, error: errorMessage(error) });
      });
    }, intervalMs);
  }

  stopTesterPresent(): void {
    if (this.testerPresentTimer) {
      clearInterval(this.testerPresentTimer);
      this.testerPresentTimer = null;
    }
  }
}

function decodeAscii(data: Uint8Array): string {
  let out = '';
  for (const byte of data) {
    if (byte === 0) break;
    if (byte < 0x20 || byte > 0x7e) continue;
    out += String.fromCharCode(byte);
  }
  return out.trim();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
