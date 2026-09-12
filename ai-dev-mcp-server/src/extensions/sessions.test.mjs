import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionStore } from "../core/session-memory.mjs";
import { TaskStore } from "../core/task-lifecycle.mjs";
import { createExtensionTools } from "../tool-extensions.mjs";
import { createSessionTools } from "./sessions.mjs";

test("session tools save a handoff, resume with a briefing, and estimate the budget", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "session-tools-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, "project");
  await fs.mkdir(path.join(projectRoot, ".ai-dev", "rules"), { recursive: true });
  await fs.writeFile(path.join(projectRoot, "AGENTS.md"), "# AGENTS\n".repeat(50));
  await fs.writeFile(path.join(projectRoot, ".ai-dev", "rules", "common.md"), "rules ".repeat(400));
  const vaultRoot = path.join(root, "vault");
  await fs.mkdir(path.join(vaultRoot, "skills"), { recursive: true });
  await fs.writeFile(path.join(vaultRoot, "skills", "one.md"), "x".repeat(8_000));
  const stateRoot = path.join(root, "state");
  const taskStore = new TaskStore({ stateRoot });
  const sessionStore = new SessionStore({ stateRoot });
  const host = {
    taskStore,
    sessionStore,
    vaultRoot,
    resolveProjectIdentity: async (projectPath) => ({ project_root: projectPath, project_id: "project-test" }),
    captureProjectState: async () => ({ fingerprint: "f1", branch: "feature/auth", dirty: true, dirty_files: ["a.ts"] }),
    detectProject: async () => ({ stack: ["TypeScript"], project_types: ["frontend"] }),
    instinctStore: { rankForContext: async () => ({ markdown: "Active instincts:\n- [project 80%] grep before edit" }) }
  };
  const registry = createExtensionTools(host, [createSessionTools]);
  const task = await taskStore.begin({
    task: "Finish auth",
    project: { project_name: "fixture", project_path: projectRoot },
    skills: [{ name: "one", path: "skills/one.md" }],
    baseline: { fingerprint: "f0" },
    context: { compiled_context: "c".repeat(20_000) }
  });

  const empty = await registry.handlers.get("resume_session")({ project_path: projectRoot });
  assert.equal(empty.session, null);
  assert.match(empty.briefing, /NO SAVED SESSION/);
  assert.equal(empty.context_pack.compiled, false);

  const saved = await registry.handlers.get("save_session")({
    task_id: task.id,
    building: "JWT auth with httpOnly cookies; the login route still needs to set the cookie.",
    worked: [{ item: "register endpoint", evidence: "Postman 200" }],
    failed: [{ approach: "Next-Auth", reason: "Prisma adapter conflict" }, { approach: "iron-session", why: "no rotation story" }],
    next_step: "Set the cookie in the login route and run verify_task.",
    client: "claude-code"
  });
  assert.equal(saved.action, "session_saved");
  assert.equal(saved.checkpoint.checkpoints, 1);
  assert.match(await fs.readFile(path.join(projectRoot, ".ai-dev", "context", "handoff.md"), "utf8"), /Set the cookie/);

  await fs.mkdir(path.join(projectRoot, ".ai-dev", "context"), { recursive: true });
  await fs.writeFile(path.join(projectRoot, ".ai-dev", "context", "latest.json"), JSON.stringify({ source_state_fingerprint: "f1" }));
  const resumed = await registry.handlers.get("resume_session")({ project_path: projectRoot });
  assert.equal(resumed.session.id, saved.session_id);
  assert.equal(resumed.session.branch, "feature/auth");
  assert.equal(resumed.open_tasks[0].id, task.id);
  assert.equal(resumed.context_pack.fresh, true);
  assert.match(resumed.briefing, /WHAT NOT TO RETRY:\n- Next-Auth — Prisma adapter conflict/);
  // `why` is the ECC spelling of `reason`; it must survive the round trip as reason.
  assert.deepEqual(resumed.session.failed[1], { approach: "iron-session", reason: "no rotation story" });
  assert.match(resumed.briefing, /grep before edit/);
  assert.match(resumed.briefing, /GIT: branch feature\/auth, 1 uncommitted/);

  const budget = await registry.handlers.get("context_budget_status")({ task_id: task.id });
  assert.equal(budget.components.context_pack, 5_000);
  assert.equal(budget.components.routed_skills, 2_000);
  assert.ok(budget.components.rules > 0);
  assert.ok(budget.components.agents_md > 0);
  assert.equal(budget.compaction_hint, "none");
  await assert.rejects(registry.handlers.get("save_session")({ topic: "x" }), /project_path or task_id is required/);
});

