/**
 * UDS client (ISO 14229-1 services on top of ISO 14229-2 session/timing).
 *
 * Transport agnostic: see link.ts. Read-only services first (AGENTS 9), write
 * services exist but are gated behind the SafetyManager at the application layer
 * (AGENTS 25/26) — the client itself performs no safety judgement.
 */

import {
  DefinitionError,
  type Logger,
  ProtocolError,
  UdsNegativeResponseError,
  UdsTimeoutError,
  createLogger,
  toHex,
} from "@vdp/shared";
import {
  type DtcSeverity,
  type DtcStatusBits,
  decodeDtc,
  decodeDtcStatus,
  dtcSeverity,
  encodeDtcToBytes,
} from "./dtc.js";
import type { UdsLink } from "./link.js";
import { NRC, isTransientNrc, nrcName } from "./nrc.js";
import { type SeedKeyAlgorithm, refuseAllSecurityAccess } from "./security.js";
import {
  DID,
  DTC_GROUP_ALL,
  DTC_REPORT,
  NEGATIVE_RESPONSE_SID,
  RESET_TYPE,
  ROUTINE_CONTROL_TYPE,
  SESSION,
  SESSION_NAMES,
  SID,
  SUPPRESS_POSITIVE_RESPONSE,
  isPositiveResponse,
} from "./services.js";
import {
  DEFAULT_UDS_TIMING,
  TIMING_MARGIN_MS,
  type UdsTiming,
  parseSessionTiming,
} from "./timing.js";

export interface DtcRecord {
  code: string;
  raw: string;
  failureType: string;
  status: number;
  statusBits: DtcStatusBits;
  severity: DtcSeverity;
  snapshot?: Uint8Array;
  extendedData?: Uint8Array;
}

export interface UdsStats {
  requests: number;
  responses: number;
  negativeResponses: number;
  pendingResponses: number;
  timeouts: number;
}

export interface UdsClientOptions {
  /** Per-ECU timing; override any value the ECU reports later (AGENTS 9). */
  timing?: Partial<UdsTiming>;
  logger?: Logger;
  /** ECU label used in logs and traces. */
  name?: string;
  sleep?: (ms: number) => Promise<void>;
  seedKey?: SeedKeyAlgorithm;
  /** Guard against an ECU that never finishes a pending response. */
  maxPendingResponses?: number;
  /** Retry once on transient NRCs (busyRepeatRequest, resourceTemporarilyNotAvailable). */
  retryTransientNrc?: boolean;
}

