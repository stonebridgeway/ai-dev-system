import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertNotProtectedProjectRoot, resolveTaskProjectRoot, safeProjectRoot, vaultRoot } from "./mcp-stdio.mjs";

/**
 * A new folder under the temp folder, by its real path: the lifecycle answers with resolved paths, and the temp
 * folder can be a link — `/var` → `/private/var` on macOS, any TMPDIR a user points elsewhere.
 */
async function realTemporaryFolder(prefix) {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}

test("task lifecycle resolves a nested package to the nearest project quality gate", async (t) => {
  const root = await realTemporaryFolder("ai-dev-task-root-");
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
  const root = await realTemporaryFolder("ai-dev-task-standalone-");
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  assert.equal(await resolveTaskProjectRoot(root), root);
});

test("project root guard rejects filesystem, home, runtime, state, and vault containers", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-protected-root-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const runtimeHome = path.join(root, "runtime-home");
  const runtimeState = path.join(runtimeHome, ".ai-dev");
  const state = path.join(root, "state");
  const vault = path.join(root, "vault");
  await Promise.all([home, runtimeState, state, vault].map((target) => fs.mkdir(target, { recursive: true })));
  const options = {
    homeDirectory: home,
    runtimeHome,
    runtimeStateDirectory: runtimeState,
    stateDirectory: state,
    knowledgeVault: vault
  };
  for (const target of [path.parse(root).root, home, runtimeHome, runtimeState, state, vault, root]) {
    assert.throws(() => assertNotProtectedProjectRoot(target, options), /protected directory/);
  }
});

test("safe project root rejects the filesystem root and the knowledge vault", async () => {
  await assert.rejects(safeProjectRoot(path.parse(process.cwd()).root), /protected directory/);
  await assert.rejects(safeProjectRoot(vaultRoot), /protected directory/);
});
