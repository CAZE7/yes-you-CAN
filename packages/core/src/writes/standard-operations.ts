/**
 * The write port with standard operations (AGENTS 25/26; master backlog P0/P2).
 *
 * A named composition instead of an anonymous `new WritePort(...)`: the set
 * of writable operations is a product decision, so it has one place.
 *
 * Operations supported:
 * 1. `clear-dtc`: Clear fault memory (medium risk).
 * 2. `coding`: ECU configuration / variant coding (high risk).
 * 3. `adaptation`: ECU calibration / setpoint adaptation (medium risk).
 */

import type { Logger } from "@vdp/shared";
import type { DtcScanner } from "../dtc/scanner.js";
import type { SafetyManager } from "../safety/safety-manager.js";
import { createAdaptationOperation } from "./adaptation.js";
import { createCodingOperation } from "./coding.js";
import { createDtcClearOperation } from "./dtc-clear.js";
import { WritePort } from "./port.js";

export interface StandardWritePortOptions {
  safety: SafetyManager;
  /** The same scanner the read path uses — one bound vehicle, not a second opinion. */
  scanner: DtcScanner;
  logger?: Logger;
  clock?: () => number;
  historySize?: number;
  /** Whether to register advanced write operations (coding, adaptation). Default true. */
  includeAdvancedOperations?: boolean;
}

export function createWritePort(options: StandardWritePortOptions): WritePort {
  const port = new WritePort({
    safety: options.safety,
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
    ...(options.historySize !== undefined ? { historySize: options.historySize } : {}),
  });
  port.register(createDtcClearOperation({ scanner: options.scanner }));
  if (options.includeAdvancedOperations ?? true) {
    port.register(
      createCodingOperation({
        ...(options.logger !== undefined ? { logger: options.logger } : {}),
      }),
    );
    port.register(
      createAdaptationOperation({
        ...(options.logger !== undefined ? { logger: options.logger } : {}),
      }),
    );
  }
  return port;
}
