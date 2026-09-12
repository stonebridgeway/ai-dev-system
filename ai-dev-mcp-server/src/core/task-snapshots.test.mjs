import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { TaskStore } from "./task-lifecycle.mjs";
import {
  RETAINED_AUTOMATIC_SNAPSHOTS,
  SNAPSHOT_REF_NAMESPACE,
  captureSnapshot,
  captureTaskSnapshot,
  deleteSnapshotRefs,
  findTaskSnapshot,
  listSnapshotRefs,
  nextSnapshotSequence,
  pruneTaskSnapshots,
  resolveTaskWorktree,
  restoreSnapshot,
  rollbackTaskToSnapshot,
  unsnapshottedRemovals,
  snapshotRef,
  snapshotTargetStatus,
  taskSnapshots
} from "./task-snapshots.mjs";

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

async function readFileOrNull(root, relative) {
  return fs.readFile(path.join(root, ...relative.split("/")), "utf8").catch(() => null);
}

/** One committed file, one ignored directory, one commit on `main`. */
async function repoFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "task-snapshots-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  await writeFile(repo, "src/app.js", "export const app = 1;\n");
  await writeFile(repo, ".gitignore", "node_modules/\n");
  await writeFile(repo, "node_modules/dep/index.js", "module.exports = 1;\n");
  runGit(repo, ["init", "-q", "-b", "main"]);
  runGit(repo, ["add", "src/app.js", ".gitignore"]);
  runGit(repo, ["commit", "-q", "-m", "init"]);
  return { root, repo: await fs.realpath(repo) };
}

async function taskStoreFixture(t, repo, overrides = {}) {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "task-snapshots-state-"));
  t.after(() => fs.rm(stateRoot, { recursive: true, force: true }));
  const taskStore = new TaskStore({ stateRoot });
  const record = await taskStore.begin({
    task: "Rewrite the router",
    project: { project_name: "fixture", project_path: repo, project_types: ["backend"] },
    skills: [],
    baseline: { fingerprint: "base" },
    ...overrides
  });
  return { taskStore, record };
}

test("snapshotRef rejects anything that would escape the snapshot namespace", () => {
  assert.equal(snapshotRef("task-20260912T090000-abcdef12", 3), `${SNAPSHOT_REF_NAMESPACE}/task-20260912T090000-abcdef12/3`);
  assert.throws(() => snapshotRef("../../heads/main", 1), /Invalid task id/);
  assert.throws(() => snapshotRef("task..one", 1), /Invalid task id/);
  assert.throws(() => snapshotRef("task-one", 0), /Invalid snapshot sequence/);
});

test("a snapshot holds tracked edits, staged or not, and new files — but not ignored ones", async (t) => {
  const { repo } = await repoFixture(t);
  await writeFile(repo, "src/app.js", "export const app = 2;\n");
  await writeFile(repo, "src/added.js", "export const added = true;\n");
  await writeFile(repo, "staged.js", "export const staged = true;\n");
  runGit(repo, ["add", "staged.js"]);

  const snapshot = await captureSnapshot({ worktreePath: repo, taskId: "task-one", sequence: 1, label: "first turn", turn: 1 });
  assert.equal(snapshot.snapshot_id, "snapshot-1");
  assert.equal(snapshot.ref, `${SNAPSHOT_REF_NAMESPACE}/task-one/1`);
  assert.equal(snapshot.turn, 1);
  assert.deepEqual(snapshot.files.sort(), ["src/added.js", "src/app.js", "staged.js"]);
  assert.equal(snapshot.file_count, 3);

  const tree = runGit(repo, ["ls-tree", "-r", "--name-only", snapshot.commit]).split("\n");
  assert.deepEqual(tree.sort(), [".gitignore", "src/added.js", "src/app.js", "staged.js"]);
  assert.equal(runGit(repo, ["rev-parse", snapshot.ref]), snapshot.commit);
  assert.equal(runGit(repo, ["rev-parse", `${snapshot.commit}^`]), runGit(repo, ["rev-parse", "HEAD"]));

  // Nothing was written to the user's history, their stash, or their index.
  assert.equal(runGit(repo, ["rev-parse", "HEAD"]), runGit(repo, ["rev-parse", "main"]));
  assert.equal(runGit(repo, ["stash", "list"]), "");
  assert.deepEqual(runGit(repo, ["status", "--porcelain"]).split("\n").sort(), ["?? src/added.js", "A  staged.js", "M src/app.js"]);
  assert.deepEqual((await fs.readdir(path.join(repo, ".git"))).filter((item) => item.includes("ai-dev-snapshot")), []);
});

