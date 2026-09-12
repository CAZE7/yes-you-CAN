import assert from "node:assert/strict";
import { test } from "vitest";
import {
  AdapterUnsupportedError,
  DecodeError,
  DefinitionError,
  EncodeError,
  type ErrorCode,
  IsoTpError,
  ProtocolError,
  SafetyViolationError,
  SessionError,
  StorageError,
  TransportClosedError,
  TransportError,
  TransportTimeoutError,
  UdsNegativeResponseError,
  UdsTimeoutError,
  VdpError,
  asError,
  messageOf,
} from "./errors.js";

/**
 * The table is the contract: upper layers react via `code`, never via string
 * matching (AGENTS 35). A mixed-up assignment — two classes sharing one code —
 * shows up here instead of steering a wrong decision in the field.
 */
const cases: ReadonlyArray<{ error: VdpError; code: ErrorCode; name: string }> = [
  { error: new TransportError("t"), code: "E_TRANSPORT", name: "TransportError" },
  {
    error: new TransportTimeoutError("t"),
    code: "E_TRANSPORT_TIMEOUT",
    name: "TransportTimeoutError",
  },
  {
    error: new TransportClosedError("t"),
    code: "E_TRANSPORT_CLOSED",
    name: "TransportClosedError",
  },
  { error: new IsoTpError("t"), code: "E_ISOTP", name: "IsoTpError" },
  {
    error: new UdsNegativeResponseError(0x22, 0x31, "requestOutOfRange"),
    code: "E_UDS_NEGATIVE_RESPONSE",
    name: "UdsNegativeResponseError",
  },
  { error: new UdsTimeoutError("t"), code: "E_UDS_TIMEOUT", name: "UdsTimeoutError" },
  { error: new ProtocolError("t"), code: "E_PROTOCOL", name: "ProtocolError" },
  { error: new DefinitionError("t"), code: "E_DEFINITION", name: "DefinitionError" },
  { error: new DecodeError("t"), code: "E_DECODE", name: "DecodeError" },
  { error: new EncodeError("t"), code: "E_ENCODE", name: "EncodeError" },
  { error: new SessionError("t"), code: "E_SESSION", name: "SessionError" },
  {
    error: new AdapterUnsupportedError("t"),
    code: "E_ADAPTER_UNSUPPORTED",
    name: "AdapterUnsupportedError",
  },
  {
    error: new SafetyViolationError("t", ["ignition on"]),
    code: "E_SAFETY_VIOLATION",
    name: "SafetyViolationError",
  },
  { error: new StorageError("t"), code: "E_STORAGE", name: "StorageError" },
];

test("every error class carries its own code and name", () => {
  for (const { error, code, name } of cases) {
    assert.equal(error.code, code, `${name} must carry ${code}`);
    assert.equal(error.name, name, "the name comes from new.target, not from VdpError");
    assert.ok(error instanceof VdpError, `${name} must be a VdpError`);
    assert.ok(error instanceof Error, `${name} must be catchable as an Error`);
    assert.ok(error.message.length > 0, "an error without a message helps nobody");
  }
});

test("codes are unique, so a caller can react to exactly one cause", () => {
  const codes = cases.map((entry) => entry.code);
  assert.equal(new Set(codes).size, codes.length, `duplicate codes: ${codes.join(", ")}`);
});

test("details survive and default to an empty object", () => {
  assert.deepEqual(new TransportError("t", { handle: 7 }).details, { handle: 7 });
  assert.deepEqual(new TransportError("t").details, {});
});

test("a safety violation names the preconditions that were not met", () => {
  const error = new SafetyViolationError("blocked", ["ignition on", "vehicle moving"], {
    speedKmh: 12,
  });
  assert.deepEqual(error.failedPreconditions, ["ignition on", "vehicle moving"]);
  assert.deepEqual(error.details, {
    failedPreconditions: ["ignition on", "vehicle moving"],
    speedKmh: 12,
  });
});

test("a UDS negative response names service and NRC readably", () => {
  const error = new UdsNegativeResponseError(0x22, 0x31, "requestOutOfRange");
  assert.equal(error.serviceId, 0x22);
  assert.equal(error.nrc, 0x31);
  assert.equal(error.nrcName, "requestOutOfRange");
  assert.equal(error.message, "UDS negative response 0x31 (requestOutOfRange) for service 0x22");
  assert.deepEqual(error.details, { serviceId: 0x22, nrc: 0x31, nrcName: "requestOutOfRange" });
});

test("messageOf names an Error by its message", () => {
  assert.equal(messageOf(new Error("boom")), "boom");
  assert.equal(messageOf(new StorageError("session gone", { id: "s1" })), "session gone");
});

test("messageOf renders a plain object instead of [object Object]", () => {
  assert.equal(messageOf({ code: "UPSTREAM_500" }), '{"code":"UPSTREAM_500"}');
  assert.equal(messageOf([1, 2]), "[1,2]");
});

test("messageOf keeps primitives readable", () => {
  assert.equal(messageOf("plain string"), "plain string");
  assert.equal(messageOf(42), "42");
  assert.equal(messageOf(true), "true");
  assert.equal(messageOf(null), "null");
  assert.equal(messageOf(undefined), "undefined");
});

test("asError keeps a real Error and names everything else", () => {
  const original = new TransportError("t", { handle: 7 });
  assert.equal(asError(original), original, "a real Error must stay the very same object");
  // Identity means: the class, the stack and the error's own fields survive.
  assert.ok(asError(original) instanceof TransportError);

  const wrapped = asError({ code: "UPSTREAM_500" });
  assert.ok(wrapped instanceof Error);
  assert.equal(wrapped.message, '{"code":"UPSTREAM_500"}');
  assert.equal(asError("plain string").message, "plain string");
});

test("messageOf survives values that cannot be serialised", () => {
  const circular: Record<string, unknown> = { name: "loop" };
  circular.self = circular;
  // The fallback is imprecise but it does not throw — the failure path must not
  // produce a second failure.
  assert.equal(messageOf(circular), "[object Object]");
  assert.equal(messageOf(10n), "10");
  assert.equal(messageOf(Symbol("marker")), "Symbol(marker)");
});
