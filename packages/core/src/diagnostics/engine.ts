/**
 * Diagnostic Engine (AGENTS 2, 9, 10, 12, 36).
 *
 * The single place that ties a transport, a definition package, the UDS layer,
 * the measurement engine and the session together. It knows nothing about the UI
 * and nothing about which transport sits below it — that is what keeps DoIP a
 * drop-in later (AGENTS 5).
 *
 * The class is deliberately a *façade* (ADR 0014 phase 4): it owns the session
 * reference and the collaborators and delegates. The work lives next to it, one
 * responsibility per module:
 *
 * - {@link EcuLinks}          — the transport seam (CAN/ISO-TP, DoIP, future buses)
 * - {@link EcuAttacher}       — from a discovered address to a usable ECU session
 * - {@link SessionOpener}     — bringing a session up, and the failure policy
 * - {@link DtcAccess}         — fault memory: read, enrich, mark, clear
 * - {@link MeasurementAccess} — signal plan, snapshots, live data
 * - {@link EcuRegistry}       — which handle belongs to which address
 * - {@link DiagnosticContext} — builds them, so this file stays a façade
 *
 * Every method below delegates; the sections name the module that does the work
 * and the collaborator's doc comment explains *how*. This surface is what the
 * runtime, the replay tooling and the integration tests use — a refactor that
 * forced them to change would have been a rewrite, not a refactor.
 */

import type { DefinitionPackage, SignalDefinition } from "@vdp/definitions";
import { OemProtocolRegistry } from "@vdp/protocols-oem";
import { createId, createLogger, type Logger, toHex } from "@vdp/shared";
import type { FreezeFrame } from "../dtc/freeze-frame.js";
import type { DtcScanner, DtcVehicleContext, EnrichedDtc } from "../dtc/scanner.js";
import { type DecodedSignal, SignalDecoder } from "../measurements/decoder.js";
import type { LiveDataEngine } from "../measurements/live.js";
import { MeasurementRecorder } from "../measurements/recorder.js";
import { SafetyManager } from "../safety/safety-manager.js";
import { createSession, type EcuSession, VehicleSession } from "../session/session.js";
import type { VehicleIdentity } from "../vehicle/identity.js";
import { deriveTxId } from "./discovery.js";
import type { DtcScanReport } from "./dtc-access.js";
import type { EcuTarget } from "./ecu-links.js";
import type { EcuHandle } from "./ecu-registry.js";
import { DiagnosticContext } from "./engine-context.js";
import type { DiagnosticEngineOptions } from "./engine-options.js";
import type { ConnectDiscoveryOptions, ConnectResult } from "./session-opener.js";

export type { DiscoveredEcu } from "./discovery.js";
export type { DtcScanReport, ScannedEcu, UnreadEcu } from "./dtc-access.js";
// Types of the collaborators, re-exported so callers (runtime, DoIP tests,
// tooling) keep one import path.
export type { EcuLinkFactory, EcuTarget, OpenedEcuLink } from "./ecu-links.js";
export type { EcuHandle } from "./ecu-registry.js";
export type { DiagnosticEngineOptions } from "./engine-options.js";
export type { ConnectDiscoveryOptions, ConnectResult } from "./session-opener.js";

export class DiagnosticEngine {
  readonly recorder: MeasurementRecorder;
  readonly decoder: SignalDecoder;
  readonly oemProtocols: OemProtocolRegistry;
  readonly safety: SafetyManager;

  private readonly log: Logger;
  private readonly context: DiagnosticContext;
  private session: VehicleSession | null = null;

  constructor(private readonly options: DiagnosticEngineOptions) {
    this.log = (options.logger ?? createLogger("uds", { level: "INFO" })).child("uds");
    this.recorder = new MeasurementRecorder(options.clock);
    this.decoder = new SignalDecoder({ logger: this.log });
    this.oemProtocols = new OemProtocolRegistry(options.oemProtocols ?? []);
    this.safety = options.safety ?? new SafetyManager({ logger: this.log });
    this.context = new DiagnosticContext({
      options,
      logger: this.log,
      decoder: this.decoder,
      oemProtocols: this.oemProtocols,
      recorder: this.recorder,
    });
  }

