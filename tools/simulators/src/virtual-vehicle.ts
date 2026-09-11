/**
 * Virtual vehicle (AGENTS 32).
 *
 * Builds one virtual ECU per ECU definition of a definition package. Each ECU is
 * a full UDS server behind its own ISO-TP connection on the virtual CAN network,
 * with live signal values, DTCs, sessions and timing — so tests, the UI and the
 * replay tooling all run without hardware.
 */

import { encodeSignal } from "@vdp/core";
import {
  type DefinitionPackage,
  type DtcDefinition,
  type EcuDefinition,
  type SignalDefinition,
  type SignalIndex,
  indexPackage,
} from "@vdp/definitions";
import { genericPackage } from "@vdp/definitions/generic";
import {
  SESSION,
  type ServerDid,
  type ServerDtc,
  UdsServer,
  type UdsServerLink,
  type UdsServerOptions,
  xorSeedKeyAlgorithm,
} from "@vdp/protocols-uds";
import { type Logger, createLogger, toHex } from "@vdp/shared";
import { IsoTpConnection } from "@vdp/transport-iso-tp";
import {
  type VirtualCanBus,
  type VirtualCanOptions,
  createVirtualCanNetwork,
} from "./virtual-can.js";

export interface VirtualVehicleOptions {
  vin?: string;
  definitions?: DefinitionPackage;
  network?: ReturnType<typeof createVirtualCanNetwork>;
  networkOptions?: VirtualCanOptions;
  logger?: Logger;
  /** Signal values evolve over time instead of being static. */
  dynamic?: boolean;
  /** Seed for the deterministic signal model (only used when dynamic is true). */
  seed?: number;
  /** Services that answer with NRC 0x78 first (exercises the P2* path). */
  pendingResponseServices?: number[];
  /** Initial DTCs per ECU id. */
  dtcs?: Record<string, ServerDtc[]>;
}

export interface VirtualEcu {
  definition: EcuDefinition;
  bus: VirtualCanBus;
  server: UdsServer;
  isoTp: IsoTpConnection;
  signals: SignalDefinition[];
}

export const DEFAULT_VIN = "1HGCM82633A004352";

/** Deterministic pseudo random generator so recordings are reproducible. */
export function createRandom(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0xffffffff;
  };
}

export class VirtualVehicle {
  readonly network: ReturnType<typeof createVirtualCanNetwork>;
  /** Tester-side bus — hand this to the diagnostic engine. */
  readonly testerBus: VirtualCanBus;
  readonly ecus: VirtualEcu[] = [];
  /**
   * `ecus` by definition id. `ecu(ecuId)` is called for every injected fault and
   * for every DID write of every test, and a fresh ECU list is only ever built in
   * the constructor — so the id lookup is a map hit here instead of a scan of the
   * array (AGENTS 32).
   */
  private readonly ecusById = new Map<string, VirtualEcu>();

  private readonly log: Logger;
  private readonly definitions: DefinitionPackage;
  private readonly index: SignalIndex;
  private readonly dynamic: boolean;
  private readonly random: () => number;
  private readonly startedAt: number;
  private readonly vin: string;
  private readonly initialDtcs: Record<string, ServerDtc[]>;
  private readonly pendingResponseServices: number[];

  constructor(options: VirtualVehicleOptions = {}) {
    this.log = (options.logger ?? createLogger("uds", { level: "WARN" })).child("uds");
    this.definitions = options.definitions ?? genericPackage;
    this.index = indexPackage(this.definitions);
    this.dynamic = options.dynamic ?? true;
    this.random = createRandom(options.seed ?? 1234);
    this.startedAt = Date.now();
    this.vin = options.vin ?? DEFAULT_VIN;
    this.initialDtcs = options.dtcs ?? {};
    this.pendingResponseServices = options.pendingResponseServices ?? [];
    this.network = options.network ?? createVirtualCanNetwork(options.networkOptions ?? {});
    this.testerBus = this.network.createBus("tester");
    for (const definition of this.definitions.ecus) {
      const ecu = this.createEcu(definition);
      this.ecus.push(ecu);
      this.ecusById.set(definition.id, ecu);
    }
  }

  get definitionPackage(): DefinitionPackage {
    return this.definitions;
  }