test("an edit that kept a file's size is snapshotted as it is now, not as git last cached it", async (t) => {
  const { repo } = await repoFixture(t);
  // The seeded stat cache must not be trusted over the file itself. Both
  // contents are the same length, and the edit is stamped with exactly the
  // mtime git recorded when it cached the file, so nothing but reading the
  // content can tell the two apart — which is what git's own "racily clean"
  // rule is for.
  const cached = Number(runGit(repo, ["ls-files", "--debug", "src/app.js"]).match(/mtime:\s*(\d+)/)[1]);
  await writeFile(repo, "src/app.js", "export const app = 2;\n");
  await fs.utimes(path.join(repo, "src", "app.js"), cached, cached);
  await fs.utimes(path.join(repo, ".git", "index"), cached, cached);

  const snapshot = await captureSnapshot({ worktreePath: repo, taskId: "task-racy", sequence: 1 });
  assert.equal(runGit(repo, ["cat-file", "-p", `${snapshot.commit}:src/app.js`]), "export const app = 2;");
  assert.deepEqual(snapshot.files, ["src/app.js"]);
});

test("an index that cannot be copied is not trusted either: the tree is hashed instead", async (t) => {
  const { repo } = await repoFixture(t);
  await writeFile(repo, "src/app.js", "export const app = 2;\n");
  // Anything that makes the seed unusable — here an index that is not a file —
  // must cost speed, never accuracy.
  await fs.rm(path.join(repo, ".git", "index"));
  await fs.mkdir(path.join(repo, ".git", "index"));
  const snapshot = await captureSnapshot({ worktreePath: repo, taskId: "task-noindex", sequence: 1 });
  assert.equal(runGit(repo, ["cat-file", "-p", `${snapshot.commit}:src/app.js`]), "export const app = 2;");
});

test("a task without a worktree of its own is snapshotted where its project is", async (t) => {
  const { repo } = await repoFixture(t);
  const record = { id: "task-plain", project: { path: repo }, context: {} };
  assert.equal(await resolveTaskWorktree({ record }), repo);
  assert.equal(await resolveTaskWorktree({ record, resolveProjectIdentity: async () => ({ project_root: "/resolved" }) }), "/resolved");
  assert.equal(await resolveTaskWorktree({ record, resolveProjectIdentity: async () => { throw new Error("no identity"); } }), repo);
  // A worktree the task already removed is not where its files are any more.
  assert.equal(await resolveTaskWorktree({ record: { ...record, context: { worktree: { path: "/gone", removed_at: "2026-09-12T00:00:00.000Z" } } } }), repo);
  await assert.rejects(resolveTaskWorktree({ record: { id: "task-empty", project: {} } }), /no project path/);
});

test("a snapshot of a repository without a commit yet has no parent", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "task-snapshots-unborn-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  runGit(root, ["init", "-q", "-b", "main"]);
  await writeFile(root, "first.js", "export const first = 1;\n");
  const snapshot = await captureSnapshot({ worktreePath: root, taskId: "task-unborn", sequence: 1 });
  assert.equal(snapshot.head, "");
  assert.deepEqual(snapshot.files, ["first.js"]);
  assert.equal(runGit(root, ["rev-list", "--count", snapshot.commit]), "1");
});

