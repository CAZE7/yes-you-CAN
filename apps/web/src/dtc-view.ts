/**
 * The fault list as the operator reads it (AGENTS 13, 20, 24).
 *
 * Split out of `backend.ts` on the line `vehicle-view.ts` and `dtc-knowledge-view.ts`
 * already established (0.E E15): a projection that is data-in / data-out belongs where
 * it is testable without a runtime, and `backend.ts` stays a wiring file. No behaviour
 * changes — the one structural difference is that the row takes the ECU list as a
 * parameter instead of reaching into `this.ecus`.
 *
 * Two honesty rules travel with the row and are named here because this is where they
 * are enforced: an undocumented code shows the raw failure type instead of an invented
 * description (AGENTS 24), and variant knowledge is attached only when the scan of the
 * resolved vehicle produced it (AGENTS 20.1) — never borrowed from the package.
 */

import type { DtcInfo } from "@vdp/domain";
import { type DtcKnowledgeView, toDtcKnowledgeView } from "./dtc-knowledge-view.js";

export interface DtcView {
  code: string;
  raw: string;
  /** Response id of the ECU that reported the code, so the UI can address it. */
  rxId: string;
  /** Description from the definition package, or the raw protocol fallback. */
  description: string;
  severity: string;
  ecu: string;
  status: string;
  confirmed: boolean;
  pending: boolean;
  testFailed: boolean;
  /** Next diagnostic step from the definition package, when one is documented. */
  hint?: string;
  /** First scan in this session that saw the code (AGENTS 20). */
  firstSeen?: string;
  /** Most recent scan that saw the code (AGENTS 20). */
  lastSeen?: string;
  /** True when the code appeared for the first time in the latest scan. */
  isNew?: boolean;
  /** Signals the definition package relates to this code (AGENTS 20). */
  relatedSignals?: Array<{ id: string; name: string }>;
  /**
   * Whether reading a freeze frame for this code is meaningful: the ECU returned
   * a snapshot record before, or the definition documents a layout.
   */
  freezeFrame?: boolean;
  /** Provenance of the description — never present invented knowledge (AGENTS 24). */
  provenance?: string;
  /**
   * What the resolved vehicle's variant knowledge adds to this code (AGENTS 20,
   * 23): the scope that says where the wording came from, the documented failure
   * patterns with their measurement checks, and what is missing or assumed.
   * Absent when no vehicle is resolved or nothing is documented — the UI then
   * shows the manufacturer-wide wording and says that it does.
   */
  knowledge?: DtcKnowledgeView;
}

/**
 * One row of the fault list: the runtime read model plus the ECU row that answers
 * on the same address, so a row can name the response id instead of an internal id.
 */
export function toDtcView(info: DtcInfo, ecus: readonly { id: string; rxId: string }[]): DtcView {
  const ecu = ecus.find((view) => view.id === info.ecuId);
  return {
    code: info.code,
    raw: info.raw,
    rxId: ecu?.rxId ?? info.ecuId,
    // A code without a definition stays honest: the raw failure type is shown
    // instead of an invented description (AGENTS 24).
    description: info.description ?? `Fehlertyp 0x${info.failureType}`,
    severity: info.severity ?? "info",
    ...(info.hint ? { hint: info.hint } : {}),
    ecu: info.ecuName,
    status: `0x${info.status.toString(16).toUpperCase().padStart(2, "0")}`,
    confirmed: info.confirmed,
    pending: info.pending,
    testFailed: info.testFailed,
    ...(info.firstSeen ? { firstSeen: info.firstSeen } : {}),
    ...(info.lastSeen ? { lastSeen: info.lastSeen } : {}),
    ...(info.firstSeenInThisScan ? { isNew: true } : {}),
    ...(info.relatedSignals ? { relatedSignals: [...info.relatedSignals] } : {}),
    ...(info.knowledge ? { knowledge: toDtcKnowledgeView(info.knowledge) } : {}),
    freezeFrame: info.hasFreezeFrame,
  };
}
