import assert from "node:assert/strict";
import test from "node:test";
import {
  activeWorktree,
  completionNextSteps,
  taskCompletionMarkdown
} from "./task-completion.mjs";

function record(overrides = {}) {
  return {
    id: "task-20260101T000000-abcd1234",
    task: "Implement the delivery endpoint",
    status: "complete",
    risk: "medium",
    project: { name: "Atlas", path: "/repo/atlas" },
    completion: { at: "2026-01-02T00:00:00.000Z", summary: "Shipped behind a flag." },
    acceptance_criteria: [
      { id: "AC-1", text: "Automated checks pass.", status: "met" },
      { id: "AC-2", text: "The endpoint is documented.", status: "waived", note: "Docs follow next week" }
    ],
    skills: [
      { name: "feature-builder", routing_role: "primary" },
      { name: "code-reviewer", role: "support" },
      { name: "planner" }
    ],
    verifications: [
      { id: "verification-1", passed: false, at: "2026-01-01T12:00:00.000Z" },
      { id: "verification-2", passed: true, at: "2026-01-02T00:00:00.000Z" }
    ],
    ...overrides
  };
}

test("the completion note carries frontmatter, the task, and every criterion", () => {
  const note = taskCompletionMarkdown(record());
  assert.match(note, /^---\ntask_id: task-20260101T000000-abcd1234\n/);
  assert.match(note, /project: "Atlas"\n/);
  assert.match(note, /status: complete\n/);
  assert.match(note, /completed_at: 2026-01-02T00:00:00\.000Z\n/);
  assert.match(note, /\n# Implement the delivery endpoint\n/);
  assert.match(note, /Project: `\/repo\/atlas`/);
  assert.match(note, /Risk: medium/);
  assert.match(note, /## Completion\n\nShipped behind a flag\./);
  assert.match(note, /- \[x\] AC-1: Automated checks pass\./);
  assert.match(note, /- \[ \] AC-2: The endpoint is documented\. \(Docs follow next week\)/);
  assert.ok(note.endsWith("\n"));
});

test("skills fall back through routing_role, role, then `routed`", () => {
  const note = taskCompletionMarkdown(record());
  assert.match(note, /- feature-builder \(primary\)/);
  assert.match(note, /- code-reviewer \(support\)/);
  assert.match(note, /- planner \(routed\)/);
});

test("every verification is listed with its verdict, failures included", () => {
  const note = taskCompletionMarkdown(record());
  assert.match(note, /- verification-1: failed at 2026-01-01T12:00:00\.000Z/);
  assert.match(note, /- verification-2: passed at 2026-01-02T00:00:00\.000Z/);
});

test("a task with nothing recorded still renders", () => {
  const note = taskCompletionMarkdown(record({
    completion: null, acceptance_criteria: [], skills: [], verifications: []
  }));
  assert.match(note, /completed_at: \n/);
  assert.match(note, /## Completion\n\n\n/);
  assert.match(note, /## Skills\n\n\n## Verification/);
});

test("a removed worktree is not an active one", () => {
  assert.equal(activeWorktree(record()), null);
  assert.equal(activeWorktree(record({ context: {} })), null);
  const live = { branch: "task/isolated", path: "/repo/.worktrees/isolated" };
  assert.deepEqual(activeWorktree(record({ context: { worktree: live } })), live);
  assert.equal(activeWorktree(record({ context: { worktree: { ...live, removed_at: "2026-01-03T00:00:00.000Z" } } })), null);
});

test("a prepared description is offered first, and the fallback only when there is a repository", () => {
  assert.deepEqual(completionNextSteps({ pullRequestPath: ".ai-dev/pr/task-1.md", hasGit: true }), [
    "The pull request description is prepared in .ai-dev/pr/task-1.md; review it, then push the branch and open the pull request with the commands it lists."
  ]);
  assert.deepEqual(completionNextSteps({ hasGit: true }), [
    "Call prepare_pull_request to build the pull request description from this task's evidence."
  ]);
  // No repository, nothing to push: the task simply ends.
  assert.deepEqual(completionNextSteps({ hasGit: false }), []);
  assert.deepEqual(completionNextSteps({}), []);
});

test("a worktree adds its own step, after whatever the pull request step said", () => {
  assert.deepEqual(completionNextSteps({ pullRequestPath: "p.md", hasGit: true, worktreeBranch: "task/iso" }), [
    "The pull request description is prepared in p.md; review it, then push the branch and open the pull request with the commands it lists.",
    "Merge or open a PR from task/iso, then call remove_task_worktree."
  ]);
  assert.deepEqual(completionNextSteps({ hasGit: false, worktreeBranch: "task/iso" }), [
    "Merge or open a PR from task/iso, then call remove_task_worktree."
  ]);
});
