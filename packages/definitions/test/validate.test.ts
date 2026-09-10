import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CURRENT_SCHEMA_VERSION,
  DefinitionRegistry,
  genericPackage,
  indexPackage,
  mercedesExamplePackage,
  vagExamplePackage,
  validateDefinitionPackage,
  type DefinitionPackage,
} from '../src/index.js';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

test('all built-in packages are valid', () => {
  for (const pkg of [genericPackage, vagExamplePackage, mercedesExamplePackage]) {
    const result = validateDefinitionPackage(pkg);
    assert.deepEqual(result.errors, [], `${pkg.name} must be valid: ${result.errors.join(', ')}`);
    assert.equal(result.valid, true);
  }
});

test('placeholder packages are flagged with a warning, not shipped silently (AGENTS 24)', () => {
  const result = validateDefinitionPackage(vagExamplePackage);
  assert.ok(result.warnings.some((w) => w.includes('placeholder')), 'placeholder provenance must warn');
  const generic = validateDefinitionPackage(genericPackage);
  assert.equal(generic.warnings.some((w) => w.includes('placeholder')), false);
});

test('non-SemVer versions are rejected (AGENTS 13)', () => {
  const pkg = clone(genericPackage);
  pkg.version = '1.0';
  const result = validateDefinitionPackage(pkg);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('SemVer')));
});

test('missing provenance is rejected', () => {
  const pkg = clone(genericPackage);
  // @ts-expect-error deliberate invalid input
  delete pkg.provenance;
  assert.equal(validateDefinitionPackage(pkg).valid, false);
});

test('licensed data without a license declaration is rejected', () => {
  const pkg = clone(genericPackage);
  pkg.provenance = { sourceType: 'licensed', source: 'OEM documentation' };
  const result = validateDefinitionPackage(pkg);
  assert.ok(result.errors.some((e) => e.includes('license')));
});

test('wrong schema version is rejected', () => {
  const pkg = clone(genericPackage);
  pkg.schemaVersion = CURRENT_SCHEMA_VERSION + 1;
  assert.equal(validateDefinitionPackage(pkg).valid, false);
});

test('signals referencing unknown ECUs are rejected', () => {
  const pkg = clone(genericPackage);
  pkg.signals[0]!.ecu = 'does-not-exist';
  const result = validateDefinitionPackage(pkg);
  assert.ok(result.errors.some((e) => e.includes('unknown ECU')));
});

test('duplicate signal and ECU ids are rejected', () => {
  const pkg = clone(genericPackage);
  pkg.signals.push(clone(pkg.signals[0]!));
  pkg.ecus.push(clone(pkg.ecus[0]!));
  const result = validateDefinitionPackage(pkg);
  assert.ok(result.errors.some((e) => e.includes('duplicate signal id')));
  assert.ok(result.errors.some((e) => e.includes('duplicate ECU id')));
});

test('encoding length mismatches are rejected', () => {
  const pkg = clone(genericPackage);
  const rpm = pkg.signals.find((s) => s.id === 'engine.rpm')!;
  rpm.length = 3;
  const result = validateDefinitionPackage(pkg);
  assert.ok(result.errors.some((e) => e.includes('engine.rpm') && e.includes('encoding')));
});

test('bitOffset and bitLength must be defined together', () => {
  const pkg = clone(genericPackage);
  pkg.signals[0]!.bitOffset = 2;
  const result = validateDefinitionPackage(pkg);
  assert.ok(result.errors.some((e) => e.includes('bitOffset and bitLength together')));
});

test('identical tx and rx identifiers are rejected', () => {
  const pkg = clone(genericPackage);
  pkg.ecus[0]!.address.rxId = pkg.ecus[0]!.address.txId;
  const result = validateDefinitionPackage(pkg);
  assert.ok(result.errors.some((e) => e.includes('must differ')));
});

test('11-bit identifiers out of range are rejected', () => {
  const pkg = clone(genericPackage);
  pkg.ecus[0]!.address.txId = 0x18daf100;
  const result = validateDefinitionPackage(pkg);
  assert.ok(result.errors.some((e) => e.includes('out of range')));
});

test('malformed DTC codes are rejected', () => {
  const pkg = clone(genericPackage);
  pkg.ecus[0]!.dtcs!.push({ code: 'X9999', description: 'broken' });
  const result = validateDefinitionPackage(pkg);
  assert.ok(result.errors.some((e) => e.includes('malformed DTC')));
});

test('indexPackage groups signals per ECU and DID', () => {
  const index = indexPackage(genericPackage);
  assert.equal(index.byId.get('engine.rpm')?.unit, 'rpm');
  assert.ok((index.byEcu.get('engine')?.length ?? 0) > 5);
  const absWheelSpeeds = index.byDid.get('abs')?.get(0xf40d);
  assert.equal(absWheelSpeeds?.length, 2, 'two wheel speeds share one DID with different offsets');
});

test('registry resolves packages by OEM and ECU by address', () => {
  const registry = new DefinitionRegistry();
  assert.equal(registry.get('generic')?.version, '1.0.0');
  assert.equal(registry.get('vag')?.oem, 'vag');
  const found = registry.findEcuByAddress(0x7e0);
  assert.equal(found?.ecuId, 'engine');
  assert.equal(registry.findEcuByAddress(0x18daf107, true)?.ecuId, 'sam_front');
  assert.equal(registry.list().length, 3);
});

test('registry accepts additional packages at runtime', () => {
  const registry = new DefinitionRegistry([]);
  const pkg: DefinitionPackage = {
    ...clone(genericPackage),
    oem: 'custom',
    name: 'Custom',
    version: '2.0.0',
  };
  registry.register(pkg);
  assert.equal(registry.get('custom')?.version, '2.0.0');
  assert.equal(registry.all().length, 1);
});
