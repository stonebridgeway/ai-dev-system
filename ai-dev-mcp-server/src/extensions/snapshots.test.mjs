import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { TaskStore } from "../core/task-lifecycle.mjs";
import { SNAPSHOT_REF_NAMESPACE } from "../core/task-snapshots.mjs";
import { createExtensionTools } from "../tool-extensions.mjs";
import { createLifecycleTools } from "./lifecycle.mjs";
import { createSnapshotTools } from "./snapshots.mjs";

function runGit(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, "-c", "user.name=T", "-c", "user.email=t@example.invalid", ...args], {
    encoding: "utf8",
    windowsHide: true,
    shell: false
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

async function writeFile(root, relative, content) {
  const target = path.join(root, ...relative.split("/"));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf8");
}

/**
 * A repository with one commit, a task open against it, and the two extensions
 * that touch snapshots. The task store is the real one; the services around it
 * answer from the fixture.
 */
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "snapshot-tools-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  await writeFile(repo, "src/app.js", "export const app = 1;\n");
  runGit(repo, ["init", "-q", "-b", "main"]);
  runGit(repo, ["add", "."]);
  runGit(repo, ["commit", "-q", "-m", "init"]);
  const repoPath = await fs.realpath(repo);
  const taskStore = new TaskStore({ stateRoot: path.join(root, "state") });
  const notes = [];
  const host = {
    taskStore,
    resolveProjectIdentity: async (projectPath) => ({ project_root: await fs.realpath(projectPath), project_id: "project-1", repository_id: "repository-1" }),
    captureProjectState: async () => ({ fingerprint: "state-1", git: null }),
    readProjectTextIfExists: async () => "",
    writeKnowledgeNote: async (args) => { notes.push(args); return { action: "created", path: args.path }; },
    skillOutcomeStore: {
      recordVerification: async () => ({ recorded: true }),
      recordCompletion: async () => ({ recorded: true })
    }
  };
  const registry = createExtensionTools(host, [createLifecycleTools, createSnapshotTools]);
  const call = (name, args) => registry.handlers.get(name)(args);
  const record = await taskStore.begin({
    task: "Rewrite the router",
    project: { project_name: "fixture", project_path: repoPath, project_types: ["backend"] },
    skills: [],
    baseline: { fingerprint: "state-0" }
  });
  return { repo: repoPath, taskStore, registry, call, record, notes };
}

/** Mark every criterion met and record the passing verification `complete_task` insists on. */
async function makeCompletable(taskStore, record) {
  await taskStore.checkpoint(record.id, {
    summary: "Router extracted and covered by tests.",
    criteria: record.acceptance_criteria.map((item) => ({ id: item.id, status: "met", evidence: ["verification-1"], note: "" }))
  });
  await taskStore.addVerification(record.id, {
    id: "verification-1",
    at: new Date().toISOString(),
    passed: true,
    checks: [{ type: "quality_gate", result: { status: "passed" } }],
    evidence: { source_state_fingerprint: "state-1" }
  });
}

test("the extension exposes three tools and only the listing is read-only", async (t) => {
  const { registry } = await fixture(t);
  const names = registry.definitions.map((item) => item.name);
  assert.deepEqual(names.filter((name) => name.includes("snapshot") || name === "rollback_task"),
    ["snapshot_task", "list_task_snapshots", "rollback_task"]);
  assert.deepEqual(registry.readOnly, ["list_task_snapshots"]);
});

