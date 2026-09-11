/**
 * DoIP message framing (ISO 13400-2 §9).
 *
 * Generic header: protocol version, inverse version, 2-byte payload type,
 * 4-byte payload length. Everything else is a payload type specific body.
 */

import { ProtocolError, concatBytes, u16be, u32be, writeU16be, writeU32be } from '@vdp/shared';

export const DOIP_PROTOCOL_VERSION = 0x02;
export const DOIP_UDP_PORT = 13400;
export const DOIP_TLS_PORT = 3496;

export const PAYLOAD_TYPE = {
  GENERIC_NACK: 0x0000,
  VEHICLE_IDENTIFICATION_REQUEST: 0x0001,
  VEHICLE_IDENTIFICATION_REQUEST_WITH_EID: 0x0002,
  VEHICLE_IDENTIFICATION_REQUEST_WITH_VIN: 0x0003,
  VEHICLE_ANNOUNCEMENT_RESPONSE: 0x0004,
  ROUTING_ACTIVATION_REQUEST: 0x0005,
  ROUTING_ACTIVATION_RESPONSE: 0x0006,
  ALIVE_CHECK_REQUEST: 0x0007,
  ALIVE_CHECK_RESPONSE: 0x0008,
  DIAGNOSTIC_POWER_MODE_INFORMATION_REQUEST: 0x4001,
  DIAGNOSTIC_POWER_MODE_INFORMATION_RESPONSE: 0x4002,
  DIAGNOSTIC_MESSAGE: 0x8001,
  DIAGNOSTIC_MESSAGE_POSITIVE_ACK: 0x8002,
  DIAGNOSTIC_MESSAGE_NEGATIVE_ACK: 0x8003,
} as const;

export const NACK_CODES: Record<number, string> = {
  0x00: 'incorrectPatternFormat',
  0x01: 'unknownPayloadType',
  0x02: 'messageTooLarge',
  0x03: 'outOfMemory',
  0x04: 'invalidPayloadLength',
};

export const ROUTING_ACTIVATION_TYPE = {
  DEFAULT: 0x00,
  WWH_OBD: 0x01,
  CENTRAL_SECURITY: 0x02,
} as const;

export const ROUTING_ACTIVATION_RESPONSE_CODES: Record<number, string> = {
  0x00: 'unknownSourceAddress',
  0x01: 'allConcurrentSocketsRegisteredAndActive',
  0x02: 'sourceAddressAlreadyRegisteredOnAnotherSocket',
  0x03: 'sourceAddressMissingAuthentication',
  0x04: 'sourceAddressMissingRejectionConfirmation',
  0x05: 'missingRoutingActivationConfirmation',
  0x06: 'routingActivationDenied',
  0x07: 'routingActivationTypeNotSupported',
  0x10: 'success',
};

export interface DoipHeader {
  version: number;
  payloadType: number;
  payloadLength: number;
}

export const DOIP_HEADER_LENGTH = 8;

export function encodeHeader(payloadType: number, payloadLength: number): Uint8Array {
  return concatBytes([
    new Uint8Array([DOIP_PROTOCOL_VERSION, (~DOIP_PROTOCOL_VERSION) & 0xff]),
    writeU16be(payloadType),
    writeU32be(payloadLength),
  ]);
}

export function decodeHeader(data: Uint8Array): DoipHeader {
  if (data.length < DOIP_HEADER_LENGTH) throw new ProtocolError(`DoIP header needs ${DOIP_HEADER_LENGTH} bytes, got ${data.length}`);
  const version = data[0] ?? 0;
  const inverse = data[1] ?? 0;
  if ((version ^ inverse) !== 0xff) {
    throw new ProtocolError(`DoIP header version check failed: version 0x${version.toString(16)}, inverse 0x${inverse.toString(16)}`);
  }
  return { version, payloadType: u16be(data, 2), payloadLength: u32be(data, 4) };
}

export function encodeMessage(payloadType: number, payload: Uint8Array): Uint8Array {
  return concatBytes([encodeHeader(payloadType, payload.length), payload]);
}

export interface VehicleIdentificationResponse {
  vin: string;
  logicalAddress: number;
  eid: Uint8Array;
  gid: Uint8Array;
  furtherActionRequired: boolean;
  vinSyncStatus?: number;
}

export function encodeVehicleIdentificationRequest(vin?: string): Uint8Array {
  if (!vin) return new Uint8Array();
  const bytes = new Uint8Array(17);
  for (let i = 0; i < 17; i++) {
    const code = vin.charCodeAt(i);
    bytes[i] = Number.isFinite(code) ? code & 0xff : 0x20;
  }
  return bytes;
}

