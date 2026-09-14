/**
 * The write port with the operations the platform ships today (AGENTS 25/26).
 *
 * A named composition instead of an anonymous `new WritePort(...)` in the
 * runtime and in every test: the set of writable operations is a product
 * decision, so it has one place. Adding an operation here (coding, adaptation,
 * routine — master backlog P2) is a deliberate act, not a side effect of a
 * constructor call somewhere.
 *
 * Today that set is exactly one operation: clearing fault memory. Every other
 * kind in the domain's risk table is still unwritten on purpose — an operation
 * that is not registered cannot be executed by accident.
 */

import type { Logger } from "@vdp/shared";
import type { DtcScanner } from "../dtc/scanner.js";
import type { SafetyManager } from "../safety/safety-manager.js";
import { createDtcClearOperation } from "./dtc-clear.js";
import { WritePort } from "./port.js";

export interface StandardWritePortOptions {
  safety: SafetyManager;
  /** The same scanner the read path uses — one bound vehicle, not a second opinion. */
  scanner: DtcScanner;
  logger?: Logger;
  clock?: () => number;
  historySize?: number;
}

export function createWritePort(options: StandardWritePortOptions): WritePort {
  const port = new WritePort({
    safety: options.safety,
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
    ...(options.historySize !== undefined ? { historySize: options.historySize } : {}),
  });
  port.register(createDtcClearOperation({ scanner: options.scanner }));
  return port;
}
