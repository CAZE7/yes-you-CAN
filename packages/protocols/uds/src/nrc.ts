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
  0x10: 'generalReject',
  0x11: 'serviceNotSupported',
  0x12: 'subFunctionNotSupported',
  0x13: 'incorrectMessageLengthOrInvalidFormat',
  0x14: 'responseTooLong',
  0x21: 'busyRepeatRequest',
  0x22: 'conditionsNotCorrect',
  0x24: 'requestSequenceError',
  0x25: 'noResponseFromSubnetComponent',
  0x26: 'preventsTransmissionOfRequestedAction',
  0x31: 'requestOutOfRange',
  0x33: 'securityAccessDenied',
  0x35: 'invalidKey',
  0x36: 'exceedNumberOfAttempts',
  0x37: 'requiredTimeDelayNotExpired',
  0x70: 'uploadDownloadNotAccepted',
  0x71: 'transferDataSuspended',
  0x72: 'generalProgrammingFailure',
  0x73: 'wrongBlockSequenceCounter',
  0x78: 'requestCorrectlyReceivedResponsePending',
  0x7e: 'subFunctionNotSupportedInActiveSession',
  0x7f: 'serviceNotSupportedInActiveSession',
  0x81: 'rpmTooHigh',
  0x82: 'rpmTooLow',
  0x83: 'engineIsRunning',
  0x84: 'engineIsNotRunning',
  0x85: 'engineRunTimeTooLow',
  0x86: 'temperatureTooHigh',
  0x87: 'temperatureTooLow',
  0x88: 'vehicleSpeedTooHigh',
  0x89: 'vehicleSpeedTooLow',
  0x8a: 'throttlePedalTooHigh',
  0x8b: 'throttlePedalTooLow',
  0x8c: 'transmissionRangeNotInNeutral',
  0x8d: 'transmissionRangeNotInGear',
  0x8f: 'brakeSwitchNotClosed',
  0x90: 'shifterLeverNotInPark',
  0x91: 'torqueConverterClutchLocked',
  0x92: 'voltageTooHigh',
  0x93: 'voltageTooLow',
  0x94: 'resourceTemporarilyNotAvailable',
};

export function nrcName(nrc: number): string {
  return NAMES[nrc] ?? `unknownNrc_0x${nrc.toString(16)}`;
}

/** True for NRCs that indicate the ECU is busy and a retry is legitimate. */
export function isTransientNrc(nrc: number): boolean {
  return nrc === NRC.BUSY_REPEAT_REQUEST || nrc === NRC.RESOURCE_TEMPORARILY_NOT_AVAILABLE;
}
