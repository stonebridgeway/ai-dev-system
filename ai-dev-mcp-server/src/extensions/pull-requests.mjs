import { listDecisions } from "../core/decision-ledger.mjs";
import { fillTemplate, findPullRequestTemplate, renderSections } from "../core/pr-template.mjs";
import {
  PR_RELATIVE_DIR,
  buildPullRequestSections,
  collectPullRequestChanges,
  groupChangedFiles,
  prRelativePath,
  pullRequestCommands,
  pullRequestTitle,
  resolveBaseRef
} from "../core/pull-request.mjs";
import { PLANS_RELATIVE_DIR } from "../core/task-plans.mjs";

/**
 * Pull-request preparation: turn a task's own evidence into the description a
 * reviewer needs. The tool reads the task record, the repository diff, the
 * decisions and the plan, fills the repository's pull-request template when it
 * has one, and writes the result to `.ai-dev/pr/<task_id>.md`.
 *
 * It pushes nothing and creates nothing on a forge: the branch push and the
 * pull request itself stay a human decision, so the commands for both are
 * returned as text.
 *
 * @param {{ taskStore: { read: Function }, resolveProjectIdentity: Function, writeProjectFile: Function, readProjectTextIfExists: Function }} host
 */
export function createPullRequestTools(host) {
  async function readPlan(projectRoot, taskId) {
    const text = await host.readProjectTextIfExists(projectRoot, `${PLANS_RELATIVE_DIR}/${taskId}.json`).catch(() => "");
    if (!text.trim()) return null;
    try {
      return JSON.parse(text).plan ?? null;
    } catch {
      return null;
    }
  }

  return {
    definitions: [
      {
        name: "prepare_pull_request",
        description: "Build a pull request description from a task's recorded evidence: goal, acceptance criteria with their status, checkpoints, the latest verify_task run and the checks it executed, recorded decisions, the plan, and the changed files grouped by kind. Fills the repository's pull request template when it has one, writes .ai-dev/pr/<task_id>.md and returns the text plus ready-to-run push and gh pr create commands. Pushes nothing and creates nothing on GitHub.",
        inputSchema: {
          type: "object",
          properties: {
            task_id: { type: "string", description: "Task whose evidence becomes the description." },
            base_ref: { type: "string", description: "Branch the pull request targets. Detected from the task worktree, origin/HEAD, main or master when omitted; an explicit ref that does not resolve is an error." },
            title: { type: "string", description: "Override the generated conventional-commit title." },
            template_path: { type: "string", description: "Repository-relative pull request template to fill instead of the discovered one." },
            max_files: { type: "number", default: 200, description: "Cap on listed changed files." },
            write_file: { type: "boolean", default: true, description: "Write .ai-dev/pr/<task_id>.md. Set false to preview the text only." }
          },
          required: ["task_id"]
        }
      }
    ],
    handlers: {
      async prepare_pull_request(args) {
        const record = await host.taskStore.read(args.task_id);
        const projectRoot = (await host.resolveProjectIdentity(record.project.path)).project_root;
        const worktreeBase = record.context?.worktree?.base_ref || "";
        const base = await resolveBaseRef({
          projectRoot,
          requested: String(args.base_ref || "").trim(),
          candidates: worktreeBase ? [worktreeBase] : []
        });
        const [changes, decisions, plan, template] = await Promise.all([
          collectPullRequestChanges({ projectRoot, baseRef: base.base_ref, maxFiles: args.max_files }),
          listDecisions(projectRoot, { limit: 20 }).catch(() => []),
          readPlan(projectRoot, record.id),
          findPullRequestTemplate(projectRoot, { explicitPath: String(args.template_path || "").trim() })
        ]);
        // A decision belongs in this description when the task recorded it, or
        // when its file is part of the change under review. Older decisions of
        // the same project are context, not this pull request's content.
        const changed = new Set(changes.files.map((file) => file.path));
        const taskDecisions = decisions.filter((item) => (
          item.task_id === record.id || (!item.task_id && changed.has(item.path))
        ));
        const built = buildPullRequestSections({
          record,
          decisions: taskDecisions,
          plan,
          changes,
          baseRef: base.base_ref
        });
        const title = String(args.title || "").trim()
          || pullRequestTitle({ task: record.task, files: changes.files.map((file) => file.path) });
        const filled = template
          ? fillTemplate({ markdown: template.markdown, sections: built.sections })
          : null;
        const body = filled ? filled.markdown : renderSections(built.sections);
        const relativePath = prRelativePath(record.id);
        const file = args.write_file === false
          ? { action: "skipped", path: relativePath, reason: "write_file=false" }
          : await host.writeProjectFile(projectRoot, relativePath, body, true);
        const branch = changes.branch || record.context?.worktree?.branch || "";
        return {
          action: "pull_request_prepared",
          task_id: record.id,
          project_path: projectRoot,
          path: relativePath,
          directory: PR_RELATIVE_DIR,
          file,
          title,
          body,
          base_ref: base.base_ref,
          base_ref_source: base.source,
          branch,
          template: template
            ? { found: true, path: template.path, filled: filled.filled, appended: filled.appended, kept: filled.kept }
            : { found: false, path: "", filled: [], appended: built.sections.filter((item) => item.lines.length).map((item) => item.key), kept: [] },
          changed_files: {
            count: changes.total ?? changes.files.length,
            listed: changes.files.length,
            truncated: changes.truncated,
            commits: changes.commits.length,
            groups: groupChangedFiles(changes.files).map((group) => ({
              id: group.id,
              title: group.title,
              files: group.files.map((file) => file.path)
            }))
          },
          checks: built.checks,
          checks_not_run: built.checks_not_run,
          outstanding: built.outstanding,
          decisions: taskDecisions.map((item) => item.id),
          commands: pullRequestCommands({ branch, baseRef: base.base_ref, title, bodyPath: relativePath }),
          next_step: built.outstanding.length
            ? `${built.outstanding.length} item(s) are still open and listed under "Outstanding" in ${relativePath}; close them or say in the pull request why they stay open.`
            : `Review ${relativePath}, then run the returned commands to push the branch and open the pull request.`
        };
      }
    },
    readOnly: []
  };
}
