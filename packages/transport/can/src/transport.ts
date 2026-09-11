/**
 * Transport & adapter contracts (AGENTS 4).
 *
 * These are the only types the Diagnostic Engine may depend on. The UDS engine
 * never learns whether bytes travel over CAN (ISO 15765-2) or DoIP (ISO 13400) —
 * ISO 14229-2 explicitly defines session services transport-independently (AGENTS 2, 5).
 */

export type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

export interface ConnectionStatus {
  state: ConnectionState;
  adapterId: string;
  /** Human readable detail, e.g. "ELM327 v2.1 @ /dev/ttyUSB0". */
  detail?: string;
  /** Frames sent/received counters for the UI adapter panel. */
  txCount?: number;
  rxCount?: number;
  lastError?: string;
  lastActivityAt?: number;
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
