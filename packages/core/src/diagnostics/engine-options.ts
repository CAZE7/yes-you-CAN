/**
 * What the diagnostic engine is configured with (AGENTS 2, 5, 26, 36).
 *
 * Kept apart from the class so the collaborators can name it without importing
 * the engine (which imports them) — and so the size of the engine module says
 * something about the engine, not about its option list. Re-exported from
 * `engine.ts`, which stays the single entry point for callers.
 */

import type { DefinitionPackage } from "@vdp/definitions";
import type { OemProtocol } from "@vdp/protocols-oem";
import type { Logger } from "@vdp/shared";
import type { CanBus } from "@vdp/transport-can";
import type { IsoTpOptions } from "@vdp/transport-iso-tp";
import type { SafetyManager } from "../safety/safety-manager.js";
import type { EcuLinkFactory } from "./ecu-links.js";

export interface DiagnosticEngineOptions {
  /**
   * CAN bus — required for `connect()` (functional discovery) and for the default
   * ISO-TP link factory. May be omitted when a {@link EcuLinkFactory} is provided
   * and ECUs are attached explicitly via `attach()` (the DoIP path).
   */
  bus?: CanBus;
  definitions?: readonly DefinitionPackage[];
  logger?: Logger;
  /**
   * Transport seam (AGENTS 5, 36). Overrides per-ECU link construction so a
   * non-CAN transport can drive the engine.
   */
  linkFactory?: EcuLinkFactory;
  /**
   * Safety manager for write operations. A private instance is created when none
   * is passed in, so every engine has one and no write path can bypass it
   * (AGENTS 26).
   */
  safety?: SafetyManager;
  /** Extra ISO-TP settings (padding, addressing, timing) applied to every ECU. */
  isoTpDefaults?: Partial<IsoTpOptions>;
  /** Poll interval used by `startLiveData`. */
  pollIntervalMs?: number;
  clock?: () => number;
  /**
   * Version of the platform that opens the session (ADR 0051). Recorded on every
   * session the engine opens, so a stored session says which platform built it.
   */
  platformVersion?: string;
  /**
   * Manufacturer specific hooks (AGENTS 3, 34.6). They are consulted only where
   * definitions are silent, so OEM knowledge never overrides documented data.
   */
  oemProtocols?: readonly OemProtocol[];
}
