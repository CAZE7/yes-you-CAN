/**
 * DoIP vehicle discovery (ISO 13400-2 §9.3, AGENTS 8 step 1).
 *
 * A UDP broadcast on port 13400 makes vehicles announce VIN + logical address.
 * The transport itself is injected so this stays testable without a network.
 */

import { createLogger, type Logger } from '@vdp/shared';
import { PAYLOAD_TYPE, decodeVehicleIdentificationResponse, encodeMessage, encodeVehicleIdentificationRequest, type VehicleIdentificationResponse } from './message.js';

export interface DoipDatagramSocket {
  broadcast(data: Uint8Array): Promise<void>;
  onData(listener: (chunk: Uint8Array) => void): () => void;
  close(): Promise<void>;
}

export interface DiscoveryResult extends VehicleIdentificationResponse {
  address: string;
}

export interface DiscoveryOptions {
  socket: DoipDatagramSocket;
  windowMs?: number;
  vin?: string;
  logger?: Logger;
}

export class DoipDiscovery {
  private readonly log: Logger;
  private readonly windowMs: number;

  constructor(private readonly options: DiscoveryOptions) {
    this.log = (options.logger ?? createLogger('connection', { level: 'INFO' })).child('connection');
    this.windowMs = options.windowMs ?? 1000;
  }

  /** Broadcast the identification request and collect every announcement. */
  async discover(): Promise<DiscoveryResult[]> {
    const results = new Map<number, DiscoveryResult>();
    const unsubscribe = this.options.socket.onData((chunk) => {
      const parsed = this.parse(chunk);
      if (parsed) results.set(parsed.logicalAddress, parsed);
    });
    try {
      await this.options.socket.broadcast(encodeMessage(PAYLOAD_TYPE.VEHICLE_IDENTIFICATION_REQUEST, encodeVehicleIdentificationRequest(this.options.vin)));
      await sleep(this.windowMs);
    } finally {
      unsubscribe();
    }
    const found = Array.from(results.values());
    this.log.info('DoIP discovery finished', { vehicles: found.length });
    return found;
  }

  /** Parse an announcement/vehicle identification response datagram. */
  parse(datagram: Uint8Array, address = 'udp'): DiscoveryResult | null {
    if (datagram.length < 8) return null;
    const payloadType = (datagram[2] ?? 0) << 8 | (datagram[3] ?? 0);
    if (payloadType !== PAYLOAD_TYPE.VEHICLE_ANNOUNCEMENT_RESPONSE) return null;
    try {
      const decoded = decodeVehicleIdentificationResponse(datagram.subarray(8));
      return { ...decoded, address };
    } catch (error) {
      this.log.warn('invalid vehicle identification response', { error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
