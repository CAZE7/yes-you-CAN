/**
 * CAN frame layer property tests (testing standards: property-based tests for
 * every frame encoder/decoder).
 *
 * DLC ↔ payload-length mapping is a classic off-by-one trap (non-linear CAN-FD
 * lengths, ISO 11898-1), so both directions are checked over the *entire* valid
 * domain, not just samples.
 */

import assert from "node:assert/strict";
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import {
  CANFD_MAX_PAYLOAD,
  CAN_MAX_DLC,
  type CanFrame,
  createFrame,
  dlcToLength,
  frameMatchesFilters,
  lengthToDlc,
} from "./frame.js";

describe("DLC mapping", () => {
  test("classic CAN: dlcToLength is the identity on 0..8", () => {
    fc.assert(
      fc.property(fc.nat({ max: CAN_MAX_DLC }), (dlc) => {
        assert.equal(dlcToLength(dlc), dlc);
      }),
    );
  });

  test("property: classic CAN length → dlc → length is the identity for all payload sizes", () => {
    fc.assert(
      fc.property(fc.nat({ max: CAN_MAX_DLC }), (length) => {
        assert.equal(dlcToLength(lengthToDlc(length)), length);
      }),
    );
  });

  test("property: CAN-FD payload → dlc → payload is the identity on every legal FD frame length", () => {
    // ISO 11898-1: DLC 9..15 denote 12/16/20/24/32/48/64 bytes — lengths in
    // between (e.g. 9) do not exist on the wire, only as padding targets.
    const legalFdLengths = [0, 1, 2, 3, 4, 5, 6, 7, 8, 12, 16, 20, 24, 32, 48, 64];
    fc.assert(
      fc.property(fc.constantFrom(...legalFdLengths), (length) => {
        assert.equal(dlcToLength(lengthToDlc(length, true), true), length);
      }),
    );
  });

  test("property: illegal FD lengths pad up to the next legal frame length, never down", () => {
    const legalFdLengths = [0, 1, 2, 3, 4, 5, 6, 7, 8, 12, 16, 20, 24, 32, 48, 64];
    fc.assert(
      fc.property(fc.nat({ max: CANFD_MAX_PAYLOAD }), (length) => {
        const padded = dlcToLength(lengthToDlc(length, true), true);
        assert.ok(padded >= length, "padding must not truncate");
        assert.ok(legalFdLengths.includes(padded), "the result must be a legal FD length");
        assert.equal(
          lengthToDlc(padded, true),
          lengthToDlc(length, true),
          "the chosen DLC must be minimal",
        );
      }),
    );
  });

  test("property: CAN-FD dlc → length → dlc is the identity for every raw DLC 0..15", () => {
    fc.assert(
      fc.property(fc.nat({ max: 15 }), (dlc) => {
        assert.equal(lengthToDlc(dlcToLength(dlc, true), true), dlc);
      }),
    );
  });

  test("classic CAN clamps out-of-range payload sizes to the MTU", () => {
    assert.equal(lengthToDlc(64, false), CAN_MAX_DLC);
    assert.equal(dlcToLength(15, false), CAN_MAX_DLC);
  });
});

describe("frameMatchesFilters", () => {
  const frame = (id: number, extended = false): CanFrame =>
    createFrame(id, new Uint8Array(0), { extended });

  test("no filters means every frame passes", () => {
    assert.equal(frameMatchesFilters(frame(0x123), []), true);
  });

  test("mask 0 matches every id, exact mask matches only itself", () => {
    assert.equal(frameMatchesFilters(frame(0x7ff), [{ id: 0, mask: 0 }]), true);
    assert.equal(frameMatchesFilters(frame(0x100), [{ id: 0x100, mask: 0x7ff }]), true);
    assert.equal(frameMatchesFilters(frame(0x101), [{ id: 0x100, mask: 0x7ff }]), false);
  });

  test("property: an id always matches a filter built from its own bits", () => {
    fc.assert(
      fc.property(fc.nat({ max: 0x7ff }), (id) => {
        assert.equal(frameMatchesFilters(frame(id), [{ id, mask: 0x7ff }]), true);
        assert.equal(frameMatchesFilters(frame(id), [{ id: 0, mask: 0 }]), true);
      }),
    );
  });

  test("property: (id & mask) equality decides, regardless of filter id layout", () => {
    fc.assert(
      fc.property(fc.nat({ max: 0x7ff }), fc.nat({ max: 0x7ff }), (a, b) => {
        const mask = 0x7ff;
        assert.equal(frameMatchesFilters(frame(a), [{ id: b, mask }]), (a & mask) === (b & mask));
      }),
    );
  });

  test("extended flag gates a filter when declared", () => {
    assert.equal(
      frameMatchesFilters(frame(0x123, true), [{ id: 0x123, mask: 0x7ff, extended: true }]),
      true,
    );
    assert.equal(
      frameMatchesFilters(frame(0x123, false), [{ id: 0x123, mask: 0x7ff, extended: true }]),
      false,
    );
    // Without the extended field, the filter is format-agnostic.
    assert.equal(frameMatchesFilters(frame(0x123, true), [{ id: 0x123, mask: 0x7ff }]), true);
  });

  test("any matching filter in the list accepts the frame", () => {
    const filters = [
      { id: 0x001, mask: 0x7ff },
      { id: 0x200, mask: 0x700 },
    ];
    assert.equal(frameMatchesFilters(frame(0x2ff), filters), true);
    assert.equal(frameMatchesFilters(frame(0x100), filters), false);
  });
});

describe("createFrame", () => {
  test("defaults: dlc derived from payload, extended from the id, channel can0", () => {
    const frame = createFrame(0x1abcdef, new Uint8Array(6));
    assert.equal(frame.extended, true);
    assert.equal(frame.dlc, 6);
    assert.equal(frame.channel, "can0");
    assert.equal(frame.fd, false);
    assert.equal(frame.direction, undefined);
  });

  test("explicit options are honoured", () => {
    const frame = createFrame(0x123, new Uint8Array(2), {
      extended: false,
      fd: true,
      channel: "can1",
      timestamp: 1234,
      direction: "tx",
      brs: true,
    });
    assert.equal(frame.extended, false);
    assert.equal(frame.fd, true);
    assert.equal(frame.channel, "can1");
    assert.equal(frame.timestamp, 1234);
    assert.equal(frame.direction, "tx");
    assert.equal(frame.brs, true);
  });

  test("FD dlc is derived from the non-linear length table", () => {
    expect(createFrame(0x123, new Uint8Array(12), { fd: true }).dlc).toBe(9);
    expect(createFrame(0x123, new Uint8Array(20), { fd: true }).dlc).toBe(11);
    expect(createFrame(0x123, new Uint8Array(64), { fd: true }).dlc).toBe(15);
  });
});
