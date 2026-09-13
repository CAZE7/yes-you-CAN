/**
 * ECU handle registry of the diagnostic engine (AGENTS 5, 36).
 *
 * The engine talks to an ECU through a {@link EcuHandle}: the diagnostic session
 * that speaks UDS to it, the reader the measurement engine polls, and the
 * discovery record that says where it was found. Which handle belongs to which
 * address is bookkeeping — and it lives here instead of inside the engine,
 * because it is the one thing every other part of the engine needs and the one
 * thing that has no I/O.
 */

import type { DtcDefinitionRef } from "../dtc/scanner.js";
import type { EcuReader } from "../measurements/live.js";
import type { DiscoveredEcu } from "./discovery.js";
import type { EcuDiagnosticSession } from "./ecu-session.js";

/** Everything the engine needs to work with one ECU (AGENTS 36). */
export interface EcuHandle {
  /** UDS session with identification, services and fault memory. */
  session: EcuDiagnosticSession;
  /** Reader the live-data engine polls (a narrow view of the session). */
  reader: EcuReader;
  /** Discovery record: addresses, definition link, how it was found. */
  discovered: DiscoveredEcu;
}

export class EcuRegistry {
  /** ECU handles by response identifier — the key every UDS operation uses. */
  private readonly byRxId = new Map<number, EcuHandle>();

  /**
   * Secondary index by request identifier.
   *
   * Traffic in the raw trace and on a functional bus is keyed by the id the
   * *tester* addressed, so {@link byTxId} is on the hot path of the replay and
   * trace tooling. Walking the values there is a linear scan per frame; one extra
   * map keeps it O(1) and stays in step because both are only written by
   * {@link add} and cleared together.
   */
  private readonly byTxId = new Map<number, EcuHandle>();

  add(handle: EcuHandle): void {
    this.byRxId.set(handle.discovered.rxId, handle);
    this.byTxId.set(handle.discovered.txId, handle);
  }

  clear(): void {
    this.byRxId.clear();
    this.byTxId.clear();
  }

  get all(): readonly EcuHandle[] {
    return Array.from(this.byRxId.values());
  }

  get size(): number {
    return this.byRxId.size;
  }

  /** Handle by response identifier, when the ECU was attached. */
  byResponseId(rxId: number): EcuHandle | undefined {
    return this.byRxId.get(rxId);
  }

  /** Handle by physical request identifier. */
  byRequestId(txId: number): EcuHandle | undefined {
    return this.byTxId.get(txId);
  }

  /** Handle or a clear error — used by every read/write helper. */
  require(rxId: number): EcuHandle {
    const handle = this.byRxId.get(rxId);
    if (!handle)
      throw new Error(`no ECU session for 0x${rxId.toString(16)} — call connect() first`);
    return handle;
  }

  /**
   * The definition ECU a handle belongs to, split from its `"<oem>:<id>"` form.
   *
   * Discovery stores the qualified id so a package from another manufacturer
   * cannot be matched by accident; the DTC knowledge lookup wants the two parts
   * separately. Absent stays absent — a plain CAN scan finds ECUs without any
   * definition, and that is not an error.
   */
  static definitionRefOf(handle: EcuHandle): DtcDefinitionRef | undefined {
    const value = handle.discovered.definitionEcuId;
    if (!value) return undefined;
    const separator = value.indexOf(":");
    return separator < 0
      ? { ecu: value }
      : { oem: value.slice(0, separator), ecu: value.slice(separator + 1) };
  }
}
