/**
 * Definitions as data (target architecture §4: "Definitions sind Daten, nicht
 * Code"; AGENTS 13).
 *
 * A definition package can arrive as JSON — from a file, an importer, a version
 * package or a cloud registry. `parseDefinitionPackage` turns the untrusted
 * input into a fully type-checked {@link DefinitionPackage} and then runs the
 * same semantic validation every built-in package passes. Loaders (file, DB,
 * HTTP) therefore stay trivial: read a string, call this, get a package.
 */

import { DefinitionError } from '@vdp/shared';
import type { DefinitionPackage, EcuDefinition, Provenance, SignalDefinition } from './schema.js';
import { assertValidPackage } from './validate.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Collects structural problems while coercing a JSON value into a package. */
class StructuralCheck {
  readonly errors: string[] = [];

  fail(path: string, message: string): void {
    this.errors.push(`${path}: ${message}`);
  }

  string(record: Record<string, unknown>, path: string, field: string): string | undefined {
    const value = record[field];
    if (!isString(value)) {
      this.fail(`${path}.${field}`, 'must be a string');
      return undefined;
    }
    return value;
  }

  number(record: Record<string, unknown>, path: string, field: string): number | undefined {
    const value = record[field];
    if (!isNumber(value)) {
      this.fail(`${path}.${field}`, 'must be a number');
      return undefined;
    }
    return value;
  }

  throwIfInvalid(name: string): void {
    if (this.errors.length > 0) {
      throw new DefinitionError(`definition source "${name}" is not a valid package:\n- ${this.errors.join('\n- ')}`, {
        package: name,
        errors: this.errors,
      });
    }
  }
}

function coerceProvenance(value: unknown, check: StructuralCheck): Provenance {
  if (!isRecord(value)) {
    check.fail('provenance', 'must be an object');
    return { sourceType: 'own', source: '' };
  }
  const sourceType = value.sourceType;
  const validTypes = new Set(['own', 'standard', 'licensed', 'community', 'reverse-engineered', 'example-placeholder']);
  if (!isString(sourceType) || !validTypes.has(sourceType)) {
    check.fail('provenance.sourceType', 'must be one of own|standard|licensed|community|reverse-engineered|example-placeholder');
  }
  if (!isString(value.source)) check.fail('provenance.source', 'must be a string');
  const provenance: Provenance = {
    sourceType: (isString(sourceType) ? sourceType : 'own') as Provenance['sourceType'],
    source: isString(value.source) ? value.source : '',
  };
  if (isString(value.license)) provenance.license = value.license;
  if (isString(value.version)) provenance.version = value.version;
  if (isString(value.retrievedAt)) provenance.retrievedAt = value.retrievedAt;
  return provenance;
}

function coerceSignal(value: unknown, index: number, check: StructuralCheck): SignalDefinition {
  const path = `signals[${index}]`;
  if (!isRecord(value)) {
    check.fail(path, 'must be an object');
    return { id: '', name: '', ecu: '', did: 0, byteOffset: 0, length: 0, encoding: 'uint8' };
  }
  const id = check.string(value, path, 'id');
  const name = check.string(value, path, 'name');
  const ecu = check.string(value, path, 'ecu');
  const did = check.number(value, path, 'did');
  const byteOffset = check.number(value, path, 'byteOffset');
  const length = check.number(value, path, 'length');
  const encoding = value.encoding;
  if (!isString(encoding)) check.fail(`${path}.encoding`, 'must be a string');
  const signal: SignalDefinition = {
    id: id ?? '',
    name: name ?? '',
    ecu: ecu ?? '',
    did: did ?? 0,
    byteOffset: byteOffset ?? 0,
    length: length ?? 0,
    encoding: (isString(encoding) ? encoding : 'uint8') as SignalDefinition['encoding'],
  };
  if (isNumber(value.service)) signal.service = value.service;
  if (isNumber(value.bitOffset)) signal.bitOffset = value.bitOffset;
  if (isNumber(value.bitLength)) signal.bitLength = value.bitLength;
  if (value.endianness === 'big' || value.endianness === 'little') signal.endianness = value.endianness;
  if (isNumber(value.scale)) signal.scale = value.scale;
  if (isNumber(value.offsetValue)) signal.offsetValue = value.offsetValue;
  if (isString(value.unit)) signal.unit = value.unit;
  if (isNumber(value.min)) signal.min = value.min;
  if (isNumber(value.max)) signal.max = value.max;
  if (isRecord(value.enumMapping)) signal.enumMapping = value.enumMapping as Record<number, string>;
  if (isString(value.description)) signal.description = value.description;
  if (typeof value.critical === 'boolean') signal.critical = value.critical;
  return signal;
}

