import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_SUBTASKS,
  epicChildState,
  epicCompletionBlockers,
  epicProgress,
  normalizeSubtasks,
  renderEpicMarkdown,
  resolveSubtaskDependencies
} from "./task-epics.mjs";

function child(id, status, { depends_on = [], checkpoints = 0, task = `do ${id}`, criteria = [] } = {}) {
  return {
    id,
    task,
    status,
    depends_on,
    checkpoints: Array.from({ length: checkpoints }, () => ({})),
    verifications: [],
    acceptance_criteria: criteria
  };
}

test("subtasks are read as strings or objects, named by key or by position", () => {
  const subtasks = normalizeSubtasks([
    "Extract the parser",
    { key: "wire", task: " Wire it into the router ", acceptance_criteria: ["The router resolves nested paths"], depends_on: ["1"] },
    { task: "Document it", depends_on: "wire" }
  ]);
  assert.deepEqual(subtasks.map((item) => item.key), ["1", "wire", "3"]);
  assert.equal(subtasks[1].task, "Wire it into the router");
  assert.deepEqual(subtasks[1].acceptance_criteria, ["The router resolves nested paths"]);
  assert.deepEqual(subtasks[2].depends_on, ["wire"], "a single reference does not have to be a list");

  assert.throws(() => normalizeSubtasks([]), /at least one child task/);
  assert.throws(() => normalizeSubtasks([{ task: "  " }]), /Subtask 1 has no task text/);
  assert.throws(() => normalizeSubtasks([{ key: "a", task: "A" }, { key: "a", task: "B" }]), /Duplicate subtask key: a/);
  assert.throws(() => normalizeSubtasks(Array.from({ length: MAX_SUBTASKS + 1 }, () => "x")), /at most 20 children/);
});

test("a dependency that cannot be worked is refused before anything is created", () => {
  const ordered = resolveSubtaskDependencies(normalizeSubtasks([
    "First", { key: "second", task: "Second", depends_on: ["1"] }, { task: "Third", depends_on: ["second", "1"] }
  ]));
  assert.deepEqual([...ordered], [["1", []], ["second", ["1"]], ["3", ["second", "1"]]]);

  assert.throws(() => resolveSubtaskDependencies(normalizeSubtasks([{ key: "a", task: "A", depends_on: ["ghost"] }])),
    /depends on "ghost", which is not one of: a/);
  assert.throws(() => resolveSubtaskDependencies(normalizeSubtasks([{ key: "a", task: "A", depends_on: ["a"] }])),
    /depends on itself/);
  assert.throws(() => resolveSubtaskDependencies(normalizeSubtasks([
    { key: "a", task: "A", depends_on: ["c"] }, { key: "b", task: "B", depends_on: ["a"] }, { key: "c", task: "C", depends_on: ["b"] }
  ])), /cycle: a -> c -> b -> a/);

  // A diamond is not a cycle: two children may wait for the same one.
  assert.doesNotThrow(() => resolveSubtaskDependencies(normalizeSubtasks([
    { key: "base", task: "Base" },
    { key: "left", task: "Left", depends_on: ["base"] },
    { key: "right", task: "Right", depends_on: ["base"] },
    { key: "join", task: "Join", depends_on: ["left", "right"] }
  ])));
});

test("a child is ready, in progress, blocked or done, and the epic knows which to work next", () => {
  const statuses = new Map([["t1", "complete"], ["t2", "active"], ["t3", "active"]]);
  assert.equal(epicChildState(child("t1", "complete"), statuses), "complete");
  assert.equal(epicChildState(child("t2", "active", { depends_on: ["t1"] }), statuses), "ready", "its dependency is done");
  assert.equal(epicChildState(child("t3", "active", { depends_on: ["t2"] }), statuses), "blocked");
  assert.equal(epicChildState(child("t2", "active", { checkpoints: 2 }), statuses), "in_progress");
  assert.equal(epicChildState(child("t2", "verified", { depends_on: ["t2"] }), statuses), "blocked", "a task cannot unblock itself by being verified");

  const progress = epicProgress({
    children: [
      child("t1", "complete", { criteria: [{ status: "met" }, { status: "met" }] }),
      child("t2", "active", { depends_on: ["t1"], checkpoints: 1, criteria: [{ status: "met" }, { status: "pending" }] }),
      child("t3", "active", { depends_on: ["t2"] })
    ]
  });
  assert.equal(progress.total, 3);
  assert.equal(progress.complete, 1);
  assert.equal(progress.in_progress, 1);
  assert.equal(progress.blocked, 1);
  assert.equal(progress.percent, 33.3);
  assert.deepEqual(progress.next, { id: "t2", task: "do t2", state: "in_progress" });
  assert.deepEqual(progress.children[2].blocked_by, ["t2"]);
  assert.deepEqual(progress.children[1].criteria_met, 1);
  assert.equal(progress.deadlocked, false);

  // Work in progress outranks something merely ready.
  const ready = epicProgress({ children: [child("t1", "active"), child("t2", "active", { checkpoints: 1 })] });
  assert.equal(ready.next.id, "t2");
});

test("an epic where every open child waits for another open one is called what it is", () => {
  const stuck = epicProgress({ children: [
    child("t1", "active", { depends_on: ["t2"] }),
    child("t2", "active", { depends_on: ["t1"] })
  ] });
  assert.equal(stuck.deadlocked, true);
  assert.equal(stuck.next, null);

  assert.equal(epicProgress({ children: [child("t1", "complete")] }).deadlocked, false);
  assert.deepEqual(epicProgress().children, []);
  assert.equal(epicProgress().percent, 0);
});

test("completion blockers name every open child and every child record that is gone", () => {
  assert.deepEqual(epicCompletionBlockers({ children: [child("t1", "complete")] }), []);
  const blockers = epicCompletionBlockers({
    children: [child("t1", "complete"), child("t2", "active", { task: "Wire the router" })],
    missing: ["t3"]
  });
  assert.equal(blockers.length, 2);
  assert.match(blockers[0], /^t2 \(active\): Wire the router$/);
  assert.match(blockers[1], /t3: the child task record is gone/);
  assert.deepEqual(epicCompletionBlockers(), []);
});

test("the markdown says where the epic stands", () => {
  const parent = { id: "task-parent", task: "Split the router" };
  const progress = epicProgress({ children: [child("t1", "complete"), child("t2", "active", { depends_on: ["t1"] })], missing: ["t9"] });
  const markdown = renderEpicMarkdown(parent, progress);
  assert.match(markdown, /# Epic task-parent/);
  assert.match(markdown, /1 of 2 children complete \(50%\)/);
  assert.match(markdown, /\| `t2` do t2 \| Ready \| 0\/0 \| — \|/);
  assert.match(markdown, /Missing child records: t9/);
  assert.match(markdown, /Next: `t2`/);
  assert.match(renderEpicMarkdown(parent, epicProgress()), /No children\. `decompose_task` creates them\./);
});
