import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  DefaultIdGenerator,
  FixedClock,
  FixedIdGenerator,
  InMemoryEventBus,
  InMemorySessionStore,
  NullDefinitionProvider,
  RecordingEventBus,
  StaticDefinitionProvider,
  clockFrom,
  systemClock,
} from "./index.js";

describe("clock port", () => {
  test("system clock produces plausible values", () => {
    assert.ok(systemClock.now() > 0);
    assert.match(systemClock.iso(), /^\d{4}-\d{2}-\d{2}T/);
  });

  test("fixed clock is deterministic and advances only forward", () => {
    const clock = new FixedClock(1000);
    assert.equal(clock.now(), 1000);
    assert.equal(clock.iso(), new Date(1000).toISOString());
    clock.advance(500);
    assert.equal(clock.now(), 1500);
    clock.set(42);
    assert.equal(clock.now(), 42);
    assert.throws(() => clock.advance(-1), /backwards/);
  });

  test("clockFrom adapts a bare function", () => {
    let ms = 7;
    const clock = clockFrom(() => ms);
    assert.equal(clock.now(), 7);
    assert.equal(clock.iso(), new Date(7).toISOString());
    ms = 9;
    assert.equal(clock.now(), 9);
  });
});

describe("id generator port", () => {
  test("default generator uses the clock and prefix", () => {
    const clock = new FixedClock(1234);
    const generator = new DefaultIdGenerator(clock);
    const a = generator.next("sess");
    const b = generator.next("sess");
    assert.ok(a.startsWith("sess_"));
    assert.notEqual(a, b);
  });

  test("fixed generator is deterministic", () => {
    const generator = new FixedIdGenerator();
    assert.equal(generator.next("ecu"), "ecu_id_1");
    assert.equal(generator.next("ecu"), "ecu_id_2");
  });
});

describe("event bus port", () => {
  test("in-memory bus delivers to subscribers and unsubscribes", () => {
    const bus = new InMemoryEventBus();
    const seen: string[] = [];
    const unsubscribe = bus.subscribe("dtcs-read", (payload) =>
      seen.push(String(payload.dtcCount)),
    );
    bus.publish("dtcs-read", { sessionId: "s", ecuCount: 1, dtcCount: 3 });
    assert.deepEqual(seen, ["3"]);
    unsubscribe();
    bus.publish("dtcs-read", { sessionId: "s", ecuCount: 1, dtcCount: 4 });
    assert.deepEqual(seen, ["3"], "no delivery after unsubscribe");
  });

  test("in-memory bus ignores events with no listeners", () => {
    const bus = new InMemoryEventBus();
    assert.doesNotThrow(() => bus.publish("vehicle-connected", { sessionId: "s", ecuCount: 0 }));
  });

  test("recording bus captures events and filters by type", () => {
    const bus = new RecordingEventBus();
    bus.publish("dtcs-read", { sessionId: "s", ecuCount: 1, dtcCount: 2 });
    bus.publish("vehicle-connected", { sessionId: "s", ecuCount: 1 });
    assert.equal(bus.events.length, 2);
    assert.equal(bus.ofType("dtcs-read").length, 1);
    bus.clear();
    assert.equal(bus.events.length, 0);
  });

  test("recording bus accepts (inert) subscriptions like any bus", () => {
    const bus = new RecordingEventBus();
    const unsubscribe = bus.subscribe("dtcs-read", () => undefined);
    assert.equal(typeof unsubscribe, "function");
    unsubscribe();
  });

  test("in-memory bus supports several listeners on one event", () => {
    const bus = new InMemoryEventBus();
    const seen: number[] = [];
    bus.subscribe("dtcs-read", () => seen.push(1));
    const second = bus.subscribe("dtcs-read", () => seen.push(2));
    bus.publish("dtcs-read", { sessionId: "s", ecuCount: 1, dtcCount: 0 });
    assert.deepEqual(seen.sort(), [1, 2]);
    second();
    bus.publish("dtcs-read", { sessionId: "s", ecuCount: 1, dtcCount: 0 });
    assert.equal(seen.length, 3, "unsubscribed listener stops receiving");
  });
});

