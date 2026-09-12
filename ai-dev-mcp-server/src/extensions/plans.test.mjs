import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PLAN_CRITERION_TEXT } from "../core/task-plans.mjs";
import { TaskStore } from "../core/task-lifecycle.mjs";
import { createExtensionTools } from "../tool-extensions.mjs";
import { createPlanTools } from "./plans.mjs";

test("plan tools record a plan, satisfy the plan criterion, and report status", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "plan-tools-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, "project");
  await fs.mkdir(projectRoot);
  const taskStore = new TaskStore({ stateRoot: path.join(root, "state") });
  const host = {
    taskStore,
    resolveProjectIdentity: async (projectPath) => ({ project_root: projectPath, project_id: "project-test" })
  };
  const registry = createExtensionTools(host, [createPlanTools]);
  const task = await taskStore.begin({
    task: "Migrate production billing to the new payment provider across all services",
    project: { project_name: "fixture", project_path: projectRoot, project_types: ["api"] },
    skills: [],
    baseline: { fingerprint: "a" }
  });
  assert.equal(task.plan_policy.plan_required, true);

  const status = await registry.handlers.get("plan_status")({ task_id: task.id });
  assert.equal(status.plan, null);
  assert.ok(status.template.phases.length >= 1);
  assert.match(status.next_step, /Plan required/);

  const recorded = await registry.handlers.get("plan_task")({
    task_id: task.id,
    overview: "Swap the provider behind the billing facade.",
    phases: [
      { title: "Phase 1: adapter", steps: [{ action: "Add provider adapter", file: "src/billing/provider.ts", risk: "medium" }], tests: ["adapter contract test"] },
      { title: "Phase 2: cutover", steps: [{ action: "Switch facade to the adapter", file: "src/billing/index.ts", depends_on: "Phase 1", risk: "high" }] }
    ],
    risks: [{ risk: "Double charges during cutover", mitigation: "idempotency keys" }],
    rollback: "Feature flag back to the old provider."
  });
  assert.equal(recorded.action, "plan_recorded");
  assert.equal(recorded.plan.phases, 2);
  assert.match(recorded.markdown, /Phase 2: cutover/);
  const criterion = recorded.acceptance_criteria.find((item) => item.text === PLAN_CRITERION_TEXT);
  assert.equal(criterion.status, "met");
  assert.deepEqual(criterion.evidence, [`.ai-dev/plans/${task.id}.md`]);

  const after = await registry.handlers.get("plan_status")({ task_id: task.id });
  assert.equal(after.plan.steps, 2);
  assert.equal(after.template, null);
  const stored = await taskStore.read(task.id);
  assert.equal(stored.plan.path, `.ai-dev/plans/${task.id}.md`);
  assert.equal(stored.checkpoints.length, 1);
  await assert.rejects(registry.handlers.get("plan_task")({ task_id: task.id, overview: "x", phases: [] }), /At least one phase/);
});