test("the full cycle: change, snapshot, change again, roll back, roll the rollback back", async (t) => {
  const { repo } = await repoFixture(t);
  const { taskStore, record } = await taskStoreFixture(t, repo);

  // Turn one: an edit, a new file, and a deleted tracked file.
  await writeFile(repo, "src/app.js", "export const app = 2;\n");
  await writeFile(repo, "src/router.js", "export const route = 1;\n");
  const first = await captureTaskSnapshot({ taskStore, record, worktreePath: repo, label: "router extracted" });
  assert.equal(first.status, "created");
  assert.equal(taskSnapshots(first.task).length, 1);

  // Turn two: everything the first turn produced is changed again.
  await writeFile(repo, "src/app.js", "export const app = 3;\n");
  await writeFile(repo, "src/router.js", "export const route = 2;\n");
  await writeFile(repo, "src/deep/nested/extra.js", "export const extra = true;\n");
  await fs.rm(path.join(repo, ".gitignore"));
  const second = await captureTaskSnapshot({ taskStore, record: first.task, worktreePath: repo, label: "second turn" });
  assert.equal(second.snapshot.snapshot_id, "snapshot-2");

  const rolledBack = await rollbackTaskToSnapshot({
    taskStore,
    record: second.task,
    worktreePath: repo,
    snapshotId: "snapshot-1"
  });
  assert.equal(rolledBack.snapshot.snapshot_id, "snapshot-1");
  assert.equal(rolledBack.undo.snapshot_id, "snapshot-3", "the state being replaced is snapshotted first");
  assert.deepEqual(rolledBack.removed_files, ["src/deep/nested/extra.js"]);
  assert.deepEqual(rolledBack.kept_files ?? [], []);
  assert.equal(await readFileOrNull(repo, "src/app.js"), "export const app = 2;\n");
  assert.equal(await readFileOrNull(repo, "src/router.js"), "export const route = 1;\n");
  assert.equal(await readFileOrNull(repo, ".gitignore"), "node_modules/\n", "a file deleted after the snapshot comes back");
  assert.equal(await readFileOrNull(repo, "src/deep/nested/extra.js"), null, "a file added after the snapshot is removed");
  assert.equal(await fs.readdir(path.join(repo, "src")).then((items) => items.includes("deep")), false, "its empty directory goes too");
  // `.gitignore` was deleted in turn two, which stopped ignoring `node_modules`.
  // Restoring the snapshot restores its ignore rules too, so the dependency
  // tree the snapshot never carried is not deleted underneath the task.
  assert.equal(await readFileOrNull(repo, "node_modules/dep/index.js"), "module.exports = 1;\n", "ignored files are never touched");

  // The rollback is itself reversible: the undo snapshot holds the replaced state.
  const forward = await rollbackTaskToSnapshot({
    taskStore,
    record: rolledBack.task,
    worktreePath: repo,
    snapshotId: rolledBack.undo.snapshot_id
  });
  assert.equal(await readFileOrNull(repo, "src/app.js"), "export const app = 3;\n");
  assert.equal(await readFileOrNull(repo, "src/router.js"), "export const route = 2;\n");
  assert.equal(await readFileOrNull(repo, "src/deep/nested/extra.js"), "export const extra = true;\n");
  assert.equal(await readFileOrNull(repo, ".gitignore"), null);
  assert.equal(forward.task.rollbacks.length, 2);
  assert.deepEqual(forward.task.rollbacks.map((item) => item.to), ["snapshot-1", "snapshot-3"]);

  // Still nothing in the user's history or stash after two rollbacks.
  assert.equal(runGit(repo, ["rev-list", "--count", "main"]), "1");
  assert.equal(runGit(repo, ["stash", "list"]), "");
  assert.deepEqual((await listSnapshotRefs({ worktreePath: repo, taskId: record.id })).map((item) => item.sequence), [1, 2, 3, 4]);
});

test("a snapshot is found by id, number or commit, and a missing one is refused by name", async (t) => {
  const { repo } = await repoFixture(t);
  const { taskStore, record } = await taskStoreFixture(t, repo);
  await writeFile(repo, "src/app.js", "export const app = 2;\n");
  const { task, snapshot } = await captureTaskSnapshot({ taskStore, record, worktreePath: repo });
  assert.equal(nextSnapshotSequence(task), 2);
  assert.equal(findTaskSnapshot(task, "snapshot-1").commit, snapshot.commit);
  assert.equal(findTaskSnapshot(task, "1").commit, snapshot.commit);
  assert.equal(findTaskSnapshot(task, snapshot.commit.slice(0, 8)).commit, snapshot.commit);
  assert.equal(findTaskSnapshot(task, snapshot.commit.toUpperCase()).commit, snapshot.commit);
  // An abbreviated commit that happens to be all digits is still a commit.
  assert.equal(findTaskSnapshot({ snapshots: [{ snapshot_id: "snapshot-1", sequence: 1, commit: "12345678abc" }] }, "12345678").sequence, 1);
  assert.equal(findTaskSnapshot(task, "snapshot-9"), null);
  assert.equal(findTaskSnapshot(task, ""), null);
  await assert.rejects(
    rollbackTaskToSnapshot({ taskStore, record: task, worktreePath: repo, snapshotId: "snapshot-9" }),
    /has no snapshot snapshot-9/
  );
});

