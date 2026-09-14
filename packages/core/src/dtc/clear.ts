/**
 * The contract of a *clearable* ECU and the result of a clear (AGENTS 20, 25).
 *
 * This module used to hold `DtcClearService`, the first write path of the
 * platform. That flow now runs as a staged write operation under the write port
 * (`../writes/dtc-clear.ts`) — master backlog P0 #3 moved writes out of the read
 * path, P0 #4 turned the flow into stages whose results carry reasons.
 *
 * What stays here is what both sides share: what the write needs from an ECU
 * (`ClearableEcu`) and what a finished clear looks like (`ClearDtcResult`) —
 * including the stages it went through, so a caller can explain *why* a clear
 * did not happen instead of reporting a bare failure. What the caller *asks for*
 * is the operation's own input type (`../writes/dtc-clear.ts`), together with the
 * binding that says which ECU, session and definition version it applies to.
 */

import type { DtcRecord } from "@vdp/protocols-uds";
import type { WritePermit } from "../safety/safety-manager.js";
import type { StageReport } from "../writes/transaction.js";
import type { DtcComparison, EnrichedDtc } from "./scanner.js";

/** Minimal ECU contract the write needs — unit testable without a bus. */
export interface ClearableEcu {
  id: string;
  name: string;
  /** Active diagnostic session type; a clear in the default session is refused (AGENTS 26). */
  sessionType: number;
  /**
   * Put the ECU into a session that allows writes (ISO 14229-1 §9.2).
   *
   * Optional: an ECU without it can only be written while it already is in a
   * non-default session, which is the fail-safe behaviour for implementations
   * that must not switch sessions on their own.
   */
  prepareWrite?: (sessionType?: number) => Promise<{ sessionType: number; switched: boolean }>;
  readDtcs(statusMask?: number): Promise<DtcRecord[]>;
  clearDiagnosticInformation(groupOfDtc?: number): Promise<void>;
}

export interface ClearDtcResult {
  cleared: boolean;
  ecuId: string;
  ecuName: string;
  /** Fault memory before the clear (also the backup). */
  before: EnrichedDtc[];
  /** Fault memory after the clear, read back from the ECU. */
  after: EnrichedDtc[];
  comparison: DtcComparison;
  /** True when the re-read confirms the codes are gone. */
  verified: boolean;
  permit: WritePermit;
  clearedAt: string;
  /**
   * Every stage of the write with its reasons (AGENTS 26 "jede Stufe ein
   * Ergebnis mit Gründen"). A caller that only reads `cleared` loses the *why*.
   */
  stages: readonly StageReport[];
  /** The transaction this clear ran in — the same id the audit log names. */
  transactionId: string;
}
