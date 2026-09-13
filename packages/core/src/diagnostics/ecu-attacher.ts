/**
 * ECU attachment: from a discovered address to a working diagnostic session
 * (AGENTS 5, 11, 12, 36).
 *
 * The engine used to do this inline: open a link, build a UDS client, ask the
 * manufacturer hooks when the definition packages were silent, register the
 * handle, read identification, probe which services actually answer. That is one
 * responsibility — *make an ECU usable* — and it is the part of the engine that
 * talks to transports, definitions and OEM hooks at once.
 *
 * Two paths lead here: CAN discovery finds ECUs functionally, or a caller
 * attaches one by address (DoIP uses a logical address, not functional
 * discovery). Both end in the same {@link EcuHandle}.
 */

import type { DefinitionPackage } from "@vdp/definitions";
import type { OemProtocolRegistry } from "@vdp/protocols-oem";
import { type Logger, messageOf } from "@vdp/shared";
import type { SignalDecoder } from "../measurements/decoder.js";
import type { EcuSession } from "../session/session.js";
import type { VehicleSession } from "../session/session.js";
import { type VehicleIdentity, createIdentityFromVin } from "../vehicle/identity.js";
import type { DiscoveredEcu } from "./discovery.js";
import type { EcuLinks, EcuTarget } from "./ecu-links.js";
import type { EcuHandle, EcuRegistry } from "./ecu-registry.js";
import { EcuDiagnosticSession } from "./ecu-session.js";

export interface EcuAttacherOptions {
  links: EcuLinks;
  registry: EcuRegistry;
  definitions: readonly DefinitionPackage[];
  oemProtocols: OemProtocolRegistry;
  decoder: SignalDecoder;
  logger: Logger;
}

export class EcuAttacher {
  private readonly links: EcuLinks;
  private readonly registry: EcuRegistry;
  private readonly definitions: readonly DefinitionPackage[];
  private readonly oemProtocols: OemProtocolRegistry;
  private readonly decoder: SignalDecoder;
  private readonly log: Logger;

  constructor(options: EcuAttacherOptions) {
    this.links = options.links;
    this.registry = options.registry;
    this.definitions = options.definitions;
    this.oemProtocols = options.oemProtocols;
    this.decoder = options.decoder;
    this.log = options.logger;
  }

  /** Definition package used for the current session (recorded for provenance). */
  get activePackage(): DefinitionPackage | undefined {
    return this.definitions[0];
  }

  /**
   * Attach one ECU by address without running CAN discovery (AGENTS 5, 36).
   *
   * This is the entry point for transports that address an ECU directly — DoIP
   * uses a logical address rather than functional CAN discovery. With an
   * {@link EcuLinks} seam that carries a factory this drives the whole diagnostic
   * stack over a non-CAN transport; without one it opens an ISO-TP connection on
   * the bus.
   */
  async attachExplicit(target: EcuTarget & { definitionEcuId?: string }): Promise<EcuHandle> {
    // An explicitly attached ECU was not found by CAN discovery, so it has no
    // discovery frames — the field exists to satisfy the DiscoveredEcu shape.
    const handle = await this.attach({
      ...target,
      extended: target.extended ?? false,
      frames: 0,
    });
    await handle.session.readIdentification();
    return handle;
  }

