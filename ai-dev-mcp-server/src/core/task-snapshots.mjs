/**
 * Turn-level snapshots of a task's working tree, and the way back to one.
 *
 * An agent's turn ends with files changed and nothing to compare them against:
 * the work is not committed (the branch belongs to the user), and an editor's
 * undo stack does not survive a session. A snapshot closes that gap. It records
 * the whole working tree of the task — tracked changes, staged or not, plus the
 * files the agent created — as one commit object that no branch points at, kept
 * alive by a ref under `refs/ai-dev/snapshots/<task_id>/<n>`. Rolling back
 * restores those files and nothing else: no branch moves, no commit lands in the
 * user's history, no stash entry appears in their stash list.
 *
 * The capture is `git add --all` into a throwaway index, `git write-tree`, then
 * `git commit-tree` with HEAD as the parent. `PLAN.md` (3.2) names
 * `git stash create` for this, and that is the idiom for tracked changes — but
 * it records only tracked ones, and a turn that adds a file is exactly the turn
 * worth undoing. The throwaway index is seeded from the repository's own index
 * (see {@link seedIndex}), so the stat cache is reused and `add --all` does not
 * re-hash the tree; the repository's index itself is never written.
 * `.gitignore` and `.git/info/exclude` apply, so `node_modules/` stays out —
 * and so does the `.worktrees/` directory that `task-worktrees.mjs` excludes.
 *
 * A rollback is reversible because `rollbackTaskToSnapshot` snapshots the
 * current state before it restores anything: the state a rollback leaves behind
 * is itself a snapshot to roll back to.
 *
 * Files are all a rollback touches. The index is left exactly as it was, so
 * whatever the agent had staged stays staged — visible in `git status`, and
 * never silently rewritten by us.
 *
 * Snapshots are deleted when the task closes (`complete_task`) or when state is
 * pruned (`prune_state`, PLAN.md 3.12, which reuses `pruneTaskSnapshots`).
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { runProcess } from "./process-runner.mjs";
import { activeWorktree } from "./task-completion.mjs";

/** Where snapshot refs live. Outside `refs/heads`, so no branch is touched. */
export const SNAPSHOT_REF_NAMESPACE = "refs/ai-dev/snapshots";

/**
 * How many automatic (checkpoint) snapshots one task keeps. Every ref holds a
 * whole tree alive, so a long task would otherwise grow the object store one
 * checkpoint at a time. The oldest automatic snapshots go first; snapshots an
 * agent asked for by name are kept until the task closes.
 */
export const RETAINED_AUTOMATIC_SNAPSHOTS = 50;

/** How many changed paths a snapshot entry names before it only counts them. */
const MAX_RECORDED_FILES = 100;
const MAX_LABEL_LENGTH = 200;

// The snapshot commits are machine-written and never land in the user's
// history, so they carry their own identity rather than the user's — and a
// repository without `user.email` configured can still be snapshotted.
const SNAPSHOT_IDENTITY = ["-c", "user.name=ai-dev", "-c", "user.email=ai-dev@snapshots.invalid"];
const REF_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

async function git(cwd, args, { env = {}, timeoutMs = 60_000 } = {}) {
  return runProcess({
    executable: "git",
    args: ["-C", path.resolve(cwd), "-c", "core.quotepath=false", ...args],
    cwd,
    env,
    timeoutMs,
    maxOutputBytes: 8 * 1024 * 1024
  }).catch((error) => ({ ok: false, exitCode: null, stdout: "", stderr: error instanceof Error ? error.message : String(error) }));
}

function assertOk(result, label) {
  if (result.ok) return result;
  throw new Error(`${label} failed: ${(result.stderr || result.stdout || "unknown git error").trim().slice(0, 500)}`);
}

async function gitPaths(root, args) {
  const result = assertOk(await git(root, args), `git ${args[0]}`);
  return result.stdout.split("\0").filter(Boolean);
}

