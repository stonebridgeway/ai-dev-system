/**
 * The MCP surface over task snapshots.
 *
 * `snapshot_task` records the working tree as it is right now,
 * `list_task_snapshots` says what can be returned to, and `rollback_task` puts
 * the files back — snapshotting the current state first, so the rollback itself
 * can be undone. `checkpoint_task` takes a snapshot on its own (see
 * `src/extensions/lifecycle.mjs`), so a task that only ever checkpoints still
 * has a turn-by-turn history to fall back to.
 *
 * Everything git touches lives in `src/core/task-snapshots.mjs`; this module
 * resolves which working tree belongs to the task and shapes the answers.
 */
import {
  captureTaskSnapshot,
  listSnapshotRefs,
  resolveTaskWorktree,
  rollbackTaskToSnapshot,
  taskSnapshots
} from "../core/task-snapshots.mjs";

/**
 * The task and the working tree its files live in — its own worktree when it
 * has one, the project root otherwise.
 *
 * @param {object} host
 * @param {string} taskId
 * @returns {Promise<{ record: object, worktreePath: string }>}
 */
async function taskWorkingTree(host, taskId) {
  const record = await host.taskStore.read(taskId);
  const worktreePath = await resolveTaskWorktree({
    record,
    resolveProjectIdentity: host.resolveProjectIdentity
  });
  return { record, worktreePath };
}

/** What a snapshot looks like in a tool response: the record, plus whether git still has it. */
function describe(entry, available) {
  return {
    snapshot_id: entry.snapshot_id,
    sequence: entry.sequence,
    turn: entry.turn,
    trigger: entry.trigger,
    label: entry.label,
    commit: entry.commit,
    ref: entry.ref,
    files: entry.files,
    file_count: entry.file_count,
    created_at: entry.created_at,
    available,
    ...(entry.deleted_at ? { deleted_at: entry.deleted_at, deleted_reason: entry.deleted_reason || "pruned" } : {})
  };
}

async function snapshotTask(host, { task_id, label = "" }) {
  const { record, worktreePath } = await taskWorkingTree(host, task_id);
  const captured = await captureTaskSnapshot({
    taskStore: host.taskStore,
    record,
    worktreePath,
    label,
    trigger: "manual"
  });
  return {
    action: "snapshot_created",
    task_id: record.id,
    worktree_path: captured.snapshot.worktree_path,
    snapshot: describe(captured.snapshot, true),
    snapshots: taskSnapshots(captured.task).filter((item) => !item.deleted_at).length,
    next_step: `Roll back to this state with rollback_task(task_id=${record.id}, snapshot_id=${captured.snapshot.snapshot_id}).`
  };
}

async function listTaskSnapshots(host, { task_id }) {
  const { record, worktreePath } = await taskWorkingTree(host, task_id);
  const refs = await listSnapshotRefs({ worktreePath, taskId: record.id }).catch(() => []);
  const live = new Map(refs.map((item) => [item.sequence, item]));
  const snapshots = taskSnapshots(record).map((entry) => describe(entry, live.has(Number(entry.sequence))));
  return {
    task_id: record.id,
    task_status: record.status,
    worktree_path: worktreePath,
    snapshots,
    count: snapshots.length,
    available: snapshots.filter((item) => item.available).length,
    rollbacks: Array.isArray(record.rollbacks) ? record.rollbacks : []
  };
}

/** A file list a person can read in a tool answer, with a tail count. */
function listFiles(files, limit = 20) {
  const shown = files.slice(0, limit).map((file) => `\`${file}\``).join(", ");
  return files.length > limit ? `${shown} and ${files.length - limit} more` : shown;
}

