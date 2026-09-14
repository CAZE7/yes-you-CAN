/**
 * The adapter registry (AGENTS 4, 0.E E16).
 *
 * `create` on an unknown id is the one message an operator sees after typing a device
 * name wrong, and `get` is what the UI consults before offering anything. Neither had a
 * test of its own — both were only reached as a side effect of other suites, which is
 * what "87,5 % lines" means here: the happy paths of somebody else's file.
 */

import assert from "node:assert/strict";
import { AdapterUnsupportedError } from "@vdp/shared";
import { describe, test } from "vitest";
import { CanAdapterRegistry, type CanBus } from "./index.js";

function fakeBus(): CanBus {
  return {
    send: async () => {},
    onFrame: () => () => {},
    open: async () => {},
    close: async () => {},
  } as unknown as CanBus;
}

function factory(
  id: string,
  displayName: string,
): {
  id: string;
  displayName: string;
  create: () => CanBus;
} {
  return { id, displayName, create: () => fakeBus() };
}

describe("CanAdapterRegistry", () => {
  test("a registered factory is found by id, and create passes the options through", () => {
    const registry = new CanAdapterRegistry();
    const seen: Array<Record<string, unknown> | undefined> = [];
    registry.register({
      id: "fake",
      displayName: "Fake bus",
      create: (options) => {
        seen.push(options);
        return fakeBus();
      },
    });

    assert.equal(registry.get("fake")?.displayName, "Fake bus");
    assert.equal(registry.get("other"), undefined, "an unknown id is not an error to look up");
    assert.ok(registry.create("fake", { device: "/dev/ttyUSB0" }));
    assert.deepEqual(
      seen,
      [{ device: "/dev/ttyUSB0" }],
      "the options reach the factory untouched, and no default is invented for them",
    );
    assert.deepEqual(registry.list(), [{ id: "fake", displayName: "Fake bus" }]);
  });

  test("creating an unknown adapter names the registered ones", () => {
    const registry = new CanAdapterRegistry();
    registry.register(factory("socketcan", "SocketCAN"));
    registry.register(factory("vcan", "Virtual CAN"));
    assert.throws(
      () => registry.create("slcan"),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /Unknown CAN adapter "slcan"/);
        assert.match(message, /socketcan, vcan/, "the message has to offer the alternatives");
        return true;
      },
    );
  });

  test("re-registering an id replaces it and keeps its place in the list", () => {
    // The list is an offer to an operator, so its order is the order things were
    // registered in — a replacement must not jump to the end of the menu.
    const registry = new CanAdapterRegistry();
    registry.register(factory("a", "first"));
    registry.register(factory("b", "second"));
    registry.register(factory("a", "replaced"));
    assert.deepEqual(
      registry.list().map((entry) => `${entry.id}:${entry.displayName}`),
      ["a:replaced", "b:second"],
    );
  });

  test("a factory that cannot serve the request reports it as unsupported, unchanged", () => {
    // The registry does not decide which transport works — the factory throws the typed
    // error, and the type is what lets the UI say "this adapter cannot do that" instead
    // of "something broke". Swallowing or wrapping it here would cost that difference.
    const registry = new CanAdapterRegistry();
    registry.register({
      id: "elm",
      displayName: "ELM327",
      create: () => {
        throw new AdapterUnsupportedError("CAN-FD is not available on ELM327");
      },
    });
    assert.throws(() => registry.create("elm"), AdapterUnsupportedError);
  });

  test("a factory without a probe is registered like any other", () => {
    const registry = new CanAdapterRegistry();
    registry.register(factory("plain", "Plain"));
    assert.equal(registry.get("plain")?.isAvailable, undefined, "probing is optional (§4)");

    const probeable = { ...factory("probed", "Probed"), isAvailable: () => false };
    registry.register(probeable);
    assert.equal(registry.get("probed")?.isAvailable?.(), false);
  });
});