function assertRefComponent(value, field) {
  if (!REF_COMPONENT.test(String(value ?? "")) || String(value).includes("..")) {
    throw new Error(`Invalid ${field} for a snapshot ref: ${value}`);
  }
  return String(value);
}

/**
 * The ref one snapshot lives under.
 *
 * @param {string} taskId
 * @param {number} sequence - 1-based snapshot number within the task.
 * @returns {string}
 */
export function snapshotRef(taskId, sequence) {
  assertRefComponent(taskId, "task id");
  const number = Number(sequence);
  if (!Number.isInteger(number) || number < 1) throw new Error(`Invalid snapshot sequence: ${sequence}`);
  return `${SNAPSHOT_REF_NAMESPACE}/${taskId}/${number}`;
}

/** The id an agent passes back to `rollback_task`. */
function snapshotIdFor(sequence) {
  return `snapshot-${sequence}`;
}

/**
 * The git working tree a task's files live in: its own worktree when
 * `begin_task_in_worktree` created one, the project root otherwise.
 *
 * @param {{ record: object, resolveProjectIdentity?: (path: string) => Promise<{ project_root?: string }> }} input
 * @returns {Promise<string>}
 */
export async function resolveTaskWorktree({ record, resolveProjectIdentity }) {
  const worktree = activeWorktree(record);
  if (worktree?.path) return worktree.path;
  const projectPath = record?.project?.path || "";
  if (!projectPath) throw new Error("Task has no project path.");
  if (typeof resolveProjectIdentity !== "function") return projectPath;
  const identity = await resolveProjectIdentity(projectPath).catch(() => null);
  return identity?.project_root || projectPath;
}

async function repositoryContext(worktreePath) {
  if (!String(worktreePath || "").trim()) throw new Error("No working tree path to snapshot.");
  const requested = path.resolve(String(worktreePath));
  const toplevel = await git(requested, ["rev-parse", "--show-toplevel"]);
  if (!toplevel.ok) throw new Error(`Not a git repository, so it cannot be snapshotted: ${requested}`);
  const root = await fs.realpath(toplevel.stdout.trim());
  const gitDir = assertOk(await git(root, ["rev-parse", "--absolute-git-dir"]), "git rev-parse --absolute-git-dir").stdout.trim();
  return { root, gitDir };
}

/**
 * Whether a task's working tree can be snapshotted at all. Lets an automatic
 * snapshot stand down with a reason instead of failing the call it rides on.
 *
 * @param {string} worktreePath
 * @returns {Promise<{ ok: boolean, root?: string, reason?: string }>}
 */
