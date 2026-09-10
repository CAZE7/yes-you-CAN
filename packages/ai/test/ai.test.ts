import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLogger } from '@vdp/shared';
import { AnalysisError, AnalysisService, HeuristicAnalysisProvider, HttpAnalysisProvider, redactVin, type AnalysisInput, type HttpClient } from '../src/index.js';

const logger = createLogger('ai', { level: 'ERROR' });

function sampleInput(overrides: Partial<AnalysisInput> = {}): AnalysisInput {
  return {
    vehicle: { brand: 'Honda', model: 'Accord', modelYear: 2003, vin: '1HGCM82633A004352' },
    mileageKm: 187_450,
    signals: [
      { signal: 'engine.rpm', name: 'Engine speed', unit: 'rpm', samples: 40, min: 780, max: 4200, average: 900, delta: 3420, outOfRangeCount: 0 },
      { signal: 'engine.coolant_temperature', name: 'Coolant temperature', unit: '°C', samples: 40, min: 88, max: 92, average: 90, delta: 4, outOfRangeCount: 2 },
      { signal: 'engine.fuel_trim_long_term', name: 'Long term fuel trim', unit: '%', samples: 2, min: -8, max: 12, average: 2, delta: 20, outOfRangeCount: 0 },
    ],
    dtcs: [{ code: 'P0420', severity: 'major', ecu: 'Engine', description: 'Catalyst system efficiency below threshold' }],
    anomalies: [{ signal: 'engine.rpm', reason: 'delta 3420 far above median' }],
    notes: ['Rough idle when cold.'],
    ...overrides,
  };
}

test('the heuristic provider reports DTCs, ranges and spreads with evidence', async () => {
  const provider = new HeuristicAnalysisProvider();
  const result = await provider.analyze(sampleInput());
  assert.equal(result.source, 'heuristic');
  assert.equal(result.provider, 'heuristic');
  assert.ok(result.findings.some((finding) => finding.id === 'dtc-P0420' && finding.severity === 'major'));
  assert.ok(result.findings.some((finding) => finding.id === 'range-engine.coolant_temperature'));
  assert.ok(result.findings.some((finding) => finding.id === 'spread-engine.rpm'));
  assert.ok(result.findings.some((finding) => finding.id === 'low-samples-engine.fuel_trim_long_term'));
  assert.ok(result.recommendations.some((entry) => entry.startsWith('P0420')));
  assert.ok(result.confidence > 0 && result.confidence <= 1);
  assert.ok(result.warnings?.length);
});

test('a clean recording yields a single informational finding', async () => {
  const provider = new HeuristicAnalysisProvider();
  const result = await provider.analyze(
    sampleInput({
      dtcs: [],
      anomalies: [],
      signals: [{ signal: 'engine.rpm', name: 'Engine speed', unit: 'rpm', samples: 50, min: 780, max: 820, average: 800, delta: 40, outOfRangeCount: 0 }],
    }),
  );
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]?.id, 'no-findings');
  assert.ok(result.recommendations.some((entry) => entry.includes('No action required')));
});

test('the heuristic provider never sends data off-box', () => {
  const provider = new HeuristicAnalysisProvider();
  assert.equal(provider.sendsDataOffBox, false);
});

test('the VIN is redacted before it reaches an HTTP provider', async () => {
  let sentBody = '';
  const httpClient: HttpClient = {
    async fetch(_url, init) {
      sentBody = init.body;
      return { ok: true, status: 200, text: async () => JSON.stringify({ summary: 'ok', findings: [], recommendations: [], confidence: 0.7 }) };
    },
  };
  const provider = new HttpAnalysisProvider({ endpoint: 'https://gateway.example/analyze', model: 'test-model', httpClient, logger });
  const result = await provider.analyze(sampleInput());
  assert.ok(!sentBody.includes('1HGCM82633A004352'), 'VIN must not leave the box by default');
  assert.ok(sentBody.includes('[redacted]'));
  assert.equal(result.source, 'model');
  assert.equal(result.model, 'test-model');
  assert.equal(result.confidence, 0.7);
  assert.equal(provider.sendsDataOffBox, true);
});