  /** Open a link, build the session and register the handle. */
  async attach(ecu: DiscoveredEcu): Promise<EcuHandle> {
    const opened = await this.links.open(ecu);
    const client = this.links.createClient(opened.link, `0x${ecu.rxId.toString(16)}`);
    const oemKey = ecu.definitionEcuId?.split(":")[0];
    const pkg = oemKey ? this.definitions.find((p) => p.oem === oemKey) : this.activePackage;
    // Only ask the OEM hooks when the definition packages say nothing about this
    // identifier — documented data always wins over manufacturer heuristics.
    const oemGuess = ecu.definitionEcuId
      ? undefined
      : this.oemProtocols.identifyEcu(ecu.rxId, ecu.extended);
    if (oemGuess) {
      this.log.info("ECU role from OEM protocol", {
        rxId: `0x${ecu.rxId.toString(16)}`,
        oem: oemGuess.oem,
        role: oemGuess.role,
      });
    }
    const session = new EcuDiagnosticSession(opened.link, client, {
      txId: ecu.txId,
      rxId: ecu.rxId,
      extended: ecu.extended,
      logger: this.log,
      decoder: this.decoder,
      closeLink: opened.close,
      ...(pkg ? { definitionPackage: pkg } : {}),
      ...(ecu.definitionEcuId ? { definitionEcuId: ecu.definitionEcuId.split(":")[1] } : {}),
      ...(oemGuess ? { name: oemGuess.role } : {}),
    });
    const handle: EcuHandle = {
      session,
      reader: { ecuId: session.id, readRaw: (did) => session.readRaw(did) },
      discovered: ecu,
    };
    this.registry.add(handle);
    return handle;
  }

  /**
   * The session of an ECU that could not be attached.
   *
   * A scan must show *that* an ECU answered and *why* it is unusable — dropping
   * it silently would turn a wiring fault into a missing ECU, and a missing ECU
   * into "the car does not have that control unit". The returned record carries
   * the failure message; the caller stores it in the session.
   */
  attachFailed(ecu: DiscoveredEcu, message: string): EcuSession {
    const fallbackIsoTp = this.links.createIsoTp(ecu.txId, ecu.rxId, ecu.extended);
    const failed = new EcuDiagnosticSession(
      fallbackIsoTp,
      this.links.createClient(fallbackIsoTp, `0x${ecu.rxId.toString(16)}`),
      {
        txId: ecu.txId,
        rxId: ecu.rxId,
        // Absent is the default (standard 11-bit addressing); spreading keeps
        // "not stated" and "stated as undefined" from becoming one thing.
        ...(ecu.extended !== undefined ? { extended: ecu.extended } : {}),
        logger: this.log,
        decoder: this.decoder,
        // Discovery may have found this ECU without a definition package
        // (a plain CAN scan); the session then runs identifier-free instead
        // of being handed a package-shaped `undefined`.
        ...(this.activePackage !== undefined ? { definitionPackage: this.activePackage } : {}),
        ...(ecu.definitionEcuId !== undefined
          ? { definitionEcuId: ecu.definitionEcuId.split(":")[1] }
          : {}),
      },
    );
    failed.record.lastError = message;
    return failed.record;
  }

  /**
   * Read identification and probe which services the ECU really answers.
   *
   * "Supported Services" is discovered, not assumed (AGENTS 12). Failing probes
   * only shorten the list; they never make the attachment fail.
   *
   * @returns number of services the ECU confirmed
   */
  async identify(handle: EcuHandle): Promise<number> {
    await handle.session.readIdentification();
    const supported = await handle.session.probeSupportedServices();
    this.log.info("ECU services probed", {
      ecu: handle.session.record.name,
      supported: supported.length,
    });
    return supported.length;
  }

  /** Read the VIN from the first ECU that answers DID 0xF190 (AGENTS 11). */
  async detectVehicleIdentity(session: VehicleSession): Promise<VehicleIdentity | undefined> {
    for (const handle of this.registry.all) {
      try {
        const vin = await handle.session.client.readVin();
        if (!vin) continue;
        const identity = createIdentityFromVin(vin, {
          ecus: session.data.ecus.map((e) => e.name),
        });
        session.data.vehicle = identity;
        this.log.info("vehicle identified", {
          vin: identity.vin,
          checkDigit: identity.vinAnalysis?.checkDigit,
        });
        return identity;
      } catch (error) {
        // Trying the next ECU is intentional — but the failure itself stays
        // observable instead of disappearing (AGENTS 33, 34.25).
        this.log.debug("VIN read failed, trying next ECU", {
          ecu: handle.session.record.name,
          error: messageOf(error),
        });
      }
    }
    return undefined;
  }
}
