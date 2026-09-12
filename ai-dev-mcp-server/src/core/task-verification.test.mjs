import assert from "node:assert/strict";
import test from "node:test";
import {
  metAcceptanceCriteria,
  verificationCheckSummary,
  verificationPassed
} from "./task-verification.mjs";

const check = (type, result) => ({ type, result });

test("a run that checked nothing proves nothing", () => {
  assert.equal(verificationPassed([]), false);
});

test("each check type has its own idea of good", () => {
  assert.equal(verificationPassed([check("quality_gate", { status: "passed" })]), true);
  assert.equal(verificationPassed([check("quality_gate", { status: "passed_with_blocked" })]), false);
  assert.equal(verificationPassed([check("frontend_qa", { gate: "pass" })]), true);
  assert.equal(verificationPassed([check("frontend_qa", { gate: "block" })]), false);
  assert.equal(verificationPassed([check("frontend_product", { ok: true })]), true);
  assert.equal(verificationPassed([check("frontend_product", { ok: "yes" })]), false);
  assert.equal(verificationPassed([check("archify_deliver", { ok: true })]), true);
  assert.equal(verificationPassed([check("archify_visual_check", { ok: true })]), true);
  // Hygiene is the one check that may warn and still pass.
  assert.equal(verificationPassed([check("change_hygiene", { status: "warn" })]), true);
  assert.equal(verificationPassed([check("change_hygiene", { status: "block" })]), false);
  // Security scanners read the same way, and a run where every scanner was
  // missing or offline passes: it is a `pass` with `checked: 0`, which is what
  // the report says out loud rather than a failure nobody can act on.
  assert.equal(verificationPassed([check("security_scan", { status: "pass", summary: { checked: 0 } })]), true);
  assert.equal(verificationPassed([check("security_scan", { status: "warn" })]), true);
  assert.equal(verificationPassed([check("security_scan", { status: "block" })]), false);
  // A coverage floor only appears when a task asked for one, and a floor
  // nobody could measure is not a floor that was met.
  assert.equal(verificationPassed([check("coverage", { status: "pass", line_percent: 91 })]), true);
  assert.equal(verificationPassed([check("coverage", { status: "below_minimum", line_percent: 61 })]), false);
  assert.equal(verificationPassed([check("coverage", { status: "no_report" })]), false);
});

test("an unknown check type fails closed, and one bad check sinks the run", () => {
  assert.equal(verificationPassed([check("something_new", { status: "passed", ok: true })]), false);
  assert.equal(verificationPassed([
    check("quality_gate", { status: "passed" }),
    check("change_hygiene", { status: "block" })
  ]), false);
});

test("a check with no result at all does not pass", () => {
  assert.equal(verificationPassed([{ type: "quality_gate" }]), false);
  assert.equal(verificationPassed([{ type: "frontend_qa", result: null }]), false);
});

const CRITERIA = [
  { id: "AC-1", text: "Automated checks pass for the changed area." },
  { id: "AC-2", text: "Changed UI is checked in a browser." },
  { id: "AC-3", text: "The design-first implementation gate is green." },
  { id: "AC-4", text: "The diagram is delivered via archify_deliver." },
  { id: "AC-5", text: "Somebody reads the release notes." }
];

const met = (input) => metAcceptanceCriteria({
  acceptanceCriteria: CRITERIA, checks: [], verificationId: "verification-1", ...input
});

test("a passing run meets the automated-checks criterion and nothing else by default", () => {
  const criteria = met({});
  assert.deepEqual(criteria, [
    { id: "AC-1", status: "met", evidence: ["verification-1"] },
    { id: "AC-3", status: "met", evidence: ["verification-1"] }
  ]);
});

test("the UI criterion is met only when frontend QA actually ran", () => {
  assert.deepEqual(met({ frontendChecked: true }).map((item) => item.id), ["AC-1", "AC-2", "AC-3"]);
  assert.equal(met({}).some((item) => item.id === "AC-2"), false);
});

test("strict visual reference QA satisfies the same criterion as the implementation gate", () => {
  const criteria = metAcceptanceCriteria({
    acceptanceCriteria: [{ id: "AC-V", text: "Strict visual reference QA is recorded." }],
    checks: [], verificationId: "v"
  });
  assert.deepEqual(criteria, [{ id: "AC-V", status: "met", evidence: ["v"] }]);
});

test("a delivery criterion needs a delivery check, and any visual check it ran must be ok", () => {
  const deliverOnly = met({ checks: [check("archify_deliver", { ok: true })] });
  assert.ok(deliverOnly.some((item) => item.id === "AC-4"));

  const bothOk = met({ checks: [check("archify_deliver", { ok: true }), check("archify_visual_check", { ok: true })] });
  assert.ok(bothOk.some((item) => item.id === "AC-4"));

  const visualFailed = met({ checks: [check("archify_deliver", { ok: true }), check("archify_visual_check", { ok: false })] });
  assert.equal(visualFailed.some((item) => item.id === "AC-4"), false);

  const deliveryFailed = met({ checks: [check("archify_deliver", { ok: false })] });
  assert.equal(deliveryFailed.some((item) => item.id === "AC-4"), false);
});

test("a criterion matching two rules is returned twice, as the task store receives it", () => {
  const criteria = metAcceptanceCriteria({
    acceptanceCriteria: [{ id: "AC-X", text: "Automated checks pass and the design-first implementation gate is green." }],
    checks: [], verificationId: "v"
  });
  assert.equal(criteria.length, 2);
  assert.deepEqual(new Set(criteria.map((item) => item.id)), new Set(["AC-X"]));
});

test("criteria are matched on text, so nothing matches an empty list", () => {
  assert.deepEqual(metAcceptanceCriteria({ acceptanceCriteria: [], checks: [], verificationId: "v" }), []);
});

test("the evidence digest names each check and how it reported itself", () => {
  assert.deepEqual(verificationCheckSummary([
    check("quality_gate", { status: "passed" }),
    check("frontend_qa", { gate: "block" }),
    check("frontend_product", { ok: true }),
    { type: "orphan" }
  ]), [
    { type: "quality_gate", status: "passed" },
    { type: "frontend_qa", status: "block" },
    { type: "frontend_product", status: "unknown" },
    { type: "orphan", status: "unknown" }
  ]);
  assert.deepEqual(verificationCheckSummary([]), []);
});
