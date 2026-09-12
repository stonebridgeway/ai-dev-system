import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  PLAN_CRITERION_TEXT,
  classifyTaskComplexity,
  normalizePlan,
  planTemplate,
  renderPlanMarkdown,
  withPlanGateWarning,
  writeTaskPlan
} from "./task-plans.mjs";
import { TaskStore } from "./task-lifecycle.mjs";

test("classifyTaskComplexity scores risk, wording, and context size", () => {
  const small = classifyTaskComplexity({ task: "Fix a typo in the README", risk: "low" });
  assert.equal(small.complexity, "small");
  assert.equal(small.plan_required, false);
  assert.equal(small.suggested_model_tier, "fast");

  const large = classifyTaskComplexity({
    task: "Refactor the payment service and migrate the database schema across all modules",
    risk: "high",
    selectedFiles: new Array(9).fill("f")
  });
  assert.equal(large.complexity, "large");
  assert.equal(large.plan_required, true);
  assert.equal(large.suggested_model_tier, "deep");
  assert.ok(large.reasons.some((reason) => /high-risk/.test(reason)));

  const russian = classifyTaskComplexity({ task: "Переписать архитектуру модуля уведомлений целиком", risk: "medium", selectedFiles: ["a", "b", "c", "d"] });
  assert.equal(russian.complexity, "large");

  const highRiskSmall = classifyTaskComplexity({ task: "Rename the deploy script", risk: "high" });
  assert.equal(highRiskSmall.plan_required, true, "high risk always requires a plan");
  assert.equal(classifyTaskComplexity({ task: "Add a field to the API response", risk: "medium" }).complexity, "small");
});

test("normalizePlan validates phases and renderPlanMarkdown follows the planner format", () => {
  assert.throws(() => normalizePlan({}), /overview is required/);
  assert.throws(() => normalizePlan({ overview: "x", phases: [] }), /At least one phase/);
  assert.throws(() => normalizePlan({ overview: "x", phases: [{ steps: [{ action: "" }] }] }), /action is required/);
  assert.throws(() => normalizePlan({ overview: "x", phases: [{ steps: [{ action: "a", risk: "huge" }] }] }), /risk must be/);
  const plan = normalizePlan({
    overview: "Add subscriptions.",
    requirements: ["Users can pick a plan"],
    phases: [
      { title: "Phase 1: schema", steps: [{ action: "Add migration", file: "db/001.sql", why: "store tier", risk: "Medium" }, "Run migration locally"], tests: ["migration applies"] },
      { title: "Webhooks", steps: [{ action: "Handle stripe events", file: "api/webhooks.ts", depends_on: "Phase 1" }] }
    ],
    risks: [{ risk: "Out-of-order events", mitigation: "idempotent updates" }, "Unmitigated risk"],
    success_criteria: ["Checkout works"]
  });
  assert.equal(plan.phases[0].steps[0].risk, "medium");
  assert.equal(plan.phases[0].steps[1].action, "Run migration locally");
  assert.equal(plan.risks.length, 2);
  const markdown = renderPlanMarkdown({ taskId: "task-1", task: "Add subscriptions", plan, recordedAt: "2026-01-01T00:00:00.000Z" });
  assert.match(markdown, /# Implementation Plan: Add subscriptions/);
  assert.match(markdown, /### Phase 1: schema/);
  assert.match(markdown, /### Phase 2: Webhooks/);
  assert.match(markdown, /1\. \*\*Add migration\*\* \(File: `db\/001\.sql`\)\n   - Why: store tier\n   - Dependencies: None\n   - Risk: Medium/);
  assert.match(markdown, /- \*\*Out-of-order events\*\* → idempotent updates/);
  assert.match(markdown, /- \[ \] Checkout works/);
  assert.ok(planTemplate("Do X").phases.length >= 1);
});

test("writeTaskPlan persists md+json and the task lifecycle enforces the plan criterion", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "task-plans-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new TaskStore({ stateRoot: path.join(root, "state") });
  const record = await store.begin({
    task: "Migrate the production payment database to the new schema across all services",
    project: { project_name: "fixture", project_path: root, project_types: ["api"] },
    skills: [],
    baseline: { fingerprint: "a" },
    context: { selected_files: new Array(10).fill({ path: "x" }) }
  });
  assert.equal(record.plan_policy.plan_required, true);
  assert.equal(record.plan, null);
  const criterion = record.acceptance_criteria.find((item) => item.text === PLAN_CRITERION_TEXT);
  assert.ok(criterion, "plan criterion added");

  const warned = withPlanGateWarning(record, ["src/a.js"]);
  assert.match(warned.plan_warning, /requires a recorded plan/);
  assert.equal(withPlanGateWarning(record, []).plan_warning, undefined);

  const written = await writeTaskPlan({
    projectRoot: root,
    taskId: record.id,
    task: record.task,
    plan: { overview: "Move to the new schema.", phases: [{ title: "Phase 1", steps: [{ action: "Write migration", file: "db/m.sql" }] }] }
  });
  assert.equal(written.path, `.ai-dev/plans/${record.id}.md`);
  assert.equal(written.phases, 1);
  assert.equal(written.steps, 1);
  const json = JSON.parse(await fs.readFile(path.join(root, ".ai-dev", "plans", `${record.id}.json`), "utf8"));
  assert.equal(json.task_id, record.id);
  assert.match(await fs.readFile(path.join(root, written.path), "utf8"), /Write migration/);

  const small = await store.begin({
    task: "Fix a typo",
    project: { project_name: "fixture", project_path: root, project_types: [] },
    skills: [],
    baseline: { fingerprint: "b" }
  });
  assert.equal(small.plan_policy.plan_required, false);
  assert.equal(small.acceptance_criteria.some((item) => item.text === PLAN_CRITERION_TEXT), false);
  assert.equal(withPlanGateWarning(small, ["x"]).plan_warning, undefined);
});
