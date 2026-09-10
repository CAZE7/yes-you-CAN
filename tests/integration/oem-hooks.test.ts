/**
 * OEM extension point wiring (AGENTS 3, 34.6).
 *
 * The hooks must only fill gaps: where a definition package documents an ECU,
 * the OEM heuristic must not rename or reinterpret it.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLogger } from '@vdp/shared';
import { genericPackage } from '@vdp/definitions';
import { VirtualVehicle } from '@vdp/simulators';
import type { OemProtocol } from '@vdp/protocols-oem';
import { DiagnosticEngine } from '@vdp/core';

const logger = createLogger('core', { level: 'ERROR' });

/** An OEM module claiming the engine address and one manufacturer specific code. */
const testOem: OemProtocol = {
  oem: 'generic',
  displayName: 'Test OEM',
  provenance: { sourceType: 'example-placeholder', source: 'invented for this test' },
  identifyEcu: (rxId) => (rxId === 0x7e8 ? 'Engine (from OEM hook)' : undefined),
  interpretDtc: (code) =>
    code === 'P0420' ? { code, description: 'Manufacturer hint: check lambda sensors first', severity: 'major' } : undefined,
};

async function withEngine(
  options: { definitions?: readonly typeof genericPackage[]; oemProtocols?: readonly OemProtocol[] },
  run: (engine: DiagnosticEngine, vehicle: VirtualVehicle) => Promise<void>,
): Promise<void> {
  const vehicle = new VirtualVehicle({
    definitions: genericPackage,
    logger,
    networkOptions: { echoToSender: true },
    dtcs: { engine: [{ code: 'P0420', status: 0x2f }] },
  });
  await vehicle.start();
  const engine = new DiagnosticEngine({
    bus: vehicle.testerBus,
    definitions: options.definitions ?? [genericPackage],
    logger,
    oemProtocols: options.oemProtocols ?? [],
  });
  try {
    await engine.connect();
    await run(engine, vehicle);
  } finally {
    await engine.disconnect();
    await vehicle.stop();
  }
}

test('an ECU no definition package knows is named by the OEM hook', async () => {
  await withEngine({ definitions: [], oemProtocols: [testOem] }, async (engine) => {
    const record = engine.vehicleSession?.data.ecus.find((ecu) => ecu.rxId === 0x7e8);
    assert.ok(record, 'the engine ECU must be discovered');
    assert.equal(record.name, 'Engine (from OEM hook)', 'the OEM role must name an otherwise unknown ECU');
  });
});

test('a documented ECU keeps its definition name over the OEM guess', async () => {
  await withEngine({ definitions: [genericPackage], oemProtocols: [testOem] }, async (engine) => {
    const record = engine.vehicleSession?.data.ecus.find((ecu) => ecu.rxId === 0x7e8);
    assert.ok(record);
    assert.equal(record.name, 'Engine Control Unit', 'documented data must win over the heuristic');
    assert.notEqual(record.name, 'Engine (from OEM hook)');
  });
});

test('DTC scanning attaches manufacturer interpretations next to the codes', async () => {
  await withEngine({ definitions: [genericPackage], oemProtocols: [testOem] }, async (engine) => {
    const results = await engine.scanDtcs();
    const engineResult = results.find((entry) => entry.dtcs.some((dtc) => dtc.code === 'P0420'));
    assert.ok(engineResult, 'P0420 must be read from the engine ECU');

    const interpretation = engineResult.interpretations.find((entry) => entry.code === 'P0420');
    assert.ok(interpretation, 'the OEM hint must be attached');
    assert.equal(interpretation.severity, 'major');
    assert.match(interpretation.description ?? '', /lambda sensors/);

    // The code itself stays untouched — a hint is interpretation, not measurement.
    const dtc = engineResult.dtcs.find((entry) => entry.code === 'P0420');
    assert.equal(dtc?.code, 'P0420');
    assert.equal(dtc?.status, 0x2f);
  });
});

test('without OEM protocols the engine behaves exactly as before', async () => {
  await withEngine({ definitions: [genericPackage], oemProtocols: [] }, async (engine) => {
    const results = await engine.scanDtcs();
    assert.ok(results.every((entry) => entry.interpretations.length === 0), 'no hooks means no interpretations');
    assert.equal(engine.oemProtocols.list().length, 0);
  });
});

test('the engine exposes which OEM modules are registered, with provenance', async () => {
  await withEngine({ definitions: [genericPackage], oemProtocols: [testOem] }, async (engine) => {
    const listed = engine.oemProtocols.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.oem, 'generic');
    assert.match(listed[0]?.provenance ?? '', /example-placeholder/, 'provenance must be visible (AGENTS 24)');
  });
});
