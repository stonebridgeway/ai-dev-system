import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { recordDecision, listDecisions } from "./decision-ledger.mjs";
import { SessionStore, renderResumeBriefing } from "./session-memory.mjs";
import { InstinctStore } from "./instincts.mjs";
import { loadContextExtras } from "./context-extras.mjs";
import { runProcess } from "./process-runner.mjs";
import { resolveProjectIdentity } from "./project-identity.mjs";

async function runGit(cwd, args) {
  const result = await runProcess({ executable: "git", args: ["-C", cwd, ...args], cwd, timeoutMs: 20_000 });
  assert.equal(result.ok, true, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

test("decision, handoff, and instinct state are durable and become bounded context extras", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "learning-memory-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await recordDecision(root, { title: "Keep local state", context: "One machine", decision: "Use a JSON-backed local store.", tags: ["state"] });
  assert.equal((await listDecisions(root, { tag: "state" }))[0].id, "ADR-0001");
  const stateRoot = path.join(root, "state");
  const sessions = new SessionStore({ stateRoot });
  const saved = await sessions.save({ projectId: "fixture", projectPath: root, building: "Durable task handoffs with a verified next step.", failed: [{ approach: "Unstructured chat recall", reason: "lost context" }], next_step: "Run the focused tests." });
  assert.match(renderResumeBriefing({ record: saved.record }), /HISTORICAL REFERENCE ONLY/);
  const instincts = new InstinctStore({ stateRoot });
  const instinct = await instincts.record({ projectId: "fixture", trigger: "when retrying jobs", action: "use idempotency keys", domain: "architecture", confidence: .8 });
  assert.equal((await instincts.rankForContext({ projectId: "fixture", task: "Fix retrying jobs" })).instincts[0].id, instinct.instinct.id);
  const extras = await loadContextExtras({ projectRoot: root, stateRoot, projectId: "fixture", task: "Fix retrying jobs" });
  assert.deepEqual(extras.sections.map((section) => section.id), ["decisions", "handoff", "instincts"]);
});

test("memory recorded in a task worktree and in its main checkout is one shared context", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "learning-memory-worktree-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const checkout = path.join(root, "checkout");
  await fs.mkdir(checkout, { recursive: true });
  await fs.writeFile(path.join(checkout, "README.md"), "# fixture\n");
  await runGit(checkout, ["init", "-q", "-b", "main"]);
  await runGit(checkout, ["add", "."]);
  await runGit(checkout, ["-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "init"]);
  const worktreePath = path.join(checkout, ".worktrees", "task-one");
  await runGit(checkout, ["worktree", "add", "-q", "-b", "task/one", worktreePath]);

  const main = await resolveProjectIdentity(checkout);
  const worktree = await resolveProjectIdentity(worktreePath);
  assert.notEqual(worktree.project_id, main.project_id);
  const stateRoot = path.join(root, "state");

  // Saved inside the worktree, where begin_task_in_worktree puts the agent.
  const sessions = new SessionStore({ stateRoot });
  const saved = await sessions.save({
    repositoryId: worktree.repository_id,
    projectId: worktree.project_id,
    projectPath: worktree.project_root,
    branch: "task/one",
    building: "Rate limiting on the public API; the middleware is written but unwired.",
    failed: [{ approach: "A global express-rate-limit", reason: "it also throttled the health check" }],
    next_step: "Wire the middleware in server.ts and run the contract tests."
  });
  // Recorded in the main checkout, where the review happens.
  const instincts = new InstinctStore({ stateRoot });
  await instincts.record({
    repositoryId: main.repository_id,
    projectId: main.project_id,
    trigger: "when adding middleware",
    action: "Exclude the health check route",
    domain: "architecture",
    confidence: 0.85
  });

  const fromCheckout = await loadContextExtras({ projectRoot: main.project_root, stateRoot, repositoryId: main.repository_id, projectId: main.project_id, task: "Finish the rate limiting middleware" });
  assert.deepEqual(fromCheckout.sections.map((section) => section.id), ["handoff", "instincts"]);
  assert.equal(fromCheckout.sections[0].items[0].id, saved.record.id, "the worktree handoff reaches the main checkout");

  const fromWorktree = await loadContextExtras({ projectRoot: worktree.project_root, stateRoot, repositoryId: worktree.repository_id, projectId: worktree.project_id, task: "Finish the rate limiting middleware" });
  assert.equal(fromWorktree.sections[0].items[0].id, saved.record.id);
  assert.match(fromWorktree.sections[1].markdown, /Exclude the health check route/, "the main checkout instinct reaches the worktree");
  assert.deepEqual(fromCheckout.errors, []);
  assert.deepEqual(fromWorktree.errors, []);
});
