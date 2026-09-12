import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TaskStore } from "../core/task-lifecycle.mjs";
import { createExtensionTools } from "../tool-extensions.mjs";
import { createEpicTools } from "./epics.mjs";

/**
 * A store with a `begin_task` that opens a real record, so the children the
 * epic tools create behave exactly like tasks opened any other way.
 */
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "epic-tools-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const taskStore = new TaskStore({ stateRoot: path.join(root, "state") });
  const begun = [];
  const host = {
    taskStore,
    callTool: async (name, args) => {
      assert.equal(name, "begin_task");
      begun.push(args);
      const record = await taskStore.begin({
        task: args.task,
        project: { project_name: args.project_name, project_path: args.project_path, project_types: [] },
        skills: [],
        acceptanceCriteria: args.acceptance_criteria,
        baseline: { fingerprint: "f0" }
      });
      return { content: [{ type: "text", text: JSON.stringify(record) }] };
    }
  };
  const parent = await taskStore.begin({
    task: "Split the router out of the entry point",
    project: { project_name: "atlas", project_path: path.join(root, "repo"), project_types: [] },
    skills: [],
    baseline: { fingerprint: "f0" }
  });
  return { registry: createExtensionTools(host, [createEpicTools]), taskStore, parent, begun };
}

test("decompose_task opens real children, links them, and names the one to start", async (t) => {
  const { registry, taskStore, parent, begun } = await fixture(t);
  const decomposed = await registry.handlers.get("decompose_task")({
    task_id: parent.id,
    subtasks: [
      { key: "extract", task: "Extract the parser", acceptance_criteria: ["The parser has its own module"] },
      { key: "wire", task: "Wire it into the router", depends_on: ["extract"] },
      { task: "Document the new module", depends_on: ["wire"] }
    ]
  });
  assert.equal(decomposed.action, "task_decomposed");
  assert.equal(decomposed.children.length, 3);
  assert.equal(begun.length, 3, "every child went through begin_task");
  assert.equal(begun[0].project_path, parent.project.path);
  assert.deepEqual(begun[0].acceptance_criteria, ["The parser has its own module"]);

  const [extract, wire, document] = decomposed.children;
  assert.deepEqual(extract.depends_on, []);
  assert.deepEqual(wire.depends_on, [extract.id]);
  assert.deepEqual(document.depends_on, [wire.id]);
  assert.equal((await taskStore.read(wire.id)).parent_id, parent.id);
  assert.deepEqual((await taskStore.read(parent.id)).epic.children, [extract.id, wire.id, document.id]);

  assert.equal(decomposed.epic.total, 3);
  assert.equal(decomposed.epic.blocked, 2);
  assert.equal(decomposed.epic.next.id, extract.id);
  assert.match(decomposed.next_step, new RegExp(`Work ${extract.id} next`));
  assert.match(decomposed.markdown, /0 of 3 children complete/);
});

test("epic_status answers from the parent or from any child, and follows the work", async (t) => {
  const { registry, taskStore, parent } = await fixture(t);
  const empty = await registry.handlers.get("epic_status")({ task_id: parent.id });
  assert.equal(empty.is_epic, false);
  assert.equal(empty.epic.total, 0);
  assert.match(empty.next_step, /has no children/);

  const decomposed = await registry.handlers.get("decompose_task")({
    task_id: parent.id,
    subtasks: ["Extract the parser", { task: "Wire it in", depends_on: ["1"] }]
  });
  const [extract, wire] = decomposed.children;

  // A child answers with its parent's epic, and says which task was asked about.
  const fromChild = await registry.handlers.get("epic_status")({ task_id: wire.id });
  assert.equal(fromChild.task_id, parent.id);
  assert.equal(fromChild.asked_about, wire.id);
  assert.equal(fromChild.is_epic, true);
  assert.equal(fromChild.epic.children[1].state, "blocked");
  assert.deepEqual(fromChild.epic.children[1].blocked_by, [extract.id]);

  await taskStore.checkpoint(extract.id, { summary: "Parser moved", changedFiles: ["src/parser.mjs"] });
  const started = await registry.handlers.get("epic_status")({ task_id: parent.id });
  assert.equal(started.epic.children[0].state, "in_progress");
  assert.equal(started.epic.next.id, extract.id);

  // Completing one unblocks the next.
  await taskStore.update(extract.id, (record) => {
    record.status = "complete";
    return record;
  });
  const moved = await registry.handlers.get("epic_status")({ task_id: parent.id });
  assert.equal(moved.epic.complete, 1);
  assert.equal(moved.epic.percent, 50);
  assert.equal(moved.epic.next.id, wire.id);
  assert.match(moved.next_step, new RegExp(`Work ${wire.id} next`));

  await taskStore.update(wire.id, (record) => {
    record.status = "complete";
    return record;
  });
  const done = await registry.handlers.get("epic_status")({ task_id: parent.id });
  assert.equal(done.epic.next, null);
  assert.match(done.next_step, /Every child is complete/);
});

test("decompose_task refuses what it cannot make work, before opening anything", async (t) => {
  const { registry, parent, begun } = await fixture(t);
  await assert.rejects(
    () => registry.handlers.get("decompose_task")({ task_id: parent.id, subtasks: [{ key: "a", task: "A", depends_on: ["b"] }] }),
    /depends on "b", which is not one of: a/
  );
  await assert.rejects(
    () => registry.handlers.get("decompose_task")({ task_id: parent.id, subtasks: [] }),
    /at least one child task/
  );
  assert.equal(begun.length, 0, "a refused decomposition leaves no half-made children");

  const decomposed = await registry.handlers.get("decompose_task")({ task_id: parent.id, subtasks: ["Only child"] });
  await assert.rejects(
    () => registry.handlers.get("decompose_task")({ task_id: decomposed.children[0].id, subtasks: ["Grandchild"] }),
    /already a child of .*an epic is one level deep/
  );
});
