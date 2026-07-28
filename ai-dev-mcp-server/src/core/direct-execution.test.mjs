import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { isDirectExecution } from "./direct-execution.mjs";

test("isDirectExecution recognizes the same physical file", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-entry-"));
  const entry = path.join(root, "server.mjs");
  await fs.writeFile(entry, "");
  try {
    assert.equal(await isDirectExecution(pathToFileURL(entry), entry), true);
    assert.equal(await isDirectExecution(pathToFileURL(entry), null), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("isDirectExecution resolves a junction or symlink before comparing", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-entry-link-"));
  const realDirectory = path.join(root, "real");
  const linkedDirectory = path.join(root, "linked");
  const realEntry = path.join(realDirectory, "server.mjs");
  await fs.mkdir(realDirectory);
  await fs.writeFile(realEntry, "");
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  try {
    await fs.symlink(
      realDirectory,
      linkedDirectory,
      process.platform === "win32" ? "junction" : "dir"
    );
  } catch (error) {
    if (["EPERM", "EACCES"].includes(error?.code)) {
      t.skip("Junction or symlink creation is unavailable on this host.");
      return;
    }
    throw error;
  }

  assert.equal(
    await isDirectExecution(pathToFileURL(realEntry), path.join(linkedDirectory, "server.mjs")),
    true
  );
});
