import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  SessionStore,
  estimateContextBudget,
  isHookDraft,
  normalizeSessionRecord,
  renderHandoffMarkdown,
  renderResumeBriefing,
  sessionSubstanceScore,
  writeHandoffProjection
} from "./session-memory.mjs";

test("session records normalize, score substance, and render handoff + briefing", () => {
  assert.throws(() => normalizeSessionRecord({}), /topic or building is required/);
  const record = normalizeSessionRecord({
    building: "JWT auth with httpOnly cookies for the Next.js app.",
    worked: [{ item: "register endpoint", evidence: "POST returns 200 in Postman" }, "password hashing"],
    failed: [
      { approach: "Next-Auth", reason: "conflicts with the Prisma adapter" },
      { approach: "iron-session", why: "no rotation story" },
      { approach: "cookie in localStorage" }
    ],
    untried: ["set cookie in login route"],
    files: [{ path: "app/api/login/route.ts", status: "In Progress", notes: "token not set yet" }, "lib/auth.ts", { path: "x.ts", status: "weird" }],
    decisions: [{ decision: "httpOnly cookie over localStorage", reason: "prevents XSS" }],
    blockers: ["does cookies().set() work in route handlers?"],
    next_step: "Set the cookie in login route and test with Postman."
  });
  assert.equal(record.topic, "JWT auth with httpOnly cookies for the Next.js app.");
  assert.equal(record.worked[1].item, "password hashing");
  // ECC's save-session prompt writes `why`; both spellings land in `reason`.
  assert.deepEqual(record.failed, [
    { approach: "Next-Auth", reason: "conflicts with the Prisma adapter" },
    { approach: "iron-session", reason: "no rotation story" },
    { approach: "cookie in localStorage", reason: "" }
  ]);
  assert.equal(record.files[0].status, "in_progress");
  assert.equal(record.files[1].status, "in_progress");
  assert.equal(record.files[2].status, "in_progress");
  assert.ok(sessionSubstanceScore(record) >= 8);
  assert.equal(sessionSubstanceScore({ topic: "x", next_step: "[next step goes here]" }), 0);

  const markdown = renderHandoffMarkdown({ ...record, saved_at: "2026-09-10T12:00:00.000Z", project_name: "my-app", branch: "main" });
  assert.match(markdown, /## What Did NOT Work \(and why\)\n\n- \*\*Next-Auth\*\* — failed because: conflicts/);
  assert.match(markdown, /\| `app\/api\/login\/route\.ts` \| In Progress \|/);
  assert.match(markdown, /## Exact Next Step\n\nSet the cookie/);

  const briefing = renderResumeBriefing({
    record: { ...record, id: "session-1", saved_at: "2026-01-01T00:00:00.000Z", project_name: "my-app" },
    tasks: [{ id: "task-1", status: "active", task: "Finish auth", plan_policy: { plan_required: true }, plan: null }],
    git: { branch: "main", dirty: true, dirty_files: ["a"] },
    freshness: { compiled: true, fresh: false },
    now: "2026-02-01T00:00:00.000Z"
  });
  assert.match(briefing, /HISTORICAL REFERENCE ONLY/);
  assert.match(briefing, /WARNING: 31 days ago/);
  assert.match(briefing, /WHAT NOT TO RETRY:\n- Next-Auth — conflicts/);
  assert.match(briefing, /task-1 \[active\] Finish auth \(plan required, not recorded\)/);
  assert.match(briefing, /GIT: branch main, 1 uncommitted file/);
  assert.match(briefing, /CONTEXT PACK: stale/);
  assert.match(renderResumeBriefing({ record: null }), /NO SAVED SESSION/);
});

test("session store saves, lists newest-first with substance filter, and writes the projection", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "session-memory-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SessionStore({ stateRoot: path.join(root, "state") });
  const placeholder = await store.save({ projectId: "project-a", projectPath: root, topic: "empty", now: "2026-01-01T00:00:00.000Z" });
  const real = await store.save({
    projectId: "project-a",
    projectPath: root,
    projectName: "fixture",
    taskId: "task-1",
    branch: "feature/x",
    building: "Real work on the login flow with several moving parts.",
    worked: [{ item: "login endpoint", evidence: "tests pass" }],
    next_step: "Wire the cookie into the middleware and run verify_task.",
    now: "2026-01-02T00:00:00.000Z"
  });
  assert.match(real.path, /20260102000000-real-work-on-the-login-flow/);
  const all = await store.list("project-a");
  assert.deepEqual(all.map((item) => item.id), [real.record.id, placeholder.record.id]);
  const latest = await store.latest("project-a");
  assert.equal(latest.id, real.record.id);
  assert.equal(latest.task_id, "task-1");
  assert.equal(await store.latest("project-b"), null);
  assert.equal((await store.read("project-a", placeholder.record.id)).topic, "empty");
  await assert.rejects(store.read("project-a", "nope"), /Unknown session/);

  const projection = await writeHandoffProjection(root, real.record);
  assert.equal(projection, ".ai-dev/context/handoff.md");
  assert.match(await fs.readFile(path.join(root, ".ai-dev", "context", "handoff.md"), "utf8"), /Wire the cookie/);
});

test("hook captures are drafts: flagged, briefed with the caveat, and dropped once confirmed", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "session-memory-drafts-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SessionStore({ stateRoot: path.join(root, "state") });

  // What the session-end hook writes: a transcript distillation nobody checked.
  const draftPath = path.join(root, "state", "sessions", "project-a", "hook-abc.json");
  await fs.mkdir(path.dirname(draftPath), { recursive: true });
  await fs.writeFile(draftPath, JSON.stringify({
    schema_version: 1,
    id: "session-hook-abc",
    saved_at: "2026-01-03T00:00:00.000Z",
    project_id: "project-a",
    project_path: root,
    source: "hook",
    confirmed: false,
    captured_by: "stop",
    topic: "Add login validation",
    building: "Requests in this session (2):\n- Add login validation\n- Now add tests",
    files: [{ path: "src/login.js", status: "in_progress", notes: "touched this session (hook capture)" }],
    next_step: ""
  }, null, 2));

  assert.equal(isHookDraft({ source: "hook" }), true, "a capture from before the flag existed is a draft too");
  assert.equal(isHookDraft({ source: "hook", confirmed: true }), false);
  assert.equal(isHookDraft({ source: "agent" }), false);
  assert.equal(isHookDraft(null), false);

  const [draft] = await store.drafts("project-a");
  assert.equal(draft.id, "session-hook-abc");
  assert.equal(draft.unconfirmed, true);
  // A draft can still be the newest thing there is, so resume shows it — with
  // the caveat, and without inventing a next step it cannot know.
  const briefing = renderResumeBriefing({ record: draft, now: "2026-01-03T01:00:00.000Z" });
  assert.match(briefing, /SESSION DRAFT:/);
  assert.match(briefing, /UNCONFIRMED HOOK DRAFT \(session-hook-abc\) — the Stop hook distilled this from the transcript/);
  assert.match(briefing, /NEXT STEP:\nNone recorded — the hook cannot know it/);
  assert.match(briefing, /This is a draft, not a handoff\./);

  // Other drafts are listed so the agent knows what is waiting to be confirmed.
  const listed = renderResumeBriefing({ record: null, drafts: [draft] });
  assert.match(listed, /UNCONFIRMED HOOK DRAFTS \(not handoffs; confirm or ignore\):\n- session-hook-abc \(2026-01-03T00:00:00.000Z\) Add login validation/);

  const confirmed = await store.save({
    projectId: "project-a",
    projectPath: root,
    topic: draft.topic,
    building: draft.building,
    next_step: "Add the negative-path tests for the login validator.",
    confirmedFrom: draft.id,
    now: "2026-01-03T02:00:00.000Z"
  });
  assert.equal(confirmed.record.confirmed, true, "agent-written records are confirmed by definition");
  assert.equal(confirmed.record.confirmed_from, "session-hook-abc");
  assert.equal(isHookDraft(confirmed.record), false);
  assert.doesNotMatch(renderResumeBriefing({ record: confirmed.record, now: "2026-01-03T02:00:00.000Z" }), /UNCONFIRMED/);

  assert.equal(await store.discardDraft(draft), true);
  assert.deepEqual(await store.drafts("project-a"), []);
  assert.equal(await fs.access(draftPath).then(() => true, () => false), false);
  assert.equal(await store.discardDraft(draft), false, "discarding twice is a no-op");
  assert.equal(await store.discardDraft(confirmed.record), false, "a real handoff is never discarded as a draft");
  assert.equal(await store.discardDraft({ source: "hook", path: path.join(root, "elsewhere.json") }), false, "only files under the sessions tree");
});

