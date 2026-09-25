/**
 * Transport & adapter contracts (AGENTS 4).
 *
 * These are the only types the Diagnostic Engine may depend on. The UDS engine
 * never learns whether bytes travel over CAN (ISO 15765-2) or DoIP (ISO 13400) —
 * ISO 14229-2 explicitly defines session services transport-independently (AGENTS 2, 5).
 */

import type { AdapterConnectionState } from "./connection.js";

/**
 * State of a byte transport link.
 *
 * The vocabulary lives in {@link AdapterConnectionState} (connection.ts) and is
 * shared with the frame layer, so `CanBus.getStatus()` and
 * `VehicleTransport.getStatus()` answer the same question with the same words —
 * `error` and `degraded` and `recovering` mean the same thing above and below
 * ISO-TP (master prompt P1, ADR 0060).
 */
export type ConnectionState = AdapterConnectionState;

/**
 * What an adapter reports about its link (AGENTS 4).
 *
 * `state` is the honest headline; `stateReason` and `lastError` say why, and
 * `since` pins when the state was entered — a UI never has to guess whether a
 * disconnected adapter just closed or died an hour ago.
 */
export interface ConnectionStatus {
  state: ConnectionState;
  adapterId: string;
  /** Human readable detail, e.g. "ELM327 v2.1 @ /dev/ttyUSB0". */
  detail?: string;
  /** Why the adapter is in this state, in its own words. */
  stateReason?: string;
  /** Frames sent/received counters for the UI adapter panel. */
  txCount?: number;
  rxCount?: number;
  /** Received messages dropped by the adapter because its buffers overflowed. */
  droppedRxCount?: number;
  lastError?: string;
  lastActivityAt?: number;
  /** Epoch ms when `state` was entered. */
  since?: number;
}

/** Byte-oriented transport as mandated verbatim by AGENTS 4. */
export interface VehicleTransport {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(data: Uint8Array): Promise<void>;
  receive(timeoutMs?: number): Promise<Uint8Array | null>;
  getStatus(): ConnectionStatus;
}

export interface AdapterInfo {
  id: string;
  kind: string;
  name: string;
  firmware?: string;
  serial?: string;
  channels: string[];
}

export interface TransportInfo {
  kind: "can" | "can-fd" | "doip" | "replay" | "virtual";
  channel: string;
  /** ISO-TP addressing parameters actually in use. */
  txId?: number;
  rxId?: number;
  extended?: boolean;
  /** DoIP: tester + target logical addresses (ISO 13400-2). */
  doipAddresses?: { testerAddress: number; targetAddress: number };
  mtu: number;
}

/** Capability model required by AGENTS 4 — features are negotiated, never assumed. */
export interface AdapterCapabilities {
  can: boolean;
  canFd: boolean;
  doip: boolean;
  isoTpOffload: boolean;
  channels: number;
  /** Optional extras advertised by concrete adapters. */
  maxBitrate?: number;
  supportsFunctionalAddressing?: boolean;
}

export const NO_CAPABILITIES: AdapterCapabilities = {
  can: false,
  canFd: false,
  doip: false,
  isoTpOffload: false,
  channels: 0,
};
