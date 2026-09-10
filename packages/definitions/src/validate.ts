/**
 * Definition package validation (AGENTS 13).
 *
 * A definition package is loaded from data files, so it is validated before use.
 * Errors are collected (not thrown on the first one) so an importer can report
 * everything that is wrong in one pass.
 */

import { DefinitionError } from '@vdp/shared';
import { CURRENT_SCHEMA_VERSION, type DefinitionPackage, type EcuDefinition, type SignalDefinition } from './schema.js';

const SEMVER = /^\d+\.\d+\.\d+(?:-[\w.]+)?(?:\+[\w.]+)?$/;
const DTC_CODE = /^[PCBU]\d[0-9A-Fa-f]{3}$/;
const VALID_ENCODINGS = new Set([
  'uint8',
  'uint16',
  'uint24',
  'uint32',
  'int8',
  'int16',
  'int32',
  'float32',
  'ascii',
  'bool',
  'bitmask',
  'bcd',
]);

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export function validateDefinitionPackage(pkg: DefinitionPackage): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (pkg.schemaVersion !== CURRENT_SCHEMA_VERSION) {
    errors.push(`schemaVersion ${pkg.schemaVersion} is not supported (expected ${CURRENT_SCHEMA_VERSION})`);
  }
  if (!SEMVER.test(pkg.version)) errors.push(`version "${pkg.version}" is not valid SemVer (AGENTS 13 requires semantic versioning)`);
  if (!pkg.oem) errors.push('oem is required');
  if (!pkg.name) errors.push('name is required');

  // Provenance is mandatory (AGENTS 24).
  if (!pkg.provenance) errors.push('provenance is required (AGENTS 24)');
  else {
    if (!pkg.provenance.sourceType) errors.push('provenance.sourceType is required');
    if (!pkg.provenance.source) errors.push('provenance.source is required');
    if (pkg.provenance.sourceType === 'licensed' && !pkg.provenance.license) {
      errors.push('licensed data must declare a license');
    }
    if (pkg.provenance.sourceType === 'reverse-engineered') {
      warnings.push('reverse-engineered definitions must be reviewed before distribution');
    }
    if (pkg.provenance.sourceType === 'example-placeholder') {
      warnings.push('package contains placeholder data — not suitable for a real vehicle');
    }
  }

  const ecuIds = new Set<string>();
  for (const ecu of pkg.ecus ?? []) {
    validateEcu(ecu, ecuIds, errors);
  }

  const signalIds = new Set<string>();
  for (const signal of pkg.signals ?? []) {
    validateSignal(signal, ecuIds, signalIds, errors, warnings);
  }

  return { valid: errors.length === 0, errors, warnings };
}

function validateEcu(ecu: EcuDefinition, ecuIds: Set<string>, errors: string[]): void {
  if (!ecu.id) errors.push('ECU without id');
  if (ecuIds.has(ecu.id)) errors.push(`duplicate ECU id "${ecu.id}"`);
  ecuIds.add(ecu.id);
  if (!ecu.name) errors.push(`ECU "${ecu.id}" has no name`);
  if (ecu.protocol !== 'uds' && ecu.protocol !== 'kwp2000') errors.push(`ECU "${ecu.id}" has unsupported protocol "${ecu.protocol}"`);
  const { txId, rxId } = ecu.address ?? {};
  if (typeof txId !== 'number' || typeof rxId !== 'number') {
    errors.push(`ECU "${ecu.id}" needs numeric txId/rxId`);
    return;
  }
  const max = ecu.address.extended ? 0x1fffffff : 0x7ff;
  if (txId > max || rxId > max) errors.push(`ECU "${ecu.id}" identifier out of range for ${ecu.address.extended ? '29-bit' : '11-bit'} addressing`);
  if (txId === rxId) errors.push(`ECU "${ecu.id}" txId and rxId must differ`);
  for (const dtc of ecu.dtcs ?? []) {
    if (!DTC_CODE.test(dtc.code)) errors.push(`ECU "${ecu.id}" has malformed DTC code "${dtc.code}"`);
    if (!dtc.description) errors.push(`DTC ${dtc.code} has no description`);
  }
}

function validateSignal(
  signal: SignalDefinition,
  ecuIds: Set<string>,
  signalIds: Set<string>,
  errors: string[],
  warnings: string[],
): void {
  if (!signal.id) errors.push('signal without id');
  if (signalIds.has(signal.id)) errors.push(`duplicate signal id "${signal.id}"`);
  signalIds.add(signal.id);
  if (!ecuIds.has(signal.ecu)) errors.push(`signal "${signal.id}" references unknown ECU "${signal.ecu}"`);
  if (!VALID_ENCODINGS.has(signal.encoding)) errors.push(`signal "${signal.id}" has unknown encoding "${signal.encoding}"`);
  if (signal.byteOffset < 0) errors.push(`signal "${signal.id}" has a negative byteOffset`);
  if (signal.length < 1) errors.push(`signal "${signal.id}" has a length below 1`);

  const naturalLength = naturalLengthFor(signal.encoding);
  if (naturalLength !== null && signal.bitLength === undefined && signal.length !== naturalLength) {
    errors.push(`signal "${signal.id}" declares ${signal.length} bytes but encoding ${signal.encoding} needs ${naturalLength}`);
  }
  if (signal.length > 1 && signal.endianness === undefined) {
    warnings.push(`signal "${signal.id}" spans ${signal.length} bytes without explicit endianness (defaulting to big endian)`);
  }
  if ((signal.bitOffset !== undefined) !== (signal.bitLength !== undefined)) {
    errors.push(`signal "${signal.id}" must define bitOffset and bitLength together`);
  }
  if (signal.bitLength !== undefined && (signal.bitLength < 1 || signal.bitLength > 32)) {
    errors.push(`signal "${signal.id}" has an unsupported bitLength ${signal.bitLength}`);
  }
  if (signal.min !== undefined && signal.max !== undefined && signal.min > signal.max) {
    errors.push(`signal "${signal.id}" has min > max`);
  }
  if (signal.enumMapping && Object.keys(signal.enumMapping).length === 0) {
    warnings.push(`signal "${signal.id}" declares an empty enumMapping`);
  }
  if (!signal.unit && signal.encoding !== 'ascii' && signal.encoding !== 'bool' && signal.encoding !== 'bitmask') {
    warnings.push(`signal "${signal.id}" has no unit — reports will show raw values`);
  }
}

function naturalLengthFor(encoding: string): number | null {
  switch (encoding) {
    case 'uint8':
    case 'int8':
    case 'bool':
      return 1;
    case 'uint16':
    case 'int16':
      return 2;
    case 'uint24':
      return 3;
    case 'uint32':
    case 'int32':
    case 'float32':
      return 4;
    default:
      return null;
  }
}

/** Throws a DefinitionError listing every problem — used by loaders. */
export function assertValidPackage(pkg: DefinitionPackage): DefinitionPackage {
  const result = validateDefinitionPackage(pkg);
  if (!result.valid) {
    throw new DefinitionError(`definition package "${pkg.name}" is invalid:\n- ${result.errors.join('\n- ')}`, {
      package: pkg.name,
      errors: result.errors,
    });
  }
  return pkg;
}
