import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  CLEANABLE_STATES,
  STALE_AFTER_DAYS,
  WORKTREE_STATES,
  cleanupTaskWorktrees,
  createTaskWorktree,
  listTaskWorktrees,
  parseWorktreeList,
  planWorktreeCleanup,
  removeTaskWorktree,
  worktreeName,
  worktreeStateOf
} from "./task-worktrees.mjs";

function runGit(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true, shell: false });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

async function repoFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "task-worktrees-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  await fs.mkdir(path.join(repo, ".ai-dev"), { recursive: true });
  await fs.writeFile(path.join(repo, "index.js"), "export const one = 1;\n");
  await fs.writeFile(path.join(repo, "AGENTS.md"), "# AGENTS\n");
  await fs.writeFile(path.join(repo, ".ai-dev", "quality-gate.md"), "# Quality Gate\n\n- Tests: `node --test`\n");
  runGit(repo, ["init", "-q", "-b", "main"]);
  runGit(repo, ["add", "index.js"]);
  runGit(repo, ["-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "init"]);
  return await fs.realpath(repo);
}

test("worktreeName and parseWorktreeList normalise input", () => {
  assert.equal(worktreeName("Исправить форму: Login / Signup!"), "login-signup");
  assert.equal(worktreeName("task-20260910T111806-280cf829"), "task-20260910t111806-280cf829");
  assert.equal(worktreeName("!!!"), "task");
  const parsed = parseWorktreeList([
    "worktree /repo",
    "HEAD abc",
    "branch refs/heads/main",
    "",
    "worktree /repo/.worktrees/one",
    "HEAD def",
    "branch refs/heads/task/one",
    "locked",
    "",
    "worktree /repo/.worktrees/gone",
    "HEAD 000",
    "detached",
    "prunable gitdir file points to non-existent location",
    ""
  ].join("\n"));
  assert.equal(parsed.length, 3);
  assert.deepEqual(parsed[1], { path: "/repo/.worktrees/one", head: "def", branch: "task/one", bare: false, detached: false, locked: true, prunable: false });
  assert.equal(parsed[2].prunable, true);
  assert.equal(parsed[2].detached, true);
});

test("create, list, and remove task worktrees with handoff files and dirty guard", async (t) => {
  const repo = await repoFixture(t);
  const created = await createTaskWorktree({ projectRoot: repo, name: "login-form" });
  assert.equal(created.created, true);
  assert.equal(created.branch, "task/login-form");
  assert.equal(created.path, path.join(repo, ".worktrees", "login-form"));
  assert.deepEqual(created.copied_files, ["AGENTS.md", ".ai-dev/quality-gate.md"]);
  assert.equal(runGit(created.path, ["branch", "--show-current"]), "task/login-form");
  assert.match(await fs.readFile(path.join(repo, ".git", "info", "exclude"), "utf8"), /^\/\.worktrees\/$/m);
  assert.equal(runGit(repo, ["status", "--porcelain"]).includes(".worktrees"), false, ".worktrees is excluded");

  const again = await createTaskWorktree({ projectRoot: repo, name: "login-form" });
  assert.equal(again.created, false);
  await assert.rejects(createTaskWorktree({ projectRoot: repo, name: "../escape" }), /Invalid worktree name/);

  // A worktree can be created from inside another worktree; it still lands under the main root.
  const nested = await createTaskWorktree({ projectRoot: created.path, name: "second", baseRef: "main" });
  assert.equal(nested.main_root, repo);
  assert.equal(nested.path, path.join(repo, ".worktrees", "second"));

  const listed = await listTaskWorktrees({ projectRoot: repo, includeStatus: true });
  assert.deepEqual(listed.worktrees.map((item) => item.name).sort(), ["login-form", "second"]);
  assert.equal(listed.worktrees.every((item) => item.dirty === false), true, "copied handoff files do not count as dirty");
  assert.equal(listed.worktrees.every((item) => item.commits_ahead_of_main === 0), true);
  await fs.writeFile(path.join(nested.path, "feature.js"), "export const f = 1;\n");
  runGit(nested.path, ["add", "feature.js"]);
  runGit(nested.path, ["-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "feat: add"]);
  const ahead = await listTaskWorktrees({ projectRoot: repo, includeStatus: true });
  assert.equal(ahead.worktrees.find((item) => item.name === "second").commits_ahead_of_main, 1);

  await fs.writeFile(path.join(created.path, "index.js"), "export const one = 2;\n");
  const dirtyList = await listTaskWorktrees({ projectRoot: repo, includeStatus: true });
  assert.equal(dirtyList.worktrees.find((item) => item.name === "login-form").dirty, true);
  await assert.rejects(removeTaskWorktree({ projectRoot: repo, worktreePath: created.path }), /uncommitted change/);
  await assert.rejects(removeTaskWorktree({ projectRoot: repo, worktreePath: repo }), /main working tree/);
  await assert.rejects(removeTaskWorktree({ projectRoot: repo, worktreePath: path.join(repo, "nope") }), /Not a registered worktree/);

  const removed = await removeTaskWorktree({ projectRoot: repo, worktreePath: created.path, force: true, deleteBranch: true });
  assert.equal(removed.dirty_files, 1);
  assert.equal(removed.branch_deleted, true);
  assert.equal(await fs.access(created.path).then(() => true).catch(() => false), false);
  assert.equal(runGit(repo, ["branch", "--list", "task/login-form"]), "");
  const clean = await removeTaskWorktree({ projectRoot: repo, worktreePath: nested.path });
  assert.equal(clean.branch_deleted, false);
  assert.equal(runGit(repo, ["branch", "--list", "task/second"]).trim().endsWith("task/second"), true, "branch kept");
});


// 3.24. A worktree can be several of these at once, so the order the states are
// decided in is the whole rule: it is what says whether removing one costs
// anything.
test("the lifecycle state is decided worst-case first", () => {
  assert.deepEqual(WORKTREE_STATES, ["orphan", "dirty", "merged", "stale", "active"]);

  assert.equal(worktreeStateOf({ prunable: true }).state, "orphan");
  assert.equal(worktreeStateOf({ exists: false }).state, "orphan");
  // Gone beats everything: there is nothing left to lose.
  assert.equal(worktreeStateOf({ prunable: true, dirty: true, commitsAheadOfMain: 4 }).state, "orphan");

  // Uncommitted work beats "merged": the commits are in, the edits are not.
  assert.equal(worktreeStateOf({ dirty: true, dirtyFiles: 2, commitsAheadOfMain: 0 }).state, "dirty");
  assert.match(worktreeStateOf({ dirty: true, dirtyFiles: 2 }).reason, /2 uncommitted change\(s\) live only here/);

  assert.equal(worktreeStateOf({ commitsAheadOfMain: 0 }).state, "merged");
  assert.match(worktreeStateOf({ commitsAheadOfMain: 0 }).reason, /reachable from the main checkout/);

  assert.equal(worktreeStateOf({ commitsAheadOfMain: 3, lastCommitDays: 30 }).state, "stale");
  assert.match(worktreeStateOf({ commitsAheadOfMain: 3, lastCommitDays: 30 }).reason, /3 unmerged commit\(s\), newest one 30 days old/);
  assert.equal(worktreeStateOf({ commitsAheadOfMain: 3, lastCommitDays: 30, staleAfterDays: 60 }).state, "active");
  assert.equal(worktreeStateOf({ commitsAheadOfMain: 3, lastCommitDays: 1 }).state, "active");

  // Nothing measurable is never a reason to offer a worktree for removal.
  assert.equal(worktreeStateOf({ commitsAheadOfMain: null }).state, "active");
  assert.equal(worktreeStateOf({ commitsAheadOfMain: 3, lastCommitDays: null }).state, "active");
  assert.equal(worktreeStateOf().state, "active");
  assert.equal(STALE_AFTER_DAYS, 14);
});

test("a cleanup plan offers the finished worktrees and keeps the rest", () => {
  const worktrees = [
    { path: "/w/merged", name: "merged", branch: "task/merged", state: "merged", reason: "in", commits_ahead_of_main: 0 },
    { path: "/w/orphan", name: "orphan", branch: "task/orphan", state: "orphan", reason: "gone" },
    { path: "/w/dirty", name: "dirty", branch: "task/dirty", state: "dirty", reason: "edits", dirty_files: 3 },
    { path: "/w/stale", name: "stale", branch: "task/stale", state: "stale", reason: "old", commits_ahead_of_main: 2 },
    { path: "/w/active", name: "active", branch: "task/active", state: "active", reason: "working" }
  ];
  const plan = planWorktreeCleanup(worktrees);
  assert.deepEqual(plan.remove.map((item) => item.name), ["merged", "orphan"]);
  assert.deepEqual(plan.keep.map((item) => item.name), ["dirty", "stale", "active"]);
  assert.deepEqual(plan.by_state, { merged: 1, orphan: 1, dirty: 1, stale: 1, active: 1 });
  assert.deepEqual(CLEANABLE_STATES, ["merged", "orphan"]);

  const withStale = planWorktreeCleanup(worktrees, { includeStale: true });
  assert.deepEqual(withStale.remove.map((item) => item.name), ["merged", "orphan", "stale"]);
  assert.equal(withStale.keep.some((item) => item.state === "dirty"), true, "dirty is never offered, at any setting");
  assert.deepEqual(planWorktreeCleanup(undefined).remove, []);
  assert.equal(planWorktreeCleanup([{}]).remove.length, 0, "a worktree with no state reads as active");
});

test("states and cleanup over a real repository, and nothing goes without being asked", async (t) => {
  const repo = await repoFixture(t);
  const commit = (cwd, message) => runGit(cwd, ["-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", message]);

  const merged = await createTaskWorktree({ projectRoot: repo, name: "merged" });
  const dirty = await createTaskWorktree({ projectRoot: repo, name: "dirty" });
  const ahead = await createTaskWorktree({ projectRoot: repo, name: "ahead" });

  // `dirty` has an uncommitted edit; `ahead` has a commit of its own; `merged`
  // has nothing and so is already contained in main.
  await fs.writeFile(path.join(dirty.path, "index.js"), "export const one = 2;\n");
  await fs.writeFile(path.join(ahead.path, "feature.js"), "export const two = 2;\n");
  runGit(ahead.path, ["add", "feature.js"]);
  commit(ahead.path, "feature");

  const listed = await listTaskWorktrees({ projectRoot: repo, includeStatus: true });
  const byName = Object.fromEntries(listed.worktrees.map((item) => [item.name, item]));
  assert.equal(byName.merged.state, "merged");
  assert.equal(byName.dirty.state, "dirty");
  assert.equal(byName.dirty.dirty_files, 1);
  assert.equal(byName.ahead.state, "active");
  assert.equal(byName.ahead.commits_ahead_of_main, 1);
  assert.ok(Date.parse(byName.ahead.last_commit_at), "the newest commit's date is read, so staleness can be judged");

  // The same repository a fortnight later: the unmerged branch reads as stale.
  const later = new Date(Date.now() + 30 * 86_400_000).toISOString();
  const aged = await listTaskWorktrees({ projectRoot: repo, includeStatus: true, now: later });
  assert.equal(aged.worktrees.find((item) => item.name === "ahead").state, "stale");

  // A registered worktree whose directory is gone.
  await fs.rm(path.join(repo, ".worktrees", "merged"), { recursive: true, force: true });
  const orphaned = await listTaskWorktrees({ projectRoot: repo, includeStatus: true });
  assert.equal(orphaned.worktrees.find((item) => item.name === "merged").state, "orphan");

  const planned = await cleanupTaskWorktrees({ projectRoot: repo });
  assert.equal(planned.dry_run, true);
  assert.deepEqual(planned.remove.map((item) => item.name), ["merged"]);
  assert.deepEqual(planned.removed, []);
  assert.equal((await listTaskWorktrees({ projectRoot: repo })).worktrees.length, 3, "a plan removes nothing");

  const applied = await cleanupTaskWorktrees({ projectRoot: repo, dryRun: false, deleteBranch: true });
  assert.equal(applied.removed.length, 1);
  assert.equal(applied.removed[0].branch_deleted, true);
  assert.deepEqual(applied.problems, []);
  // Each record says what was removed, not only that something was: the plan
  // entry's name, state and reason, plus the outcome (Д-27).
  assert.equal(applied.removed[0].name, "merged");
  assert.equal(applied.removed[0].state, "orphan");
  assert.match(applied.removed[0].branch, /merged$/);
  assert.equal(typeof applied.removed[0].reason, "string");
  assert.equal(applied.removed[0].path, applied.removed[0].removed);
  const remaining = await listTaskWorktrees({ projectRoot: repo, includeStatus: true });
  assert.deepEqual(remaining.worktrees.map((item) => item.name).sort(), ["ahead", "dirty"]);
  assert.equal(remaining.worktrees.every((item) => item.state !== "orphan"), true);

  // The dirty one survives even when stale ones are included: uncommitted work
  // is only ever discarded through remove_task_worktree with force.
  const aggressive = await cleanupTaskWorktrees({ projectRoot: repo, dryRun: false, includeStale: true, staleAfterDays: 0 });
  assert.deepEqual(aggressive.removed.map((item) => path.basename(item.removed)), ["ahead"]);
  assert.deepEqual(aggressive.removed.map((item) => item.name), ["ahead"], "and by name, which is what a report prints");
  assert.deepEqual((await listTaskWorktrees({ projectRoot: repo })).worktrees.map((item) => item.name), ["dirty"]);
});
