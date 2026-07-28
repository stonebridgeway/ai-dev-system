import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveTaskProjectRoot } from "./mcp-stdio.mjs";

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