export function decodeVehicleIdentificationResponse(payload: Uint8Array): VehicleIdentificationResponse {
  if (payload.length < 32) throw new ProtocolError(`vehicle identification response needs at least 32 bytes, got ${payload.length}`);
  const vinBytes = payload.subarray(0, 17);
  let vin = '';
  for (const byte of vinBytes) vin += String.fromCharCode(byte);
  return {
    vin: vin.trim(),
    logicalAddress: u16be(payload, 17),
    eid: payload.subarray(19, 25).slice(),
    gid: payload.subarray(25, 31).slice(),
    furtherActionRequired: (payload[31] ?? 0) !== 0x00,
    ...(payload.length > 32 ? { vinSyncStatus: payload[32] ?? 0 } : {}),
  };
}

export function encodeVehicleIdentificationResponse(response: VehicleIdentificationResponse): Uint8Array {
  const vin = new Uint8Array(17);
  for (let i = 0; i < 17; i++) {
    const code = response.vin.charCodeAt(i);
    vin[i] = Number.isFinite(code) ? code & 0xff : 0x20;
  }
  return concatBytes([
    vin,
    writeU16be(response.logicalAddress),
    response.eid,
    response.gid,
    new Uint8Array([response.furtherActionRequired ? 0x01 : 0x00]),
    ...(response.vinSyncStatus !== undefined ? [new Uint8Array([response.vinSyncStatus])] : []),
  ]);
}

export function encodeRoutingActivationRequest(sourceAddress: number, activationType: number = ROUTING_ACTIVATION_TYPE.DEFAULT): Uint8Array {
  return concatBytes([writeU16be(sourceAddress), new Uint8Array([activationType, 0x00, 0x00, 0x00, 0x00])]);
}

export function decodeRoutingActivationResponse(payload: Uint8Array): {
  testerLogicalAddress: number;
  entityLogicalAddress: number;
  code: number;
  codeName: string;
} {
  // ISO 13400-2 §9.3.2.2 Table: tester address (0-1), entity address (2-3), response
  // code (4), reserved (5-8). The reserved tail is what an entity "may" append, so 5
  // bytes are a complete answer — and 5 is also the shortest thing real gateways send.
  // Reading the code at byte 8 instead made every denial look like success, because
  // the reserved bytes are zero and zero happens to be a valid refusal code.
  if (payload.length < 5) throw new ProtocolError(`routing activation response needs at least 5 bytes, got ${payload.length}`);
  const code = payload[4] ?? 0;
  return {
    testerLogicalAddress: u16be(payload, 0),
    entityLogicalAddress: u16be(payload, 2),
    code,
    codeName: ROUTING_ACTIVATION_RESPONSE_CODES[code] ?? `unknown_0x${code.toString(16)}`,
  };
}

/**
 * Encode the routing activation response an entity sends back: addresses, response code
 * at byte 4, then the four reserved ISO bytes (written as zeros, as required).
 */
export function encodeRoutingActivationResponse(testerAddress: number, entityAddress: number, code: number): Uint8Array {
  return concatBytes([writeU16be(testerAddress), writeU16be(entityAddress), new Uint8Array([code, 0x00, 0x00, 0x00, 0x00])]);
}

/** Diagnostic message: source address, target address, UDS payload (ISO 14229-5). */
export function encodeDiagnosticMessage(sourceAddress: number, targetAddress: number, udsPayload: Uint8Array): Uint8Array {
  return concatBytes([writeU16be(sourceAddress), writeU16be(targetAddress), udsPayload]);
}

export function decodeDiagnosticMessage(payload: Uint8Array): { sourceAddress: number; targetAddress: number; udsPayload: Uint8Array } {
  if (payload.length < 4) throw new ProtocolError(`diagnostic message needs at least 4 bytes, got ${payload.length}`);
  return { sourceAddress: u16be(payload, 0), targetAddress: u16be(payload, 2), udsPayload: payload.subarray(4).slice() };
}

export function decodeDiagnosticAck(payload: Uint8Array): { sourceAddress: number; targetAddress: number; ackCode: number } {
  if (payload.length < 5) throw new ProtocolError(`diagnostic ack needs at least 5 bytes, got ${payload.length}`);
  return { sourceAddress: u16be(payload, 0), targetAddress: u16be(payload, 2), ackCode: payload[4] ?? 0 };
}
