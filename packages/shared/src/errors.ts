/**
 * Shared error hierarchy.
 *
 * Rule (AGENTS 35 Definition of Done): every feature ships with error handling.
 * Every layer throws typed errors so upper layers can react without string matching.
 */

export type ErrorCode =
  | "E_TRANSPORT"
  | "E_TRANSPORT_TIMEOUT"
  | "E_TRANSPORT_CLOSED"
  | "E_ISOTP"
  | "E_UDS_NEGATIVE_RESPONSE"
  | "E_UDS_TIMEOUT"
  | "E_PROTOCOL"
  | "E_DEFINITION"
  | "E_DECODE"
  | "E_ENCODE"
  | "E_SESSION"
  | "E_ADAPTER_UNSUPPORTED"
  | "E_SAFETY_VIOLATION"
  | "E_STORAGE"
  | "E_CONFIG";

export class VdpError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.details = details;
  }
}

export class TransportError extends VdpError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super("E_TRANSPORT", message, details);
  }
}

export class TransportTimeoutError extends VdpError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super("E_TRANSPORT_TIMEOUT", message, details);
  }
}

export class TransportClosedError extends VdpError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super("E_TRANSPORT_CLOSED", message, details);
  }
}

export class IsoTpError extends VdpError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super("E_ISOTP", message, details);
  }
}

export class UdsNegativeResponseError extends VdpError {
  readonly serviceId: number;
  readonly nrc: number;
  readonly nrcName: string;

  constructor(
    serviceId: number,
    nrc: number,
    nrcName: string,
    details: Record<string, unknown> = {},
  ) {
    super(
      "E_UDS_NEGATIVE_RESPONSE",
      `UDS negative response 0x${nrc.toString(16)} (${nrcName}) for service 0x${serviceId.toString(16)}`,
      {
        serviceId,
        nrc,
        nrcName,
        ...details,
      },
    );
    this.serviceId = serviceId;
    this.nrc = nrc;
    this.nrcName = nrcName;
  }
}

export class UdsTimeoutError extends VdpError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super("E_UDS_TIMEOUT", message, details);
  }
}

export class ProtocolError extends VdpError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super("E_PROTOCOL", message, details);
  }
}

export class DefinitionError extends VdpError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super("E_DEFINITION", message, details);
  }
}

export class DecodeError extends VdpError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super("E_DECODE", message, details);
  }
}

export class EncodeError extends VdpError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super("E_ENCODE", message, details);
  }
}

export class SessionError extends VdpError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super("E_SESSION", message, details);
  }
}

export class AdapterUnsupportedError extends VdpError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super("E_ADAPTER_UNSUPPORTED", message, details);
  }
}

export class SafetyViolationError extends VdpError {
  readonly failedPreconditions: string[];
  constructor(
    message: string,
    failedPreconditions: string[],
    details: Record<string, unknown> = {},
  ) {
    super("E_SAFETY_VIOLATION", message, { failedPreconditions, ...details });
    this.failedPreconditions = failedPreconditions;
  }
}

export class StorageError extends VdpError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super("E_STORAGE", message, details);
  }
}
