import path from "node:path";
import {
  CLEANABLE_STATES,
  STALE_AFTER_DAYS,
  TASK_BRANCH_PREFIX,
  WORKTREES_DIR,
  WORKTREE_STATES,
  cleanupTaskWorktrees,
  createTaskWorktree,
  listTaskWorktrees,
  removeTaskWorktree,
  worktreeName
} from "../core/task-worktrees.mjs";

function parseToolText(result) {
  const text = result?.content?.find((item) => item.type === "text")?.text ?? "";
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Unexpected tool result: ${text.slice(0, 200)}`);
  }
}

/**
 * Task worktree tools: one git worktree + branch per task so parallel tasks
 * never share a working tree, and the task record remembers where its code lives.
 *
 * @param {{ callTool: Function, taskStore: { read: Function, update: Function }, resolveProjectIdentity: Function }} host
 */
export function createWorktreeTools(host) {
  return {
    definitions: [
      {
        name: "begin_task_in_worktree",
        description: "Create an isolated git worktree and branch (task/<name> under .worktrees/) from base_ref, copy the agent handoff files into it, then start begin_task inside the worktree. Use for parallel or risky work so the main checkout stays untouched.",
        inputSchema: {
          type: "object",
          properties: {
            project_path: { type: "string", description: "Absolute path of the main repository (or any of its worktrees)." },
            task: { type: "string" },
            project_name: { type: "string" },
            acceptance_criteria: { type: "array", items: { type: "string" }, default: [] },
            base_ref: { type: "string", default: "HEAD", description: "Commit, branch, or tag the task branch starts from." },
            name: { type: "string", description: "Optional worktree/branch slug; derived from the task text when omitted." }
          },
          required: ["project_path", "task"]
        }
      },
      {
        name: "list_task_worktrees",
        description: `List task worktrees of a repository with branch, dirty state, commits ahead of the main checkout, and the lifecycle state of each: ${WORKTREE_STATES.join(", ")}. orphan means git still registers a directory that is gone, dirty means uncommitted work lives only there, merged means every commit is already in the main checkout, stale means unmerged commits with nothing recent, active means leave it alone.`,
        inputSchema: {
          type: "object",
          properties: {
            project_path: { type: "string" },
            include_status: { type: "boolean", default: true, description: "Read dirty state, distance from the main checkout and the lifecycle state. Without it only the registration is listed." },
            stale_after_days: { type: "number", default: STALE_AFTER_DAYS, description: "How old a worktree's newest commit may be before it reads as stale." }
          },
          required: ["project_path"]
        }
      },
      {
        name: "plan_worktree_cleanup",
        description: `Plan which task worktrees can go, by lifecycle state, and carry the plan out only when dry_run is false. ${CLEANABLE_STATES.join(" and ")} worktrees are offered; stale ones only with include_stale, because a branch with no recent commits is also what one waiting on review looks like; dirty ones never — use remove_task_worktree with force to discard uncommitted work deliberately.`,
        inputSchema: {
          type: "object",
          properties: {
            project_path: { type: "string" },
            dry_run: { type: "boolean", default: true, description: "Report the plan and remove nothing." },
            include_stale: { type: "boolean", default: false, description: "Also offer worktrees with unmerged commits that have seen nothing recent." },
            delete_branch: { type: "boolean", default: false, description: "Delete each removed worktree's task branch as well." },
            stale_after_days: { type: "number", default: STALE_AFTER_DAYS }
          },
          required: ["project_path"]
        }
      },
      {
        name: "remove_task_worktree",
        description: "Remove a task worktree after its branch was merged or abandoned. Refuses while uncommitted changes exist unless force=true; optionally deletes the task branch.",
        inputSchema: {
          type: "object",
          properties: {
            task_id: { type: "string", description: "Task whose worktree is removed (from its record)." },
            worktree_path: { type: "string", description: "Explicit worktree path when no task id is available." },
            force: { type: "boolean", default: false },
            delete_branch: { type: "boolean", default: false }
          }
        }
      }
    ],
    handlers: {
      async begin_task_in_worktree(args) {
        const identity = await host.resolveProjectIdentity(args.project_path);
        const stamp = new Date().toISOString().replace(/\D/g, "").slice(4, 12);
        const name = args.name ? worktreeName(args.name) : `${worktreeName(args.task, 36)}-${stamp}`;
        const worktree = await createTaskWorktree({
          projectRoot: identity.project_root,
          name,
          baseRef: args.base_ref || "HEAD"
        });
        const begun = parseToolText(await host.callTool("begin_task", {
          project_path: worktree.path,
          task: args.task,
          project_name: args.project_name || "",
          acceptance_criteria: args.acceptance_criteria || []
        }));
        const record = await host.taskStore.update(begun.id, (current) => {
          current.context = {
            ...current.context,
            worktree: {
              path: worktree.path,
              branch: worktree.branch,
              base_ref: worktree.base_ref,
              main_root: worktree.main_root,
              created: worktree.created
            }
          };
          return current;
        });
        return {
          ...begun,
          context: record.context,
          worktree,
          next_actions: [
            `Work only inside ${worktree.path} (branch ${worktree.branch}); commit there.`,
            ...(begun.next_actions ?? []),
            "After complete_task, merge or open a PR from the task branch, then call remove_task_worktree."
          ]
        };
      },
      async list_task_worktrees(args) {
        const identity = await host.resolveProjectIdentity(args.project_path);
        const includeStatus = args.include_status !== false;
        const listed = await listTaskWorktrees({
          projectRoot: identity.project_root,
          includeStatus,
          staleAfterDays: Number(args.stale_after_days) > 0 ? Number(args.stale_after_days) : undefined
        });
        const byState = {};
        for (const worktree of listed.worktrees) {
          if (!worktree.state) continue;
          byState[worktree.state] = (byState[worktree.state] ?? 0) + 1;
        }
        return {
          ...listed,
          worktrees_dir: WORKTREES_DIR,
          branch_prefix: TASK_BRANCH_PREFIX,
          count: listed.worktrees.length,
          by_state: byState,
          next_step: includeStatus
            ? (byState.merged || byState.orphan
              ? "plan_worktree_cleanup lists what can go and removes nothing until dry_run is false."
              : "Nothing here is finished with; leave them.")
            : "Pass include_status to read each worktree's lifecycle state."
        };
      },
      async plan_worktree_cleanup(args) {
        const identity = await host.resolveProjectIdentity(args.project_path);
        const result = await cleanupTaskWorktrees({
          projectRoot: identity.project_root,
          dryRun: args.dry_run !== false,
          includeStale: Boolean(args.include_stale),
          deleteBranch: Boolean(args.delete_branch),
          staleAfterDays: Number(args.stale_after_days) > 0 ? Number(args.stale_after_days) : undefined
        });
        return {
          ...result,
          worktrees_dir: WORKTREES_DIR,
          branch_prefix: TASK_BRANCH_PREFIX,
          next_step: result.dry_run
            ? (result.remove.length
              ? `Nothing was removed. Call again with dry_run: false to remove ${result.remove.length} worktree(s).`
              : "Nothing can be cleaned up yet.")
            : result.problems.length
              ? "Some worktrees could not be removed; the problems list says which and why."
              : `${result.removed.length} worktree(s) removed.`
        };
      },
      async remove_task_worktree(args) {
        let worktreePath = args.worktree_path ? path.resolve(args.worktree_path) : "";
        let record = null;
        if (args.task_id) {
          record = await host.taskStore.read(args.task_id);
          worktreePath = record.context?.worktree?.path || worktreePath;
          if (!worktreePath) throw new Error(`Task ${args.task_id} has no recorded worktree.`);
          if (record.status !== "complete" && !args.force) {
            throw new Error(`Task ${args.task_id} is ${record.status}; complete it first or pass force=true.`);
          }
        }
        if (!worktreePath) throw new Error("task_id or worktree_path is required.");
        const projectRoot = record?.context?.worktree?.main_root || path.dirname(path.dirname(worktreePath));
        const removed = await removeTaskWorktree({
          projectRoot,
          worktreePath,
          force: Boolean(args.force),
          deleteBranch: Boolean(args.delete_branch)
        });
        if (record) {
          await host.taskStore.update(record.id, (current) => {
            current.context = { ...current.context, worktree: { ...current.context.worktree, removed_at: new Date().toISOString() } };
            return current;
          });
        }
        return { action: "worktree_removed", task_id: record?.id || null, ...removed };
      }
    },
    readOnly: ["list_task_worktrees"]
  };
}