export async function snapshotTargetStatus(worktreePath) {
  try {
    const { root } = await repositoryContext(worktreePath);
    return { ok: true, root };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Copy the repository's index to `target` so `git add --all` starts from its
 * stat cache instead of re-hashing the whole tree.
 *
 * The copy keeps the original's timestamp, and that is the point. Git trusts a
 * cached entry's stat only while the entry is older than the index it sits in;
 * an entry written in the same second as the index is "racily clean" and its
 * content is read again. A copy stamped with the present time quietly turns
 * that check off, and an edit that kept a file's size — one digit for another —
 * would be snapshotted as the content it replaced. Where the timestamp cannot
 * be carried over, the copy is dropped and the capture starts from an empty
 * index: slower, and never wrong.
 *
 * @param {string} source - The repository's own index.
 * @param {string} target - The throwaway index this capture writes.
 */
async function seedIndex(source, target) {
  const stat = await fs.stat(source).catch(() => null);
  if (!stat) return;
  try {
    await fs.copyFile(source, target);
    await fs.utimes(target, stat.atime, stat.mtime);
  } catch {
    await fs.rm(target, { force: true }).catch(() => undefined);
  }
}

async function changedPaths(root, head, commit) {
  return head
    ? gitPaths(root, ["diff", "--name-only", "-z", head, commit])
    : gitPaths(root, ["ls-tree", "-r", "--name-only", "-z", commit]);
}

/**
 * Capture the working tree as a snapshot commit and point a ref at it.
 *
 * Writes one ref and no branch, tag, stash entry or file in the working tree.
 *
 * @param {{ worktreePath: string, taskId: string, sequence: number, label?: string, turn?: number, trigger?: string }} input
 * @returns {Promise<object>} The snapshot entry recorded on the task.
 */
export async function captureSnapshot({ worktreePath, taskId, sequence, label = "", turn = 0, trigger = "manual" }) {
  assertRefComponent(taskId, "task id");
  const ref = snapshotRef(taskId, sequence);
  const { root, gitDir } = await repositoryContext(worktreePath);
  const indexFile = path.join(gitDir, `ai-dev-snapshot-${crypto.randomUUID()}.index`);
  const text = String(label || "").trim().slice(0, MAX_LABEL_LENGTH);
  try {
    await seedIndex(path.join(gitDir, "index"), indexFile);
    const env = { GIT_INDEX_FILE: indexFile };
    assertOk(await git(root, ["add", "--all"], { env }), "git add --all");
    const tree = assertOk(await git(root, ["write-tree"], { env }), "git write-tree").stdout.trim();
    const head = (await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"])).stdout.trim();
    const message = `ai-dev snapshot ${taskId} #${sequence}${text ? `: ${text}` : ""}`;
    const commit = assertOk(
      await git(root, [...SNAPSHOT_IDENTITY, "commit-tree", tree, ...(head ? ["-p", head] : []), "-m", message]),
      "git commit-tree"
    ).stdout.trim();
    assertOk(await git(root, ["update-ref", ref, commit]), "git update-ref");
    const files = await changedPaths(root, head, commit);
    return {
      snapshot_id: snapshotIdFor(sequence),
      sequence: Number(sequence),
      turn: Number(turn) || 0,
      trigger,
      label: text,
      commit,
      head,
      ref,
      worktree_path: root,
      files: files.slice(0, MAX_RECORDED_FILES),
      file_count: files.length,
      created_at: new Date().toISOString()
    };
  } finally {
    await fs.rm(indexFile, { force: true }).catch(() => undefined);
  }
}

/**
 * The snapshot refs git still holds for a task, newest sequence last.
 *
 * @param {{ worktreePath: string, taskId: string }} input
 * @returns {Promise<Array<{ ref: string, sequence: number, commit: string }>>}
 */
export async function listSnapshotRefs({ worktreePath, taskId }) {
  assertRefComponent(taskId, "task id");
  const { root } = await repositoryContext(worktreePath);
  const listed = await git(root, ["for-each-ref", "--format=%(objectname) %(refname)", `${SNAPSHOT_REF_NAMESPACE}/${taskId}`]);
  if (!listed.ok) return [];
  return listed.stdout.split("\n").filter(Boolean)
    .map((line) => {
      const [commit, ref = ""] = line.trim().split(/\s+/);
      return { ref, commit, sequence: Number(ref.slice(ref.lastIndexOf("/") + 1)) || 0 };
    })
    .filter((item) => item.ref && item.sequence)
    .sort((left, right) => left.sequence - right.sequence);
}

function insideRoot(root, relative) {
  const target = path.resolve(root, relative);
  return target === root || target.startsWith(`${root}${path.sep}`) ? target : "";
}

async function removeEmptyDirectories(root, removed) {
  const directories = new Set();
  for (const relative of removed) {
    let current = path.dirname(relative);
    while (current && current !== "." && current !== path.sep) {
      directories.add(current);
      current = path.dirname(current);
    }
  }
  // Deepest first, so a directory that only held other emptied directories goes too.
  for (const relative of [...directories].sort((left, right) => right.split("/").length - left.split("/").length)) {
    const target = insideRoot(root, relative);
    if (target) await fs.rmdir(target).catch(() => undefined);
  }
}

/**
 * Restore a working tree to a snapshot: every file the snapshot holds is put
 * back with its recorded content, and every file that appeared since is
 * removed. Ignored files (`node_modules/`, build output) are never touched,
 * because the snapshot never carried them; neither is a nested repository,
 * which is reported in `kept_files` instead.
 *
 * @param {{ worktreePath: string, commit: string }} input
 * @returns {Promise<{ commit: string, restored_files: number, removed_files: string[], kept_files: string[] }>}
 */
export async function restoreSnapshot({ worktreePath, commit }) {
  const { root } = await repositoryContext(worktreePath);
  const verified = await git(root, ["rev-parse", "--verify", "--quiet", `${commit}^{commit}`]);
  if (!verified.ok) throw new Error(`Snapshot commit is not in this repository: ${commit}`);
  const snapshotted = new Set(await gitPaths(root, ["ls-tree", "-r", "--name-only", "-z", commit]));
  // An empty snapshot tree has no pathspec to match, so `git restore` would
  // refuse it; there is nothing to write back either way.
  if (snapshotted.size) {
    assertOk(await git(root, ["restore", "--source", commit, "--worktree", "--", "."]), "git restore");
  }
  // What is on disk is read after the restore, so the ignore rules that decide
  // it are the snapshot's own: a task that edited `.gitignore` and rolled back
  // must not have the files it stopped ignoring deleted underneath it.
  const present = await gitPaths(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  const removed = [];
  const kept = [];
  for (const relative of present) {
    if (snapshotted.has(relative)) continue;
    const target = insideRoot(root, relative);
    if (!target) continue;
    const stat = await fs.lstat(target).catch(() => null);
    if (!stat) continue;
    // A directory here is a gitlink — a submodule or a repository someone
    // nested inside this one. It has a history of its own, so it is reported
    // and left alone rather than deleted with the files around it.
    if (stat.isDirectory()) {
      kept.push(relative);
      continue;
    }
    await fs.rm(target, { force: true });
    removed.push(relative);
  }
  await removeEmptyDirectories(root, removed);
  return { commit, restored_files: snapshotted.size, removed_files: removed, kept_files: kept };
}

/**
 * Delete snapshot refs. The commits themselves become unreachable and are
 * collected by git's own housekeeping.
 *
 * @param {{ worktreePath: string, taskId: string, sequences?: number[] }} input - All
 *   the task's snapshots, or only the given sequences.
 * @returns {Promise<{ deleted: string[], failed: string[] }>}
 */
export async function deleteSnapshotRefs({ worktreePath, taskId, sequences = null }) {
  const wanted = sequences ? new Set(sequences.map(Number)) : null;
  const { root } = await repositoryContext(worktreePath);
  const refs = (await listSnapshotRefs({ worktreePath: root, taskId }))
    .filter((item) => !wanted || wanted.has(item.sequence));
  const deleted = [];
  const failed = [];
  for (const item of refs) {
    // The old value is passed so a ref written since is left alone.
    const result = await git(root, ["update-ref", "-d", item.ref, item.commit]);
    (result.ok ? deleted : failed).push(item.ref);
  }
  return { deleted, failed };
}

/**
 * The snapshots recorded on a task, tolerating a record written before
 * snapshots existed.
 *
 * @param {object} record
 * @returns {object[]}
 */
export function taskSnapshots(record) {
  return Array.isArray(record?.snapshots) ? record.snapshots : [];
}

/**
 * @param {object} record
 * @returns {number} The sequence number the next snapshot of this task takes.
 */
export function nextSnapshotSequence(record) {
  return taskSnapshots(record).reduce((highest, item) => Math.max(highest, Number(item.sequence) || 0), 0) + 1;
}

/**
 * Find a snapshot by what an agent is likely to have: its id
 * (`snapshot-3`), its bare sequence number, or its commit (full or abbreviated
 * to at least seven characters).
 *
 * @param {object} record
 * @param {string} wanted
 * @returns {object|null}
 */
export function findTaskSnapshot(record, wanted) {
  const value = String(wanted ?? "").trim();
  if (!value) return null;
  const snapshots = taskSnapshots(record);
  const byId = snapshots.find((item) => item.snapshot_id === value);
  if (byId) return byId;
  // A commit is read as a commit before it is read as a number: one abbreviated
  // to digits alone is still a commit, and no task has a millionth snapshot.
  if (/^[0-9a-f]{7,40}$/i.test(value)) {
    const byCommit = snapshots.find((item) => String(item.commit || "").toLowerCase().startsWith(value.toLowerCase()));
    if (byCommit) return byCommit;
  }
  if (/^\d+$/.test(value)) return snapshots.find((item) => Number(item.sequence) === Number(value)) || null;
  return null;
}

function liveSnapshots(record) {
  return taskSnapshots(record).filter((item) => !item.deleted_at);
}

async function markDeleted({ taskStore, taskId, sequences, reason }) {
  const wanted = new Set(sequences.map(Number));
  const at = new Date().toISOString();
  return taskStore.update(taskId, (current) => {
    for (const item of taskSnapshots(current)) {
      if (!wanted.has(Number(item.sequence)) || item.deleted_at) continue;
      item.deleted_at = at;
      item.deleted_reason = reason;
    }
    return current;
  });
}

async function applyRetention({ taskStore, record, worktreePath }) {
  const automatic = liveSnapshots(record).filter((item) => item.trigger === "checkpoint");
  const excess = automatic.length - RETAINED_AUTOMATIC_SNAPSHOTS;
  if (excess <= 0) return { task: record, retired: [] };
  const sequences = automatic.slice(0, excess).map((item) => Number(item.sequence));
  await deleteSnapshotRefs({ worktreePath, taskId: record.id, sequences }).catch(() => undefined);
  return {
    task: await markDeleted({ taskStore, taskId: record.id, sequences, reason: "retention" }),
    retired: sequences
  };
}

/**
 * Snapshot a task's working tree and record it on the task.
 *
 * @param {{ taskStore: object, record: object, worktreePath: string, label?: string, trigger?: string, required?: boolean }} input -
 *   `required: false` (an automatic snapshot) turns a repository that cannot be
 *   snapshotted into a `skipped` result instead of an error, so the call it
 *   rides on still succeeds.
 * @returns {Promise<{ status: "created"|"skipped", snapshot?: object, reason?: string, task: object }>}
 */
export async function captureTaskSnapshot({ taskStore, record, worktreePath, label = "", trigger = "manual", required = true }) {
  try {
    const snapshot = await captureSnapshot({
      worktreePath,
      taskId: record.id,
      sequence: nextSnapshotSequence(record),
      label,
      turn: Array.isArray(record.checkpoints) ? record.checkpoints.length : 0,
      trigger
    });
    const stored = await taskStore.update(record.id, (current) => {
      current.snapshots = [...taskSnapshots(current), snapshot];
      return current;
    });
    const { task } = await applyRetention({ taskStore, record: stored, worktreePath });
    return { status: "created", snapshot, task };
  } catch (error) {
    if (required) throw error;
    return { status: "skipped", reason: error instanceof Error ? error.message : String(error), task: record };
  }
}

/**
 * Which of the removed files this task has never had in a snapshot of its own.
 *
 * A rollback brings the tree to the snapshot's state, so every file that
 * appeared afterwards goes — including one a person wrote from another terminal
 * while the agent worked (docs/ecc-upgrades/DEBTS.md, Д-15).
 *
 * What this list says, exactly: no snapshot of this task holds this path. That
 * is a fact about the snapshots, not about who wrote the file — a file the
 * agent itself created since the last snapshot is in here too, which is why the
 * warning built on it stopped calling these files somebody else's (Д-28). It
 * does say something worth knowing: for these paths the undo snapshot is the
 * only record that they ever existed.
 *
 * The list is only as good as the recorded file lists, which are capped at a
 * hundred paths per snapshot. When any of them was truncated the answer says so
 * instead of guessing.
 *
 * @param {object} record - The task.
 * @param {string[]} removedFiles
 * @returns {{ files: string[], reliable: boolean }}
 */
export function unsnapshottedRemovals(record, removedFiles) {
  const seen = new Set();
  let truncated = false;
  for (const snapshot of taskSnapshots(record)) {
    const files = Array.isArray(snapshot?.files) ? snapshot.files : [];
    for (const file of files) seen.add(file);
    if (Number(snapshot?.file_count ?? 0) > files.length) truncated = true;
  }
  if (truncated) return { files: [], reliable: false };
  return { files: (removedFiles ?? []).filter((file) => !seen.has(file)), reliable: true };
}

/**
 * Roll a task's working tree back to one of its snapshots.
 *
 * The current state is snapshotted first, so the rollback itself can be rolled
 * back: `undo` names the snapshot that holds what was on disk a moment ago.
 * That is also what makes the removals safe to report rather than refuse:
 * every file this rollback deletes is in the undo snapshot.
 *
 * @param {{ taskStore: object, record: object, worktreePath: string, snapshotId: string }} input
 * @returns {Promise<{ snapshot: object, undo: object, restored_files: number, removed_files: string[], removed_unsnapshotted_files: string[], removed_snapshot_history_complete: boolean, task: object }>}
 */
export async function rollbackTaskToSnapshot({ taskStore, record, worktreePath, snapshotId }) {
  const target = findTaskSnapshot(record, snapshotId);
  if (!target) throw new Error(`Task ${record.id} has no snapshot ${snapshotId}. Call list_task_snapshots to see what it has.`);
  if (target.deleted_at) {
    throw new Error(`Snapshot ${target.snapshot_id} was deleted (${target.deleted_reason || "pruned"}) and cannot be restored.`);
  }
  const undo = await captureTaskSnapshot({
    taskStore,
    record,
    worktreePath,
    label: `Before rollback to ${target.snapshot_id}`,
    trigger: "rollback"
  });
  const restore = await restoreSnapshot({ worktreePath, commit: target.commit });
  const unsnapshotted = unsnapshottedRemovals(record, restore.removed_files);
  const task = await taskStore.update(record.id, (current) => {
    current.rollbacks = [...(Array.isArray(current.rollbacks) ? current.rollbacks : []), {
      at: new Date().toISOString(),
      to: target.snapshot_id,
      commit: target.commit,
      undo_snapshot_id: undo.snapshot.snapshot_id,
      restored_files: restore.restored_files,
      removed_files: restore.removed_files.length,
      removed_unsnapshotted_files: unsnapshotted.files
    }];
    return current;
  });
  return {
    snapshot: target,
    undo: undo.snapshot,
    ...restore,
    removed_unsnapshotted_files: unsnapshotted.files,
    removed_snapshot_history_complete: unsnapshotted.reliable,
    task
  };
}

/**
 * Delete every snapshot a task still holds. Called when the task closes and by
 * `prune_state`; safe to call twice, and safe to call on a task that never had
 * a snapshot or whose repository is gone.
 *
 * @param {{ taskStore: object, record: object, worktreePath: string, reason?: string }} input
 * @returns {Promise<{ status: "pruned"|"nothing_to_prune"|"skipped", deleted: number, reason?: string, task: object }>}
 */
export async function pruneTaskSnapshots({ taskStore, record, worktreePath, reason = "completed" }) {
  const live = liveSnapshots(record);
  if (!live.length) return { status: "nothing_to_prune", deleted: 0, task: record };
  const sequences = live.map((item) => Number(item.sequence));
  try {
    // Every ref of this task goes, not only the recorded ones: a capture that
    // wrote its ref and then failed to record it leaves nothing behind.
    await deleteSnapshotRefs({ worktreePath, taskId: record.id });
  } catch (error) {
    return { status: "skipped", deleted: 0, reason: error instanceof Error ? error.message : String(error), task: record };
  }
  return {
    status: "pruned",
    deleted: sequences.length,
    task: await markDeleted({ taskStore, taskId: record.id, sequences, reason })
  };
}
