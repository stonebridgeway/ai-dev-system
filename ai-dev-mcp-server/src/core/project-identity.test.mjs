import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runProcess } from "./process-runner.mjs";
import {
  configureRuntimeStateRoot,
  memoryScopeKeys,
  projectIdentityKey,
  repositoryId,
  resolveProjectIdentity,
  sameProjectIdentity
} from "./project-identity.mjs";
import { memoryKeysOf, projectIdOf, repositoryIdOf } from "../../hooks/lib.mjs";

async function runGit(cwd, args) {
  const result = await runProcess({ executable: "git", args: ["-C", cwd, ...args], cwd, timeoutMs: 20_000 });
  assert.equal(result.ok, true, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

/** A clone with one committed package and a linked worktree of the same clone. */
async function cloneWithWorktree(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-repository-id-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const main = path.join(root, "checkout");
  await fs.mkdir(path.join(main, "packages", "web"), { recursive: true });
  await fs.writeFile(path.join(main, "packages", "web", "package.json"), "{\"name\":\"web\"}\n");
  await runGit(main, ["init", "-q", "-b", "main"]);
  await runGit(main, ["add", "."]);
  await runGit(main, ["-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "init"]);
  const worktree = path.join(root, "worktrees", "task-one");
  await runGit(main, ["worktree", "add", "-q", "-b", "task/one", worktree]);
  return { main: await fs.realpath(main), worktree: await fs.realpath(worktree) };
}

test("nested directories without a project marker resolve to their Git project", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-project-id-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const nested = path.join(root, "packages", "web");
  await fs.mkdir(nested, { recursive: true });
  const initialized = await runProcess({
    executable: "git",
    args: ["init", root],
    cwd: root,
    timeoutMs: 15_000
  });
  assert.equal(initialized.ok, true);

  const fromRoot = await resolveProjectIdentity(root);
  const fromNested = await resolveProjectIdentity(nested);
  assert.equal(fromNested.project_id, fromRoot.project_id);
  assert.equal(fromNested.project_root, fromRoot.project_root);
  assert.equal(sameProjectIdentity(fromRoot, fromNested), true);
});

test("the nearest package boundary wins over a parent Git worktree", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-project-package-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const nested = path.join(root, "apps", "web");
  await fs.mkdir(nested, { recursive: true });
  await fs.writeFile(path.join(nested, "package.json"), "{\"name\":\"web\"}\n");
  const initialized = await runProcess({
    executable: "git", args: ["init", root], cwd: root, timeoutMs: 15_000
  });
  assert.equal(initialized.ok, true);

  const identity = await resolveProjectIdentity(nested);
  assert.equal(identity.project_root, await fs.realpath(nested));
  assert.equal(identity.git.detected, true);
  assert.equal(identity.git.root, await fs.realpath(root));
});

test("the nearest nested Git boundary wins over a parent package", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-project-git-boundary-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const nested = path.join(root, "apps", "worker");
  await fs.mkdir(nested, { recursive: true });
  await fs.writeFile(path.join(root, "package.json"), "{\"name\":\"parent\"}\n");
  const initialized = await runProcess({
    executable: "git", args: ["init", nested], cwd: nested, timeoutMs: 15_000
  });
  assert.equal(initialized.ok, true);

  const identity = await resolveProjectIdentity(nested);
  const canonicalNested = await fs.realpath(nested);
  assert.equal(identity.project_root, canonicalNested);
  assert.equal(identity.git.root, canonicalNested);
});

test("the configured runtime-state .ai-dev is not treated as a project boundary", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-home-"));
  t.after(() => {
    configureRuntimeStateRoot("");
    return fs.rm(home, { recursive: true, force: true });
  });
  // The runtime lives at <home>/.ai-dev; a non-git project sits directly under it.
  const runtimeStateRoot = path.join(home, ".ai-dev");
  await fs.mkdir(path.join(runtimeStateRoot, "projects", "my-app"), { recursive: true });
  configureRuntimeStateRoot(runtimeStateRoot);
  const project = path.join(runtimeStateRoot, "projects", "my-app");

  const identity = await resolveProjectIdentity(project);
  // Without the fix, the walk stops at <home> because <home>/.ai-dev exists.
  assert.notEqual(identity.project_root, path.resolve(home));
});

test("filesystem projects use a stable canonical key", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-filesystem-id-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const identity = await resolveProjectIdentity(root);
  assert.match(identity.project_id, /^project-[a-f0-9]{20}$/);
  assert.equal(projectIdentityKey(identity), identity.project_id);
  assert.equal(identity.kind, "filesystem");
});

test("every worktree of one clone shares a repository id while project ids stay per tree", async (t) => {
  const { main, worktree } = await cloneWithWorktree(t);

  const fromMain = await resolveProjectIdentity(main);
  const fromWorktree = await resolveProjectIdentity(worktree);
  assert.match(fromMain.repository_id, /^repository-[a-f0-9]{20}$/);
  assert.equal(fromWorktree.repository_id, fromMain.repository_id, "memory follows the clone");
  assert.notEqual(fromWorktree.project_id, fromMain.project_id, "tasks stay bound to one working tree");
  assert.equal(await repositoryId(worktree), fromMain.repository_id);
  assert.deepEqual(memoryScopeKeys(fromWorktree), [fromWorktree.repository_id, fromWorktree.project_id]);

  // A package inside the clone keeps its own memory, and that memory is still
  // shared between the main checkout and the worktree.
  const nestedMain = await resolveProjectIdentity(path.join(main, "packages", "web"));
  const nestedWorktree = await resolveProjectIdentity(path.join(worktree, "packages", "web"));
  assert.equal(nestedMain.project_root, path.join(main, "packages", "web"));
  assert.equal(nestedWorktree.repository_id, nestedMain.repository_id);
  assert.notEqual(nestedMain.repository_id, fromMain.repository_id);
});

test("the hooks copy of the derivation answers exactly like the server", async (t) => {
  const { main, worktree } = await cloneWithWorktree(t);
  for (const projectRoot of [main, worktree, path.join(main, "packages", "web")]) {
    const identity = await resolveProjectIdentity(projectRoot);
    assert.equal(repositoryIdOf(projectRoot), identity.repository_id, projectRoot);
    assert.equal(projectIdOf(projectRoot), identity.project_id, projectRoot);
    assert.deepEqual(memoryKeysOf(projectRoot), memoryScopeKeys(identity), projectRoot);
  }
});

test("projects outside Git fall back to the project id as their memory key", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-no-git-id-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const identity = await resolveProjectIdentity(root);
  assert.equal(identity.repository_id, null);
  assert.equal(await repositoryId(root), null);
  assert.deepEqual(memoryScopeKeys(identity), [identity.project_id]);
  assert.deepEqual(memoryKeysOf(root, false), [identity.project_id]);
  assert.deepEqual(memoryScopeKeys("project-bare"), ["project-bare"]);
  assert.deepEqual(memoryScopeKeys({ repositoryId: "repository-1", projectId: "repository-1" }), ["repository-1"]);
});
