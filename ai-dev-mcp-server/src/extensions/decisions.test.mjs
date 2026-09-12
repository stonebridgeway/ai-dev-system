import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TaskStore } from "../core/task-lifecycle.mjs";
import { createExtensionTools } from "../tool-extensions.mjs";
import { createDecisionTools } from "./decisions.mjs";

test("decision tools record ADRs, checkpoint the task, and list results", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "decision-tools-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, "project");
  await fs.mkdir(projectRoot, { recursive: true });
  const taskStore = new TaskStore({ stateRoot: path.join(root, "state") });
  const dirty = [];
  const host = {
    taskStore,
    resolveProjectIdentity: async (projectPath) => ({ project_root: projectPath, project_id: "project-test" }),
    markSearchIndexDirty: (reason) => dirty.push(reason)
  };
  const registry = createExtensionTools(host, [createDecisionTools]);
  assert.deepEqual(registry.definitions.map((item) => item.name), ["record_decision", "list_decisions"]);
  assert.deepEqual(registry.readOnly, ["list_decisions"]);

  const task = await taskStore.begin({
    task: "Choose storage",
    project: { project_name: "fixture", project_path: projectRoot, project_types: ["api"] },
    skills: [],
    baseline: { fingerprint: "a" }
  });
  const recorded = await registry.handlers.get("record_decision")({
    task_id: task.id,
    title: "Keep SQLite",
    context: "Single machine.",
    decision: "SQLite stays the state store.",
    tags: ["storage"]
  });
  assert.equal(recorded.decision.id, "ADR-0001");
  assert.equal(recorded.checkpoint.checkpoints, 1);
  assert.equal(dirty.length, 1);
  const updated = await taskStore.read(task.id);
  assert.match(updated.checkpoints[0].summary, /Decision recorded: ADR-0001 Keep SQLite/);
  assert.deepEqual(updated.checkpoints[0].changed_files, [".ai-dev/decisions/0001-keep-sqlite.md"]);

  const listed = await registry.handlers.get("list_decisions")({ project_path: projectRoot, tag: "storage" });
  assert.equal(listed.count, 1);
  assert.equal(listed.decisions[0].task_id, task.id);

  await assert.rejects(registry.handlers.get("list_decisions")({}), /project_path or task_id is required/);
});
