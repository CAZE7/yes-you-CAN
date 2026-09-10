/**
 * UDS service identifiers and sub-function constants (ISO 14229-1).
 *
 * Only the services listed in AGENTS 9 are modelled; everything else stays out
 * until a definition package needs it (no speculative surface).
 */

export const SID = {
  DIAGNOSTIC_SESSION_CONTROL: 0x10,
  ECU_RESET: 0x11,
  CLEAR_DIAGNOSTIC_INFORMATION: 0x14,
  READ_DTC_INFORMATION: 0x19,
  READ_DATA_BY_IDENTIFIER: 0x22,
  SECURITY_ACCESS: 0x27,
  COMMUNICATION_CONTROL: 0x28,
  WRITE_DATA_BY_IDENTIFIER: 0x2e,
  INPUT_OUTPUT_CONTROL_BY_IDENTIFIER: 0x2f,
  ROUTINE_CONTROL: 0x31,
  REQUEST_DOWNLOAD: 0x34,
  TESTER_PRESENT: 0x3e,
  CONTROL_DTC_SETTING: 0x85,
} as const;

export type ServiceId = (typeof SID)[keyof typeof SID];

/** Positive response SID = request SID + 0x40 (ISO 14229-1 §7.2). */
export const POSITIVE_RESPONSE_OFFSET = 0x40;
export const NEGATIVE_RESPONSE_SID = 0x7f;
/** Sub-function bit 7 suppresses the positive response (ISO 14229-1 §9.2.2). */
export const SUPPRESS_POSITIVE_RESPONSE = 0x80;

export const SESSION = {
  DEFAULT: 0x01,
  PROGRAMMING: 0x02,
  EXTENDED: 0x03,
} as const;

export const SESSION_NAMES: Record<number, string> = {
  0x01: 'defaultSession',
  0x02: 'programmingSession',
  0x03: 'extendedDiagnosticSession',
};

export const RESET_TYPE = {
  HARD_RESET: 0x01,
  KEY_OFF_ON_RESET: 0x02,
  SOFT_RESET: 0x03,
} as const;

export const DTC_REPORT = {
  REPORT_NUMBER_OF_DTC_BY_STATUS_MASK: 0x01,
  REPORT_DTC_BY_STATUS_MASK: 0x02,
  REPORT_DTC_SNAPSHOT_IDENTIFICATION: 0x03,
  REPORT_DTC_SNAPSHOT_RECORD_BY_DTC_NUMBER: 0x04,
  REPORT_DTC_STORED_DATA_BY_DTC_NUMBER: 0x05,
  REPORT_DTC_EXTENDED_DATA_RECORD_BY_DTC_NUMBER: 0x06,
  REPORT_SUPPORTED_DTC: 0x0a,
} as const;

export const ROUTINE_CONTROL_TYPE = {
  START_ROUTINE: 0x01,
  STOP_ROUTINE: 0x02,
  REQUEST_ROUTINE_RESULTS: 0x03,
} as const;

/** Well-known standardized DIDs (ISO 14229-1 Annex D / common OEM usage). */
export const DID = {
  BOOT_SOFTWARE_IDENTIFICATION: 0xf180,
  APPLICATION_SOFTWARE_IDENTIFICATION: 0xf181,
  APPLICATION_DATA_IDENTIFICATION: 0xf182,
  ECU_SERIAL_NUMBER: 0xf18c,
  VEHICLE_IDENTIFIER_NUMBER: 0xf190,
  VEHICLE_MANUFACTURER_SPARE_PART_NUMBER: 0xf187,
  SYSTEM_NAME_OR_ENGINE_TYPE: 0xf197,
  ACTIVE_DIAGNOSTIC_SESSION: 0xf186,
} as const;

export const DTC_GROUP_ALL = 0xffffff;

export function positiveResponseSid(requestSid: number): number {
  return (requestSid + POSITIVE_RESPONSE_OFFSET) & 0xff;
}

export function isPositiveResponse(requestSid: number, response: Uint8Array): boolean {
  return (response[0] ?? 0) === positiveResponseSid(requestSid);
}

export function serviceName(serviceId: number): string {
  const entry = Object.entries(SID).find(([, value]) => value === serviceId);
  return entry ? entry[0] : `SERVICE_0x${serviceId.toString(16)}`;
}