async function rollbackTask(host, { task_id, snapshot_id }) {
  const { record, worktreePath } = await taskWorkingTree(host, task_id);
  const result = await rollbackTaskToSnapshot({
    taskStore: host.taskStore,
    record,
    worktreePath,
    snapshotId: snapshot_id
  });
  // Every file a rollback deletes is named, because a rollback brings the tree
  // to the snapshot's state and anything written since goes — this task's own
  // work as much as a file a person put there from another terminal (Д-15).
  // The warning says that about all of them equally: which of two files written
  // since the last snapshot is whose is not something the snapshots know, and
  // the split used to claim it did (Д-28). The deletions are recoverable from
  // the undo snapshot, so they are reported rather than refused.
  const warnings = [];
  if (result.removed_files.length) {
    warnings.push(`${result.removed_files.length} file(s) that did not exist in ${result.snapshot.snapshot_id} were deleted: ${listFiles(result.removed_files)}. All of them were written after that snapshot — by this task, or by anyone else working in this tree. Every one is in the undo snapshot ${result.undo.snapshot_id}: restore them with rollback_task(task_id=${record.id}, snapshot_id=${result.undo.snapshot_id}), and check with whoever shares the working tree before carrying on.`);
  }
  if (result.removed_unsnapshotted_files.length) {
    warnings.push(`${result.removed_unsnapshotted_files.length} of them appear in no snapshot of this task at all, so the undo snapshot is the only record that they existed: ${listFiles(result.removed_unsnapshotted_files)}.`);
  } else if (result.removed_files.length && !result.removed_snapshot_history_complete) {
    warnings.push("Which of the deleted files this task had snapshotted before could not be told: at least one snapshot recorded more paths than it kept. Read the removed_files list rather than trusting the split.");
  }
  return {
    action: "rolled_back",
    task_id: record.id,
    worktree_path: worktreePath,
    snapshot: describe(result.snapshot, true),
    undo_snapshot: describe(result.undo, true),
    restored_files: result.restored_files,
    removed_files: result.removed_files,
    removed_unsnapshotted_files: result.removed_unsnapshotted_files,
    removed_snapshot_history_complete: result.removed_snapshot_history_complete,
    warnings,
    ...(result.kept_files.length ? { kept_files: result.kept_files, kept_reason: "A nested repository is left in place: its history is not this task's to delete." } : {}),
    next_step: `This rollback is itself reversible: rollback_task(task_id=${record.id}, snapshot_id=${result.undo.snapshot_id}) restores the state it replaced.`
  };
}

/**
 * @param {object} host - Shared runtime services (see `src/tool-extensions.mjs`).
 * @returns {{ definitions: Array<object>, handlers: object, readOnly: Array<string> }}
 */
export function createSnapshotTools(host) {
  return {
    definitions: [
      {
        name: "snapshot_task",
        description: "Record the task's whole working tree (tracked changes, staged or not, plus new files) as a restorable snapshot. Nothing is committed to a branch and nothing is stashed: the snapshot is one object kept alive by a ref under refs/ai-dev/snapshots/<task_id>/. checkpoint_task snapshots on its own; call this before a risky edit that is not a checkpoint.",
        inputSchema: {
          type: "object",
          properties: {
            task_id: { type: "string" },
            label: { type: "string", description: "What this state is, for reading the list later (\"before the router rewrite\")." }
          },
          required: ["task_id"]
        }
      },
      {
        name: "list_task_snapshots",
        description: "List a task's snapshots with the turn they belong to, what changed, and whether git still holds them. Snapshots are deleted when the task completes.",
        inputSchema: {
          type: "object",
          properties: { task_id: { type: "string" } },
          required: ["task_id"]
        }
      },
      {
        name: "rollback_task",
        description: "Restore the task's working tree to a snapshot: files it holds go back to their recorded content and files added since are removed. Every removed file is named in removed_files with a warning — all of them were written after the snapshot, by this task or by anyone else sharing the working tree — and the ones no snapshot of this task holds at all are named again in removed_unsnapshotted_files. Ignored files, nested repositories and the git index are untouched, and no branch, commit or stash entry is written. The state being replaced is snapshotted first, so the rollback can itself be rolled back and nothing it deleted is lost.",
        inputSchema: {
          type: "object",
          properties: {
            task_id: { type: "string" },
            snapshot_id: { type: "string", description: "Snapshot id (snapshot-3), its number (3), or its commit." }
          },
          required: ["task_id", "snapshot_id"]
        }
      }
    ],
    handlers: {
      snapshot_task: (args) => snapshotTask(host, args),
      list_task_snapshots: (args) => listTaskSnapshots(host, args),
      rollback_task: (args) => rollbackTask(host, args)
    },
    readOnly: ["list_task_snapshots"]
  };
}
