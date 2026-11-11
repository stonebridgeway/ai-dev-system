import assert from "node:assert/strict";
import test from "node:test";
import {
  FIRST_RUN_STEPS,
  describeDenseCoverage,
  firstRunSucceeded,
  planFirstRun,
  renderFirstRunReport
} from "./first-run.mjs";

const byId = (plan) => Object.fromEntries(plan.map((item) => [item.id, item]));

test("a bare clone builds the things every install needs, and nothing else", () => {
  const plan = byId(planFirstRun({ present: {} }));
  assert.deepEqual(
    Object.entries(plan).filter(([, item]) => item.run).map(([id]) => id),
    ["skill_registry", "skill_quality_report", "search_index", "routing_benchmark"]
  );
  // The two that reach the network are never run unasked — one of them is 2.3 GB.
  assert.equal(plan.dense_model.run, false);
  assert.match(plan.dense_model.reason, /--model/);
  assert.equal(plan.frontend_qa.run, false);
  assert.match(plan.frontend_qa.reason, /--frontend-qa/);
});

test("an optional step nobody asked for says how this install gets it: setup's flags, or the image's own words", () => {
  const states = [];
  const plan = byId(planFirstRun({
    present: { dense_model: true },
    stale: { dense_model: true },
    optionalReason: (step, state) => { states.push([step.id, state]); return `${step.id}:${state}`; }
  }));
  assert.equal(plan.dense_model.reason, "dense_model:stale");
  assert.equal(plan.frontend_qa.reason, "frontend_qa:missing");
  assert.deepEqual(states.map(([id]) => id), ["frontend_qa", "dense_model", "dense_index"]);
  assert.match(byId(planFirstRun({ present: { dense_model: true } })).dense_model.reason, /^already installed; --model rebuilds it$/);
  const built = { skill_registry: true, skill_quality_report: true, search_index: true, routing_benchmark: true };
  assert.equal(byId(planFirstRun({ present: built })).search_index.reason, "already built; --force rebuilds it");
  assert.equal(byId(planFirstRun({ present: built, builtReason: "already built" })).search_index.reason, "already built");
});

test("what is already built is left alone, and --force rebuilds it", () => {
  const present = {
    skill_registry: true, skill_quality_report: true, search_index: true, routing_benchmark: true
  };
  const settled = byId(planFirstRun({ present }));
  assert.deepEqual(Object.values(settled).filter((item) => item.run), []);
  assert.match(settled.search_index.reason, /already built/);

  const forced = byId(planFirstRun({ present, force: true }));
  assert.deepEqual(
    Object.values(forced).filter((item) => item.run).map((item) => item.id),
    ["skill_registry", "skill_quality_report", "search_index", "routing_benchmark"],
    "--force does not drag the optional steps in with it"
  );
  assert.match(forced.search_index.reason, /rebuilding on request/);
});

test("something built but out of date is rebuilt, without being asked twice", () => {
  // Measured on a real vault: the index and the benchmark were both on disk and
  // both stale, setup said "already built", and the diagnostic in the same run
  // reported them stale. Existence is not freshness.
  const present = {
    skill_registry: true, skill_quality_report: true, search_index: true, routing_benchmark: true
  };
  const plan = byId(planFirstRun({ present, stale: { search_index: true, routing_benchmark: true } }));
  assert.deepEqual(
    Object.values(plan).filter((item) => item.run).map((item) => item.id),
    ["search_index", "routing_benchmark"]
  );
  assert.equal(plan.search_index.reason, "out of date");
  assert.equal(plan.skill_registry.run, false, "what is current is still left alone");

  // Stale is only meaningful for something that exists.
  const absent = byId(planFirstRun({ present: {}, stale: { search_index: true } }));
  assert.equal(absent.search_index.reason, "missing");
});

test("an optional step runs when it is asked for, whether or not it is there", () => {
  const asked = byId(planFirstRun({ present: {}, want: { dense_model: true, frontend_qa: true } }));
  assert.equal(asked.dense_model.run, true);
  assert.equal(asked.frontend_qa.run, true);

  const already = byId(planFirstRun({ present: { dense_model: true }, want: {} }));
  assert.equal(already.dense_model.run, false);
  assert.match(already.dense_model.reason, /already installed/);
});