function coerceEcu(value: unknown, index: number, check: StructuralCheck): EcuDefinition {
  const path = `ecus[${index}]`;
  if (!isRecord(value)) {
    check.fail(path, 'must be an object');
    return { id: '', name: '', address: { txId: 0, rxId: 0 }, protocol: 'uds' };
  }
  const id = check.string(value, path, 'id');
  const name = check.string(value, path, 'name');
  const protocol = value.protocol;
  if (protocol !== 'uds' && protocol !== 'kwp2000') check.fail(`${path}.protocol`, 'must be "uds" or "kwp2000"');

  const address = value.address;
  let ecuAddress: EcuDefinition['address'] = { txId: 0, rxId: 0 };
  if (!isRecord(address)) {
    check.fail(`${path}.address`, 'must be an object with txId/rxId');
  } else {
    const txId = check.number(address, `${path}.address`, 'txId');
    const rxId = check.number(address, `${path}.address`, 'rxId');
    ecuAddress = { txId: txId ?? 0, rxId: rxId ?? 0 };
    if (typeof address.extended === 'boolean') ecuAddress.extended = address.extended;
    if (address.addressing === 'normal' || address.addressing === 'extended') ecuAddress.addressing = address.addressing;
    if (isNumber(address.functionalId)) ecuAddress.functionalId = address.functionalId;
  }

  const ecu: EcuDefinition = {
    id: id ?? '',
    name: name ?? '',
    address: ecuAddress,
    protocol: protocol === 'kwp2000' ? 'kwp2000' : 'uds',
  };
  if (Array.isArray(value.identification)) ecu.identification = value.identification as EcuDefinition['identification'];
  if (Array.isArray(value.services)) ecu.services = value.services as number[];
  if (Array.isArray(value.dtcs)) ecu.dtcs = value.dtcs as EcuDefinition['dtcs'];
  if (isString(value.description)) ecu.description = value.description;
  if (isRecord(value.timing)) ecu.timing = value.timing as EcuDefinition['timing'];
  return ecu;
}

/**
 * Coerce an untrusted value (parsed JSON) into a {@link DefinitionPackage},
 * throwing a {@link DefinitionError} that lists every structural problem. The
 * result also passes the semantic validation built-in packages use.
 */
export function parseDefinitionPackage(source: unknown): DefinitionPackage {
  const check = new StructuralCheck();
  const name = isRecord(source) ? (isString(source.name) ? source.name : '<unknown>') : '<unknown>';

  if (!isRecord(source)) {
    throw new DefinitionError('definition source must be a JSON object', { package: name });
  }

  const schemaVersion = source.schemaVersion;
  if (!isNumber(schemaVersion)) check.fail('schemaVersion', 'must be a number');
  const oem = check.string(source, '$', 'oem');
  const pkgName = check.string(source, '$', 'name');
  const version = check.string(source, '$', 'version');
  const provenance = coerceProvenance(source.provenance, check);

  if (!Array.isArray(source.ecus)) check.fail('ecus', 'must be an array');
  if (!Array.isArray(source.signals)) check.fail('signals', 'must be an array');

  const ecus = Array.isArray(source.ecus) ? source.ecus.map((ecu, i) => coerceEcu(ecu, i, check)) : [];
  const signals = Array.isArray(source.signals) ? source.signals.map((signal, i) => coerceSignal(signal, i, check)) : [];

  check.throwIfInvalid(name);

  // Semantically validated exactly like the built-in packages (AGENTS 13).
  return assertValidPackage({
    schemaVersion: schemaVersion as number,
    oem: oem as string,
    name: pkgName as string,
    version: version as string,
    provenance,
    ecus,
    signals,
  });
}

/** Parse a JSON string into a definition package. */
export function parseDefinitionPackageJson(json: string): DefinitionPackage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new DefinitionError(`definition JSON is not parseable: ${error instanceof Error ? error.message : String(error)}`, {});
  }
  return parseDefinitionPackage(parsed);
}
