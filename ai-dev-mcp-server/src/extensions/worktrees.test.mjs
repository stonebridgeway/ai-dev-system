import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { TaskStore } from "../core/task-lifecycle.mjs";
import { createExtensionTools } from "../tool-extensions.mjs";
import { createWorktreeTools } from "./worktrees.mjs";

function runGit(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true, shell: false });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

test("begin_task_in_worktree starts the task inside a fresh worktree and remove cleans it up", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "worktree-tools-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  await fs.mkdir(repo, { recursive: true });
  await fs.writeFile(path.join(repo, "index.js"), "export const one = 1;\n");
  runGit(repo, ["init", "-q", "-b", "main"]);
  runGit(repo, ["add", "."]);
  runGit(repo, ["-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "init"]);
  const realRepo = await fs.realpath(repo);

  const taskStore = new TaskStore({ stateRoot: path.join(root, "state") });
  const calls = [];
  const host = {
    taskStore,
    resolveProjectIdentity: async (projectPath) => ({ project_root: await fs.realpath(projectPath), project_id: "project-test" }),
    async callTool(name, args) {
      calls.push({ name, args });
      const record = await taskStore.begin({
        task: args.task,
        project: { project_name: "fixture", project_path: args.project_path },
        skills: [],
        baseline: { fingerprint: "a" }
      });
      return { content: [{ type: "text", text: JSON.stringify({ ...record, next_actions: ["verify"] }) }] };
    }
  };
  const registry = createExtensionTools(host, [createWorktreeTools]);

  const begun = await registry.handlers.get("begin_task_in_worktree")({
    project_path: repo,
    task: "Add login form validation",
    name: "login-validation"
  });
  assert.equal(calls[0].name, "begin_task");
  assert.equal(calls[0].args.project_path, path.join(realRepo, ".worktrees", "login-validation"));
  assert.equal(begun.worktree.branch, "task/login-validation");
  assert.equal(begun.context.worktree.path, path.join(realRepo, ".worktrees", "login-validation"));
  assert.match(begun.next_actions[0], /Work only inside/);
  assert.equal(runGit(begun.worktree.path, ["branch", "--show-current"]), "task/login-validation");

  const listed = await registry.handlers.get("list_task_worktrees")({ project_path: repo });
  assert.equal(listed.count, 1);
  assert.equal(listed.worktrees[0].name, "login-validation");
  // A fresh worktree has no commits of its own, so it is already contained in
  // the main checkout and the cleanup offers it.
  assert.equal(listed.worktrees[0].state, "merged");
  assert.deepEqual(listed.by_state, { merged: 1 });
  assert.match(listed.next_step, /plan_worktree_cleanup/);

  const withoutStatus = await registry.handlers.get("list_task_worktrees")({ project_path: repo, include_status: false });
  assert.equal("state" in withoutStatus.worktrees[0], false);
  assert.match(withoutStatus.next_step, /Pass include_status/);

  const plan = await registry.handlers.get("plan_worktree_cleanup")({ project_path: repo });
  assert.equal(plan.dry_run, true);
  assert.deepEqual(plan.remove.map((item) => item.name), ["login-validation"]);
  assert.deepEqual(plan.removed, []);
  assert.match(plan.next_step, /Call again with dry_run: false to remove 1 worktree/);
  assert.equal((await registry.handlers.get("list_task_worktrees")({ project_path: repo })).count, 1, "the plan removed nothing");

  await assert.rejects(
    registry.handlers.get("remove_task_worktree")({ task_id: begun.id }),
    /complete it first or pass force=true/
  );
  const removed = await registry.handlers.get("remove_task_worktree")({ task_id: begun.id, force: true, delete_branch: true });
  assert.equal(removed.branch, "task/login-validation");
  assert.equal(removed.branch_deleted, true);
  const record = await taskStore.read(begun.id);
  assert.ok(record.context.worktree.removed_at);
  assert.equal((await registry.handlers.get("list_task_worktrees")({ project_path: repo })).count, 0);
  await assert.rejects(registry.handlers.get("remove_task_worktree")({}), /task_id or worktree_path is required/);

  // Auto-generated names are derived from the task text plus a timestamp.
  const auto = await registry.handlers.get("begin_task_in_worktree")({ project_path: repo, task: "Починить форму логина" });
  assert.match(auto.worktree.branch, /^task\/[a-z0-9-]+-\d{8}$/);
});


test("plan_worktree_cleanup removes only what it offered, and only when told to", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "worktree-cleanup-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  await fs.mkdir(repo, { recursive: true });
  await fs.writeFile(path.join(repo, "index.js"), "export const one = 1;\n");
  runGit(repo, ["init", "-q", "-b", "main"]);
  runGit(repo, ["add", "."]);
  runGit(repo, ["-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "init"]);
  const realRepo = await fs.realpath(repo);

  const host = {
    taskStore: new TaskStore({ stateRoot: path.join(root, "state") }),
    resolveProjectIdentity: async (projectPath) => ({ project_root: await fs.realpath(projectPath), project_id: "project-test" }),
    callTool: async () => { throw new Error("not used"); }
  };
  const registry = createExtensionTools(host, [createWorktreeTools]);

  runGit(realRepo, ["worktree", "add", "-b", "task/finished", path.join(realRepo, ".worktrees", "finished")]);
  runGit(realRepo, ["worktree", "add", "-b", "task/in-progress", path.join(realRepo, ".worktrees", "in-progress")]);
  await fs.writeFile(path.join(realRepo, ".worktrees", "in-progress", "index.js"), "export const one = 2;\n");

  const applied = await registry.handlers.get("plan_worktree_cleanup")({ project_path: repo, dry_run: false, delete_branch: true });
  assert.deepEqual(applied.remove.map((item) => item.name), ["finished"]);
  assert.deepEqual(applied.keep.map((item) => [item.name, item.state]), [["in-progress", "dirty"]]);
  assert.equal(applied.removed.length, 1);
  assert.deepEqual(applied.problems, []);
  assert.match(applied.next_step, /1 worktree\(s\) removed/);

  const left = await registry.handlers.get("list_task_worktrees")({ project_path: repo });
  assert.deepEqual(left.worktrees.map((item) => item.name), ["in-progress"]);
  assert.deepEqual(left.by_state, { dirty: 1 });
  assert.match(left.next_step, /Nothing here is finished with/);
  assert.equal(runGit(realRepo, ["branch", "--list", "task/finished"]), "");
});