test("handoffs are keyed by repository, so a worktree and its main checkout share one memory", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "session-memory-worktree-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SessionStore({ stateRoot: path.join(root, "state") });
  // One clone, two working trees: same repository id, different project ids.
  const checkout = { repository_id: "repository-1", project_id: "project-checkout" };
  const worktree = { repository_id: "repository-1", project_id: "project-worktree" };

  const fromWorktree = await store.save({
    repositoryId: worktree.repository_id,
    projectId: worktree.project_id,
    projectPath: path.join(root, "worktrees", "task-one"),
    building: "Rate limiting for the public API, middleware still unwired.",
    next_step: "Wire the middleware and run the contract tests.",
    now: "2026-01-01T00:00:00.000Z"
  });
  assert.equal(path.basename(path.dirname(fromWorktree.path)), "repository-1");
  assert.equal((await store.latest(checkout)).id, fromWorktree.record.id, "the main checkout reads the worktree handoff");

  const fromCheckout = await store.save({
    repositoryId: checkout.repository_id,
    projectId: checkout.project_id,
    projectPath: root,
    building: "Merged the rate limiter and started on the metrics endpoint.",
    next_step: "Add the counter metric and run verify_task.",
    now: "2026-01-02T00:00:00.000Z"
  });
  assert.equal((await store.latest(worktree)).id, fromCheckout.record.id, "the worktree reads the main checkout handoff");
  assert.deepEqual(
    (await store.list(worktree)).map((item) => item.id),
    [fromCheckout.record.id, fromWorktree.record.id]
  );

  // Another clone of the same project keeps its own memory.
  assert.equal(await store.latest({ repository_id: "repository-2", project_id: "project-other" }), null);
});