export interface RequestOptions {
  suppressPositiveResponse?: boolean;
  timeoutMs?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class UdsClient {
  readonly stats: UdsStats = {
    requests: 0,
    responses: 0,
    negativeResponses: 0,
    pendingResponses: 0,
    timeouts: 0,
  };
  readonly name: string;

  private readonly link: UdsLink;
  private readonly log: Logger;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxPendingResponses: number;
  private readonly retryTransientNrc: boolean;
  private timingValue: UdsTiming;
  private seedKey: SeedKeyAlgorithm;
  private testerPresentTimer: ReturnType<typeof setInterval> | null = null;
  private activeSession: number = SESSION.DEFAULT;

  constructor(link: UdsLink, options: UdsClientOptions = {}) {
    this.link = link;
    this.name = options.name ?? "ecu";
    this.timingValue = { ...DEFAULT_UDS_TIMING, ...(options.timing ?? {}) };
    this.log = (options.logger ?? createLogger("uds", { level: "INFO" })).child("uds");
    this.sleep = options.sleep ?? defaultSleep;
    this.maxPendingResponses = options.maxPendingResponses ?? 10;
    this.retryTransientNrc = options.retryTransientNrc ?? true;
    this.seedKey = options.seedKey ?? refuseAllSecurityAccess;
  }

  get timing(): UdsTiming {
    return { ...this.timingValue };
  }

  /** Adopt ECU-reported timing (DiagnosticSessionControl) — never hardcode globally (AGENTS 9). */
  updateTiming(partial: Partial<UdsTiming>): void {
    this.timingValue = { ...this.timingValue, ...partial };
    this.log.debug("UDS timing updated", { ecu: this.name, ...this.timingValue });
  }

  get activeSessionType(): number {
    return this.activeSession;
  }

  get activeSessionName(): string {
    return SESSION_NAMES[this.activeSession] ?? `session_0x${this.activeSession.toString(16)}`;
  }

  setSeedKeyAlgorithm(algorithm: SeedKeyAlgorithm): void {
    this.log.info("seed&key algorithm registered", {
      ecu: this.name,
      algorithm: algorithm.id,
      provenance: algorithm.provenance,
    });
    this.seedKey = algorithm;
  }

  // ---------------------------------------------------------------- services

  async diagnosticSessionControl(
    sessionType: number,
    options: RequestOptions = {},
  ): Promise<{ sessionType: number; p2Ms: number; p2StarMs: number }> {
    const response = await this.request(SID.DIAGNOSTIC_SESSION_CONTROL, [sessionType], options);
    if (response.length === 0)
      return { sessionType, p2Ms: this.timingValue.p2Ms, p2StarMs: this.timingValue.p2StarMs };
    const reported = parseSessionTiming(response);
    if (reported) this.updateTiming(reported);
    this.activeSession = response[1] ?? sessionType;
    this.log.info("session changed", {
      ecu: this.name,
      session: this.activeSessionName,
      ...this.timing,
    });
    return {
      sessionType: this.activeSession,
      p2Ms: this.timing.p2Ms,
      p2StarMs: this.timing.p2StarMs,
    };
  }

  async ecuReset(
    resetType: number = RESET_TYPE.SOFT_RESET,
    options: RequestOptions = {},
  ): Promise<Uint8Array> {
    return this.request(SID.ECU_RESET, [resetType], options);
  }

  async testerPresent(
    suppressPositiveResponse = true,
    options: RequestOptions = {},
  ): Promise<void> {
    const subFunction = suppressPositiveResponse ? SUPPRESS_POSITIVE_RESPONSE : 0x00;
    await this.request(SID.TESTER_PRESENT, [subFunction], {
      ...options,
      suppressPositiveResponse: suppressPositiveResponse,
    });
  }

  /** Keep the non-default session alive (S3Server, ISO 14229-2). */
  startTesterPresent(intervalMs = 2000): void {
    this.stopTesterPresent();
    this.testerPresentTimer = setInterval(() => {
      void this.testerPresent().catch((error) => {
        this.log.warn("TesterPresent failed", { ecu: this.name, error: errorMessage(error) });
      });
    }, intervalMs);
    this.log.debug("TesterPresent scheduler started", { ecu: this.name, intervalMs });
  }

  stopTesterPresent(): void {
    if (this.testerPresentTimer) {
      clearInterval(this.testerPresentTimer);
      this.testerPresentTimer = null;
      this.log.debug("TesterPresent scheduler stopped", { ecu: this.name });
    }
  }

  async clearDiagnosticInformation(groupOfDtc: number = DTC_GROUP_ALL): Promise<void> {
    const group =
      groupOfDtc === DTC_GROUP_ALL
        ? [0xff, 0xff, 0xff]
        : [(groupOfDtc >>> 16) & 0xff, (groupOfDtc >>> 8) & 0xff, groupOfDtc & 0xff];
    await this.request(SID.CLEAR_DIAGNOSTIC_INFORMATION, group);
  }

  async readDtcByStatusMask(statusMask: number): Promise<DtcRecord[]> {
    const response = await this.request(SID.READ_DTC_INFORMATION, [
      DTC_REPORT.REPORT_DTC_BY_STATUS_MASK,
      statusMask & 0xff,
    ]);
    return parseDtcList(response, 3);
  }

  async readSupportedDtc(): Promise<DtcRecord[]> {
    const response = await this.request(SID.READ_DTC_INFORMATION, [
      DTC_REPORT.REPORT_SUPPORTED_DTC,
    ]);
    return parseDtcList(response, 3);
  }

  /** Freeze frame / snapshot data (AGENTS 20 "Freeze Frame / Environment Data"). */
  async readDtcSnapshotRecord(
    dtc: string,
    recordNumber = 0xff,
  ): Promise<{ recordNumber: number; data: Uint8Array } | null> {
    const bytes = encodeDtcToBytes(dtc);
    const response = await this.request(SID.READ_DTC_INFORMATION, [
      DTC_REPORT.REPORT_DTC_SNAPSHOT_RECORD_BY_DTC_NUMBER,
      bytes[0] ?? 0,
      bytes[1] ?? 0,
      bytes[2] ?? 0,
      recordNumber & 0xff,
    ]);
    if (response.length < 7) return null;
    return { recordNumber: response[6] ?? recordNumber, data: response.subarray(7).slice() };
  }

  async readDtcExtendedDataRecord(
    dtc: string,
    recordNumber = 0x01,
  ): Promise<{ recordNumber: number; data: Uint8Array } | null> {
    const bytes = encodeDtcToBytes(dtc);
    const response = await this.request(SID.READ_DTC_INFORMATION, [
      DTC_REPORT.REPORT_DTC_EXTENDED_DATA_RECORD_BY_DTC_NUMBER,
      bytes[0] ?? 0,
      bytes[1] ?? 0,
      bytes[2] ?? 0,
      recordNumber & 0xff,
    ]);
    if (response.length < 7) return null;
    return { recordNumber: response[6] ?? recordNumber, data: response.subarray(7).slice() };
  }

  /**
   * Read Data By Identifier (0x22).
   *
   * A multi-DID response carries no length fields, so several DIDs in one request
   * can only be split when their lengths are known from a definition package
   * (AGENTS 13/14). Without that knowledge we issue one request per DID — slower,
   * but unambiguous. Pass `lengths` to opt into the single-request fast path.
   */
  async readDataByIdentifier(
    dids: readonly number[],
    lengths?: ReadonlyMap<number, number>,
  ): Promise<Map<number, Uint8Array>> {
    if (dids.length === 0) return new Map();

    if (dids.length > 1 && lengths) {
      const data: number[] = [];
      for (const did of dids) data.push((did >> 8) & 0xff, did & 0xff);
      const response = await this.request(SID.READ_DATA_BY_IDENTIFIER, data);
      return parseMultiDidResponse(response, lengths);
    }

    const result = new Map<number, Uint8Array>();
    for (const did of dids) {
      const response = await this.request(SID.READ_DATA_BY_IDENTIFIER, [
        (did >> 8) & 0xff,
        did & 0xff,
      ]);
      const value = parseSingleDidResponse(response, did);
      if (value) result.set(did, value);
    }
    return result;
  }

  /** Convenience: read a single DID. */
  async readDid(did: number): Promise<Uint8Array | null> {
    const map = await this.readDataByIdentifier([did]);
    return map.get(did) ?? null;
  }

  /** Write service — must be routed through the SafetyManager (AGENTS 25/26). */
  async writeDataByIdentifier(did: number, value: Uint8Array): Promise<void> {
    await this.request(SID.WRITE_DATA_BY_IDENTIFIER, [(did >> 8) & 0xff, did & 0xff, ...value]);
  }

  async routineControl(
    controlType: number,
    routineId: number,
    data: Uint8Array = new Uint8Array(),
  ): Promise<Uint8Array> {
    const response = await this.request(SID.ROUTINE_CONTROL, [
      controlType,
      (routineId >> 8) & 0xff,
      routineId & 0xff,
      ...data,
    ]);
    return response.subarray(4).slice();
  }

  async startRoutine(routineId: number, data?: Uint8Array): Promise<Uint8Array> {
    return this.routineControl(ROUTINE_CONTROL_TYPE.START_ROUTINE, routineId, data);
  }

  async securityAccessRequestSeed(securityLevel: number, record?: Uint8Array): Promise<Uint8Array> {
    const response = await this.request(SID.SECURITY_ACCESS, [
      securityLevel & 0xff,
      ...(record ?? []),
    ]);
    return response.subarray(2).slice();
  }

  async securityAccessSendKey(securityLevel: number, key: Uint8Array): Promise<void> {
    await this.request(SID.SECURITY_ACCESS, [securityLevel & 0xff, ...key]);
  }

  /**
   * Full unlock via the registered SeedKeyAlgorithm. Refused by default
   * (AGENTS 34.12 — no bypass of manufacturer security mechanisms).
   */
  async unlockSecurityAccess(
    securityLevel: number,
    record?: Uint8Array,
  ): Promise<{ algorithm: string; provenance: string }> {
    const seed = await this.securityAccessRequestSeed(securityLevel, record);
    const key = await this.seedKey.computeKey({
      securityLevel,
      seed,
      ...(record ? { record } : {}),
      ecu: this.name,
    });
    this.log.info("security access key computed", {
      ecu: this.name,
      level: securityLevel,
      algorithm: this.seedKey.id,
      provenance: this.seedKey.provenance,
    });
    await this.securityAccessSendKey(securityLevel + 1, key);
    return { algorithm: this.seedKey.id, provenance: this.seedKey.provenance };
  }

  /** Escape hatch for OEM services not modelled yet — fully logged (AGENTS 34.10). */
  async raw(request: Uint8Array, options: RequestOptions = {}): Promise<Uint8Array> {
    return this.transmit(request, options);
  }

  async readVin(): Promise<string | null> {
    const data = await this.readDid(DID.VEHICLE_IDENTIFIER_NUMBER);
    if (!data) return null;
    let out = "";
    for (const byte of data) {
      if (byte === 0) break;
      out += String.fromCharCode(byte);
    }
    return out.trim() || null;
  }

  // ------------------------------------------------------------------ engine

  async request(
    serviceId: number,
    data: readonly number[] = [],
    options: RequestOptions = {},
  ): Promise<Uint8Array> {
    return this.transmit(new Uint8Array([serviceId, ...data]), options, serviceId);
  }

  private async transmit(
    payload: Uint8Array,
    options: RequestOptions,
    serviceId = payload[0] ?? 0,
  ): Promise<Uint8Array> {
    this.stats.requests++;
    this.log.raw("uds tx", {
      ecu: this.name,
      sid: `0x${serviceId.toString(16)}`,
      payload: toHex(payload),
    });
    const timeoutMs = options.timeoutMs ?? this.timingValue.p2Ms + TIMING_MARGIN_MS;

    if (options.suppressPositiveResponse) {
      await this.link.sendOnly(payload);
      return new Uint8Array();
    }

    let attempt = 0;
    for (;;) {
      let response: Uint8Array;
      try {
        response = await this.link.request(payload, timeoutMs);
      } catch (error) {
        this.stats.timeouts++;
        throw error;
      }
      try {
        return await this.evaluateResponse(serviceId, response);
      } catch (error) {
        const nrc = error instanceof UdsNegativeResponseError ? error.nrc : undefined;
        if (nrc !== undefined && isTransientNrc(nrc) && this.retryTransientNrc && attempt < 1) {
          attempt++;
          this.log.warn("transient NRC — retrying once", { ecu: this.name, nrc: nrcName(nrc) });
          await this.sleep(20);
          continue;
        }
        throw error;
      }
    }
  }

  /** Handle positive responses, NRC 0x78 pending loops and negative responses. */
  private async evaluateResponse(
    serviceId: number,
    firstResponse: Uint8Array,
  ): Promise<Uint8Array> {
    let response = firstResponse;
    for (let pending = 0; ; pending++) {
      this.stats.responses++;
      this.log.raw("uds rx", { ecu: this.name, payload: toHex(response) });

      if ((response[0] ?? 0) === NEGATIVE_RESPONSE_SID) {
        const nrc = response[2] ?? 0;
        if (nrc === NRC.REQUEST_CORRECTLY_RECEIVED_RESPONSE_PENDING) {
          if (pending >= this.maxPendingResponses) {
            throw new UdsTimeoutError(
              `ECU stayed in ResponsePending beyond ${this.maxPendingResponses} iterations`,
              { ecu: this.name },
            );
          }
          this.stats.pendingResponses++;
          this.log.debug("ResponsePending (NRC 0x78) — waiting P2*", {
            ecu: this.name,
            p2StarMs: this.timingValue.p2StarMs,
          });
          const next = await this.link.receive(this.timingValue.p2StarMs + TIMING_MARGIN_MS);
          if (!next) {
            this.stats.timeouts++;
            throw new UdsTimeoutError(
              `no final response after NRC 0x78 within P2* (${this.timingValue.p2StarMs} ms)`,
              { ecu: this.name },
            );
          }
          response = next;
          continue;
        }
        this.stats.negativeResponses++;
        throw new UdsNegativeResponseError(serviceId, nrc, nrcName(nrc), { ecu: this.name });
      }

      if (isPositiveResponse(serviceId, response)) return response;

      throw new ProtocolError(
        `unexpected UDS response for SID 0x${serviceId.toString(16)}: ${toHex(response)}`,
        { ecu: this.name },
      );
    }
  }
}

/** [0x59, sub, availabilityMask, (DTC(3) + status(1))*] → DtcRecord[] */
function parseDtcList(response: Uint8Array, startIndex: number): DtcRecord[] {
  const records: DtcRecord[] = [];
  for (let offset = startIndex; offset + 3 < response.length; offset += 4) {
    const high = response[offset] ?? 0;
    const low = response[offset + 1] ?? 0;
    const failureType = response[offset + 2] ?? 0;
    const status = response[offset + 3] ?? 0;
    const decoded = decodeDtc(high, low, failureType);
    const statusBits = decodeDtcStatus(status);
    records.push({
      code: decoded.code,
      raw: decoded.raw,
      failureType: decoded.failureType,
      status,
      statusBits,
      severity: dtcSeverity(statusBits),
    });
  }
  return records;
}

/** [0x62, DIDhi, DIDlo, ...data] → data for exactly one DID. */
export function parseSingleDidResponse(response: Uint8Array, did: number): Uint8Array | null {
  if (response.length < 3) return null;
  const echoed = ((response[1] ?? 0) << 8) | (response[2] ?? 0);
  if (echoed !== did) return null;
  return response.subarray(3).slice();
}

/**
 * Split a multi-DID response using known lengths from the definition package.
 * Throws when the definitions do not cover the payload — guessing offsets would
 * silently produce wrong measurement values (AGENTS 34.18).
 */
export function parseMultiDidResponse(
  response: Uint8Array,
  lengths: ReadonlyMap<number, number>,
): Map<number, Uint8Array> {
  const result = new Map<number, Uint8Array>();
  let offset = 1;
  while (offset + 2 <= response.length) {
    const did = ((response[offset] ?? 0) << 8) | (response[offset + 1] ?? 0);
    const length = lengths.get(did);
    if (length === undefined) {
      throw new DefinitionError(
        `no definition length for DID 0x${did.toString(16).toUpperCase()} — cannot split a multi-DID response`,
        {
          did,
        },
      );
    }
    offset += 2;
    if (offset + length > response.length) {
      throw new DefinitionError(
        `DID 0x${did.toString(16).toUpperCase()} declares ${length} bytes but only ${response.length - offset} remain`,
        {
          did,
          declared: length,
        },
      );
    }
    result.set(did, response.subarray(offset, offset + length).slice());
    offset += length;
  }
  return result;
}

export function didToBytes(did: number): Uint8Array {
  return new Uint8Array([(did >> 8) & 0xff, did & 0xff]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
