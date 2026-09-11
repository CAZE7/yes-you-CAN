import assert from 'node:assert/strict';
import { test } from 'vitest';
import { ConsoleSink, createLogger, LOG_LEVEL_ORDER, MemorySink } from './logger.js';

test('level filtering drops below threshold', () => {
  const sink = new MemorySink();
  const log = createLogger('uds', { level: 'WARN' }, [sink]);
  log.debug('ignored');
  log.warn('kept');
  assert.equal(sink.all().length, 1);
  assert.equal(sink.all()[0]?.level, 'WARN');
});

test('raw protocol logging is opt-in (AGENTS 33)', () => {
  const quiet = new MemorySink();
  createLogger('can', { level: 'TRACE', rawProtocol: false }, [quiet]).raw('frame', { data: new Uint8Array([1]) });
  assert.equal(quiet.all().length, 0);

  const loud = new MemorySink();
  createLogger('can', { level: 'TRACE', rawProtocol: true }, [loud]).raw('frame', { data: new Uint8Array([1, 2]) });
  assert.equal(loud.all().length, 1);
  assert.deepEqual((loud.all()[0]?.fields as Record<string, unknown>)?.data, '01 02');
});

test('scope filtering and child loggers share the record buffer', () => {
  const sink = new MemorySink();
  const root = createLogger('connection', { level: 'TRACE', scopes: ['uds'] }, [sink]);
  root.info('connection message');
  root.child('uds').info('uds message');
  assert.equal(sink.all().length, 1);
  assert.equal(sink.all()[0]?.scope, 'uds');
  assert.equal(root.records.length, 1);
});

test('level order is monotonic', () => {
  assert.ok(LOG_LEVEL_ORDER.TRACE < LOG_LEVEL_ORDER.DEBUG);
  assert.ok(LOG_LEVEL_ORDER.DEBUG < LOG_LEVEL_ORDER.INFO);
  assert.ok(LOG_LEVEL_ORDER.INFO < LOG_LEVEL_ORDER.WARN);
  assert.ok(LOG_LEVEL_ORDER.WARN < LOG_LEVEL_ORDER.ERROR);
});

test('console sink does not throw on circular structures', () => {
  const sink = new ConsoleSink();
  const circular: Record<string, unknown> = { a: 1 };
  circular['self'] = circular;
  const original = console.log;
  console.log = () => undefined;
  try {
    sink.write({ timestamp: 't', level: 'INFO', scope: 'ui', message: 'm', fields: circular });
  } finally {
    console.log = original;
  }
});