test("resume flags an unconfirmed hook draft; save_session confirms it into a real handoff", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "session-tools-draft-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, "project");
  await fs.mkdir(projectRoot, { recursive: true });
  const stateRoot = path.join(root, "state");
  const sessionStore = new SessionStore({ stateRoot });
  const host = {
    taskStore: { read: async () => { throw new Error("no task"); }, list: async () => [], checkpoint: async () => ({}) },
    sessionStore,
    resolveProjectIdentity: async (projectPath) => ({ project_root: projectPath, project_id: "project-draft" }),
    captureProjectState: async () => ({ branch: "main", dirty: false, dirty_files: [] })
  };
  const registry = createExtensionTools(host, [createSessionTools]);

  // Written by the session-end hook, not by an agent.
  const draftPath = path.join(stateRoot, "sessions", "project-draft", "hook-abc.json");
  await fs.mkdir(path.dirname(draftPath), { recursive: true });
  await fs.writeFile(draftPath, JSON.stringify({
    id: "session-hook-abc",
    saved_at: "2026-01-04T00:00:00.000Z",
    project_id: "project-draft",
    project_path: projectRoot,
    source: "hook",
    confirmed: false,
    captured_by: "pre-compact",
    topic: "Rate limit the public API",
    building: "Requests in this session (2):\n- Rate limit the public API\n- Exclude the health check",
    files: [{ path: "src/middleware.ts", status: "in_progress", notes: "touched this session (hook capture)" }],
    next_step: ""
  }, null, 2));

  const resumed = await registry.handlers.get("resume_session")({ project_path: projectRoot });
  assert.equal(resumed.session.id, "session-hook-abc");
  assert.equal(resumed.unconfirmed, true);
  assert.equal(resumed.history[0].unconfirmed, true);
  assert.deepEqual(resumed.hook_drafts, [], "the draft being read is not also listed as pending");
  assert.match(resumed.briefing, /UNCONFIRMED HOOK DRAFT \(session-hook-abc\) — the PreCompact hook distilled this/);

  // Confirming keeps what the agent knows and fills the rest from the draft.
  const confirmed = await registry.handlers.get("save_session")({
    project_path: projectRoot,
    confirm_hook_draft: true,
    next_step: "Wire the limiter in server.ts and run the contract tests."
  });
  assert.deepEqual(confirmed.confirmed_draft, { id: "session-hook-abc", discarded: true });
  assert.equal(await fs.access(draftPath).then(() => true, () => false), false);
  assert.match(confirmed.markdown, /Rate limit the public API/);
  assert.match(confirmed.markdown, /src\/middleware\.ts/);

  const after = await registry.handlers.get("resume_session")({ project_path: projectRoot });
  assert.equal(after.session.id, confirmed.session_id);
  assert.equal(after.unconfirmed, false);
  assert.equal(after.session.confirmed_from, "session-hook-abc");
  assert.deepEqual(after.hook_drafts, []);
  assert.match(after.briefing, /Wire the limiter in server\.ts/);
  assert.doesNotMatch(after.briefing, /UNCONFIRMED/);

  // Nothing left to confirm: the handoff is still saved, and says so.
  const nothing = await registry.handlers.get("save_session")({
    project_path: projectRoot,
    confirm_hook_draft: true,
    building: "Second pass over the limiter, this time with the health check excluded.",
    next_step: "Add the exclusion test."
  });
  assert.equal(nothing.confirmed_draft, null);
  assert.match(nothing.next_step, /No unconfirmed hook draft was found/);
  await assert.rejects(registry.handlers.get("save_session")({ project_path: projectRoot, confirm_hook_draft: true, draft_session_id: "session-hook-gone", topic: "x" }), /Unknown session/);
  await assert.rejects(registry.handlers.get("save_session")({ project_path: projectRoot, confirm_hook_draft: true, draft_session_id: confirmed.session_id, topic: "x" }), /is not an unconfirmed hook draft/);
});

