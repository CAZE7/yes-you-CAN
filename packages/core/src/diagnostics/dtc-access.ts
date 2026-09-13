/**
 * Fault-memory access of the diagnostic engine (AGENTS 20, 26).
 *
 * Reading a fault memory is not just `readDtcs`: the records are enriched with
 * definition knowledge, manufacturer hints are attached next to them, every code
 * becomes a marker on the time axis, and a full scan is snapshotted so the next
 * scan can say what is new. Clearing is the only write path so far and runs
 * through the safety layer.
 *
 * This is one responsibility — *fault memory in, results out* — and it lives
 * here so the engine stays a façade and the clear service (which owns the
 * preconditions) never has to be reached around.
 */

import type { OemDtcInterpretation, OemProtocolRegistry } from "@vdp/protocols-oem";
import type { Logger } from "@vdp/shared";
import { messageOf } from "@vdp/shared";
import type {
  ClearDtcOptions,
  ClearDtcResult,
  ClearableEcu,
  DtcClearService,
} from "../dtc/clear.js";
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

export interface DtcAccessOptions {
  registry: EcuRegistry;
  scanner: DtcScanner;
  clear: DtcClearService;
  oemProtocols: OemProtocolRegistry;
  recorder: MeasurementRecorder;
  logger: Logger;
}

export class DtcAccess {
  private readonly registry: EcuRegistry;
  private readonly scanner: DtcScanner;
  private readonly clearService: DtcClearService;
  private readonly oemProtocols: OemProtocolRegistry;
  private readonly recorder: MeasurementRecorder;
  private readonly log: Logger;

  constructor(options: DtcAccessOptions) {
    this.registry = options.registry;
    this.scanner = options.scanner;
    this.clearService = options.clear;
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
   */
  async scanAll(
    session: VehicleSession,
    activeOem?: string,
    statusMask = 0xff,
  ): Promise<ScannedEcu[]> {
    const results: ScannedEcu[] = [];
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
        this.log.warn("DTC scan failed for ECU", {
          ecu: handle.session.record.name,
          error: messageOf(error),
        });
      }
    }
    const all = results.flatMap((r) => r.dtcs);
    if (all.length > 0) session.addDtcSnapshot(all, "scan");
    this.log.info("DTC scan complete", { ecus: results.length, codes: all.length });
    return results;
  }

  /**
   * Pre-check a planned clear without writing anything (AGENTS 26).
   * The UI uses it to show which precondition is missing before the operator
   * confirms.
   */
  evaluate(
    handle: EcuHandle,
    options: Pick<ClearDtcOptions, "userConfirmed" | "vehicleState">,
    definitionVersion?: string,
  ): { ok: boolean; failed: string[]; warnings: string[] } {
    return this.clearService.evaluate(this.clearable(handle), {
      ...options,
      ...(definitionVersion ? { definitionVersion } : {}),
    });
  }

  /**
   * Clear the fault memory of one ECU (AGENTS 20).
   *
   * Requires an explicit confirmation and a passing safety check; the previous
   * state is stored as a session snapshot so the result can be compared and, if
   * necessary, audited later (AGENTS 25/26).
   */
  async clear(
    handle: EcuHandle,
    options: ClearDtcOptions,
    hooks: { session: VehicleSession | null; definitionVersion?: string },
  ): Promise<ClearDtcResult> {
    const session = hooks.session;
    return this.clearService.clear(this.clearable(handle), {
      ...options,
      ...(hooks.definitionVersion !== undefined
        ? { definitionVersion: hooks.definitionVersion }
        : {}),
      recordSnapshot: (records, label) => {
        session?.addDtcSnapshot([...records], label);
      },
      recordAction: (action) => {
        session?.recordAction(action);
      },
    });
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

  /**
   * Adapt an ECU session to the write contract of the clear service.
   *
   * One place, so the pre-check and the actual clear can never drift apart — a
   * pre-check that validates different conditions than the write is worse than
   * no pre-check at all (AGENTS 26).
   */
  private clearable(handle: EcuHandle): ClearableEcu {
    const { session } = handle;
    return {
      id: session.record.id,
      name: session.record.name,
      sessionType: session.record.sessionType,
      readDtcs: (mask) => session.readDtcs(mask),
      clearDiagnosticInformation: (group) => session.clearDiagnosticInformation(group),
      prepareWrite: () => session.ensureWritableSession(),
    };
  }
}
