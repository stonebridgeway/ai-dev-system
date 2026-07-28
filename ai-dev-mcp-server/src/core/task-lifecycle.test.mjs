import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TaskStore } from "./task-lifecycle.mjs";

test("task completion requires met criteria and current-state verification", async () => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-tasks-"));
  const store = new TaskStore({ stateRoot });
  const record = await store.begin({
    task: "Исправить форму",
    project: {
      project_name: "fixture",
      project_path: stateRoot,
      project_types: ["frontend"],
      stack: ["React"]
    },
    skills: [{ name: "bugfix-investigator" }],
    baseline: { fingerprint: "before" }
  });
  await assert.rejects(
    store.complete(record.id, { summary: "done", projectState: { fingerprint: "after" } }),
    /unresolved acceptance criteria/i
  );
  await store.checkpoint(record.id, {
    summary: "implemented",
    criteria: record.acceptance_criteria.map((item) => ({ id: item.id, status: "met", evidence: ["test"] }))
  });
  await store.addVerification(record.id, {
    id: "verify-1",
    passed: true,
    evidence: { source_state_fingerprint: "after" }
  });
  const complete = await store.complete(record.id, {
    summary: "done",
    projectState: { fingerprint: "after" }
  });
  assert.equal(complete.status, "complete");
});

test("design-first criteria apply to Russian product work but not a narrow frontend bug", async (t) => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-product-tasks-"));
  t.after(() => fs.rm(stateRoot, { recursive: true, force: true }));
  const store = new TaskStore({ stateRoot });
  const project = {
    project_name: "fixture",
    project_path: stateRoot,
    project_types: ["frontend"],
    stack: ["React"]
  };

  const productTask = await store.begin({
    task: "\u0423\u043b\u0443\u0447\u0448\u0438 \u0434\u0438\u0437\u0430\u0439\u043d \u0444\u0440\u043e\u043d\u0442\u0435\u043d\u0434\u0430",
    project,
    skills: [],
    baseline: { fingerprint: "before-product" }
  });
  assert.ok(productTask.acceptance_criteria.some((item) => (
    /design-first implementation gate/i.test(item.text)
  )));

  const bugTask = await store.begin({
    task: "Fix a frontend console error without changing the UI",
    project,
    skills: [],
    baseline: { fingerprint: "before-bug" }
  });
  assert.equal(bugTask.acceptance_criteria.some((item) => (
    /design-first implementation gate/i.test(item.text)
  )), false);
});
