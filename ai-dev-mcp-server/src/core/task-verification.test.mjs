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

// A failed verification reduced to `quality_gate: failed` and the reason
// stayed in a command's stdout nobody reading the verdict ever saw.
test("a failed check carries the line that says why, and the gate's hint", () => {
  const hint = "Node >= 21 treats positional arguments as glob patterns; a directory is run as a test file.";
  const [summary] = verificationCheckSummary([
    check("quality_gate", {
      status: "failed",
      results: [
        { label: "Lint", status: "passed", stdout: "all good", stderr: "" },
        {
          label: "Test",
          status: "failed",
          hint,
          // What npm really prints: its own echo first, the runner's banner
          // next, and only then the line that says anything.
          stdout: [
            "",
            "> repro47@1.0.0 test",
            "> node --test test/",
            "TAP version 13",
            "# Error: Cannot find module '/home/dev/repro47/test'",
            "# fail 1"
          ].join("\n"),
          stderr: ""
        }
      ]
    })
  ]);

  assert.equal(summary.status, "failed");
  assert.equal(summary.detail.output, "Error: Cannot find module '/home/dev/repro47/test'");
  assert.equal(summary.detail.hint, hint);
});

test("a check that came back good carries no detail, and neither does a silent failure", () => {
  const [passed] = verificationCheckSummary([
    check("quality_gate", {
      status: "passed",
      results: [{ label: "Test", status: "passed", stdout: "Error: none of this matters", hint: "" }]
    })
  ]);
  assert.equal(Object.hasOwn(passed, "detail"), false, "a passing check explains nothing");

  // `unchecked` passes, so it is not dressed up as a failure either — its
  // `next_step` is what says nothing ran.
  const [unchecked] = verificationCheckSummary([
    check("security_scan", { status: "unchecked", summary: { checked: 0 } })
  ]);
  assert.deepEqual(unchecked, { type: "security_scan", status: "unchecked" });

  const [silent] = verificationCheckSummary([check("frontend_qa", { gate: "block" })]);
  assert.deepEqual(silent, { type: "frontend_qa", status: "block" });

  // A check that never ran reports the error it threw.
  const [unavailable] = verificationCheckSummary([
    check("quality_gate", { status: "unavailable", error: "Quality gate file not found: /repo/.ai-dev/quality-gate.md" })
  ]);
  assert.match(unavailable.detail.output, /Quality gate file not found/);
  assert.equal(Object.hasOwn(unavailable.detail, "hint"), false);
});

// The gate compares the project's `engines.node` with the Node it ran
// on. A verdict that only shows the mismatch when something else already failed
// is not a warning, so it survives a passing check too.
test("a Node the project did not choose is carried into the verdict", () => {
  const engines_mismatch = {
    declared: "20",
    running: "v22.22.2",
    message: "This project declares engines.node 20; the quality gate ran its commands on Node v22.22.2."
  };

  const [failed] = verificationCheckSummary([
    check("quality_gate", {
      status: "failed",
      runtime: { node: "v22.22.2", engines: { declared: "20", satisfied: false }, engines_mismatch },
      results: [{ label: "Test", status: "failed", hint: "", stdout: "# Error: Cannot find module '/repo/test'", stderr: "" }]
    })
  ]);
  assert.equal(failed.detail.engines_mismatch.declared, "20");
  assert.equal(failed.detail.engines_mismatch.running, "v22.22.2");
  assert.match(failed.detail.output, /Cannot find module/, "the cause is still the cause");

  const [passed] = verificationCheckSummary([
    check("quality_gate", {
      status: "passed",
      runtime: { node: "v22.22.2", engines: { declared: "20", satisfied: false }, engines_mismatch },
      results: [{ label: "Test", status: "passed", stdout: "ok", hint: "" }]
    })
  ]);
  assert.deepEqual(passed, { type: "quality_gate", status: "passed", detail: { engines_mismatch } });

  // Everything that is not a mismatch stays silent on a passing check.
  const [agreeing] = verificationCheckSummary([
    check("quality_gate", {
      status: "passed",
      runtime: { node: "v22.22.2", engines: { declared: ">=18", satisfied: true } },
      results: [{ label: "Test", status: "passed", stdout: "Error: none of this matters", hint: "" }]
    })
  ]);
  assert.deepEqual(agreeing, { type: "quality_gate", status: "passed" });

  const [undeclared] = verificationCheckSummary([
    check("quality_gate", { status: "passed", runtime: { node: "v22.22.2" }, results: [] })
  ]);
  assert.deepEqual(undeclared, { type: "quality_gate", status: "passed" });
});

test("a Node mismatch never turns a passing run into a failing one", () => {
  const checks = [check("quality_gate", {
    status: "passed",
    runtime: {
      node: "v22.22.2",
      engines: { declared: "20", satisfied: false },
      engines_mismatch: { declared: "20", running: "v22.22.2", message: "warning only" }
    },
    results: []
  })];
  assert.equal(verificationPassed(checks), true, "the gate warns; it does not block");
});
