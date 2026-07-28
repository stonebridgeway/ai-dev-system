import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applySkillOutcome,
  classifyVerificationFailure,
  SkillOutcomeStore,
  summarizeSkillOutcomes
} from "./skill-outcomes.mjs";

test("empirical validation requires attempts, pass rate, and multiple projects", () => {
  const outcomes = [
    {
      task_id: "one",
      status: "pass",
      project_id: "a",
      at: "2026-01-01",
      skills: ["code-reviewer"],
      human_review: {
        verdict: "accepted",
        reviewer: { human_confirmed: true },
        dimensions: [{ score: 5 }]
      }
    },
    { task_id: "two", status: "pass", project_id: "a", at: "2026-01-02", skills: ["code-reviewer"] },
    { task_id: "three", status: "pass", project_id: "b", at: "2026-01-03", skills: ["code-reviewer"] }
  ];
  const summary = summarizeSkillOutcomes(outcomes)["code-reviewer"];
  assert.equal(summary.empirical_status, "pass");
  assert.equal(summary.distinct_projects, 2);
  assert.equal(summary.pass_rate, 1);
});

test("only the latest terminal outcome for a task affects empirical quality", () => {
  const outcomes = [
    { task_id: "same-task", status: "fail", project_id: "a", at: "2026-01-01", skills: ["feature-builder"] },
    { task_id: "same-task", status: "pass", project_id: "a", at: "2026-01-02", skills: ["feature-builder"], verification_attempts: 2 }
  ];
  const summary = summarizeSkillOutcomes(outcomes)["feature-builder"];
  assert.equal(summary.attempts, 1);
  assert.equal(summary.verification_attempts, 2);
  assert.equal(summary.passed, 1);
  assert.equal(summary.failed, 0);
});

test("infrastructure failures are classified separately from product failures", () => {
  assert.equal(classifyVerificationFailure({
    passed: false,
    checks: [{ type: "quality_gate", result: { status: "unavailable" } }]
  }), "infrastructure");
  assert.equal(classifyVerificationFailure({
    passed: false,
    checks: [{ type: "quality_gate", result: { status: "failed" } }]
  }), "product");
});

test("observed outcomes do not promote maturity prematurely", () => {
  const item = applySkillOutcome({
    name: "feature-builder",
    maturity: "reviewed",
    quality_status: "pass"
  }, {
    attempts: 1,
    passed: 1,
    failed: 0,
    pass_rate: 1,
    distinct_projects: 1,
    empirical_score: 100,
    empirical_status: "observed",
    latest_at: "2026-01-01"
  });
  assert.equal(item.maturity, "reviewed");
  assert.equal(item.validation_status, "provisional");
});

test("outcome store keeps idempotent attempts but scores one completed task", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-outcomes-"));
  const store = new SkillOutcomeStore({ stateRoot: root });
  const input = {
    task: {
      id: "task-test",
      status: "complete",
      completion: { at: "2026-01-01T00:01:00.000Z" },
      project: { id: "project-one", path: path.join(root, "project") },
      context: {},
      verifications: [{ id: "verification-test" }],
      skills: [{ name: "feature-builder", source: "custom" }]
    },
    verification: {
      id: "verification-test",
      at: "2026-01-01T00:00:00.000Z",
      passed: true,
      checks: [{ type: "quality_gate", result: { status: "passed" } }]
    },
    projectState: {
      fingerprint: "fingerprint",
      head: "head",
      strength: "strong"
    }
  };
  try {
    await store.recordVerification(input);
    await store.recordVerification(input);
    await store.recordCompletion(input);
    await store.recordCompletion(input);
    const status = await store.status();
    assert.equal(status.events, 1);
    assert.equal(status.verification_attempts, 1);
    assert.equal(status.summaries["feature-builder"].attempts, 1);
    assert.equal(status.summaries["feature-builder"].passed, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
