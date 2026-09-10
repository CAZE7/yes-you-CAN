/**
 * Per-ECU diagnostic session (AGENTS 9, 10, 12).
 *
 * Binds one definition ECU to one UDS client on one transport. Keeps raw and
 * decoded data apart and logs every diagnostic operation (AGENTS 34.10).
 */

import { createLogger, toHex, type Logger } from '@vdp/shared';
import { IsoTpConnection } from '@vdp/transport-iso-tp';
import { DID, UdsClient, type DtcRecord } from '@vdp/protocols-uds';
import { indexPackage, type DefinitionPackage, type EcuDefinition, type SignalDefinition, type SignalIndex } from '@vdp/definitions';
import { SignalDecoder, type DecodedSignal } from '../measurements/decoder.js';
import { createEcuSession, type EcuIdentification, type EcuSession } from '../session/session.js';

export interface EcuDiagnosticSessionOptions {
  definitionEcu?: EcuDefinition;
  packageName?: string;
  logger?: Logger;
  decoder?: SignalDecoder;
}

export class EcuDiagnosticSession {
  readonly client: UdsClient;
  readonly isoTp: IsoTpConnection;
  readonly record: EcuSession;
  private readonly signalIndex: SignalIndex;
  private readonly signalsByEcu: SignalDefinition[];
  private readonly decoder: SignalDecoder;
  private readonly log: Logger;
  private readonly definitionEcu?: EcuDefinition;

  constructor(
    isoTp: IsoTpConnection,
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
    },
  ) {
    this.isoTp = isoTp;
    this.client = client;
    this.log = (options.logger ?? createLogger('ecu', { level: 'INFO' })).child('ecu');
    this.decoder = options.decoder ?? new SignalDecoder({ logger: this.log });
    this.definitionEcu =
      options.definitionEcu ??
      (options.definitionPackage && options.definitionEcuId
        ? options.definitionPackage.ecus.find((e) => e.id === options.definitionEcuId)
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

  /** Probe which of the relevant services the ECU answers (AGENTS 12 "Supported Services"). */
  async probeSupportedServices(candidates: readonly number[] = [0x10, 0x11, 0x14, 0x19, 0x22, 0x2e, 0x31, 0x3e]): Promise<number[]> {
    const supported: number[] = [];
    for (const serviceId of candidates) {
      try {
        if (serviceId === 0x3e) {
          await this.client.testerPresent(false);
        } else if (serviceId === 0x19) {
          await this.client.readSupportedDtc();
        } else if (serviceId === 0x22) {
          await this.client.readDid(this.definitionEcu?.identification?.[0]?.did ?? DID.VEHICLE_IDENTIFIER_NUMBER);
        } else if (serviceId === 0x10) {
          await this.client.diagnosticSessionControl(0x01);
        } else {
          // A negative response other than serviceNotSupported still proves the
          // service exists on this ECU.
          await this.client.raw(new Uint8Array([serviceId, 0x00]));
        }
        supported.push(serviceId);
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        if (!message.includes('serviceNotSupported')) supported.push(serviceId);
      }
    }
    this.record.supportedServices = supported;
    return supported;
  }

  async readRaw(did: number): Promise<Uint8Array | null> {
    return this.client.readDid(did);
  }

  /** Read every signal of this ECU once and decode it. */
  async readAllSignals(): Promise<DecodedSignal[]> {
    const decoded: DecodedSignal[] = [];
    for (const [did, signals] of this.didPlan()) {
      try {
        const raw = await this.client.readDid(did);
        if (!raw) continue;
        for (const signal of signals) {
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