test("completion deletes the task's snapshots and leaves the record of what they were", async (t) => {
  const { repo } = await repoFixture(t);
  const { taskStore, record } = await taskStoreFixture(t, repo);
  await writeFile(repo, "src/app.js", "export const app = 2;\n");
  const first = await captureTaskSnapshot({ taskStore, record, worktreePath: repo });
  const second = await captureTaskSnapshot({ taskStore, record: first.task, worktreePath: repo });

  const pruned = await pruneTaskSnapshots({ taskStore, record: second.task, worktreePath: repo });
  assert.equal(pruned.status, "pruned");
  assert.equal(pruned.deleted, 2);
  assert.deepEqual(await listSnapshotRefs({ worktreePath: repo, taskId: record.id }), []);
  assert.deepEqual(taskSnapshots(pruned.task).map((item) => item.deleted_reason), ["completed", "completed"]);
  assert.equal(taskSnapshots(pruned.task)[0].commit, first.snapshot.commit, "what the turn changed is still readable");

  // Pruning twice is a no-op, and a deleted snapshot cannot be restored.
  assert.deepEqual(await pruneTaskSnapshots({ taskStore, record: pruned.task, worktreePath: repo }),
    { status: "nothing_to_prune", deleted: 0, task: pruned.task });
  await assert.rejects(
    rollbackTaskToSnapshot({ taskStore, record: pruned.task, worktreePath: repo, snapshotId: "snapshot-1" }),
    /was deleted \(completed\) and cannot be restored/
  );
});

test("automatic snapshots are capped; snapshots asked for by name are kept", async (t) => {
  const { repo } = await repoFixture(t);
  const { taskStore, record } = await taskStoreFixture(t, repo);
  let task = record;
  const kept = await captureTaskSnapshot({ taskStore, record: task, worktreePath: repo, label: "keep me", trigger: "manual" });
  task = kept.task;
  for (let index = 0; index < RETAINED_AUTOMATIC_SNAPSHOTS + 2; index += 1) {
    await writeFile(repo, "src/app.js", `export const app = ${index};\n`);
    task = (await captureTaskSnapshot({ taskStore, record: task, worktreePath: repo, trigger: "checkpoint" })).task;
  }
  const live = taskSnapshots(task).filter((item) => !item.deleted_at);
  assert.equal(live.filter((item) => item.trigger === "checkpoint").length, RETAINED_AUTOMATIC_SNAPSHOTS);
  assert.equal(live.filter((item) => item.trigger === "manual").length, 1);
  assert.deepEqual(taskSnapshots(task).filter((item) => item.deleted_at).map((item) => item.deleted_reason), ["retention", "retention"]);
  const refs = await listSnapshotRefs({ worktreePath: repo, taskId: record.id });
  assert.equal(refs.length, RETAINED_AUTOMATIC_SNAPSHOTS + 1);
  assert.equal(refs.some((item) => item.sequence === 1), true, "the labelled snapshot survives the cap");
});

