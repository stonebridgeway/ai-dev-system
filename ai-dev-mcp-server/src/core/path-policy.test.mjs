import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isPathInside, resolveWithin, resolveWithinSync } from "./path-policy.mjs";

test("isPathInside rejects sibling prefix collisions", () => {
  const root = path.resolve("C:/vault");
  assert.equal(isPathInside(root, path.resolve("C:/vault/note.md")), true);
  assert.equal(isPathInside(root, path.resolve("C:/vault-evil/note.md")), false);
});

test("resolveWithin rejects traversal and absolute paths", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-path-"));
  await fs.writeFile(path.join(root, "ok.md"), "ok");
  await assert.rejects(resolveWithin(root, "../escape.md"), /escapes/i);
  assert.throws(() => resolveWithinSync(root, path.resolve(root, "ok.md")), /absolute/i);
  assert.equal(await resolveWithin(root, "ok.md"), path.join(root, "ok.md"));
});

test("resolveWithin blocks existing junction or symlink escapes", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-link-"));
  const root = path.join(base, "root");
  const outside = path.join(base, "outside");
  await fs.mkdir(root);
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "secret.md"), "secret");
  try {
    await fs.symlink(outside, path.join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (["EPERM", "EACCES"].includes(error?.code)) {
      t.skip("Symlink creation is unavailable on this host.");
      return;
    }
    throw error;
  }
  await assert.rejects(resolveWithin(root, "linked/secret.md"), /escapes/i);
  await assert.rejects(resolveWithin(root, "linked/new.md", { mode: "write" }), /escapes/i);
});
