import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runProcess } from "./core/process-runner.mjs";
import { resolveTaskProjectRoot, safeProjectRoot } from "./mcp-stdio.mjs";

test("task lifecycle resolves a nested package to the nearest project quality gate", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-task-root-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const nested = path.join(root, "packages", "web");
  await fs.mkdir(path.join(root, ".ai-dev"), { recursive: true });
  await fs.mkdir(nested, { recursive: true });
  await fs.writeFile(
    path.join(root, ".ai-dev", "quality-gate.md"),
    "# Quality Gate\n",
    "utf8"
  );

  assert.equal(await resolveTaskProjectRoot(nested), root);
});

test("task lifecycle preserves a standalone project directory", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-task-standalone-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  assert.equal(await resolveTaskProjectRoot(root), root);
});

test("task lifecycle uses a nested .ai-dev boundary inside a Git worktree", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-task-git-root-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const nested = path.join(root, "apps", "web");
  await fs.mkdir(path.join(nested, ".ai-dev"), { recursive: true });
  const init = await runProcess({
    executable: "git", args: ["init", root], cwd: root, timeoutMs: 15_000
  });
  assert.equal(init.ok, true);

  assert.equal(await resolveTaskProjectRoot(nested), nested);
});

test("project root resolution refuses the filesystem root", async () => {
  await assert.rejects(
    safeProjectRoot(path.parse(process.cwd()).root),
    /protected directory/
  );
});
