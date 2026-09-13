/**
 * Wire contract between the backend and the browser front end (AGENTS 16, 34.3).
 *
 * Every interface here describes a JSON shape that crosses the network: the
 * backend builds it (`backend.ts`), the front end renders it (`public/*.js`).
 * The two sides used to agree by convention only — the front end is plain
 * JavaScript, so a renamed field broke the UI at runtime and nothing caught it.
 *
 * The declarations live in their own module for two reasons:
 *
 * 1. This file is **node-free by construction**: it imports types only. The
 *    browser project (`tsconfig.frontend.json`) therefore checks
 *    `apps/web/public/*.js` against the very declarations the server fills in,
 *    so a field the server stops sending fails the frontend typecheck instead of
 *    rendering as `undefined`.
 * 2. `DemoBackend` needs `node:fs`, transports and repositories; the front end
 *    must never pull that chain into its program.
 *
 * `backend.ts` re-exports all of it, so existing imports keep working.
 */

import type { AdapterDescription, AdapterProbe, AdapterSelection } from "@vdp/adapter-host";
import type { AnalysisResult } from "@vdp/ai";
import type { DtcKnowledgeView } from "./dtc-knowledge-view.js";
import type { VehicleResolutionView } from "./vehicle-view.js";

// The view shapes nested inside the payloads above are part of the same
// contract, so they are re-exported from here — the front end imports every wire
// type from one module.
export type {
  AdapterConfig,
  AdapterDescription,
  AdapterProbe,
  AdapterSelection,
} from "@vdp/adapter-host";
export type { DtcCheckView, DtcKnowledgeView, DtcPatternView } from "./dtc-knowledge-view.js";
export type {
  VehicleCandidateView,
  VehicleEvidenceView,
  VehicleResolutionView,
} from "./vehicle-view.js";

export interface EcuView {
  id: string;
  name: string;
  txId: string;
  rxId: string;
  extended: boolean;
  reachable: boolean;
  identification: Array<{ label: string; value: string }>;
  services: string[];
  sessionType: number;
  p2Ms: number;
  dtcCount: number;
  lastError?: string;
}

/**
 * Freeze frame of a fault code, as shown in the UI (AGENTS 20).
 *
 * Decoded values and raw bytes both travel to the front end so an operator can
 * see that a value came from a byte range, not from a guess.
 */
export interface FreezeFrameView {
  code: string;
  recordNumber: number;
  documented: boolean;
  notes: string[];
  unassignedHex: string;
  fields: Array<{
    did: string;
    name: string;
    rawHex: string;
    values: Array<{
      signal: string;
      name: string;
      value: string;
      unit?: string;
      rawHex: string;
      outOfRange: boolean;
    }>;
  }>;
}

/**
 * Vehicle preconditions for a write, as asserted by the operator (AGENTS 26).
 *
 * They are asserted, not measured: the workbench cannot see whether the car is
 * stationary, so the operator confirms each one and the safety layer records who
 * asserted what. A value that a real adapter *can* measure (battery voltage via
 * ATRV) is passed through when it is known.
 */
export interface VehicleStateView {
  stationary: boolean;
  ignitionOn: boolean;
  parkingBrake?: boolean;
  batteryVoltage?: number;
}

/** Result of a cleared fault memory, including the before/after comparison. */
export interface DtcClearView {
  ecu: string;
  cleared: boolean;
  /** The re-read confirms that the clear took effect. */
  verified: boolean;
  before: string[];
  after: string[];
  /** Codes that are gone after the clear. */
  removed: string[];
  /** Codes that are still stored because the fault condition is still present. */
  stillFailing: string[];
  /** Codes whose status did not change at all — the ECU ignored the clear. */
  unchanged: string[];
  /**
   * Why the safety chain refused (only present when {@link cleared} is false):
   * a rejection is an answer with reasons, not an HTTP error (AGENTS 26,
   * ADR 0018).
   */
  reasons?: string[];
}

export interface DtcClearPrecheck {
  rxId: string;
  ecu: string;
  ok: boolean;
  failed: string[];
  /**
   * Reasons that are missing evidence rather than a violation — the operator
   * has to measure something, not repair something (AGENTS 26, P0 #5).
   */
  unproven: string[];
  warnings: string[];
}

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

export interface SampleView {
  signal: string;
  name: string;
  /** Formatted for display — the UI shows this string verbatim. */
  value: string;
  /**
   * Numeric value for the graphs, `null` for textual/enum signals.
   * Charts must never parse a formatted string back into a number: the decimal
   * separator and the precision belong to the presentation layer (AGENTS 14).
   */
  numeric: number | null;
  /** Undecoded value next to the decoded one (AGENTS 34.7). */
  rawValue: number | string | boolean;
  rawHex: string;
  unit?: string;
  outOfRange: boolean;
  t: number;
  timestamp: string;
}