describe("session store port", () => {
  test("in-memory store round-trips sessions", async () => {
    const store = new InMemorySessionStore<{ id: string; startedAt: string }>();
    await store.save({ id: "session_1", startedAt: "2026-01-01T00:00:00.000Z" });
    assert.equal(await store.exists("session_1"), true);
    assert.equal((await store.load("session_1"))?.id, "session_1");
    const list = await store.list();
    assert.equal(list.length, 1);
    assert.equal(list[0]?.id, "session_1");
    await store.delete("session_1");
    assert.equal(await store.exists("session_1"), false);
    assert.equal(await store.load("missing"), undefined);
  });

  test("the default summarizer tolerates sparse sessions and keeps rich ones", async () => {
    type Loose = {
      id: string;
      startedAt?: string;
      endedAt?: string;
      title?: string;
      schemaVersion?: number;
    };
    const store = new InMemorySessionStore<Loose>();
    await store.save({ id: "session_sparse" });
    await store.save({
      id: "session_full",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T01:00:00.000Z",
      title: "Test",
      schemaVersion: 1,
    });
    const list = await store.list();
    const sparse = list.find((entry) => entry.id === "session_sparse");
    assert.ok(sparse);
    assert.equal(sparse.startedAt, "");
    assert.equal(sparse.endedAt, undefined);
    assert.equal(sparse.schemaVersion, undefined);
    const full = list.find((entry) => entry.id === "session_full");
    assert.ok(full);
    assert.equal(full.startedAt, "2026-01-01T00:00:00.000Z");
    assert.equal(full.endedAt, "2026-01-01T01:00:00.000Z");
    assert.equal(full.title, "Test");
    assert.equal(full.schemaVersion, 1);
  });

  test("a custom summarizer wins over the default", async () => {
    const store = new InMemorySessionStore<{ id: string }>((session) => ({
      id: session.id,
      startedAt: "custom",
      title: "derived",
    }));
    await store.save({ id: "session_x" });
    const [entry] = await store.list();
    assert.equal(entry?.startedAt, "custom");
    assert.equal(entry?.title, "derived");
  });
});

describe("definition provider port", () => {
  test("null provider knows nothing", () => {
    const provider = new NullDefinitionProvider();
    assert.deepEqual(provider.listPackages(), []);
    assert.equal(provider.findEcu({}), undefined);
    assert.equal(provider.findDid({ did: 1 }), undefined);
    assert.equal(provider.findSignal("x"), undefined);
    assert.equal(provider.source, "none");
  });

  test("static provider looks up ecus, dids and signals", () => {
    const provider = new StaticDefinitionProvider({
      source: "test",
      packages: [{ oem: "generic", name: "Generic", version: "1.0.0" }],
      ecus: [
        {
          id: "engine",
          name: "Engine",
          oem: "generic",
          protocol: "uds",
          address: { txId: 0x7e0, rxId: 0x7e8 },
        },
      ],
      dids: [{ did: 0xf190, ecu: "engine", name: "VIN", signalIds: ["engine.vin"] }],
      signals: [{ id: "engine.vin", name: "VIN", ecu: "engine", did: 0xf190 }],
    });
    assert.equal(provider.source, "test");
    assert.equal(provider.listPackages().length, 1);
    assert.equal(provider.findEcu({ rxId: 0x7e8 })?.id, "engine");
    assert.equal(provider.findEcu({ txId: 0x7e0 })?.id, "engine");
    assert.equal(provider.findEcu({ id: "engine" })?.name, "Engine");
    assert.equal(provider.findEcu({ rxId: 0x111 }), undefined);
    assert.equal(provider.findEcu({ rxId: 0x7e8, oem: "other" }), undefined);
    assert.equal(provider.findDid({ did: 0xf190, ecu: "engine" })?.name, "VIN");
    assert.equal(provider.findDid({ did: 0xf190, ecu: "abs" }), undefined);
    assert.equal(provider.findSignal("engine.vin")?.did, 0xf190);
    assert.equal(provider.findSignal("missing"), undefined);
  });

  test('static provider defaults are empty and source falls back to "static"', () => {
    const provider = new StaticDefinitionProvider({});
    assert.equal(provider.source, "static");
    assert.deepEqual(provider.listPackages(), []);
    assert.equal(provider.findEcu({ id: "anything" }), undefined);
    assert.equal(provider.findDid({ did: 1 }), undefined);
    assert.equal(provider.findSignal("anything"), undefined);
  });

  test("static provider handles an ECU without an address and an ecu-less did", () => {
    const provider = new StaticDefinitionProvider({
      ecus: [
        { id: "gateway", name: "Gateway", oem: "generic", protocol: "uds" },
        {
          id: "engine",
          name: "Engine",
          oem: "generic",
          protocol: "uds",
          address: { txId: 0x7e0, rxId: 0x7e8 },
        },
      ],
      dids: [{ did: 0xf187, name: "Part Number" }],
    });
    assert.equal(provider.findEcu({ id: "gateway" })?.address, undefined);
    assert.equal(provider.findEcu({ rxId: 0x7e8 })?.id, "engine");
    const did = provider.findDid({ did: 0xf187 });
    assert.equal(did?.name, "Part Number");
    assert.equal(did?.ecu, undefined);
  });
});