  /**
   * Open every ECU bus plus the tester bus.
   *
   * The buses are independent nodes of one virtual network, so each open is
   * started in the same pass and awaited together: awaiting inside the loop used
   * to serialise the whole setup — one event-loop turn per ECU, and with
   * `latencyMs` configured even the transport `open()` of every connection — and
   * the tester could already see frames from a bus that had not opened yet.
   */
  async start(): Promise<void> {
    const opening: Array<Promise<void>> = [];
    for (const ecu of this.ecus) {
      ecu.isoTp.open();
      ecu.server.start();
      opening.push(ecu.bus.open());
    }
    opening.push(this.testerBus.open());
    await Promise.all(opening);
    this.log.info("virtual vehicle started", { vin: this.vin, ecus: this.ecus.length });
  }

  /** Stop every ECU first, then close the buses together. */
  async stop(): Promise<void> {
    const closing: Array<Promise<void>> = [];
    for (const ecu of this.ecus) {
      ecu.server.stop();
      ecu.isoTp.close();
      closing.push(ecu.bus.close());
    }
    closing.push(this.testerBus.close());
    await Promise.all(closing);
  }

  /** Inject a DTC (simulates a fault appearing while recording). */
  setDtc(ecuId: string, code: string, status = 0x2f): void {
    this.ecu(ecuId)?.server.setDtcStatus(code, status);
  }

  clearAllDtcs(): void {
    for (const ecu of this.ecus)
      for (const dtc of this.dtcListOf(ecu.definition)) ecu.server.setDtcStatus(dtc.code, 0x00);
  }

  ecu(ecuId: string): VirtualEcu | undefined {
    return this.ecusById.get(ecuId);
  }

  /**
   * Fault memory of an ECU.
   *
   * Injected codes are merged over the definition-derived ones instead of
   * replacing them: a test that only sets a status must not silently strip the
   * freeze frame the definition declares (AGENTS 20).
   */
  private dtcListOf(definition: EcuDefinition): ServerDtc[] {
    const byCode = new Map(
      defaultDtcsFor(definition, this.index.byId).map((dtc) => [dtc.code, dtc]),
    );
    const injected = this.initialDtcs[definition.id];
    if (!injected) return [...byCode.values()];
    for (const dtc of injected) {
      const declared = byCode.get(dtc.code);
      // Injected values win (a test injects the status it wants to see), but the
      // declared fields survive: a code never loses its description, hint or
      // freeze frame just because a test set a status (AGENTS 13, 20).
      byCode.set(dtc.code, declared ? { ...declared, ...dtc } : { ...dtc });
    }
    return [...byCode.values()];
  }

  private createEcu(definition: EcuDefinition): VirtualEcu {
    const bus = this.network.createBus(`ecu-${definition.id}`);
    const signals = this.index.byEcu.get(definition.id) ?? [];
    const isoTp = new IsoTpConnection(
      bus,
      {
        txId: definition.address.rxId,
        rxId: definition.address.txId,
        extended: definition.address.extended ?? false,
        addressing: definition.address.addressing ?? "normal",
        padding: true,
      },
      this.log,
    );

    const link: UdsServerLink = {
      onMessage: (listener) => isoTp.onUnsolicited(listener),
      send: (payload) => isoTp.sendOnly(payload),
    };

    const serverOptions: UdsServerOptions = {
      name: definition.name,
      logger: this.log,
      dids: this.buildDids(definition, signals),
      dtcs: this.dtcListOf(definition),
      sessions: [SESSION.DEFAULT, SESSION.EXTENDED, SESSION.PROGRAMMING],
      ...(definition.timing ? { timing: definition.timing } : {}),
      ...(this.pendingResponseServices.length > 0
        ? { pendingResponseServices: this.pendingResponseServices }
        : {}),
      securityAccess: {
        // XOR seed&key so the simulator can exercise the 0x27 flow end to end.
        // Clearly labelled as a test algorithm — never a real one (AGENTS 34.12).
        seed: () => new Uint8Array([0x11, 0x22, 0x33, 0x44]),
        verifyKey: (_level, key) => toHex(key) === "EE DD CC BB",
      },
    };
    const server = new UdsServer(link, serverOptions);
    return { definition, bus, server, isoTp, signals };
  }

