/**
 * What a finished task leaves behind.
 *
 * `complete_task` writes a durable record of the run into the vault and tells
 * the agent what is left to do with the branch. The record and that advice are
 * both derived from the task record alone, so they are written here.
 */

/**
 * The task run as a knowledge note: what was asked, what was accepted, which
 * skills were routed, and every verification with its verdict.
 *
 * @param {object} record - A completed task record.
 * @returns {string} Markdown, frontmatter included.
 */
export function taskCompletionMarkdown(record) {
  const lines = [
    "---",
    `task_id: ${record.id}`,
    `project: ${JSON.stringify(record.project.name)}`,
    `status: ${record.status}`,
    `completed_at: ${record.completion?.at || ""}`,
    "---",
    "",
    `# ${record.task}`,
    "",
    `Project: \`${record.project.path}\``,
    "",
    `Risk: ${record.risk}`,
    "",
    "## Completion",
    "",
    record.completion?.summary || "",
    "",
    "## Acceptance Criteria",
    ""
  ];
  for (const item of record.acceptance_criteria) {
    lines.push(`- [${item.status === "met" ? "x" : " "}] ${item.id}: ${item.text}${item.note ? ` (${item.note})` : ""}`);
  }
  lines.push("", "## Skills", "");
  for (const item of record.skills) lines.push(`- ${item.name} (${item.routing_role || item.role || "routed"})`);
  lines.push("", "## Verification", "");
  for (const item of record.verifications) {
    lines.push(`- ${item.id}: ${item.passed ? "passed" : "failed"} at ${item.at}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The task's worktree, if it still has one.
 *
 * A removed worktree is recorded rather than deleted, so "has a worktree" means
 * one that was created and not yet removed.
 *
 * @param {object} record - A task record.
 * @returns {object|null}
 */
export function activeWorktree(record) {
  return record.context?.worktree && !record.context.worktree.removed_at ? record.context.worktree : null;
}

/**
 * What to do next with the branch this task was written on.
 *
 * @param {object} input
 * @param {string} [input.pullRequestPath] - Where the prepared description was written.
 * @param {boolean} [input.hasGit] - Whether the project is a git repository.
 * @param {string} [input.worktreeBranch] - The task's worktree branch, when it has one.
 * @returns {string[]} One sentence per step, in the order they should be read.
 */
export function completionNextSteps({ pullRequestPath = "", hasGit = false, worktreeBranch = "" }) {
  const nextSteps = [];
  if (pullRequestPath) {
    nextSteps.push(`The pull request description is prepared in ${pullRequestPath}; review it, then push the branch and open the pull request with the commands it lists.`);
  } else if (hasGit) {
    nextSteps.push("Call prepare_pull_request to build the pull request description from this task's evidence.");
  }
  if (worktreeBranch) nextSteps.push(`Merge or open a PR from ${worktreeBranch}, then call remove_task_worktree.`);
  return nextSteps;
}