test("a working tree that cannot be snapshotted is reported, not thrown, when the snapshot is automatic", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "task-snapshots-nogit-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { repo } = await repoFixture(t);
  const { taskStore, record } = await taskStoreFixture(t, repo);

  const status = await snapshotTargetStatus(root);
  assert.equal(status.ok, false);
  assert.match(status.reason, /Not a git repository/);
  assert.deepEqual(await snapshotTargetStatus(repo), { ok: true, root: repo });

  const skipped = await captureTaskSnapshot({ taskStore, record, worktreePath: root, required: false });
  assert.equal(skipped.status, "skipped");
  assert.match(skipped.reason, /Not a git repository/);
  assert.equal(taskSnapshots(skipped.task).length, 0);
  assert.equal((await captureTaskSnapshot({ taskStore, record, worktreePath: "", required: false })).reason, "No working tree path to snapshot.");
  await assert.rejects(captureTaskSnapshot({ taskStore, record, worktreePath: root }), /Not a git repository/);

  const prune = await pruneTaskSnapshots({ taskStore, record: { ...record, snapshots: [{ sequence: 1, snapshot_id: "snapshot-1" }] }, worktreePath: root });
  assert.equal(prune.status, "skipped");
  assert.match(prune.reason, /Not a git repository/);
});

test("a task in its own worktree snapshots that worktree, and its refs live in the shared repository", async (t) => {
  const { repo } = await repoFixture(t);
  const worktree = path.join(repo, ".worktrees", "router");
  runGit(repo, ["worktree", "add", "-q", "-b", "task/router", worktree]);
  const { taskStore, record } = await taskStoreFixture(t, repo, {
    project: { project_name: "fixture", project_path: worktree, project_types: ["backend"] }
  });
  const inWorktree = await taskStore.update(record.id, (current) => {
    current.context = { ...current.context, worktree: { path: worktree, branch: "task/router", main_root: repo } };
    return current;
  });
  assert.equal(await resolveTaskWorktree({ record: inWorktree }), worktree);

  await writeFile(worktree, "src/app.js", "export const app = 9;\n");
  const captured = await captureTaskSnapshot({ taskStore, record: inWorktree, worktreePath: await resolveTaskWorktree({ record: inWorktree }) });
  assert.equal(captured.snapshot.worktree_path, await fs.realpath(worktree));
  assert.equal(runGit(repo, ["rev-parse", captured.snapshot.ref]), captured.snapshot.commit, "the ref is visible from the main checkout");
  assert.equal(await readFileOrNull(repo, "src/app.js"), "export const app = 1;\n", "the main checkout is untouched");

  await writeFile(worktree, "src/app.js", "export const app = 10;\n");
  await rollbackTaskToSnapshot({ taskStore, record: captured.task, worktreePath: worktree, snapshotId: "snapshot-1" });
  assert.equal(await readFileOrNull(worktree, "src/app.js"), "export const app = 9;\n");
});

test("a repository nested inside the working tree is reported, not deleted", async (t) => {
  const { repo } = await repoFixture(t);
  const snapshot = await captureSnapshot({ worktreePath: repo, taskId: "task-nested", sequence: 1 });

  // Git records an embedded repository as a gitlink: one entry whose path is a
  // directory. Rolling back must not take its history with it.
  const nested = path.join(repo, "vendor", "widget");
  await fs.mkdir(nested, { recursive: true });
  runGit(nested, ["init", "-q", "-b", "main"]);
  await writeFile(nested, "widget.js", "export const widget = 1;\n");
  runGit(nested, ["add", "-A"]);
  runGit(nested, ["commit", "-q", "-m", "widget"]);
  runGit(repo, ["add", "--all"]);

  const restored = await restoreSnapshot({ worktreePath: repo, commit: snapshot.commit });
  assert.deepEqual(restored.kept_files, ["vendor/widget"]);
  assert.deepEqual(restored.removed_files, []);
  assert.equal(await readFileOrNull(nested, "widget.js"), "export const widget = 1;\n");
});

test("a removed ref is reported as unavailable, and restoring an unknown commit is refused", async (t) => {
  const { repo } = await repoFixture(t);
  await writeFile(repo, "src/app.js", "export const app = 2;\n");
  const snapshot = await captureSnapshot({ worktreePath: repo, taskId: "task-refs", sequence: 1 });
  await captureSnapshot({ worktreePath: repo, taskId: "task-refs", sequence: 2 });
  assert.deepEqual((await deleteSnapshotRefs({ worktreePath: repo, taskId: "task-refs", sequences: [2] })).deleted,
    [`${SNAPSHOT_REF_NAMESPACE}/task-refs/2`]);
  assert.deepEqual((await listSnapshotRefs({ worktreePath: repo, taskId: "task-refs" })).map((item) => item.sequence), [1]);

  // The commit object survives its ref until git collects it, so restoring by
  // commit still works; an object from nowhere does not.
  assert.equal((await restoreSnapshot({ worktreePath: repo, commit: snapshot.commit })).restored_files, 2);
  await assert.rejects(restoreSnapshot({ worktreePath: repo, commit: "0".repeat(40) }), /not in this repository/);
  assert.deepEqual(await listSnapshotRefs({ worktreePath: repo, taskId: "task-unknown" }), []);
});