test("handoffs written under the old project key are read, then migrated by the first repository write", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "session-memory-migration-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stateRoot = path.join(root, "state");
  const store = new SessionStore({ stateRoot });
  const scope = { repositoryId: "repository-1", projectId: "project-legacy" };

  const legacy = await store.save({
    projectId: scope.projectId,
    projectPath: root,
    building: "Legacy handoff written before repository ids existed.",
    next_step: "Read this from the repository key without losing it.",
    now: "2026-01-01T00:00:00.000Z"
  });
  assert.equal(path.basename(path.dirname(legacy.path)), "project-legacy");
  assert.equal((await store.latest(scope)).id, legacy.record.id, "reading falls back to the project key");

  const migrated = await store.save({
    ...scope,
    projectPath: root,
    building: "First save under the repository key.",
    next_step: "Confirm the legacy record moved across.",
    now: "2026-01-02T00:00:00.000Z"
  });
  const directory = path.join(stateRoot, "sessions", "repository-1");
  assert.deepEqual(
    (await fs.readdir(directory)).sort(),
    [path.basename(legacy.path), path.basename(migrated.path)].sort()
  );
  assert.deepEqual(await fs.readdir(path.join(stateRoot, "sessions")), ["repository-1"], "the legacy directory is gone");
  assert.deepEqual(
    (await store.list(scope)).map((item) => item.id),
    [migrated.record.id, legacy.record.id]
  );
});

test("estimateContextBudget reports static overhead and boundary compaction hints", () => {
  const healthy = estimateContextBudget({ contextPackChars: 20_000, skillChars: 12_000, rulesChars: 8_000, agentsChars: 4_000 });
  assert.equal(healthy.static_tokens, 11_000);
  assert.equal(healthy.compaction_hint, "none");
  assert.match(healthy.advice[0], /healthy/);
  const heavy = estimateContextBudget({ contextPackChars: 120_000, skillChars: 100_000, checkpoints: 6, verifications: 3, windowTokens: 200_000 });
  assert.equal(heavy.compaction_hint, "boundary");
  assert.ok(heavy.advice.some((item) => /Static overhead is/.test(item)));
  assert.ok(heavy.advice.some((item) => /Five or more checkpoints/.test(item)));
  assert.ok(heavy.advice.some((item) => /verification rounds/.test(item)));
});
