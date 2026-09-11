/**
 * Connection ports (target architecture §2: "Ports & Adapters").
 *
 * The domain knows a vehicle connection only through these interfaces.
 * `IsoTpConnection`, DoIP clients, replay transports — all of them are
 * implementations on the other side of the port; new adapters plug in without
 * touching the core.
 */

/** What a connection can carry — capabilities, not type switches (§6). */
export interface ConnectionCapabilities {
  /** Transport identifiers this connection supports, e.g. "can", "can-fd", "doip". */
  transports: readonly string[];
  /** Largest payload one message can carry without external segmentation. */
  maxPayloadBytes: number;
  /** Adapter streams live traffic while diagnostics run. */
  liveStreaming: boolean;
  /** Connection permits write operations (some adapters are read-only). */
  writeSupported: boolean;
}

export interface VehicleConnection {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  getCapabilities(): ConnectionCapabilities;
  /** Human readable description for logs and UI ("socketcan:can0"). */
  describe(): string;
}

export interface DiagnosticRequestOptions {
  timeoutMs?: number;
}

/**
 * The transport contract the diagnostic layer speaks (§1): the core knows
 * only `DiagnosticTransport` — never `IsoTpConnection`, `CanableAdapter` or
 * `DoIpClient` directly.
 */
export interface DiagnosticTransport {
  /** Send one diagnostic message and resolve with the ECU's response. */
  request(data: Uint8Array, options?: DiagnosticRequestOptions): Promise<Uint8Array>;
  /** Largest payload this transport accepts in a single request. */
  readonly maxPayloadBytes: number;
  close(): void;
}
