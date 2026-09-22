/**
 * Fault-memory access of the diagnostic engine (AGENTS 20, 26).
 *
 * Reading a fault memory is not just `readDtcs`: the records are enriched with
 * definition knowledge, manufacturer hints are attached next to them, every code
 * becomes a marker on the time axis, and a full scan is snapshotted so the next
 * scan can say what is new.
 *
 * This is the **read** side of fault memory, and only the read side. Reading and
 * clearing used to sit in one place, which is why the read path carried write
 * methods (master backlog P0 #3). Clearing now lives under the write port
 * (`../writes/dtc-clear.ts`), where its stages, its permit and its reasons are
 * recorded; nothing in this file can change the vehicle.
 */

import type { OemDtcInterpretation, OemProtocolRegistry } from "@vdp/protocols-oem";
import type { Logger } from "@vdp/shared";
import { messageOf } from "@vdp/shared";
import type { FreezeFrame } from "../dtc/freeze-frame.js";
import type { DtcScanner, EnrichedDtc } from "../dtc/scanner.js";
import type { MeasurementRecorder } from "../measurements/recorder.js";
import type { EcuSession, VehicleSession } from "../session/session.js";
import { type EcuHandle, EcuRegistry } from "./ecu-registry.js";

/** One ECU's scan result, including what the manufacturer hooks added. */
export interface ScannedEcu {
  ecu: EcuSession;
  dtcs: EnrichedDtc[];
  interpretations: OemDtcInterpretation[];
}

/**
 * One ECU whose fault memory this scan could **not** read (ADR 0049).
 *
 * A scan that keeps going after a failure is right — one dead module must not
 * hide the other four. But "I could not ask this module" is a fact about the
 * vehicle, and dropping it turns an empty fault list into a claim that no fault
 * is stored (ADR 0033: missing evidence is a failure, not a warning). So the
 * failure travels with the result as data, named by the address an operator can
 * look up, with the reason the bus gave.
 */
export interface UnreadEcu {
  ecuId: string;
  ecuName: string;
  rxId: number;
  /** What the read threw, verbatim — the timeout or NRC is the evidence. */
  reason: string;
}

/**
 * The whole answer of a full scan: the fault memories that were read, and the
 * modules that did not answer. Both halves are results; neither is an exception.
 */
export interface DtcScanReport {
  scanned: ScannedEcu[];
  unread: UnreadEcu[];
}

export interface DtcAccessOptions {
  registry: EcuRegistry;
  scanner: DtcScanner;
  oemProtocols: OemProtocolRegistry;
  recorder: MeasurementRecorder;
  logger: Logger;
}

export class DtcAccess {
  private readonly registry: EcuRegistry;
  private readonly scanner: DtcScanner;
  private readonly oemProtocols: OemProtocolRegistry;
  private readonly recorder: MeasurementRecorder;
  private readonly log: Logger;

  constructor(options: DtcAccessOptions) {
    this.registry = options.registry;
    this.scanner = options.scanner;
    this.oemProtocols = options.oemProtocols;
    this.recorder = options.recorder;
    this.log = options.logger;
  }

  /**
   * Read the fault memory of exactly one ECU — same enrichment and marker path
   * as {@link scanAll}, for single-ECU reads from the runtime layer.
   *
   * No session snapshot is recorded here: partial scans must not replace the
   * "last full scan" that reports and summaries are based on (AGENTS 20).
   */
  async scanOne(
    handle: EcuHandle,
    statusMask = 0xff,
  ): Promise<{ ecu: EcuSession; dtcs: EnrichedDtc[] }> {
    const dtcs = await this.enrich(handle, statusMask);
    this.mark(handle.session.record.name, dtcs);
    return { ecu: handle.session.record, dtcs };
  }

  /**
   * Read DTCs from every attached ECU (AGENTS 20 "Scan all ECUs").
   *
   * `activeOem` is the manufacturer of the package that drives this session —
   * the OEM hooks are consulted under that name, never under the name of a
   * package that merely happens to be installed too.
   *
   * A module that does not answer is **not** dropped: it comes back in
   * {@link DtcScanReport.unread}, so an empty code list can always be told apart
   * from "nobody answered" (ADR 0049). The scan still continues — one dead
   * module must not hide the fault memories of the others.
   */
  async scanAll(
    session: VehicleSession,
    activeOem?: string,
    statusMask = 0xff,
  ): Promise<DtcScanReport> {
    const results: ScannedEcu[] = [];
    const unread: UnreadEcu[] = [];
    for (const handle of this.registry.all) {
      try {
        // Enrichment (description, severity, first/last seen, related signals)
        // happens once per scan and per ECU, so the tracker sees one scan of one
        // ECU at a time and cannot mistake a response order for a history.
        const dtcs = await this.enrich(handle, statusMask);
        // Manufacturer hints are attached next to the codes, never merged into
        // them: a hint is interpretation, the code is the measured fact.
        const interpretations = dtcs
          .map((dtc) => this.oemProtocols.interpretDtc(activeOem, dtc.code))
          .filter(
            (interpretation): interpretation is OemDtcInterpretation =>
              interpretation !== undefined,
          );
        results.push({ ecu: handle.session.record, dtcs, interpretations });
        // One marker per fault code, not one per ECU: the time axis should show
        // *which* fault appeared, and a code is what the operator filters by.
        this.mark(handle.session.record.name, dtcs);
      } catch (error) {
        const reason = messageOf(error);
        this.log.warn("DTC scan failed for ECU", {
          ecu: handle.session.record.name,
          error: reason,
        });
        unread.push({
          ecuId: handle.session.record.id,
          ecuName: handle.session.record.name,
          rxId: handle.discovered.rxId,
          reason,
        });
      }
    }
    const all = results.flatMap((r) => r.dtcs);
    if (all.length > 0) session.addDtcSnapshot(all, "scan");
    this.log.info("DTC scan complete", {
      ecus: results.length,
      codes: all.length,
      unread: unread.length,
    });
    return { scanned: results, unread };
  }

  /** Freeze frame of one fault code, or `null` when the ECU has none. */
  async snapshot(
    handle: EcuHandle,
    code: string,
    recordNumber = 0xff,
  ): Promise<FreezeFrame | null> {
    return handle.session.readDtcSnapshot(code, recordNumber);
  }

  /** Enrich the records of one ECU with definition and variant knowledge. */
  private async enrich(handle: EcuHandle, statusMask: number): Promise<EnrichedDtc[]> {
    const records = await handle.session.readDtcs(statusMask);
    return this.scanner.enrich(
      records,
      handle.session.record.name,
      handle.session.record.id,
      EcuRegistry.definitionRefOf(handle),
    );
  }

  /** One marker per fault code (AGENTS 16 "DTC-Marker auf Zeitachse", AGENTS 20). */
  private mark(ecuName: string, dtcs: readonly EnrichedDtc[]): void {
    for (const dtc of dtcs) {
      const status = `0x${dtc.status.toString(16).toUpperCase().padStart(2, "0")}`;
      this.recorder.addMarker(dtc.code, "dtc", `${ecuName} · Status ${status}`);
    }
  }
}
