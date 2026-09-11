/**
 * Per-ECU diagnostic session (AGENTS 9, 10, 12).
 *
 * Binds one definition ECU to one UDS client on one transport. Keeps raw and
 * decoded data apart and logs every diagnostic operation (AGENTS 34.10).
 */

import { UdsNegativeResponseError, createLogger, toHex, type Logger } from '@vdp/shared';
import { DID, NRC, SESSION, SID, UdsClient, nrcName, type DtcRecord, type UdsLink } from '@vdp/protocols-uds';
import { indexEcus, indexPackage, type DefinitionPackage, type DtcDefinition, type EcuDefinition, type SignalDefinition, type SignalIndex } from '@vdp/definitions';
import { SignalDecoder, type DecodedSignal } from '../measurements/decoder.js';
import { decodeFreezeFrame, type FreezeFrame } from '../dtc/freeze-frame.js';
import { createEcuSession, type EcuIdentification, type EcuSession, type ServiceProbeResult } from '../session/session.js';

export interface EcuDiagnosticSessionOptions {
  definitionEcu?: EcuDefinition;
  packageName?: string;
  logger?: Logger;
  decoder?: SignalDecoder;
}

/**
 * Request used to test one service, chosen so that it cannot change anything:
 * an unassigned sub-function, a DID that does not exist or a truncated request
 * that fails length validation before any action (ISO 14229-1 §7.5, §11).
 */
const SERVICE_PROBES: Record<number, Uint8Array> = {
  // unassigned session type 0x00 → subFunctionNotSupported when supported
  0x10: new Uint8Array([0x10, 0x00]),
  // unassigned reset type 0x00 → no reset is performed
  0x11: new Uint8Array([0x11, 0x00]),
  // reportSupportedDtc (0x19 0x0A) is read-only
  0x19: new Uint8Array([0x19, 0x0a]),
  // DID 0x0000 is not assigned → requestOutOfRange, nothing is read
  0x22: new Uint8Array([0x22, 0x00, 0x00]),
  // missing data field → format error before any write could happen
  0x2e: new Uint8Array([0x2e, 0x00, 0x00]),
  // routine type 0x00 is unassigned → no routine is started
  0x31: new Uint8Array([0x31, 0x00, 0x00, 0x00]),
  // TesterPresent is safe by definition (ISO 14229-1 §9.9)
  0x3e: new Uint8Array([0x3e, 0x00]),
};

/** Services a read-only platform must not probe, with the reason shown in the UI. */
const NON_PROBEABLE_SERVICES: Record<number, string> = {
  0x14: 'clearing fault memory destroys diagnostic history — not probed (AGENTS 34.11)',
  0x27: 'a failed security access attempt can lock the ECU — not probed',
  0x2f: 'input/output control actuates hardware — not probed',
  0x34: 'a download request can modify ECU memory — not probed',
};

export const DEFAULT_SERVICE_PROBES: readonly number[] = [0x10, 0x11, 0x14, 0x19, 0x22, 0x27, 0x2e, 0x31, 0x3e];

/** Extract the NRC from a negative response error without importing the class. */
function nrcOf(error: unknown): number | undefined {
  return typeof error === 'object' && error !== null && 'nrc' in error && typeof (error as { nrc?: unknown }).nrc === 'number'
    ? (error as { nrc: number }).nrc
    : undefined;
}

export class EcuDiagnosticSession {
  readonly client: UdsClient;
  /**
   * The transport-neutral UDS link this session talks on (AGENTS 5, 36). On CAN
   * this is an ISO-TP connection; on DoIP it is a request/response link over a
   * TCP socket. The session never needs to know which one it is.
   */
  readonly link: UdsLink;
  /** Releases the underlying link (CAN: closes the ISO-TP connection). */
  readonly closeLink: () => void;
  readonly record: EcuSession;
  private readonly signalIndex: SignalIndex;
  private readonly signalsByEcu: SignalDefinition[];
  private readonly decoder: SignalDecoder;
  private readonly log: Logger;
  private readonly definitionEcu?: EcuDefinition;

