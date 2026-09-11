/**
 * Capability model (target architecture §6, §8).
 *
 * ECUs report what they can do as capabilities, not as brand checks or
 * ad-hoc flags. The UI derives its available actions from this set, and a
 * new feature (coding, flashing) is a new capability instead of a new
 * if/else cascade.
 *
 * The module defines only the vocabulary and set operations. *Which*
 * protocol feature (e.g. which UDS service) grants which capability is
 * decided in the runtime layer — the domain stays protocol-free (§3).
 */

export type DiagnosticCapability =
  | 'session-control'
  | 'ecu-reset'
  | 'read-dtc'
  | 'clear-dtc'
  | 'read-did'
  | 'write-did'
  | 'routine-control'
  | 'io-control'
  | 'security-access'
  | 'tester-present'
  | 'coding'
  | 'adaptation'
  | 'flash';

export const ALL_CAPABILITIES: readonly DiagnosticCapability[] = [
  'session-control',
  'ecu-reset',
  'read-dtc',
  'clear-dtc',
  'read-did',
  'write-did',
  'routine-control',
  'io-control',
  'security-access',
  'tester-present',
  'coding',
  'adaptation',
  'flash',
];

export type DiagnosticCapabilities = ReadonlySet<DiagnosticCapability>;

/** Build a capability set, de-duplicating automatically. */
export function capabilitiesOf(...capabilities: readonly DiagnosticCapability[]): DiagnosticCapabilities {
  return new Set(capabilities);
}

export function isDiagnosticCapability(value: string): value is DiagnosticCapability {
  return (ALL_CAPABILITIES as readonly string[]).includes(value);
}

export function hasCapability(set: DiagnosticCapabilities, capability: DiagnosticCapability): boolean {
  return set.has(capability);
}

export function hasAllCapabilities(set: DiagnosticCapabilities, required: readonly DiagnosticCapability[]): boolean {
  return required.every((capability) => set.has(capability));
}

/** The required capabilities missing from the set, in the order requested. */
export function missingCapabilities(set: DiagnosticCapabilities, required: readonly DiagnosticCapability[]): DiagnosticCapability[] {
  return required.filter((capability) => !set.has(capability));
}

/** Human readable label for UIs; falls back to the raw name. */
export function describeCapability(capability: DiagnosticCapability): string {
  switch (capability) {
    case 'session-control':
      return 'Session control';
    case 'ecu-reset':
      return 'ECU reset';
    case 'read-dtc':
      return 'Read fault memory';
    case 'clear-dtc':
      return 'Clear fault memory';
    case 'read-did':
      return 'Read data';
    case 'write-did':
      return 'Write data';
    case 'routine-control':
      return 'Run routines';
    case 'io-control':
      return 'I/O control';
    case 'security-access':
      return 'Security access';
    case 'tester-present':
      return 'Tester present';
    case 'coding':
      return 'Coding';
    case 'adaptation':
      return 'Adaptation';
    case 'flash':
      return 'Flash firmware';
  }
}
