import assert from "node:assert/strict";
import test from "node:test";
import {
  FIRST_RUN_STEPS,
  firstRunSucceeded,
  planFirstRun,
  renderFirstRunReport
} from "./first-run.mjs";

const byId = (plan) => Object.fromEntries(plan.map((item) => [item.id, item]));

test("a bare clone builds the three things every install needs, and nothing else", () => {
  const plan = byId(planFirstRun({ present: {} }));
  assert.deepEqual(
    Object.entries(plan).filter(([, item]) => item.run).map(([id]) => id),
    ["skill_registry", "search_index", "routing_benchmark"]
  );
  // The two that reach the network are never run unasked — one of them is 2.3 GB.
  assert.equal(plan.dense_model.run, false);
  assert.match(plan.dense_model.reason, /--dense/);
  assert.equal(plan.frontend_qa.run, false);
  assert.match(plan.frontend_qa.reason, /--frontend-qa/);
});

test("what is already built is left alone, and --force rebuilds it", () => {
  const present = { skill_registry: true, search_index: true, routing_benchmark: true };
  const settled = byId(planFirstRun({ present }));
  assert.deepEqual(Object.values(settled).filter((item) => item.run), []);
  assert.match(settled.search_index.reason, /already built/);

  const forced = byId(planFirstRun({ present, force: true }));
  assert.deepEqual(
    Object.values(forced).filter((item) => item.run).map((item) => item.id),
    ["skill_registry", "search_index", "routing_benchmark"],
    "--force does not drag the optional steps in with it"
  );
  assert.match(forced.search_index.reason, /rebuilding on request/);
});

test("an optional step runs when it is asked for, whether or not it is there", () => {
  const asked = byId(planFirstRun({ present: {}, want: { dense_model: true, frontend_qa: true } }));
  assert.equal(asked.dense_model.run, true);
  assert.equal(asked.frontend_qa.run, true);

  const already = byId(planFirstRun({ present: { dense_model: true }, want: {} }));
  assert.equal(already.dense_model.run, false);
  assert.match(already.dense_model.reason, /already installed/);
});

test("the report names every step, including the ones that did not run", () => {
  const text = renderFirstRunReport([
    { id: "skill_registry", title: "Skill registry", run: true, reason: "missing", status: "done", duration_ms: 1200 },
    { id: "search_index", title: "Search index", run: true, reason: "missing", status: "failed", error: "python3 not found" },
    { id: "dense_model", title: "Local BGE-M3 model", run: false, reason: "not installed — pass --dense to install it" }
  ]);
  assert.match(text, /✓ Skill registry \(1\.2s\): missing/);
  assert.match(text, /✗ Search index: python3 not found/);
  assert.match(text, /· Local BGE-M3 model: not installed — pass --dense/);
  assert.match(text, /1 built, 1 skipped, 1 failed\./);
});

test("only an attempted step that failed makes the run a failure", () => {
  assert.equal(firstRunSucceeded([{ status: "done" }, { status: "skipped" }]), true);
  assert.equal(firstRunSucceeded([{ status: "done" }, { status: "failed" }]), false);
  assert.equal(firstRunSucceeded([]), true);
});

test("every step says what it is for, and the optional ones name their flag", () => {
  for (const step of FIRST_RUN_STEPS) {
    assert.ok(step.title && step.detail, `${step.id} has no description`);
    if (step.optional) assert.match(step.flag, /^--/, `${step.id} is optional without a flag`);
  }
  assert.deepEqual(
    FIRST_RUN_STEPS.map((step) => step.id),
    ["skill_registry", "search_index", "routing_benchmark", "frontend_qa", "dense_model"]
  );
});
