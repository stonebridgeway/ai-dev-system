import path from "node:path";
import { PRUNE_DEFAULTS, pruneState, renderPruneStateMarkdown } from "../core/state-pruning.mjs";

/**
 * State housekeeping as one tool.
 *
 * The decisions and the writes live in `core/state-pruning.mjs`; this is the
 * MCP surface over the four stores the host already owns. `dry_run` defaults to
 * true: the first call anyone makes should show the plan, not carry it out.
 *
 * @param {object} host - Shared runtime services from `mcp-stdio.mjs`.
 */
export function createStateTools(host) {
  return {
    definitions: [
      {
        name: "prune_state",
        description: "Tidy the local state directory: retire instincts whose confidence fell under 0.3 and that have not been observed for 90 days, archive session handoffs and hook observation logs older than 90 days (moved into an archive/ directory, never deleted), rotate the usage ledger down to its newest events, and delete the snapshot refs of completed and abandoned tasks. Runs as a dry run unless dry_run is false, and reports each area separately.",
        inputSchema: {
          type: "object",
          properties: {
            project_path: { type: "string", description: "Repository whose tasks are swept for snapshot refs. Omit to sweep every task in the state directory." },
            dry_run: { type: "boolean", default: true, description: "Report what would go and change nothing." },
            instinct_confidence_below: { type: "number", default: PRUNE_DEFAULTS.instinct_confidence_below },
            instinct_idle_days: { type: "number", default: PRUNE_DEFAULTS.instinct_idle_days },
            session_archive_days: { type: "number", default: PRUNE_DEFAULTS.session_archive_days },
            abandoned_task_days: { type: "number", default: PRUNE_DEFAULTS.abandoned_task_days, description: "A task that is not complete and has not been updated for this long has no work left to protect, so its snapshot refs go." },
            usage_keep_lines: { type: "number", default: PRUNE_DEFAULTS.usage_keep_lines }
          }
        }
      }
    ],
    handlers: {
      async prune_state(args = {}) {
        const projectPath = args.project_path
          ? (await host.resolveProjectIdentity(args.project_path)).project_root
          : "";
        const thresholds = {};
        for (const key of Object.keys(PRUNE_DEFAULTS)) {
          if (Number.isFinite(Number(args[key]))) thresholds[key] = Number(args[key]);
        }
        const result = await pruneState({
          projectPath,
          taskStore: host.taskStore,
          instinctStore: host.instinctStore,
          usageLedger: host.usageLedger,
          sessionsRoot: path.join(host.taskStateRoot, "sessions"),
          resolveProjectIdentity: host.resolveProjectIdentity,
          dryRun: args.dry_run !== false,
          thresholds
        });
        const planned = result.instincts.retired + result.sessions.archived + result.usage.removed + result.snapshots.tasks_pruned;
        return {
          ...result,
          state_root: host.taskStateRoot,
          markdown: renderPruneStateMarkdown(result),
          next_step: result.dry_run
            ? (planned
              ? "Read the plan, then call prune_state with dry_run: false to carry it out."
              : "Nothing has aged out yet; there is nothing to prune.")
            : result.problems.length
              ? "Some areas could not be tidied; the problems list says which and why."
              : "State pruned. Snapshot refs of completed and abandoned tasks are gone; archived sessions are still on disk under archive/."
        };
      }
    },
    readOnly: []
  };
}
