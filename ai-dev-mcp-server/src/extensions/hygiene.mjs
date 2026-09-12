import { renderChangeHygieneMarkdown, verifyChangeHygiene } from "../core/change-hygiene.mjs";

/**
 * Change hygiene tool: a deterministic review of added lines (secrets, debug
 * leftovers, focused/skipped tests, conflict markers, protected config edits,
 * missing test changes, documentation left behind by an interface change).
 * `verify_task` runs the same scan automatically; this tool lets the agent run
 * it early and often.
 *
 * @param {{ resolveProjectIdentity: Function, taskStore: { read: Function, checkpoint: Function } }} host
 */
export function createHygieneTools(host) {
  return {
    definitions: [
      {
        name: "verify_change_hygiene",
        description: "Scan the current change set (uncommitted work, or everything since base_ref) for secrets, debug leftovers, focused or skipped tests, merge-conflict markers, weakened lint configs, oversized files, source changes without test changes, and public-interface changes (exports, tool schemas, CLI flags) with no documentation change. Each finding is { rule, severity, file, line, message, excerpt } with severity block, warn, or info.",
        inputSchema: {
          type: "object",
          properties: {
            project_path: { type: "string", description: "Absolute repository path. Optional when task_id is given." },
            task_id: { type: "string", description: "Task whose project is scanned; a checkpoint note with the summary is added." },
            base_ref: { type: "string", default: "HEAD", description: "Git ref to diff against. Use the branch base (for example main) to include committed work." },
            max_files: { type: "number", default: 200 },
            record_checkpoint: { type: "boolean", default: false, description: "Attach the summary to the task as a checkpoint note." }
          }
        }
      }
    ],
    handlers: {
      async verify_change_hygiene(args) {
        let projectRoot;
        let record = null;
        if (args.task_id) {
          record = await host.taskStore.read(args.task_id);
          projectRoot = (await host.resolveProjectIdentity(record.project.path)).project_root;
        } else if (args.project_path) {
          projectRoot = (await host.resolveProjectIdentity(args.project_path)).project_root;
        } else {
          throw new Error("project_path or task_id is required.");
        }
        const result = await verifyChangeHygiene(projectRoot, {
          baseRef: args.base_ref || "HEAD",
          maxFiles: args.max_files
        });
        const markdown = renderChangeHygieneMarkdown(result);
        let checkpoint = null;
        if (record && args.record_checkpoint && record.status !== "complete") {
          const updated = await host.taskStore.checkpoint(record.id, {
            summary: `Change hygiene: ${result.status} (${result.summary?.block ?? 0} block, ${result.summary?.warn ?? 0} warn)`,
            changedFiles: result.files,
            notes: markdown
          });
          checkpoint = { task_id: updated.id, checkpoints: updated.checkpoints.length };
        }
        return {
          project_path: projectRoot,
          ...result,
          markdown,
          checkpoint,
          next_step: result.status === "block"
            ? "Fix every block finding (rotate real secrets, remove leftovers) before verify_task."
            : result.status === "warn"
              ? "Address or explicitly justify the warnings in your checkpoint notes."
              : "No hygiene issues; continue with verify_task."
        };
      }
    },
    readOnly: []
  };
}
