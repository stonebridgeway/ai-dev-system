import {
  DECISION_STATUSES,
  DECISIONS_RELATIVE_DIR,
  listDecisions,
  recordDecision
} from "../core/decision-ledger.mjs";

/**
 * Decision ledger tools: lightweight ADRs stored with the code under
 * `.ai-dev/decisions/` and surfaced in every context pack.
 *
 * @param {{ resolveProjectIdentity: Function, taskStore: { read: Function, checkpoint: Function }, markSearchIndexDirty?: Function }} host
 */
export function createDecisionTools(host) {
  async function projectRootFor({ project_path, task_id }) {
    if (task_id) {
      const record = await host.taskStore.read(task_id);
      return { projectRoot: (await host.resolveProjectIdentity(record.project.path)).project_root, record };
    }
    if (!project_path) throw new Error("project_path or task_id is required.");
    return { projectRoot: (await host.resolveProjectIdentity(project_path)).project_root, record: null };
  }

  return {
    definitions: [
      {
        name: "record_decision",
        description: "Record an architecture or product decision as a numbered ADR under .ai-dev/decisions (title, context, decision, alternatives, consequences). Decisions are versioned with the code and surfaced in later context packs. Give project_path or task_id: a decision is recorded against a repository, and the task is how it finds one.",
        inputSchema: {
          type: "object",
          properties: {
            project_path: { type: "string", description: "Absolute repository path. Optional when task_id is given." },
            task_id: { type: "string", description: "Task that produced the decision; a checkpoint note is added to it." },
            title: { type: "string" },
            context: { type: "string", description: "Why the decision was needed." },
            decision: { type: "string", description: "What was decided, stated as a fact." },
            alternatives: { type: "array", items: { type: "string" }, default: [] },
            consequences: { type: "array", items: { type: "string" }, default: [] },
            tags: { type: "array", items: { type: "string" }, default: [] },
            status: { type: "string", enum: DECISION_STATUSES, default: "accepted" },
            supersedes: { type: "string", description: "Id of an older decision this one replaces, for example ADR-0003." }
          },
          required: ["title", "decision"]
        }
      },
      {
        name: "list_decisions",
        description: "List recorded decisions (ADRs) for a project, newest first, optionally filtered by status or tag. Give project_path or task_id to say which repository to read.",
        inputSchema: {
          type: "object",
          properties: {
            project_path: { type: "string" },
            task_id: { type: "string" },
            status: { type: "string", enum: DECISION_STATUSES },
            tag: { type: "string" },
            limit: { type: "number", default: 20 }
          }
        }
      }
    ],
    handlers: {
      async record_decision(args) {
        const { projectRoot, record } = await projectRootFor(args);
        const result = await recordDecision(projectRoot, {
          title: args.title,
          context: args.context,
          decision: args.decision,
          alternatives: args.alternatives,
          consequences: args.consequences,
          tags: args.tags,
          status: args.status,
          supersedes: args.supersedes,
          task_id: args.task_id || ""
        });
        let checkpoint = null;
        if (record && record.status !== "complete") {
          checkpoint = await host.taskStore.checkpoint(record.id, {
            summary: `Decision recorded: ${result.record.id} ${result.record.title}`,
            changedFiles: [result.path],
            notes: result.record.decision
          }).then((updated) => ({ task_id: updated.id, checkpoints: updated.checkpoints.length }));
        }
        host.markSearchIndexDirty?.(`decision recorded: ${result.path}`);
        return {
          action: "decision_recorded",
          project_path: projectRoot,
          decision: result.record,
          path: result.path,
          superseded: result.superseded,
          checkpoint,
          next_step: `Commit ${DECISIONS_RELATIVE_DIR} with the code change so the decision travels with the repository.`
        };
      },
      async list_decisions(args) {
        const { projectRoot } = await projectRootFor(args);
        const decisions = await listDecisions(projectRoot, {
          status: args.status,
          tag: args.tag,
          limit: args.limit
        });
        return {
          project_path: projectRoot,
          directory: DECISIONS_RELATIVE_DIR,
          count: decisions.length,
          decisions
        };
      }
    },
    readOnly: ["list_decisions"]
  };
}