  /** One DID handler per DID; multiple signals can share a DID. */
  private buildDids(definition: EcuDefinition, signals: readonly SignalDefinition[]): ServerDid[] {
    const byDid = new Map<number, SignalDefinition[]>();
    for (const signal of signals) {
      const list = byDid.get(signal.did) ?? [];
      list.push(signal);
      byDid.set(signal.did, list);
    }

    const dids: ServerDid[] = [];
    for (const [did, didSignals] of byDid) {
      dids.push({
        did,
        value: () => this.buildPayload(definition, did, didSignals),
        writable: did < 0xf000,
      });
    }

    // Identification DIDs declared by the ECU definition itself.
    for (const entry of definition.identification ?? []) {
      if (byDid.has(entry.did)) continue;
      dids.push({
        did: entry.did,
        value: () =>
          asciiBytes(
            entry.did === 0xf190
              ? this.vin
              : `${definition.id.toUpperCase()}-${entry.did.toString(16)}`,
          ),
      });
    }
    return dids;
  }

  private buildPayload(
    definition: EcuDefinition,
    _did: number,
    signals: readonly SignalDefinition[],
  ): Uint8Array {
    const length = signals.reduce(
      (max, signal) => Math.max(max, signal.byteOffset + signal.length),
      0,
    );
    const payload = new Uint8Array(length);
    for (const signal of signals) {
      const value = this.signalValue(definition.id, signal);
      try {
        const encoded = encodeSignal(signal, value, { payloadLength: length });
        for (let i = 0; i < signal.length; i++) {
          payload[signal.byteOffset + i] = encoded[signal.byteOffset + i] ?? 0;
        }
      } catch (error) {
        this.log.debug("simulator encode failed", {
          signal: signal.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return payload;
  }

  /**
   * Simple physical model so graphs show realistic movement.
   * Deterministic per seed, so recordings are reproducible (AGENTS 31/32).
   */
  private signalValue(ecuId: string, signal: SignalDefinition): number | string | boolean {
    if (signal.encoding === "ascii") return this.vin;
    if (signal.encoding === "bool") return true;

    const elapsedS = (Date.now() - this.startedAt) / 1000;
    const base = baselineFor(ecuId, signal);
    if (!this.dynamic) return base;

    switch (signal.id) {
      case "engine.rpm":
        return round(800 + 1600 * Math.abs(Math.sin(elapsedS / 4)) + 200 * this.random(), 0.25);
      case "engine.coolant_temperature":
        return Math.min(105, 20 + elapsedS * 0.8 + 2 * this.random());
      case "vehicle.speed":
        return round(40 + 60 * Math.abs(Math.sin(elapsedS / 6)), 1);
      case "engine.load":
        return round(15 + 45 * Math.abs(Math.sin(elapsedS / 5)), 0.39215686274509803);
      case "engine.throttle_position":
        return round(10 + 40 * Math.abs(Math.sin(elapsedS / 3)), 0.39215686274509803);
      case "engine.short_term_fuel_trim":
      case "engine.long_term_fuel_trim":
        return round(-3 + 6 * this.random(), 0.78125);
      case "engine.intake_manifold_pressure":
        return Math.round(30 + 60 * Math.abs(Math.sin(elapsedS / 5)));
      case "engine.timing_advance":
        return round(8 + 12 * Math.abs(Math.sin(elapsedS / 7)), 0.5);
      case "engine.maf_airflow":
        return round(4 + 12 * Math.abs(Math.sin(elapsedS / 4)), 0.01);
      case "engine.runtime":
        return Math.round(elapsedS);
      case "engine.intake_air_temperature":
        return Math.round(25 + 3 * this.random());
      case "engine.fuel_rail_pressure":
        return Math.round(300 + 50 * this.random());
      case "engine.fuel_system_status":
        return 2; // closed loop
      case "transmission.oil_temperature":
        return Math.min(120, 30 + elapsedS * 0.5);
      case "transmission.gear_position":
        return 3;
      case "abs.wheel_speed_front_left":
      case "abs.wheel_speed_front_right":
        return round(40 + 60 * Math.abs(Math.sin(elapsedS / 6)), 0.01);
      case "abs.brake_pedal":
        return 0;
      default:
        return base;
    }
  }
}

function baselineFor(_ecuId: string, signal: SignalDefinition): number {
  const fallback = signal.min ?? 0;
  switch (signal.id) {
    case "engine.rpm":
      return 850;
    case "engine.coolant_temperature":
      return 90;
    case "vehicle.speed":
      return 0;
    case "engine.load":
      return 22;
    case "engine.throttle_position":
      return 14;
    case "engine.short_term_fuel_trim":
    case "engine.long_term_fuel_trim":
      return 0;
    case "engine.intake_manifold_pressure":
      return 35;
    case "engine.timing_advance":
      return 12;
    case "engine.maf_airflow":
      return 5;
    case "engine.runtime":
      return 0;
    case "engine.intake_air_temperature":
      return 26;
    case "engine.fuel_rail_pressure":
      return 320;
    case "engine.fuel_system_status":
      return 2;
    case "transmission.oil_temperature":
      return 60;
    case "transmission.gear_position":
      return 3;
    case "abs.wheel_speed_front_left":
    case "abs.wheel_speed_front_right":
      return 0;
    case "abs.brake_pedal":
      return 0;
    default:
      return typeof signal.max === "number" && signal.max > 0
        ? Math.min(fallback + 1, signal.max)
        : fallback;
  }
}

/**
 * Fault codes of an ECU definition, with a freeze frame whose layout matches the
 * definition package (AGENTS 13, 20).
 *
 * The snapshot is encoded with the very same signal definitions the live DIDs
 * use, so a decoder that works on live values works on freeze frames too — and a
 * mismatch between definition and simulator shows up immediately in tests
 * instead of being papered over by a hand-written byte blob.
 */
export function defaultDtcsFor(
  definition: EcuDefinition,
  signalById: ReadonlyMap<string, SignalDefinition> = new Map(),
): ServerDtc[] {
  return (definition.dtcs ?? []).map((dtc, index) => ({
    code: dtc.code,
    // Give the first DTC an active status, the rest confirmed-only, so the UI and
    // reports have both cases to render.
    status: index === 0 ? 0x2f : 0x08,
    ...(buildFreezeFrame(dtc, signalById) ?? {}),
    extendedData: new Uint8Array([0x01, 0x02, 0x03]),
  }));
}

/**
 * Operating point a stored fault is frozen at.
 *
 * A freeze frame records *where* the ECU was when the fault occurred, so it must
 * not equal the idle baseline — otherwise the snapshot carries no information and
 * a decoder bug would go unnoticed.
 */
function freezeFrameValue(signal: SignalDefinition): number {
  switch (signal.id) {
    case "engine.rpm":
      return 3120;
    case "vehicle.speed":
      return 78;
    case "engine.load":
      return 64;
    case "engine.coolant_temperature":
      return 93;
    case "engine.throttle_position":
      return 38;
    default:
      return signal.min ?? 0;
  }
}

/** Encode the declared freeze frame fields into the record the server returns. */
function buildFreezeFrame(
  dtc: DtcDefinition,
  signalById: ReadonlyMap<string, SignalDefinition>,
): { snapshot: Uint8Array } | undefined {
  const fields = dtc.freezeFrame ?? [];
  if (fields.length === 0) return undefined;
  const parts: number[] = [];
  for (const field of fields) {
    const fieldSignals = (field.signals ?? [])
      .map((id) => signalById.get(id))
      .filter((s): s is SignalDefinition => s !== undefined);
    if (fieldSignals.length === 0) {
      // Undocumented value: emit zeros of the declared length so the record
      // length still matches the declared layout.
      for (let i = 0; i < (field.length ?? 0); i++) parts.push(0);
      continue;
    }
    const length =
      field.length ??
      fieldSignals.reduce((max, signal) => Math.max(max, signal.byteOffset + signal.length), 0);
    const payload = new Uint8Array(length);
    for (const signal of fieldSignals) {
      const value = freezeFrameValue(signal);
      const encoded = encodeSignal(signal, value, { payloadLength: length });
      for (let i = 0; i < signal.length; i++)
        payload[signal.byteOffset + i] = encoded[signal.byteOffset + i] ?? 0;
    }
    for (const byte of payload) parts.push(byte);
  }
  return { snapshot: new Uint8Array(parts) };
}

function asciiBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

function round(value: number, scale: number): number {
  const decimals = Math.max(0, Math.min(4, Math.ceil(-Math.log10(scale))));
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export { xorSeedKeyAlgorithm };
