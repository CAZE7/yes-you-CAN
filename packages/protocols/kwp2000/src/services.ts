/**
 * KWP2000 (ISO 14230) service identifiers.
 *
 * Older ECUs (VAG up to ~2008, Mercedes pre-DoIP) speak KWP2000 rather than UDS.
 * The transport layer is identical — only the application services differ — so
 * this client reuses the same link abstraction as UDS (AGENTS 5).
 */

export const KWP_SID = {
  START_COMMUNICATION: 0x81,
  STOP_COMMUNICATION: 0x82,
  ACCESS_TIMING_PARAMETER: 0x83,
  START_DIAGNOSTIC_SESSION: 0x10,
  STOP_DIAGNOSTIC_SESSION: 0x11,
  READ_ECU_IDENTIFICATION: 0x1a,
  READ_DATA_BY_LOCAL_IDENTIFIER: 0x21,
  READ_MEMORY_BY_ADDRESS: 0x23,
  READ_DATA_BY_PERIODIC_LOCAL_IDENTIFIER: 0x2a,
  WRITE_DATA_BY_LOCAL_IDENTIFIER: 0x3b,
  CLEAR_DIAGNOSTIC_INFORMATION: 0x14,
  READ_DIAGNOSTIC_TROUBLE_CODES: 0x18,
  TESTER_PRESENT: 0x3e,
  SECURITY_ACCESS: 0x27,
  STOP_REPEATED_DATA_TRANSMISSION: 0x28,
} as const;

/** Common "local identifiers" for KWP2000 identification reads. */
export const KWP_LOCAL_ID = {
  ECU_IDENTIFICATION_CODE: 0x86,
  DIAGNOSTIC_LEVEL: 0x87,
  VEHICLE_IDENTIFICATION_NUMBER: 0x90,
  CODESET: 0x91,
  VEHICLE_INFO: 0x9a,
  IMMOBILIZER_CODE: 0x9f,
} as const;

/** KWP2000 fault code status bits differ from ISO 14229 — modelled explicitly. */
export const KWP_FAULT_STATUS = {
  TEST_FAILED: 0x01,
  TEST_FAILED_THIS_CYCLE: 0x02,
  PENDING: 0x04,
  CONFIRMED: 0x08,
  NOT_COMPLETED: 0x10,
  TEST_FAILED_SINCE_CLEAR: 0x20,
} as const;

export function kwpServiceName(serviceId: number): string {
  const entry = Object.entries(KWP_SID).find(([, value]) => value === serviceId);
  return entry ? entry[0] : `KWP_SERVICE_0x${serviceId.toString(16)}`;
}