test("snapshot_task, list_task_snapshots and rollback_task carry one task through a turn and back", async (t) => {
  const { repo, call, record } = await fixture(t);
  await writeFile(repo, "src/app.js", "export const app = 2;\n");
  await writeFile(repo, "src/router.js", "export const route = 1;\n");

  const taken = await call("snapshot_task", { task_id: record.id, label: "before the router rewrite" });
  assert.equal(taken.action, "snapshot_created");
  assert.equal(taken.snapshot.snapshot_id, "snapshot-1");
  assert.equal(taken.snapshot.trigger, "manual");
  assert.equal(taken.snapshot.label, "before the router rewrite");
  assert.deepEqual(taken.snapshot.files.sort(), ["src/app.js", "src/router.js"]);
  assert.match(taken.next_step, /rollback_task\(task_id=task-/);

  await writeFile(repo, "src/router.js", "export const route = 2;\n");
  await writeFile(repo, "src/broken.js", "throw new Error('half a thought');\n");

  const listed = await call("list_task_snapshots", { task_id: record.id });
  assert.equal(listed.count, 1);
  assert.equal(listed.available, 1);
  assert.equal(listed.worktree_path, repo);
  assert.equal(listed.snapshots[0].available, true);

  const rolledBack = await call("rollback_task", { task_id: record.id, snapshot_id: "snapshot-1" });
  assert.equal(rolledBack.action, "rolled_back");
  assert.deepEqual(rolledBack.removed_files, ["src/broken.js"]);
  assert.equal(rolledBack.undo_snapshot.snapshot_id, "snapshot-2");
  // Д-15: the deletion is named in the answer, with the undo snapshot that can
  // bring it back. Д-28: the warning says the same thing about every deleted
  // file, because which of them is whose is not something snapshots know.
  assert.deepEqual(rolledBack.removed_unsnapshotted_files, ["src/broken.js"]);
  assert.equal(rolledBack.removed_snapshot_history_complete, true);
  assert.equal(rolledBack.warnings.length, 2);
  assert.match(rolledBack.warnings[0], /^1 file\(s\) that did not exist in snapshot-1 were deleted: `src\/broken\.js`\./);
  assert.match(rolledBack.warnings[0], /by this task, or by anyone else working in this tree/);
  assert.match(rolledBack.warnings[0], /in the undo snapshot snapshot-2/);
  assert.doesNotMatch(rolledBack.warnings.join("\n"), /someone else's work rather than yours/);
  assert.match(rolledBack.warnings[1], /appear in no snapshot of this task at all.*`src\/broken\.js`/);
  assert.equal(await fs.readFile(path.join(repo, "src", "router.js"), "utf8"), "export const route = 1;\n");
  assert.match(rolledBack.next_step, /snapshot-2/);

  // The rollback is on the record, and its undo snapshot is listed too.
  const afterRollback = await call("list_task_snapshots", { task_id: record.id });
  assert.equal(afterRollback.count, 2);
  assert.deepEqual(afterRollback.rollbacks.map((item) => item.to), ["snapshot-1"]);
  assert.equal(afterRollback.snapshots[1].trigger, "rollback");

  // And it is reversible through the same tool.
  await call("rollback_task", { task_id: record.id, snapshot_id: "snapshot-2" });
  assert.equal(await fs.readFile(path.join(repo, "src", "broken.js"), "utf8"), "throw new Error('half a thought');\n");
  assert.equal(runGit(repo, ["rev-list", "--count", "main"]), "1", "the user's branch never moved");
});

test("a snapshot git no longer holds is listed as unavailable and refused by name", async (t) => {
  const { repo, call, record } = await fixture(t);
  await writeFile(repo, "src/app.js", "export const app = 2;\n");
  const taken = await call("snapshot_task", { task_id: record.id });
  runGit(repo, ["update-ref", "-d", `${SNAPSHOT_REF_NAMESPACE}/${record.id}/1`]);

  const listed = await call("list_task_snapshots", { task_id: record.id });
  assert.equal(listed.count, 1);
  assert.equal(listed.available, 0);
  assert.equal(listed.snapshots[0].available, false);
  assert.equal(listed.snapshots[0].commit, taken.snapshot.commit);
  await assert.rejects(call("rollback_task", { task_id: record.id, snapshot_id: "snapshot-7" }), /has no snapshot snapshot-7/);
});

test("checkpoint_task snapshots the turn it records, and says so when it cannot", async (t) => {
  const { repo, call, record, taskStore } = await fixture(t);
  await writeFile(repo, "src/app.js", "export const app = 2;\n");

  const checkpointed = await call("checkpoint_task", {
    task_id: record.id,
    summary: "Extracted the router.",
    changed_files: ["src/app.js"]
  });
  assert.equal(checkpointed.snapshot.status, "created");
  assert.equal(checkpointed.snapshot.snapshot_id, "snapshot-1");
  assert.equal(checkpointed.snapshot.turn, 1, "the snapshot belongs to the turn it was taken on");
  assert.equal(checkpointed.snapshots.length, 1);
  assert.equal(checkpointed.snapshots[0].trigger, "checkpoint");
  assert.equal(checkpointed.snapshots[0].label, "Extracted the router.");
  assert.equal(runGit(repo, ["rev-parse", checkpointed.snapshots[0].ref]), checkpointed.snapshot.commit);

  const withoutSnapshot = await call("checkpoint_task", {
    task_id: record.id,
    summary: "Second turn, no snapshot wanted.",
    snapshot: false
  });
  assert.deepEqual(withoutSnapshot.snapshot, { status: "skipped", reason: "snapshot=false" });
  assert.equal(withoutSnapshot.snapshots.length, 1);

  // A project git cannot snapshot still checkpoints: the reason is reported.
  const elsewhere = await fs.mkdtemp(path.join(os.tmpdir(), "snapshot-tools-nogit-"));
  t.after(() => fs.rm(elsewhere, { recursive: true, force: true }));
  const moved = await taskStore.begin({
    task: "Write the brief",
    project: { project_name: "plain", project_path: elsewhere, project_types: ["docs"] },
    skills: [],
    baseline: { fingerprint: "state-0" }
  });
  const plain = await call("checkpoint_task", { task_id: moved.id, summary: "Outline drafted." });
  assert.equal(plain.snapshot.status, "skipped");
  assert.match(plain.snapshot.reason, /Not a git repository/);
  assert.equal(plain.checkpoints.length, 1, "the checkpoint itself is recorded either way");
});

test("complete_task deletes the task's snapshot refs and reports what it deleted", async (t) => {
  const { repo, call, record, taskStore } = await fixture(t);
  await writeFile(repo, "src/app.js", "export const app = 2;\n");
  await call("snapshot_task", { task_id: record.id, label: "first" });
  await call("snapshot_task", { task_id: record.id, label: "second" });
  await makeCompletable(taskStore, record);

  const completed = await call("complete_task", {
    task_id: record.id,
    summary: "Router extracted; the quality gate passed.",
    write_report: false,
    prepare_pull_request: false
  });
  assert.equal(completed.task.status, "complete");
  assert.deepEqual(completed.snapshots, { status: "pruned", deleted: 2 });
  assert.equal(runGit(repo, ["for-each-ref", "--format=%(refname)", `${SNAPSHOT_REF_NAMESPACE}/${record.id}`]), "");

  const listed = await call("list_task_snapshots", { task_id: record.id });
  assert.equal(listed.available, 0);
  assert.deepEqual(listed.snapshots.map((item) => item.deleted_reason), ["completed", "completed"]);
  assert.equal(listed.task_status, "complete");

  // The working tree is untouched by the pruning, and so is the user's branch.
  assert.equal(await fs.readFile(path.join(repo, "src", "app.js"), "utf8"), "export const app = 2;\n");
  assert.equal(runGit(repo, ["rev-list", "--count", "main"]), "1");
});

test("completing a task that never had a snapshot says so without touching git", async (t) => {
  const { call, record, taskStore } = await fixture(t);
  await makeCompletable(taskStore, record);
  const completed = await call("complete_task", {
    task_id: record.id,
    summary: "Nothing to restore here.",
    write_report: false,
    prepare_pull_request: false
  });
  assert.deepEqual(completed.snapshots, { status: "nothing_to_prune", deleted: 0 });
});