  // --- Session lifecycle (session-opener.ts) -------------------------------
  // connect() attaches every responder, including the ones that fail to answer:
  // an ECU that does not come up must stay visible in the session (AGENTS 12).

  /** Open the session: discover ECUs, attach the responders, read VIN (AGENTS 11). */
  async connect(discoveryOptions: ConnectDiscoveryOptions = {}): Promise<ConnectResult> {
    const result = await this.context.opener.open(discoveryOptions);
    this.session = result.session;
    return result;
  }

  /**
   * Attach one ECU by address — the entry point for DoIP/ethernet (AGENTS 5, 36).
   *
   * When nothing is connected yet and the transport seam can describe itself
   * (DoIP does, see {@link EcuLinkFactory.describe}), this opens the session
   * record the rest of the platform hangs off: the diagnostic IR, the evidence
   * set, the report and the recording all need a session, and an explicitly
   * attached ECU used to produce a handle without one — which made the DoIP path
   * end at the handle (master prompt P2, ADR 0061). A factory that cannot
   * describe its transport keeps the old behaviour: the raw session record is
   * absent rather than invented.
   */
  async attach(target: EcuTarget & { definitionEcuId?: string }): Promise<EcuHandle> {
    const handle = await this.context.attacher.attachExplicit(target);
    if (this.session === null) {
      const described = this.context.links.describeTransport();
      if (described === undefined) {
        this.log.debug("attach without a session record", {
          rxId: `0x${target.rxId.toString(16)}`,
          reason: "the link factory does not describe its transport",
        });
        return handle;
      }
      const activePackage = this.definitions[0];
      this.session = new VehicleSession(
        createSession({
          adapter: described.adapter,
          transport: described.transport,
          ...(activePackage
            ? { definitionPackage: { oem: activePackage.oem, version: activePackage.version } }
            : {}),
          ...(this.options.platformVersion !== undefined
            ? { platformVersion: this.options.platformVersion }
            : {}),
          ...(this.options.clock ? { clock: this.options.clock } : {}),
        }),
      );
      this.log.info("session opened by an explicit attach", {
        transport: described.transport.kind,
        channel: described.transport.channel,
      });
    }
    this.session.upsertEcu(handle.session.record);
    return handle;
  }

  async disconnect(): Promise<void> {
    this.stopLiveData();
    // The next connection may be another car: resolved knowledge must not
    // survive the session it was resolved for (AGENTS 11).
    this.context.scanner.setVehicle(undefined);
    const session = this.session;
    await this.context.opener.close(session);
    this.log.info("session closed", { session: session?.id });
  }

  get vehicleSession(): VehicleSession | null {
    return this.session;
  }

  // --- Provenance (definitions) -------------------------------------------

  get definitions(): readonly DefinitionPackage[] {
    return this.options.definitions ?? [];
  }

  /** Definition package driving this session — recorded in every report. */
  get activePackage(): DefinitionPackage | undefined {
    return this.definitions[0];
  }

  /**
   * Fault-memory enrichment of this session — read-only, and shared with the
   * write port on purpose (the same bound vehicle, not a second opinion).
   */
  get scanner(): DtcScanner {
    return this.context.scanner;
  }

  // --- Vehicle binding (DtcScanner) ---------------------------------------

  /** Bind the resolved vehicle so scanned codes are enriched (AGENTS 11 → 20). */
  setVehicleContext(context: DtcVehicleContext | undefined): void {
    this.context.scanner.setVehicle(context);
  }

  get vehicleContext(): DtcVehicleContext | undefined {
    return this.context.scanner.vehicleContext;
  }