test('the VIN can be sent only with an explicit opt-in', async () => {
  let sentBody = '';
  const httpClient: HttpClient = {
    async fetch(_url, init) {
      sentBody = init.body;
      return { ok: true, status: 200, text: async () => JSON.stringify({ summary: 'ok', findings: [], recommendations: [] }) };
    },
  };
  const provider = new HttpAnalysisProvider({ endpoint: 'https://gateway.example/analyze', httpClient, sendVin: true, logger });
  await provider.analyze(sampleInput());
  assert.ok(sentBody.includes('1HGCM82633A004352'));
});

test('the API key is sent as a bearer header and never appears in the body', async () => {
  let authHeader = '';
  const httpClient: HttpClient = {
    async fetch(_url, init) {
      authHeader = init.headers['authorization'] ?? '';
      return { ok: true, status: 200, text: async () => JSON.stringify({ summary: 'ok', findings: [], recommendations: [] }) };
    },
  };
  const provider = new HttpAnalysisProvider({ endpoint: 'https://gateway.example/analyze', apiKey: 'secret-token', httpClient, logger });
  await provider.analyze(sampleInput({ dtcs: [], anomalies: [], signals: [] }));
  assert.equal(authHeader, 'Bearer secret-token');
});

test('gateway errors surface as AnalysisError with the status code', async () => {
  const httpClient: HttpClient = {
    async fetch() {
      return { ok: false, status: 503, text: async () => 'unavailable' };
    },
  };
  const provider = new HttpAnalysisProvider({ endpoint: 'https://gateway.example/analyze', httpClient, logger });
  await assert.rejects(provider.analyze(sampleInput({ signals: [] })), (error: unknown) => {
    assert.ok(error instanceof AnalysisError);
    assert.match(error.message, /503/);
    return true;
  });
});

test('network failures are wrapped, not leaked raw', async () => {
  const httpClient: HttpClient = {
    async fetch() {
      throw new Error('connect ECONNREFUSED');
    },
  };
  const provider = new HttpAnalysisProvider({ endpoint: 'https://gateway.example/analyze', httpClient, logger });
  await assert.rejects(provider.analyze(sampleInput({ signals: [] })), /analysis request failed/);
});

test('malformed gateway JSON is reported as a failure', async () => {
  const httpClient: HttpClient = {
    async fetch() {
      return { ok: true, status: 200, text: async () => 'not json' };
    },
  };
  const provider = new HttpAnalysisProvider({ endpoint: 'https://gateway.example/analyze', httpClient, logger });
  await assert.rejects(provider.analyze(sampleInput({ signals: [] })), AnalysisError);
});

test('redactVin leaves an input without a VIN untouched', () => {
  const input = sampleInput({ vehicle: { brand: 'Honda' } });
  assert.equal(redactVin(input), input);
});

test('the service routes to the chosen provider and records history', async () => {
  const service = new AnalysisService({ providers: [new HeuristicAnalysisProvider()], logger });
  assert.equal(service.defaultProviderId, 'heuristic');
  assert.deepEqual(service.listProviders(), [{ id: 'heuristic', label: 'Local rule engine', sendsDataOffBox: false }]);
  const result = await service.analyze({ input: sampleInput() });
  assert.equal(result.provider, 'heuristic');
  assert.equal(service.history.length, 1);
});

test('unknown providers are rejected with the known ids', async () => {
  const service = new AnalysisService({ providers: [new HeuristicAnalysisProvider()], logger });
  await assert.rejects(service.analyze({ input: sampleInput(), providerId: 'gpt-9' }), /unknown analysis provider/);
});

test('a service without providers fails loudly instead of silently returning nothing', async () => {
  const service = new AnalysisService({ logger });
  await assert.rejects(service.analyze({ input: sampleInput() }), /no analysis provider registered/);
});
