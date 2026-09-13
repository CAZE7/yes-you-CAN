/**
 * Wiring of the engine collaborators (ADR 0014 phase 4).
 *
 * The engine itself holds the session reference and the public API; building the
 * collaborators and keeping their construction order in one place keeps the
 * engine a façade instead of a constructor with twenty fields. Everything here
 * is dependency injection with no behaviour of its own — which is exactly why it
 * is a small module and not logic.
 *
 * Order matters and is enforced by the types: the scanner is built before the
 * clear service (the clear service needs it), the attacher after the registry and
 * the links, the opener last (it needs the attacher) and the two access objects
 * after the registry they read.
 */

import type { DefinitionPackage } from "@vdp/definitions";
import type { OemProtocolRegistry } from "@vdp/protocols-oem";
import type { Logger } from "@vdp/shared";
import { DtcClearService } from "../dtc/clear.js";
import { DtcScanner } from "../dtc/scanner.js";
import type { SignalDecoder } from "../measurements/decoder.js";
import type { MeasurementRecorder } from "../measurements/recorder.js";
import type { SafetyManager } from "../safety/safety-manager.js";
import { DtcAccess } from "./dtc-access.js";
import { EcuAttacher } from "./ecu-attacher.js";
import { EcuLinks } from "./ecu-links.js";
import { EcuRegistry } from "./ecu-registry.js";
import type { DiagnosticEngineOptions } from "./engine-options.js";
import { MeasurementAccess } from "./measurement-access.js";
import { SessionOpener } from "./session-opener.js";

export interface DiagnosticContextOptions {
  options: DiagnosticEngineOptions;
  logger: Logger;
  decoder: SignalDecoder;
  oemProtocols: OemProtocolRegistry;
  recorder: MeasurementRecorder;
  safety: SafetyManager;
}

export class DiagnosticContext {
  /** Which handle belongs to which address — read by nearly every collaborator. */
  readonly registry = new EcuRegistry();
  /** Fault-memory enrichment and the clear service's view of the world. */
  readonly scanner: DtcScanner;
  readonly clear: DtcClearService;

  private readonly definitions: readonly DefinitionPackage[];
  readonly links: EcuLinks;
  readonly attacher: EcuAttacher;
  readonly opener: SessionOpener;
  readonly dtc: DtcAccess;
  readonly measurements: MeasurementAccess;

  constructor(deps: DiagnosticContextOptions) {
    const { options, logger } = deps;
    this.definitions = options.definitions ?? [];
    this.scanner = new DtcScanner({ definitions: this.definitions });
    this.clear = new DtcClearService({
      safety: deps.safety,
      scanner: this.scanner,
      logger,
    });
    this.links = new EcuLinks(
      {
        bus: options.bus,
        linkFactory: options.linkFactory,
        isoTpDefaults: options.isoTpDefaults,
      },
      logger,
    );
    this.attacher = new EcuAttacher({
      links: this.links,
      registry: this.registry,
      definitions: this.definitions,
      oemProtocols: deps.oemProtocols,
      decoder: deps.decoder,
      logger,
    });
    this.opener = new SessionOpener({
      bus: options.bus,
      definitions: this.definitions,
      attacher: this.attacher,
      registry: this.registry,
      logger,
      clock: options.clock,
    });
    this.dtc = new DtcAccess({
      registry: this.registry,
      scanner: this.scanner,
      clear: this.clear,
      oemProtocols: deps.oemProtocols,
      recorder: deps.recorder,
      logger,
    });
    this.measurements = new MeasurementAccess({
      registry: this.registry,
      recorder: deps.recorder,
      decoder: deps.decoder,
      definitions: this.definitions,
      logger,
      pollIntervalMs: options.pollIntervalMs,
    });
  }
}
