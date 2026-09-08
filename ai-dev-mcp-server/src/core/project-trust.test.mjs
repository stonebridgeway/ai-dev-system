import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertTrusted, isTrusted, listTrustedProjects, removeTrustedProject, trustProject } from "./project-trust.mjs";

test("project trust is explicit, canonical, and stored outside the project", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-trust-"));
  const project = path.join(root, "project"); await fs.mkdir(project);
  const previous = process.env.AI_DEV_HOME; process.env.AI_DEV_HOME = path.join(root, "runtime");
  const testContext = process.env.NODE_TEST_CONTEXT; delete process.env.NODE_TEST_CONTEXT;
  t.after(() => { if (previous === undefined) delete process.env.AI_DEV_HOME; else process.env.AI_DEV_HOME = previous; if (testContext === undefined) delete process.env.NODE_TEST_CONTEXT; else process.env.NODE_TEST_CONTEXT = testContext; return fs.rm(root, { recursive: true, force: true }); });
  await assert.rejects(assertTrusted(project), (error) => error.code === "PROJECT_NOT_TRUSTED");
  assert.equal(await trustProject(project), await fs.realpath(project));
  assert.equal(await isTrusted(project), true);
  assert.equal((await listTrustedProjects()).length, 1);
  assert.equal(await removeTrustedProject(project), true);
  assert.equal(await isTrusted(project), false);
});
