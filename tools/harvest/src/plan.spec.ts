/**
 * The plan is data, and the plan is read-only (ADR 0058).
 *
 * Two things are pinned here. First, that resolving a plan is deterministic and
 * bounded: the DID list comes out sorted and deduplicated, a wide range hits the
 * per-ECU cap at one visible place, and the budgets have defaults that are budgets
 * rather than guesses. Second — and this is the guardrail with teeth — that no
 * service a harvest may send is a write, and that the list of forbidden services
 * covers every write service the platform knows.
 */

import assert from "node:assert/strict";
import { SID } from "@vdp/protocols-uds";
import { test } from "vitest";
import {
  DEFAULT_HARVEST_BUDGET,
  describeHarvestPlan,
  FORBIDDEN_HARVEST_SERVICES,
  findWriteRequests,
  HARVEST_SERVICES,
  harvestServiceIds,
  resolveHarvestPlan,
  STANDARD_DIDS,
  STANDARD_IDENTIFICATION_RANGE,
} from "./plan.js";

test("the default plan sweeps the two standardised blocks and reads the fault memory", () => {
  const plan = resolveHarvestPlan();
  assert.deepEqual(
    plan.didRanges.map((range) => range.name),
    ["identification", "obd"],
  );
  assert.ok(plan.dids.includes(0xf190), "the VIN DID is always asked");
  assert.ok(plan.dids.includes(0xf40c), "the OBD block is swept too");
  assert.equal(plan.readDtcs, true);
  assert.equal(plan.readDtcRecords, true);
  assert.equal(plan.functionalId, 0x7df, "ISO 15765-4 functional request identifier");
});

test("the DID list is sorted, deduplicated and bounded", () => {
  const plan = resolveHarvestPlan({ extraDids: [0xf190, 0x1234, 0x1234] });
  const sorted = [...plan.dids].sort((a, b) => a - b);
  assert.deepEqual(plan.dids, sorted, "the list is sorted so two runs produce the same file");
  assert.equal(new Set(plan.dids).size, plan.dids.length, "no DID is asked twice");
  assert.ok(plan.dids.includes(0x1234), "an extra DID outside every range is still asked");

  const capped = resolveHarvestPlan({
    didRanges: [{ name: "wide", from: 0x0000, to: 0xffff, reason: "test" }],
    maxDidsPerEcu: 20,
  });
  assert.equal(capped.dids.length, 20, "the cap is applied where it can be seen, not mid-run");
});

test("every standardised identification DID is in the default plan", () => {
  const plan = resolveHarvestPlan();
  for (const entry of STANDARD_DIDS) {
    assert.ok(plan.dids.includes(entry.did), `DID 0x${entry.did.toString(16)} (${entry.label})`);
    assert.ok(plan.standardDids.includes(entry.did));
  }
  assert.equal(STANDARD_IDENTIFICATION_RANGE.from, 0xf180);
  assert.equal(STANDARD_IDENTIFICATION_RANGE.to, 0xf1ff);
});

test("every service a harvest may send states what the read is for", () => {
  assert.ok(HARVEST_SERVICES.length >= 5);
  for (const entry of HARVEST_SERVICES) {
    assert.ok(entry.why.length > 10, `service 0x${entry.service.toString(16)} needs a reason`);
    assert.ok(entry.name.length > 0);
    assert.equal(
      FORBIDDEN_HARVEST_SERVICES[entry.service],
      undefined,
      `0x${entry.service.toString(16)} cannot be both allowed and forbidden`,
    );
  }
  assert.deepEqual(
    HARVEST_SERVICES.map((entry) => entry.service),
    [...HARVEST_SERVICES.map((entry) => entry.service)].sort((a, b) => a - b),
    "the list is sorted, so a diff of two plans is readable",
  );
});

test("no service a harvest may send is a write", () => {
  const violations = findWriteRequests(harvestServiceIds());
  assert.deepEqual(violations, [], violations.join("\n"));
  assert.deepEqual(findWriteRequests([]), []);
});

test("every write service the protocol knows is forbidden to a harvest", () => {
  const writeServices = [
    SID.CLEAR_DIAGNOSTIC_INFORMATION,
    SID.SECURITY_ACCESS,
    SID.COMMUNICATION_CONTROL,
    SID.WRITE_DATA_BY_IDENTIFIER,
    SID.INPUT_OUTPUT_CONTROL_BY_IDENTIFIER,
    SID.REQUEST_DOWNLOAD,
    SID.CONTROL_DTC_SETTING,
  ];
  for (const service of writeServices) {
    assert.ok(
      FORBIDDEN_HARVEST_SERVICES[service] !== undefined,
      `service 0x${service.toString(16)} must be on the forbidden list`,
    );
    assert.ok(!harvestServiceIds().includes(service), `0x${service.toString(16)} must not be sent`);
  }
  const violations = findWriteRequests(writeServices);
  assert.equal(violations.length, writeServices.length);
  assert.match(violations[0] ?? "", /0x14/, "the violation names the service in hex");
  assert.match(violations[0] ?? "", /not read-only/, "and says why");
});

test("the plan describes itself in one readable block", () => {
  const text = describeHarvestPlan(resolveHarvestPlan({ requestGapMs: 12, budgetPerEcuMs: 4_000 }));
  assert.match(text, /DIDs: \d+/);
  assert.match(text, /identification 0xf180–0xf1ff/);
  assert.match(text, /Budget: 4000 ms je ECU · Abstand 12 ms/);
  assert.match(text, /Fehlerspeicher: ja · Aufzeichnungen: ja/);
});

test("switching the fault memory off is visible in the plan and in its description", () => {
  const plan = resolveHarvestPlan({ readDtcs: false, readDtcRecords: false });
  assert.equal(plan.readDtcs, false);
  assert.match(describeHarvestPlan(plan), /Fehlerspeicher: nein · Aufzeichnungen: nein/);
});

test("the budgets have defaults that are stated, not invented per call", () => {
  const plan = resolveHarvestPlan();
  assert.equal(plan.budgetPerEcuMs, DEFAULT_HARVEST_BUDGET.budgetPerEcuMs);
  assert.equal(plan.requestGapMs, DEFAULT_HARVEST_BUDGET.requestGapMs);
  assert.equal(
    plan.repeatReadsForStability,
    DEFAULT_HARVEST_BUDGET.repeatReadsForStability,
    "a value is only called stable when it was read twice",
  );
  assert.ok(DEFAULT_HARVEST_BUDGET.requestGapMs > 0, "a real bus is not flooded by default");
});