test("the weights and the vectors built from them are two steps, both behind --model", () => {
  // Measured on a real install: the model downloaded, the worker answered, and
  // the index had vectors for a fraction of its documents, because documents
  // are embedded during a rebuild and nothing had rebuilt since. Asking for the
  // model after that is asking for the vectors too.
  const want = { dense_model: true, dense_index: true };
  const fresh = byId(planFirstRun({ present: {}, want }));
  assert.deepEqual(
    fresh.dense_model.run && fresh.dense_index.run,
    true,
    "both run on a machine that has neither"
  );
  assert.equal(
    FIRST_RUN_STEPS.findIndex((step) => step.id === "dense_index")
      > FIRST_RUN_STEPS.findIndex((step) => step.id === "dense_model"),
    true,
    "nothing can be embedded before the weights are there"
  );

  // The model already downloaded and documents still waiting: the 2.3 GB is not
  // fetched again, the embedding is done.
  const halfway = byId(planFirstRun({
    present: { dense_model: true, dense_index: true },
    stale: { dense_index: true },
    want
  }));
  assert.equal(halfway.dense_model.run, false);
  assert.equal(halfway.dense_index.run, true);
  assert.equal(halfway.dense_index.reason, "out of date");

  // Neither is ever run unasked — but a half-embedded index says so rather than
  // reporting itself installed.
  const unasked = byId(planFirstRun({ present: {}, want: {} }));
  assert.equal(unasked.dense_index.run, false);
  assert.match(unasked.dense_index.reason, /--model/);
  const partial = byId(planFirstRun({ present: { dense_index: true }, stale: { dense_index: true }, want: {} }));
  assert.equal(partial.dense_index.run, false);
  assert.equal(partial.dense_index.reason, "out of date; --model rebuilds it");
});

test("the coverage line separates a half-embedded index from one never embedded", () => {
  // An index rebuilt without the model reports no vectors and nothing pending.
  assert.equal(
    describeDenseCoverage({ current_document_count: 338, dense_documents: 0, dense_pending_documents: 0 }),
    "Indexed: 338 document(s), none embedded yet (--model embeds them)."
  );
  // Measured on a real install: the model was there and most documents were not.
  assert.equal(
    describeDenseCoverage({ current_document_count: 3672, dense_documents: 300, dense_pending_documents: 382 }),
    "Indexed: 3672 document(s), 300 with a dense vector, 382 waiting for one."
  );
  assert.equal(describeDenseCoverage(null), "No search index yet.");
  // --model does not embed with a model this user cannot read.
  assert.equal(
    describeDenseCoverage({ current_document_count: 338, dense_documents: 0, dense_pending_documents: 0 }, { modelUnreadable: true }),
    "Indexed: 338 document(s), none embedded yet (the model cannot be read)."
  );
  assert.equal(
    describeDenseCoverage({ current_document_count: 825, dense_documents: 0, dense_pending_documents: 365, dense_other_model_documents: 365 }, { modelUnreadable: true }),
    "Indexed: 825 document(s), 0 with a dense vector, 365 waiting for one (365 with a vector of another model, which hybrid search does not compare; a model this user can read embeds them again)."
  );
  // A 2.x index the Python backend embedded: kept, not compared, waiting.
  assert.equal(
    describeDenseCoverage({ current_document_count: 825, dense_documents: 0, dense_pending_documents: 365, dense_other_model_documents: 365 }),
    "Indexed: 825 document(s), 0 with a dense vector, 365 waiting for one (365 with a vector of another model, "
      + "which hybrid search does not compare; --model embeds them again)."
  );
});

test("the report names every step, including the ones that did not run", () => {
  const text = renderFirstRunReport([
    { id: "skill_registry", title: "Skill registry", run: true, reason: "missing", status: "done", duration_ms: 1200 },
    { id: "search_index", title: "Search index", run: true, reason: "missing", status: "failed", error: "python3 not found" },
    { id: "dense_model", title: "Local BGE-M3 model", run: false, reason: "not installed — pass --model to install it" }
  ]);
  assert.match(text, /✓ Skill registry \(1\.2s\): missing/);
  assert.match(text, /✗ Search index: python3 not found/);
  assert.match(text, /· Local BGE-M3 model: not installed — pass --model/);
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
    [
      "skill_registry", "skill_quality_report", "search_index", "routing_benchmark",
      "frontend_qa", "dense_model", "dense_index"
    ]
  );
});