// Д-15. A rollback brings the tree to the snapshot's state, so a file written
// after it goes — including one a person put there from another terminal. It
// cannot be told apart from the task's own new file, so it is named instead of
// quietly deleted, and separately when this task has never snapshotted it.
test("a rollback names every file it deletes, and flags the ones the task never had", async (t) => {
  const { repo } = await repoFixture(t);
  const { taskStore, record } = await taskStoreFixture(t, repo);

  await writeFile(repo, "src/app.js", "export const app = 2;\n");
  const first = await captureTaskSnapshot({ taskStore, record, worktreePath: repo, label: "turn one" });

  // The task's own new file, and a note a person wrote while it worked.
  await writeFile(repo, "src/router.js", "export const route = 1;\n");
  await writeFile(repo, "user-note.md", "# reminder: ask about the migration\n");

  const rolledBack = await rollbackTaskToSnapshot({
    taskStore,
    record: first.task,
    worktreePath: repo,
    snapshotId: "snapshot-1"
  });

  assert.deepEqual(rolledBack.removed_files, ["src/router.js", "user-note.md"]);
  // Neither file was in snapshot-1, and this task has never captured either, so
  // both are flagged: the answer cannot tell whose they are, only that the task
  // has no record of them.
  assert.deepEqual(rolledBack.removed_unsnapshotted_files, ["src/router.js", "user-note.md"]);
  assert.equal(rolledBack.removed_snapshot_history_complete, true);
  assert.equal(await readFileOrNull(repo, "user-note.md"), null);
  // And it is recoverable, which is what makes reporting rather than refusing
  // the right answer.
  await rollbackTaskToSnapshot({ taskStore, record: rolledBack.task, worktreePath: repo, snapshotId: rolledBack.undo.snapshot_id });
  assert.equal(await readFileOrNull(repo, "user-note.md"), "# reminder: ask about the migration\n");

  // A file the task has snapshotted before is not flagged.
  const known = await captureTaskSnapshot({ taskStore, record: await taskStore.read(record.id), worktreePath: repo, label: "captured the note" });
  await writeFile(repo, "user-note.md", "# edited\n");
  const second = await rollbackTaskToSnapshot({ taskStore, record: known.task, worktreePath: repo, snapshotId: "snapshot-1" });
  assert.deepEqual(second.removed_files, ["src/router.js", "user-note.md"]);
  assert.deepEqual(second.removed_unsnapshotted_files, [], "both paths are in this task's snapshot history now");

  // The rollback record keeps the flagged list, so the answer survives the call.
  const stored = (await taskStore.read(record.id)).rollbacks;
  assert.deepEqual(stored[0].removed_unsnapshotted_files, ["src/router.js", "user-note.md"]);
});

test("the removal split is refused rather than guessed when a snapshot's file list was truncated", () => {
  const record = {
    snapshots: [
      { snapshot_id: "snapshot-1", files: ["a.js", "b.js"], file_count: 2 },
      { snapshot_id: "snapshot-2", files: ["c.js"], file_count: 1 }
    ]
  };
  assert.deepEqual(unsnapshottedRemovals(record, ["a.js", "d.js"]), { files: ["d.js"], reliable: true });
  assert.deepEqual(unsnapshottedRemovals({ snapshots: [] }, ["d.js"]), { files: ["d.js"], reliable: true });
  assert.deepEqual(unsnapshottedRemovals({}, undefined), { files: [], reliable: true });

  const truncated = { snapshots: [{ snapshot_id: "snapshot-1", files: ["a.js"], file_count: 140 }] };
  assert.deepEqual(unsnapshottedRemovals(truncated, ["a.js", "d.js"]), { files: [], reliable: false });
});
