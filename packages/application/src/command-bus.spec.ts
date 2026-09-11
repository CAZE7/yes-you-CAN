import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { CommandBus, DuplicateHandlerError, NoHandlerError } from './index.js';
import { connectVehicle, readDtcs, CommandKinds } from './index.js';
import { getSession, getEcuList, QueryKinds } from './index.js';

describe('command bus', () => {
  test('dispatch routes to the registered command handler', async () => {
    const bus = new CommandBus();
    bus.registerCommand<string>(CommandKinds.ConnectVehicle, () => 'connected');
    assert.equal(await bus.dispatch(connectVehicle()), 'connected');
  });

  test('commands and queries live in separate registries', async () => {
    const bus = new CommandBus();
    bus.registerCommand(CommandKinds.ReadDtcs, () => []);
    bus.registerQuery(QueryKinds.GetSession, () => undefined);
    assert.equal(bus.hasCommand(CommandKinds.ReadDtcs), true);
    assert.equal(bus.hasQuery(CommandKinds.ReadDtcs), false);
    assert.equal(bus.hasQuery(QueryKinds.GetSession), true);
    assert.deepEqual(bus.commandKinds(), [CommandKinds.ReadDtcs]);
    assert.deepEqual(bus.queryKinds(), [QueryKinds.GetSession]);
  });

  test('dispatching without a handler raises NoHandlerError', async () => {
    const bus = new CommandBus();
    await assert.rejects(bus.dispatch(readDtcs()), NoHandlerError);
    await assert.rejects(bus.query(getEcuList()), (error: unknown) => {
      assert.ok(error instanceof NoHandlerError);
      assert.match(error.message, /query/);
      return true;
    });
  });

  test('a duplicate registration is a wiring error', () => {
    const bus = new CommandBus();
    bus.registerCommand(CommandKinds.ConnectVehicle, () => undefined);
    assert.throws(() => bus.registerCommand(CommandKinds.ConnectVehicle, () => undefined), DuplicateHandlerError);
    bus.registerQuery(QueryKinds.GetSession, () => undefined);
    assert.throws(() => bus.registerQuery(QueryKinds.GetSession, () => undefined), DuplicateHandlerError);
  });

  test('handler results are awaited', async () => {
    const bus = new CommandBus();
    bus.registerCommand<number>(CommandKinds.ReadDtcs, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return 42;
    });
    assert.equal(await bus.dispatch(readDtcs()), 42);
  });

  test('getSession query factory produces the stable kind', () => {
    assert.equal(getSession().kind, 'session.get');
    assert.equal(QueryKinds.GetSession, 'session.get');
  });
});
