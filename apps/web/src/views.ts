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
import type { DtcView, UnreadEcuView } from "./dtc-view.js";
import type { EcuView } from "./ecu-view.js";
import type { MarkerView, SampleView, TraceView } from "./trace-view.js";
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
/**
 * The rows the projections own (`dtc-view.ts`, `ecu-view.ts`, `trace-view.ts`;
 * 0.E E15) are re-exported here: a projection *is* a wire type, and the front end
 * imports the whole contract from one module so that `tsconfig.frontend.json` has
 * exactly one mapping to point at (ADR 0030 §2).
 */
export type { DtcView, UnreadEcuView } from "./dtc-view.js";
export type { EcuView, FreezeFrameView } from "./ecu-view.js";
export type {
  ScenarioCatalogView,
  ScenarioCheckRow,
  ScenarioCheckView,
  ScenarioMemoryRow,
  ScenarioMemoryView,
  ScenarioModelRow,
  ScenarioOptionView,
  ScenarioPanelState,
  ScenarioPanelView,
  ScenarioRunView,
  ScenarioSummary,
  ScenarioVerdictView,
} from "./scenario-view.js";
export type { MarkerView, SampleView, TraceView } from "./trace-view.js";
export type {
  VehicleCandidateView,
  VehicleEvidenceView,
  VehicleResolutionView,
} from "./vehicle-view.js";

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
  /**
   * Modules the last full scan could not read (ADR 0049). Empty when every module
   * answered; the fault table is only a statement about the ones that did.
   */
  unreadEcus: UnreadEcuView[];
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

/** Guided Diagnosis wire contract (Task 6; loop step since ADR 0056). */
export interface GuidedDiagnosisView {
  status: "in-progress" | "resolved" | "inconclusive";
  summary: string;
  stepsCompleted: number;
  hypotheses: Array<{
    id: string;
    claim: string;
    confidence: number;
    outcome: "confirmed" | "refuted" | "untested";
    checks: Array<{ signal: string; expect: string; outcome: string }>;
    /** The evidence that speaks for this hypothesis (item id + the side). */
    supporting: Array<{ itemId: string; why: string }>;
    /** The evidence that speaks against it — never netted into the confidence. */
    against: Array<{ itemId: string; why: string }>;
    nextTest?: { signal: string; expect: string; min?: number; max?: number; windowMs?: number };
  }>;
  /** What the last step measurement changed — the loop's machine-readable diff. */
  changes?: Array<
    | {
        kind: "outcome";
        hypothesisId: string;
        from: "confirmed" | "refuted" | "untested" | "absent";
        to: "confirmed" | "refuted" | "untested" | "absent";
      }
    | { kind: "confidence"; hypothesisId: string; from: number; to: number }
    | { kind: "evidence"; itemId: string; change: "added" | "removed" }
  >;
  nextRecommendedTest?: {
    hypothesisId: string;
    rationale: string;
    test: { signal: string; expect: string; min?: number; max?: number; windowMs?: number };
    discriminatesAgainst?: string[];
    /** How much uncertainty this test removes, on the loop's published rule. */
    uncertaintyReduction?: number;
  };
}

/** ECU Coding write outcome (Task 8). */
export interface CodingResultView {
  ok: boolean;
  verified: boolean;
  ecuId: string;
  did: number;
  originalHex?: string;
  writtenHex?: string;
  reasons?: string[];
  warnings?: string[];
  transactionId: string;
}

/** Parameter Adaptation write outcome (Task 8). */
export interface AdaptationResultView {
  ok: boolean;
  verified: boolean;
  ecuId: string;
  did: number;
  originalValue?: number;
  writtenValue?: number;
  unit?: string;
  reasons?: string[];
  warnings?: string[];
  transactionId: string;
}

/** Advanced signal analysis view (Task 5). */
export interface AdvancedSignalAnalysisView {
  signalId: string;
  sampleCount: number;
  statistics?: {
    min: number;
    max: number;
    mean: number;
    median: number;
    variance: number;
    stdDev: number;
    skewness: number;
    kurtosis: number;
    p5: number;
    p50: number;
    p95: number;
  };
  spectrum?: {
    dominantFrequency: number;
    dominantMagnitude: number;
    snrDb: number;
  };
  anomalies: Array<{
    kind: string;
    value: number;
    severity: string;
    description: string;
  }>;
}

/** Chaos testing and fault injection status view (Task 4). */
export interface ChaosStatusView {
  active: boolean;
  dropRate: number;
  dropBurstRemaining: number;
  /**
   * What the armed burst is aimed at, formatted like every other id on this wire.
   * `null` means no id was given, and `dropBurstScope` then says whether that was the
   * bus-wide form or nothing armed at all — the panel must not have to guess, because
   * a burst aimed at an id the vehicle does not talk on takes nothing and looks active
   * either way (AGENTS 0.E → docs/architecture/backlog.md E24).
   */
  dropBurstTarget: string | null;
  dropBurstScope: "none" | "bus-wide" | "targeted";
  droppedFrames: number;
  corruptedFrames: number;
  delayedFrames: number;
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