/** Marker on the shared time axis (AGENTS 16 "Event-Marker", AGENTS 20 DTC events). */
export interface MarkerView {
  id: string;
  t: number;
  timestamp: string;
  label: string;
  kind: "dtc" | "action" | "note" | "user" | "anomaly";
  detail?: string;
}

export interface TraceView {
  t: number;
  timestamp: string;
  canId: string;
  direction: "tx" | "rx";
  dlc: number;
  data: string;
  channel: string;
  extended: boolean;
}

export interface HistoryView {
  /** Wall clock at recording start, so the UI can convert relative times. */
  startedAt: number;
  live: boolean;
  samples: SampleView[];
  markers: MarkerView[];
}

/**
 * Window statistics of one recorded signal as the UI consumes them
 * (AGENTS 16 "Min/Max/Durchschnitt/Delta"). Domain-shaped — the web app
 * stays free of core imports (storage/persistence seam, roadmap steps 10–13).
 */
export interface SignalStatisticsView {
  signal: string;
  name: string;
  unit?: string;
  samples: number;
  min: number | null;
  max: number | null;
  average: number | null;
  delta: number | null;
  first: number | null;
  last: number | null;
  outOfRangeCount: number;
}

/** A signal the definition package documents (id, label, unit, criticality). */
export interface SignalInfoView {
  id: string;
  name: string;
  unit?: string;
  critical: boolean;
}

/** A measurement that left the range its definition declares (AGENTS 14). */
export interface AnomalyView {
  signal: string;
  reason: string;
  value?: number;
}

/** One entry of the action log (reads and writes, in order). */
export interface ActionView {
  timestamp: string;
  kind: string;
  ecuId: string;
  description: string;
  result: string;
}

export interface AppState {
  connected: boolean;
  /** Which transport source is selected (AGENTS 4, 29, 32). */
  mode: BackendMode;
  sessionId: string;
  vin?: string;
  vehicle: string;
  /**
   * Last vehicle resolution (AGENTS 11) — the hypotheses with their evidence.
   * Absent until something was resolved; never a guess about the identity.
   */
  vehicleResolution?: VehicleResolutionView;
  mileageKm?: number;
  adapter: { id: string; name: string; kind: string; channels: string[] };
  /** Adapter the user selected, including its settings, so the UI can show them. */
  adapterSelection: AdapterSelection;
  /** Live probe result of the selected adapter (never a guess). */
  adapterProbe?: AdapterProbe;
  transport: { kind: string; channel: string; mtu: number };
  ecus: EcuView[];
  dtcs: DtcView[];
  samples: SampleView[];
  statistics: SignalStatisticsView[];
  trace: TraceView[];
  live: boolean;
  signals: SignalInfoView[];
  anomalies: AnomalyView[];
  actions: ActionView[];
}

/**
 * Events pushed to the UI over SSE. Every member here has an `emit()` call
 * site below; `'log'` was dropped because nothing ever sent or listened for
 * it (the `'log'` string elsewhere is a storage line kind, not an SSE event).
 */
export interface BackendEvent {
  /** 'marker' adds one event, 'markers' replaces the whole list (after a scan). */
  type:
    | "sample"
    | "trace"
    | "dtc"
    | "ecu"
    | "analysis"
    | "error"
    | "marker"
    | "markers"
    | "vehicle";
  payload: unknown;
}

/**
 * Where the CAN traffic comes from.
 *
 * `simulator` and `replay` are application-owned transports; `hardware` means a
 * real adapter builds the bus.
 */
export type BackendMode = "simulator" | "replay" | "hardware";

/* ---------------------------------------------- Adapter-Auswahl (AGENTS 4, 29) */

/**
 * Payload of `GET /api/adapters`: what the host found, without opening a bus.
 *
 * `selected` is the current selection (including its settings), `adapters` the
 * full catalog with its live probe result. The front end renders both; it never
 * decides which adapter is usable (AGENTS 5).
 */
export interface AdaptersView {
  selected: AdapterSelection;
  mode: BackendMode;
  adapters: AdapterDescription[];
}

/** Payload of `POST /api/adapter/select`. */
export interface AdapterSelectView {
  adapter: AdapterDescription;
  /** True when the running connection was dropped by the change. */
  reconnectRequired: boolean;
  connected: boolean;
}

/**
 * Payload of `POST /api/analyze`.
 *
 * The analysis result is re-used verbatim: the front end must label it with the
 * provenance the service reports (`source`, `provider`) and must not restate a
 * finding in its own words (AGENTS 5, 24).
 */
export type AnalysisView = AnalysisResult;
