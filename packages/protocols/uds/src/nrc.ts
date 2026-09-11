/**
 * Negative Response Codes (ISO 14229-1 Annex A).
 *
 * AGENTS 34 rule 18: where a norm detail matters, reference the ISO number in
 * code rather than guessing — every constant below is traceable to 14229-1.
 */

export const NRC = {
  GENERAL_REJECT: 0x10,
  SERVICE_NOT_SUPPORTED: 0x11,
  SUB_FUNCTION_NOT_SUPPORTED: 0x12,
  INCORRECT_MESSAGE_LENGTH_OR_INVALID_FORMAT: 0x13,
  RESPONSE_TOO_LONG: 0x14,
  BUSY_REPEAT_REQUEST: 0x21,
  CONDITIONS_NOT_CORRECT: 0x22,
  REQUEST_SEQUENCE_ERROR: 0x24,
  NO_RESPONSE_FROM_SUBNET_COMPONENT: 0x25,
  PREVENTS_TRANSMISSION_OF_REQUESTED_ACTION: 0x26,
  REQUEST_OUT_OF_RANGE: 0x31,
  SECURITY_ACCESS_DENIED: 0x33,
  INVALID_KEY: 0x35,
  EXCEED_NUMBER_OF_ATTEMPTS: 0x36,
  REQUIRED_TIME_DELAY_NOT_EXPIRED: 0x37,
  UPLOAD_DOWNLOAD_NOT_ACCEPTED: 0x70,
  TRANSFER_DATA_SUSPENDED: 0x71,
  GENERAL_PROGRAMMING_FAILURE: 0x72,
  WRONG_BLOCK_SEQUENCE_COUNTER: 0x73,
  REQUEST_CORRECTLY_RECEIVED_RESPONSE_PENDING: 0x78,
  SUB_FUNCTION_NOT_SUPPORTED_IN_ACTIVE_SESSION: 0x7e,
  SERVICE_NOT_SUPPORTED_IN_ACTIVE_SESSION: 0x7f,
  RPM_TOO_HIGH: 0x81,
  RPM_TOO_LOW: 0x82,
  ENGINE_IS_RUNNING: 0x83,
  ENGINE_IS_NOT_RUNNING: 0x84,
  ENGINE_RUN_TIME_TOO_LOW: 0x85,
  TEMPERATURE_TOO_HIGH: 0x86,
  TEMPERATURE_TOO_LOW: 0x87,
  VEHICLE_SPEED_TOO_HIGH: 0x88,
  VEHICLE_SPEED_TOO_LOW: 0x89,
  THROTTLE_PEDAL_TOO_HIGH: 0x8a,
  THROTTLE_PEDAL_TOO_LOW: 0x8b,
  TRANSMISSION_RANGE_NOT_IN_NEUTRAL: 0x8c,
  TRANSMISSION_RANGE_NOT_IN_GEAR: 0x8d,
  BRAKE_SWITCH_NOT_CLOSED: 0x8f,
  SHIFTER_LEVER_NOT_IN_PARK: 0x90,
  TORQUE_CONVERTER_CLUTCH_LOCKED: 0x91,
  VOLTAGE_TOO_HIGH: 0x92,
  VOLTAGE_TOO_LOW: 0x93,
  RESOURCE_TEMPORARILY_NOT_AVAILABLE: 0x94,
} as const;

export type NegativeResponseCode = (typeof NRC)[keyof typeof NRC];

const NAMES: Record<number, string> = {
  16: "generalReject",
  17: "serviceNotSupported",
  18: "subFunctionNotSupported",
  19: "incorrectMessageLengthOrInvalidFormat",
  20: "responseTooLong",
  33: "busyRepeatRequest",
  34: "conditionsNotCorrect",
  36: "requestSequenceError",
  37: "noResponseFromSubnetComponent",
  38: "preventsTransmissionOfRequestedAction",
  49: "requestOutOfRange",
  51: "securityAccessDenied",
  53: "invalidKey",
  54: "exceedNumberOfAttempts",
  55: "requiredTimeDelayNotExpired",
  112: "uploadDownloadNotAccepted",
  113: "transferDataSuspended",
  114: "generalProgrammingFailure",
  115: "wrongBlockSequenceCounter",
  120: "requestCorrectlyReceivedResponsePending",
  126: "subFunctionNotSupportedInActiveSession",
  127: "serviceNotSupportedInActiveSession",
  129: "rpmTooHigh",
  130: "rpmTooLow",
  131: "engineIsRunning",
  132: "engineIsNotRunning",
  133: "engineRunTimeTooLow",
  134: "temperatureTooHigh",
  135: "temperatureTooLow",
  136: "vehicleSpeedTooHigh",
  137: "vehicleSpeedTooLow",
  138: "throttlePedalTooHigh",
  139: "throttlePedalTooLow",
  140: "transmissionRangeNotInNeutral",
  141: "transmissionRangeNotInGear",
  143: "brakeSwitchNotClosed",
  144: "shifterLeverNotInPark",
  145: "torqueConverterClutchLocked",
  146: "voltageTooHigh",
  147: "voltageTooLow",
  148: "resourceTemporarilyNotAvailable",
};

export function nrcName(nrc: number): string {
  return NAMES[nrc] ?? `unknownNrc_0x${nrc.toString(16)}`;
}

/** True for NRCs that indicate the ECU is busy and a retry is legitimate. */
export function isTransientNrc(nrc: number): boolean {
  return nrc === NRC.BUSY_REPEAT_REQUEST || nrc === NRC.RESOURCE_TEMPORARILY_NOT_AVAILABLE;
}