  /** Read the VIN from the first ECU that answers DID 0xF190 (AGENTS 11). */
  async detectVehicleIdentity(): Promise<VehicleIdentity | undefined> {
    if (!this.session) return undefined;
    return this.context.attacher.detectVehicleIdentity(this.session);
  }

  // --- Fault memory, read-only (dtc-access.ts) -----------------------------
  // Writing is *not* here: fault memory is cleared through the write port
  // (`@vdp/core` → `writes/`), which owns the staged flow, the permit and the
  // audit trail (master backlog P0 #3). A read path that can write is a read
  // path nobody can hand to a viewer, a report or an AI without dread.

  /** Read DTCs from every reachable ECU (AGENTS 20 "Scan all ECUs"). */
  async scanDtcs(statusMask = 0xff): Promise<DtcScanReport> {
    const session = this.requireSession();
    return this.context.dtc.scanAll(session, this.activePackage?.oem, statusMask);
  }

  /** Read one ECU's fault memory — same enrichment, no session snapshot. */
  async scanEcu(
    rxId: number,
    statusMask = 0xff,
  ): Promise<{ ecu: EcuSession; dtcs: EnrichedDtc[] }> {
    return this.context.dtc.scanOne(this.context.registry.require(rxId), statusMask);
  }

  /** Freeze frame of one code, or `null` when the ECU has none (AGENTS 20). */
  async readDtcSnapshot(
    rxId: number,
    code: string,
    recordNumber = 0xff,
  ): Promise<FreezeFrame | null> {
    return this.context.dtc.snapshot(this.context.registry.require(rxId), code, recordNumber);
  }

  // --- Measurements (measurement-access.ts) --------------------------------

  /** Read defined signals once; the filter limits which DIDs are asked (AGENTS 12). */
  async snapshotSignals(signalIds?: readonly string[]): Promise<DecodedSignal[]> {
    return this.context.measurements.snapshot(this.session, signalIds);
  }

  /** Start live data acquisition across all ECUs (AGENTS 15). */
  async startLiveData(
    options: { signalIds?: readonly string[]; intervalMs?: number; maxRounds?: number } = {},
  ): Promise<LiveDataEngine> {
    return this.context.measurements.startLive(this.requireSession(), options);
  }

  stopLiveData(): void {
    this.context.measurements.stopLive();
  }

  /** ecuSessionId → signals to poll, honouring an optional signal filter. */
  buildPlan(signalIds?: readonly string[]): Map<string, readonly SignalDefinition[]> {
    return this.context.measurements.buildPlan(signalIds);
  }

  /** Resolve a signal definition across all packages. */
  findSignal(signalId: string): SignalDefinition | undefined {
    return this.context.measurements.findSignal(signalId);
  }

  // --- ECU access (ecu-registry.ts) ---------------------------------------

  get ecuHandles(): readonly EcuHandle[] {
    return this.context.registry.all;
  }

  /** ECU handle by response identifier — used by the UI and the replay tooling. */
  handleFor(rxId: number): EcuHandle | undefined {
    return this.context.registry.byResponseId(rxId);
  }

  /** ECU handle by physical request identifier. */
  handleForTxId(txId: number): EcuHandle | undefined {
    return this.context.registry.byRequestId(txId);
  }

  // --- Helpers -------------------------------------------------------------

  /** Session or the error every session-bound operation reports (AGENTS 2). */
  private requireSession(): VehicleSession {
    if (!this.session) throw new Error("no session — call connect() first");
    return this.session;
  }

  /** Convenience for tooling: derive the request id for a response id. */
  static deriveTxId(rxId: number, extended = false): number {
    return deriveTxId(rxId, extended);
  }

  /** Stable id helper for session/trace correlation. */
  static newTraceId(): string {
    return createId("trace");
  }

  /** Hex helper so callers do not need to import shared directly. */
  static hex(data: Uint8Array): string {
    return toHex(data);
  }
}