  constructor(
    link: UdsLink,
    client: UdsClient,
    options: {
      txId: number;
      rxId: number;
      extended?: boolean;
      name?: string;
      definitionPackage?: DefinitionPackage;
      definitionEcuId?: string;
      definitionEcu?: EcuDefinition;
      logger?: Logger;
      decoder?: SignalDecoder;
      closeLink?: () => void;
    },
  ) {
    this.link = link;
    this.closeLink = options.closeLink ?? (() => {});
    this.client = client;
    this.log = (options.logger ?? createLogger('ecu', { level: 'INFO' })).child('ecu');
    this.decoder = options.decoder ?? new SignalDecoder({ logger: this.log });
    // The definition id comes from discovery and is resolved through the
    // package's cached id index — scanning `pkg.ecus` per session would repeat
    // the same linear search for every ECU that is attached (AGENTS 12/13).
    this.definitionEcu =
      options.definitionEcu ??
      (options.definitionPackage && options.definitionEcuId
        ? indexEcus(options.definitionPackage).get(options.definitionEcuId)
        : undefined);

    this.record = createEcuSession({
      name: options.name ?? this.definitionEcu?.name ?? `ECU 0x${options.txId.toString(16)}`,
      protocol: this.definitionEcu?.protocol ?? 'uds',
      txId: options.txId,
      rxId: options.rxId,
      extended: options.extended ?? false,
      ...(this.definitionEcu ? { definitionEcuId: this.definitionEcu.id } : {}),
    });

    this.signalIndex = options.definitionPackage ? indexPackage(options.definitionPackage) : { byId: new Map(), byEcu: new Map(), byDid: new Map() };
    this.signalsByEcu = this.definitionEcu ? (this.signalIndex.byEcu.get(this.definitionEcu.id) ?? []) : [];

    if (this.definitionEcu?.timing) {
      this.client.updateTiming({
        ...(this.definitionEcu.timing.p2Ms !== undefined ? { p2Ms: this.definitionEcu.timing.p2Ms } : {}),
        ...(this.definitionEcu.timing.p2StarMs !== undefined ? { p2StarMs: this.definitionEcu.timing.p2StarMs } : {}),
      });
    }
  }

  get signals(): readonly SignalDefinition[] {
    return this.signalsByEcu;
  }

  get id(): string {
    return this.record.id;
  }

  /** Signals grouped by DID so one 0x22 request can serve several of them. */
  didPlan(): Map<number, SignalDefinition[]> {
    const plan = new Map<number, SignalDefinition[]>();
    for (const signal of this.signalsByEcu) {
      const list = plan.get(signal.did) ?? [];
      list.push(signal);
      plan.set(signal.did, list);
    }
    return plan;
  }

