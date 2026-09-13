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
import { type OemDtcInterpretation, OemProtocolRegistry } from "@vdp/protocols-oem";
import { type Logger, createId, createLogger, toHex } from "@vdp/shared";
import type { ClearDtcOptions, ClearDtcResult } from "../dtc/clear.js";
import type { FreezeFrame } from "../dtc/freeze-frame.js";
import type { DtcVehicleContext, EnrichedDtc } from "../dtc/scanner.js";
import { type DecodedSignal, SignalDecoder } from "../measurements/decoder.js";
import type { LiveDataEngine } from "../measurements/live.js";
import { MeasurementRecorder } from "../measurements/recorder.js";
import { SafetyManager } from "../safety/safety-manager.js";
import type { EcuSession, VehicleSession } from "../session/session.js";
import type { VehicleIdentity } from "../vehicle/identity.js";
import { deriveTxId } from "./discovery.js";
import type { EcuTarget } from "./ecu-links.js";
import type { EcuHandle } from "./ecu-registry.js";
import { DiagnosticContext } from "./engine-context.js";
import type { DiagnosticEngineOptions } from "./engine-options.js";
import type { ConnectDiscoveryOptions, ConnectResult } from "./session-opener.js";

// Types of the collaborators, re-exported so callers (runtime, DoIP tests,
// tooling) keep one import path.
export type { OpenedEcuLink, EcuLinkFactory, EcuTarget } from "./ecu-links.js";
export type { EcuHandle } from "./ecu-registry.js";
export type { ConnectResult, ConnectDiscoveryOptions } from "./session-opener.js";
export type { ScannedEcu } from "./dtc-access.js";
export type { DiagnosticEngineOptions } from "./engine-options.js";
export type { DiscoveredEcu } from "./discovery.js";

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
      safety: this.safety,
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

  /** Attach one ECU by address — the entry point for DoIP/ethernet (AGENTS 5, 36). */
  attach(target: EcuTarget & { definitionEcuId?: string }): Promise<EcuHandle> {
    return this.context.attacher.attachExplicit(target);
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

  // --- Fault memory (dtc-access.ts, dtc/clear.ts) --------------------------

  /** Read DTCs from every reachable ECU (AGENTS 20 "Scan all ECUs"). */
  async scanDtcs(
    statusMask = 0xff,
  ): Promise<
    Array<{ ecu: EcuSession; dtcs: EnrichedDtc[]; interpretations: OemDtcInterpretation[] }>
  > {
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

  /** Pre-check a planned clear without writing anything — drives the UI (AGENTS 26). */
  evaluateDtcClear(
    rxId: number,
    options: Pick<ClearDtcOptions, "userConfirmed" | "vehicleState">,
  ): { ok: boolean; failed: string[]; warnings: string[] } {
    return this.context.dtc.evaluate(
      this.context.registry.require(rxId),
      options,
      this.activePackage?.version,
    );
  }

  /**
   * Clear one ECU's fault memory (AGENTS 20). Needs explicit confirmation and a
   * passing safety check; the previous state becomes a session snapshot, so the
   * result stays comparable and auditable (AGENTS 25/26).
   */
  async clearDtcs(rxId: number, options: ClearDtcOptions): Promise<ClearDtcResult> {
    // Named binding: the conditional spread below needs the narrowed value.
    const definitionVersion = options.definitionVersion ?? this.activePackage?.version;
    return this.context.dtc.clear(this.context.registry.require(rxId), options, {
      session: this.session,
      ...(definitionVersion !== undefined ? { definitionVersion } : {}),
    });
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
