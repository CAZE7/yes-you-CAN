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

/**
 * The text of whatever a `catch` caught (AGENTS 34.25: no silent `catch {}` —
 * the reason has to arrive somewhere readable).
 *
 * Seven byte-identical private copies of this lived in ai/http, ai/service,
 * storage/repository, transport/doip, transport/iso-tp, web/backend and
 * web/server, plus the same line inline in three dozen more places. One question
 * — "what goes into the log when the thrown value is not an Error?" — had
 * forty-odd answers, none of them tested. This is the one answer, with tests.
 *
 * Plain objects render as JSON: `String({ code: "UPSTREAM_500" })` says only
 * "[object Object]", and a workshop log line has to carry the reason. Values
 * that cannot be serialised (cycles, BigInt, symbols) fall back to `String` —
 * an imprecise text beats a second failure inside the failure path.
 */
export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error); // circular or BigInt — String() still names it
  }
}

/**
 * The caught value as an `Error` — for the places that rethrow it or hand it to
 * a `fail()` seam instead of only writing it down.
 *
 * Replaces `error instanceof Error ? error : new Error(String(error))`: a real
 * Error stays the very same object (stack, `cause` and its own fields survive),
 * everything else is named through {@link messageOf} — an object therefore by
 * its content instead of "[object Object]".
 */
export function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(messageOf(error));
}