  async readIdentification(): Promise<EcuIdentification[]> {
    const identification: EcuIdentification[] = [];
    const wanted = this.definitionEcu?.identification ?? [{ label: 'VIN', did: DID.VEHICLE_IDENTIFIER_NUMBER }];
    for (const entry of wanted) {
      try {
        const raw = await this.client.readDid(entry.did);
        if (!raw) continue;
        const value = entry.encoding === 'ascii' || entry.did >= 0xf180 ? toAscii(raw) : toHex(raw);
        identification.push({ label: entry.label, value });
      } catch (error) {
        this.log.debug('identification DID not available', {
          ecu: this.record.name,
          did: `0x${entry.did.toString(16)}`,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.record.identification = identification;
    this.record.reachable = true;
    return identification;
  }

  /**
   * Probe which relevant services the ECU answers (AGENTS 12 "Supported Services").
   *
   * UDS has no standardized "list your services" request (ISO 14229-1 has no such
   * service; that is a KWP2000 idea), so support is established with a request
   * that cannot change vehicle state and by looking at the negative response:
   * `serviceNotSupported` (0x11) means absent, anything else — including
   * `subFunctionNotSupported` (0x12) or `requestOutOfRange` (0x31) — proves the
   * service exists.
   *
   * Deliberately **not probed** are services where even a malformed request can
   * have consequences: clearing fault memory destroys diagnostic history, a
   * security access attempt can trigger a lockout counter, and I/O control
   * actuates hardware. Those are reported as `not-probed` with the reason
   * (AGENTS 24, 26, 34.11: read-only first).
   */
  async probeSupportedServices(candidates: readonly number[] = DEFAULT_SERVICE_PROBES): Promise<ServiceProbeResult[]> {
    const probes: ServiceProbeResult[] = [];
    for (const serviceId of candidates) {
      const reason = NON_PROBEABLE_SERVICES[serviceId];
      if (reason) {
        probes.push({ service: serviceId, outcome: 'not-probed', detail: reason });
        continue;
      }
      const request = SERVICE_PROBES[serviceId];
      if (!request) {
        probes.push({ service: serviceId, outcome: 'not-probed', detail: 'no safe probe known for this service' });
        continue;
      }
      try {
        await this.client.raw(request);
        probes.push({ service: serviceId, outcome: 'supported', detail: 'answered positively to a safe probe' });
      } catch (error) {
        const nrc = nrcOf(error);
        if (nrc === NRC.SERVICE_NOT_SUPPORTED) {
          probes.push({ service: serviceId, outcome: 'unsupported', detail: 'serviceNotSupported (0x11)' });
        } else if (nrc !== undefined) {
          probes.push({
            service: serviceId,
            outcome: 'supported',
            detail: `negative response 0x${nrc.toString(16)} (${nrcName(nrc)}) proves the service exists`,
          });
        } else {
          probes.push({
            service: serviceId,
            outcome: 'unsupported',
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    this.record.serviceProbes = probes;
    this.record.supportedServices = probes.filter((probe) => probe.outcome === 'supported').map((probe) => probe.service);
    this.log.debug('service probe finished', {
      ecu: this.record.name,
      supported: this.record.supportedServices.length,
      notProbed: probes.filter((probe) => probe.outcome === 'not-probed').length,
    });
    return probes;
  }

  async readRaw(did: number): Promise<Uint8Array | null> {
    return this.client.readDid(did);
  }

  /** Read every signal of this ECU once and decode it. */
  async readAllSignals(): Promise<DecodedSignal[]> {
    return this.readSignals(this.signalsByEcu);
  }

  /**
   * Read and decode only the given signals. Grouped by DID so one 0x22 request
   * still serves several of them — a snapshot that asks for two signals must not
   * pay for the ECU's whole signal table (AGENTS 12).
   */
  async readSignals(signals: readonly SignalDefinition[]): Promise<DecodedSignal[]> {
    const decoded: DecodedSignal[] = [];
    const plan = new Map<number, SignalDefinition[]>();
    for (const signal of signals) {
      const list = plan.get(signal.did) ?? [];
      list.push(signal);
      plan.set(signal.did, list);
    }
    for (const [did, group] of plan) {
      try {
        const raw = await this.client.readDid(did);
        if (!raw) continue;
        for (const signal of group) {
          const value = this.decoder.decode(signal, raw);
          if (value) decoded.push(value);
        }
      } catch (error) {
        this.log.debug('signal DID read failed', {
          ecu: this.record.name,
          did: `0x${did.toString(16)}`,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return decoded;
  }

  async readDtcs(statusMask = 0xff): Promise<DtcRecord[]> {
    const records = await this.client.readDtcByStatusMask(statusMask);
    this.record.dtcs = records;
    return records;
  }

  /**
   * Read and decode the freeze frame of one fault code (AGENTS 20).
   *
   * The 0x19 0x04 record layout is manufacturer specific, so the split comes
   * from the definition package; without one the bytes are returned raw instead
   * of being interpreted (AGENTS 13, 34.18).
   */
  async readDtcSnapshot(code: string, recordNumber = 0xff): Promise<FreezeFrame | null> {
    let raw: { recordNumber: number; data: Uint8Array } | null;
    try {
      raw = await this.client.readDtcSnapshotRecord(code, recordNumber);
    } catch (error) {
      // requestOutOfRange for 0x19 0x04 means "this ECU stores no snapshot for
      // this code" — a normal answer, not a failure. Anything else (timeout,
      // session, security) is a real error and must not be swallowed.
      if (nrcOf(error) === NRC.REQUEST_OUT_OF_RANGE) {
        this.log.info('no freeze frame stored for this code', { ecu: this.record.name, code });
        return null;
      }
      throw error;
    }
    if (!raw) return null;
    const definition = this.dtcDefinition(code);
    const frame = decodeFreezeFrame(raw.data, {
      code,
      recordNumber: raw.recordNumber,
      ...(definition ? { definition } : {}),
      signals: this.signalIndex.byId,
      decoder: this.decoder,
    });
    this.log.debug('freeze frame read', {
      ecu: this.record.name,
      code,
      documented: frame.documented,
      fields: frame.fields.length,
    });
    return frame;
  }

  /** Clears the fault memory of this ECU through the UDS service 0x14. */
  async clearDiagnosticInformation(groupOfDtc?: number): Promise<void> {
    await (groupOfDtc === undefined
      ? this.client.clearDiagnosticInformation()
      : this.client.clearDiagnosticInformation(groupOfDtc));
  }

  /** DTC definition of the active package for a code, if documented. */
  dtcDefinition(code: string): DtcDefinition | undefined {
    return this.definitionEcu?.dtcs?.find((dtc) => dtc.code.toUpperCase() === code.toUpperCase());
  }

  /**
   * Put the ECU into an extended session if it is still in the default session.
   *
   * Diagnostic writes (0x14, 0x2E, 0x31 …) are only allowed outside the default
   * session (ISO 14229-1 §9.2 / §11.3). If the ECU refuses the session switch —
   * typically because it demands security access first — the refusal is reported
   * and *not* worked around: this platform does not bypass access mechanisms
   * (AGENTS 29, 34.12).
   */
  async ensureWritableSession(sessionType = SESSION.EXTENDED): Promise<{ switched: boolean; sessionType: number }> {
    if (this.record.sessionType !== SESSION.DEFAULT) {
      return { switched: false, sessionType: this.record.sessionType };
    }
    try {
      await this.switchSession(sessionType);
      this.log.info('session switched for a write', { ecu: this.record.name, session: sessionType });
      return { switched: true, sessionType };
    } catch (error) {
      throw new UdsNegativeResponseError(
        SID.DIAGNOSTIC_SESSION_CONTROL,
        nrcOf(error) ?? NRC.CONDITIONS_NOT_CORRECT,
        nrcName(nrcOf(error) ?? NRC.CONDITIONS_NOT_CORRECT),
        {
          ecu: this.record.name,
          reason: `the ECU refuses the extended diagnostic session and this platform does not bypass security access (AGENTS 29)`,
          original: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }

  async switchSession(sessionType: number): Promise<void> {
    await this.client.diagnosticSessionControl(sessionType);
    this.record.sessionType = sessionType;
    this.record.timing = { p2Ms: this.client.timing.p2Ms, p2StarMs: this.client.timing.p2StarMs };
  }

  /** Definition lookup helper for the live data engine. */
  signalById(signalId: string): SignalDefinition | undefined {
    return this.signalIndex.byId.get(signalId);
  }
}

function toAscii(data: Uint8Array): string {
  let out = '';
  for (const byte of data) {
    if (byte === 0) break;
    if (byte < 0x20 || byte > 0x7e) continue;
    out += String.fromCharCode(byte);
  }
  return out.trim();
}