test("a handoff saved in a task worktree resumes from the main checkout", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "session-tools-worktree-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const checkout = path.join(root, "checkout");
  const worktree = path.join(root, "checkout", ".worktrees", "task-one");
  await fs.mkdir(worktree, { recursive: true });
  const stateRoot = path.join(root, "state");
  const host = {
    taskStore: { read: async () => { throw new Error("no task"); }, list: async () => [], checkpoint: async () => ({}) },
    sessionStore: new SessionStore({ stateRoot }),
    // One clone, two working trees: what resolveProjectIdentity returns for a
    // worktree and for its main checkout differs only in project_id.
    resolveProjectIdentity: async (projectPath) => ({
      project_root: projectPath,
      project_id: `project-${path.basename(projectPath)}`,
      repository_id: "repository-fixture"
    }),
    captureProjectState: async (projectPath) => ({ branch: projectPath === worktree ? "task/one" : "main", dirty: false, dirty_files: [] })
  };
  const registry = createExtensionTools(host, [createSessionTools]);

  const saved = await registry.handlers.get("save_session")({
    project_path: worktree,
    building: "Rate limiting on the public API; the middleware is written but unwired.",
    next_step: "Wire the middleware in server.ts and run the contract tests."
  });
  assert.equal(saved.repository_id, "repository-fixture");
  assert.equal(path.basename(path.dirname(saved.path)), "repository-fixture");

  const resumed = await registry.handlers.get("resume_session")({ project_path: checkout });
  assert.equal(resumed.project_id, "project-checkout");
  assert.equal(resumed.session.id, saved.session_id, "the main checkout resumes the worktree handoff");
  assert.equal(resumed.session.branch, "task/one");
  assert.match(resumed.briefing, /Wire the middleware in server\.ts/);
  assert.equal((await registry.handlers.get("resume_session")({ project_path: checkout, session_id: saved.session_id })).session.id, saved.session_id);
});

test("list_sessions shows what a repository remembers, and which sessions still have a log to learn from", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "list-sessions-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, "project");
  await fs.mkdir(projectRoot, { recursive: true });
  const stateRoot = path.join(root, "state");
  const sessionStore = new SessionStore({ stateRoot });
  const identity = { project_root: projectRoot, project_id: "project-test", repository_id: "repository-test" };
  const host = {
    taskStore: new TaskStore({ stateRoot }),
    sessionStore,
    resolveProjectIdentity: async () => identity,
    captureProjectState: async () => ({ fingerprint: "f1", branch: "main", dirty: false, dirty_files: [] }),
    instinctStore: { rankForContext: async () => ({ markdown: "" }) }
  };
  const registry = createExtensionTools(host, [createSessionTools]);

  const none = await registry.handlers.get("list_sessions")({ project_path: projectRoot });
  assert.equal(none.count, 0);
  assert.match(none.next_step, /No handoffs yet/);

  await sessionStore.save({
    ...identity, repositoryId: identity.repository_id, projectId: identity.project_id, projectPath: projectRoot,
    sessionId: "s-1", now: "2026-09-12T09:00:00.000Z",
    topic: "Extract the router", building: "Splitting the router out of the entry point",
    next_step: "Move the last two handlers and run the suite", files: [{ path: "src/router.mjs", status: "in_progress" }]
  });
  const directory = sessionStore.directoryFor("repository-test");
  await fs.writeFile(path.join(directory, "hook-s-2.json"), JSON.stringify({
    schema_version: 1, id: "session-hook-s-2", saved_at: "2026-09-12T11:00:00.000Z",
    repository_id: "repository-test", project_id: "project-test", project_path: projectRoot,
    source: "hook", confirmed: false, session_id: "s-2", topic: "Chase a flaky test",
    building: "Requests in this session (3)", files: [], worked: [], failed: [], untried: [], decisions: [], blockers: [], next_step: ""
  }, null, 2));
  await fs.writeFile(path.join(directory, "observe-s-2.json"), JSON.stringify({
    schema_version: 1, session_id: "s-2", updated_at: "2026-09-12T11:00:00.000Z", events: [{ k: "tool", n: "Bash", c: "npm test" }]
  }, null, 2));

  const listed = await registry.handlers.get("list_sessions")({ project_path: projectRoot });
  assert.equal(listed.count, 2);
  assert.equal(listed.drafts, 1);
  assert.equal(listed.observation_logs, 1);
  assert.deepEqual(listed.sessions.map((item) => item.session_id), ["s-2", "s-1"], "newest first");
  assert.equal(listed.sessions[0].unconfirmed, true);
  assert.equal(listed.sessions[0].has_observations, true);
  assert.equal(listed.sessions[1].unconfirmed, false);
  assert.equal(listed.sessions[1].has_observations, false, "the older handoff has no log left to learn from");
  assert.equal(listed.sessions[1].next_step, "Move the last two handlers and run the suite");
  assert.match(listed.next_step, /1 unconfirmed hook draft/);

  const drafts = await registry.handlers.get("list_sessions")({ project_path: projectRoot, drafts_only: true });
  assert.deepEqual(drafts.sessions.map((item) => item.id), ["session-hook-s-2"]);
  const substantive = await registry.handlers.get("list_sessions")({ project_path: projectRoot, substantive_only: true });
  assert.deepEqual(substantive.sessions.map((item) => item.session_id), ["s-1"], "the draft is too thin to resume from");
});
