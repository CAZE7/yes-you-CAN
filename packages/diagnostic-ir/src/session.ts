/**
 * Session and ECU observations (master backlog P0 #6; AGENTS 10, 12).
 *
 * What the tester found on the bus, as data: which ECUs answered, at which
 * addresses, in which session, with which services. This is the part of a
 * session that a report or a replay needs to stay reproducible — and it separates
 * "the ECU answered" from "we never reached it" (a `reachable: false` ECU carries
 * the reason in `lastError`).
 */

import type { Evidence } from "./provenance.js";
import { proven, unproven } from "./provenance.js";

export type EcuProtocol = "uds" | "kwp2000" | "unknown";

export interface EcuObservation {
  kind: "ecu";
  ecuId: string;
  /** Definition ECU id when one matched, e.g. "engine". */
  definitionEcuId?: string;
  name: string;
  protocol: EcuProtocol;
  /** Physical request identifier (tester → ECU). */
  txId: number;
  /** Physical response identifier (ECU → tester). */
  rxId: number;
  /** True when extended addressing is used on this ECU's frames. */
  extended: boolean;
  /** False when the ECU was discovered but no session could be opened. */
  reachable: boolean;
  /** Active diagnostic session type (ISO 14229-1 §9.2), unknown before the first switch. */
  sessionType?: number;
  telemetry: EcuTelemetry;
  /** UDS service ids the ECU answered during probing — evidence, not expectation. */
  supportedServices?: number[];
  /** Why the ECU is unusable, when it is. */
  lastError?: string;
  /** Human-readable identity entries read from the ECU (§11/§12). */
  identification?: Array<{ label: string; value: string; did?: number }>;
  at: string;
  evidence: Evidence;
}

/** Cycle-time characteristics of one ECU (ISO 14229-2 P2/P2*). */
export interface EcuTelemetry {
  /** Application timing P2 in milliseconds. */
  p2Ms: number;
  /** Enhanced timing P2* in milliseconds, when the ECU announced one. */
  p2StarMs?: number;
}

export interface EcuObservationInput {
  ecuId: string;
  definitionEcuId?: string;
  name: string;
  protocol: EcuProtocol;
  txId: number;
  rxId: number;
  extended?: boolean;
  reachable?: boolean;
  sessionType?: number;
  p2Ms?: number;
  p2StarMs?: number;
  supportedServices?: number[];
  lastError?: string;
  identification?: Array<{ label: string; value: string; did?: number }>;
  at?: string;
}

/** Build an ECU observation; a discovered-but-unreachable ECU states its reason. */
export function ecuObservation(input: EcuObservationInput): EcuObservation {
  const at = input.at ?? new Date().toISOString();
  const reachable = input.reachable ?? true;
  return {
    kind: "ecu",
    ecuId: input.ecuId,
    ...(input.definitionEcuId !== undefined ? { definitionEcuId: input.definitionEcuId } : {}),
    name: input.name,
    protocol: input.protocol,
    txId: input.txId,
    rxId: input.rxId,
    extended: input.extended ?? false,
    reachable,
    ...(input.sessionType !== undefined ? { sessionType: input.sessionType } : {}),
    telemetry: {
      p2Ms: input.p2Ms ?? 50,
      ...(input.p2StarMs !== undefined ? { p2StarMs: input.p2StarMs } : {}),
    },
    ...(input.supportedServices !== undefined
      ? { supportedServices: [...input.supportedServices] }
      : {}),
    ...(input.lastError !== undefined ? { lastError: input.lastError } : {}),
    ...(input.identification !== undefined
      ? { identification: input.identification.map((entry) => ({ ...entry })) }
      : {}),
    at,
    evidence: reachable
      ? proven({ origin: "ecu-response", at, ecuId: input.ecuId, serviceId: 0x3e })
      : unproven(input.lastError ?? "the ECU did not answer", { at, ecuId: input.ecuId }),
  };
}

export interface SessionObservationInput {
  sessionId: string;
  /** Adapter the session runs on, e.g. `{ kind: "virtual", channels: ["vcan0"] }`. */
  adapter: { kind: string; channels: readonly string[]; [key: string]: unknown };
  transport: { kind: string; channel: string; mtu?: number };
  startedAt?: string;
  endedAt?: string;
  ecus?: EcuObservation[];
}

/** One diagnostic session on one vehicle: the frame everything else hangs on. */
export interface SessionObservation {
  kind: "session";
  sessionId: string;
  adapter: SessionObservationInput["adapter"];
  transport: SessionObservationInput["transport"];
  startedAt: string;
  endedAt?: string;
  ecus: EcuObservation[];
  evidence: Evidence;
}

export function sessionObservation(input: SessionObservationInput): SessionObservation {
  const startedAt = input.startedAt ?? new Date().toISOString();
  const ecus = input.ecus ?? [];
  return {
    kind: "session",
    sessionId: input.sessionId,
    adapter: input.adapter,
    transport: input.transport,
    startedAt,
    ...(input.endedAt !== undefined ? { endedAt: input.endedAt } : {}),
    ecus: ecus.map((ecu) => ({ ...ecu })),
    evidence: proven({
      origin: "operator",
      at: startedAt,
      note: `session on ${input.adapter.kind} (${input.adapter.channels.join(", ") || "no channel"})`,
    }),
  };
}

/** ECUs that answered and can be used. */
export function reachableEcus(session: SessionObservation): EcuObservation[] {
  return session.ecus.filter((ecu) => ecu.reachable);
}

/** ECUs that were discovered but are unusable — never silently dropped. */
export function unreachableEcus(session: SessionObservation): EcuObservation[] {
  return session.ecus.filter((ecu) => !ecu.reachable);
}
