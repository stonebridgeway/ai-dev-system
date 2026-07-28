import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runProcess } from "./process-runner.mjs";
import {
  projectIdentityKey,
  resolveProjectIdentity,
  sameProjectIdentity
} from "./project-identity.mjs";

test("nested packages resolve to one canonical Git project", async (t) => {
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

test("filesystem projects use a stable canonical key", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-filesystem-id-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const identity = await resolveProjectIdentity(root);
  assert.match(identity.project_id, /^project-[a-f0-9]{20}$/);
  assert.equal(projectIdentityKey(identity), identity.project_id);
  assert.equal(identity.kind, "filesystem");
});
