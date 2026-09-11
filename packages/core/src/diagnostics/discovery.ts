/**
 * ECU discovery (AGENTS 12).
 *
 * Discovery is NOT hardcoded to one manufacturer: a functional request is sent
 * on the bus and every ECU that answers reveals its physical response identifier.
 * Definition packages can pre-seed the candidate list, but unknown responders are
 * reported as well — an ECU Explorer that only shows known ECUs would hide
 * exactly the interesting cases.
 */

import type { DefinitionPackage } from "@vdp/definitions";
import { SID } from "@vdp/protocols-uds";
import { type Logger, createLogger, toHex } from "@vdp/shared";
import type { CanBus, CanFrame } from "@vdp/transport-can";
import { IsoTpConnection } from "@vdp/transport-iso-tp";

export interface DiscoveredEcu {
  /** Physical response identifier the ECU answered with. */
  rxId: number;
  /** Derived physical request identifier (see deriveTxId). */
  txId: number;
  extended: boolean;
  /** Definition package ECU id, when the address matched a definition. */
  definitionEcuId?: string;
  /** First response payload, e.g. the positive response to the probe. */
  response?: Uint8Array;
  /** Raw CAN frames observed from this ECU during discovery. */
  frames: number;
}

export interface DiscoveryOptions {
  functionalId?: number;
  /** How long to listen for answers. */
  windowMs?: number;
  /** Probe service; TesterPresent is the least invasive choice. */
  probeService?: number;
  /** Candidate identifiers to probe individually in addition to the functional request. */
  candidates?: Array<{ txId: number; rxId: number; extended?: boolean }>;
  extended?: boolean;
  logger?: Logger;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Derive the physical request identifier from a response identifier.
 *
 * The mapping is manufacturer specific; the two conventions in wide use are
 * implemented here and anything else has to come from a definition package
 * (AGENTS 34.18: reference the standard instead of guessing silently).
 */
export function deriveTxId(rxId: number, extended: boolean): number {
  if (!extended) {
    // 11-bit convention: request 0x7E0..0x7E7 ↔ response 0x7E8..0x7EF, and
    // request 0x713 ↔ response 0x77B style pairs are handled via definitions.
    if (rxId >= 0x7e8 && rxId <= 0x7ef) return rxId - 8;
    return rxId - 0x68;
  }
  // 29-bit convention (ISO 15765-2 Annex): 0x18DA<tester><ecu> ↔ 0x18DA<ecu><tester>.
  const tester = (rxId >> 8) & 0xff;
  const ecu = rxId & 0xff;
  return ((rxId & 0xffff0000) >>> 0) | (ecu << 8) | tester;
}

export class EcuDiscovery {
  private readonly log: Logger;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly bus: CanBus,
    private readonly options: DiscoveryOptions = {},
  ) {
    this.log = (options.logger ?? createLogger("ecu", { level: "INFO" })).child("ecu");
    this.sleep =
      options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * Send a functional probe and collect responders.
   * Definition-supplied candidates are probed individually as well, because not
   * every ECU answers functional requests.
   */
  async discover(definitions?: readonly DefinitionPackage[]): Promise<DiscoveredEcu[]> {
    const windowMs = this.options.windowMs ?? 1200;
    const functionalId = this.options.functionalId ?? 0x7df;
    const extended = this.options.extended ?? false;
    const probeService = this.options.probeService ?? SID.TESTER_PRESENT;
    const found = new Map<number, DiscoveredEcu>();

    const record = (frame: CanFrame): void => {
      // Our own transmissions are not ECU responses. An adapter that echoes sent
      // frames back (candump, and any bus opened with echoToSender) would
      // otherwise make every request identifier look like a responding ECU.
      if (frame.direction === "tx") return;
      const key = frame.id;
      const entry = found.get(key) ?? {
        rxId: frame.id,
        txId: deriveTxId(frame.id, frame.extended),
        extended: frame.extended,
        frames: 0,
      };
      entry.frames++;
      if (!entry.response && frame.payload.length > 0) entry.response = stripAddressByte(frame);
      found.set(key, entry);
    };

    const unsubscribe = this.bus.subscribe((frame) => record(frame));

    try {
      this.log.info("ECU discovery started", {
        functionalId: `0x${functionalId.toString(16)}`,
        windowMs,
      });
      await this.sendFunctionalProbe(functionalId, probeService, extended);
      await this.sleep(windowMs / 2);

      const candidates = this.options.candidates ?? collectCandidates(definitions);
      for (const candidate of candidates) {
        if (this.bus.isOpen() === false) break;
        await this.probeSingle(candidate.txId, probeService, candidate.extended ?? extended);
        await this.sleep(15);
      }
      await this.sleep(windowMs / 2);
    } finally {
      unsubscribe();
    }

    const results = Array.from(found.values()).sort((a, b) => a.rxId - b.rxId);
    for (const entry of results) {
      const match = findDefinitionEcu(definitions, entry);
      if (match) entry.definitionEcuId = match;
    }
    this.log.info("ECU discovery finished", { responders: results.length });
    return results;
  }

  private async sendFunctionalProbe(
    functionalId: number,
    serviceId: number,
    extended: boolean,
  ): Promise<void> {
    const conn = new IsoTpConnection(this.bus, {
      txId: functionalId,
      rxId: -1, // no single response id; frames are collected via the bus subscription
      extended,
      padding: true,
      sleep: this.sleep,
    });
    // A probe that cannot be written must not abort the scan: the listener is armed
    // already, and ECUs that answer a previous broadcast are worth collecting even
    // when this adapter is unhappy (§34.26 — every probe path reports, none throws).
    try {
      await conn.sendOnly(new Uint8Array([serviceId, 0x80]));
      this.log.debug("functional probe sent", {
        functionalId: `0x${functionalId.toString(16)}`,
        serviceId: `0x${serviceId.toString(16)}`,
      });
    } catch (error) {
      this.log.warn("functional probe could not be sent", {
        functionalId: `0x${functionalId.toString(16)}`,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async probeSingle(txId: number, serviceId: number, extended: boolean): Promise<void> {
    const conn = new IsoTpConnection(this.bus, {
      txId,
      rxId: -1,
      extended,
      padding: true,
      sleep: this.sleep,
    });
    try {
      await conn.sendOnly(new Uint8Array([serviceId, 0x00]));
    } catch (error) {
      this.log.debug("single probe failed", {
        txId: `0x${txId.toString(16)}`,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/** Address-extension byte is not part of the ISO-TP payload for our purposes. */
function stripAddressByte(frame: CanFrame): Uint8Array {
  return frame.payload.slice();
}

function collectCandidates(
  definitions?: readonly DefinitionPackage[],
): Array<{ txId: number; rxId: number; extended?: boolean }> {
  const candidates: Array<{ txId: number; rxId: number; extended?: boolean }> = [];
  for (const pkg of definitions ?? []) {
    for (const ecu of pkg.ecus) {
      candidates.push({
        txId: ecu.address.txId,
        rxId: ecu.address.rxId,
        extended: ecu.address.extended,
      });
    }
  }
  // Common 11-bit OBD request identifiers, so a bare adapter still finds ECUs.
  for (let id = 0x7e0; id <= 0x7e7; id++) candidates.push({ txId: id, rxId: id + 8 });
  return candidates;
}

function findDefinitionEcu(
  definitions: readonly DefinitionPackage[] | undefined,
  entry: DiscoveredEcu,
): string | undefined {
  for (const pkg of definitions ?? []) {
    for (const ecu of pkg.ecus) {
      if (ecu.address.rxId === entry.rxId && Boolean(ecu.address.extended) === entry.extended)
        return `${pkg.oem}:${ecu.id}`;
    }
  }
  return undefined;
}

export { toHex };
