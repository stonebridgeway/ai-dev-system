import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { FINDING_FIELDS } from "../core/change-hygiene.mjs";
import { TaskStore } from "../core/task-lifecycle.mjs";
import { createExtensionTools } from "../tool-extensions.mjs";
import { createHygieneTools } from "./hygiene.mjs";

function runGit(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true, shell: false });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
}

test("verify_change_hygiene scans a task project and can checkpoint the summary", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hygiene-tools-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, "project");
  await fs.mkdir(path.join(projectRoot, "src"), { recursive: true });
  await fs.writeFile(path.join(projectRoot, "src", "index.js"), "export const a = 1;\n");
  runGit(projectRoot, ["init", "-q"]);
  runGit(projectRoot, ["add", "."]);
  runGit(projectRoot, ["-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "init"]);

  const taskStore = new TaskStore({ stateRoot: path.join(root, "state") });
  const host = {
    taskStore,
    resolveProjectIdentity: async (projectPath) => ({ project_root: projectPath, project_id: "project-test" })
  };
  const registry = createExtensionTools(host, [createHygieneTools]);
  const task = await taskStore.begin({
    task: "Add feature",
    project: { project_name: "fixture", project_path: projectRoot },
    skills: [],
    baseline: { fingerprint: "a" }
  });

  const clean = await registry.handlers.get("verify_change_hygiene")({ project_path: projectRoot });
  assert.equal(clean.status, "pass");
  assert.equal(clean.findings.length, 0);

  await fs.writeFile(path.join(projectRoot, "src", "index.js"), "export const a = 1;\nconsole.log(a);\n");
  const dirty = await registry.handlers.get("verify_change_hygiene")({ task_id: task.id, record_checkpoint: true });
  assert.equal(dirty.status, "warn");
  const leftover = dirty.findings.find((item) => item.rule === "console_log");
  // The response schema every consumer reads: docs, the verification-loop skill, task notes.
  assert.deepEqual(Object.keys(leftover), [...FINDING_FIELDS]);
  assert.equal(leftover.file, "src/index.js");
  assert.equal(leftover.line, 2);
  assert.equal(leftover.severity, "warn");
  assert.equal(leftover.excerpt, "console.log(a);");
  assert.ok(dirty.findings.some((item) => item.rule === "no_test_changes"));
  assert.equal(dirty.checkpoint.checkpoints, 1);
  assert.match(dirty.markdown, /console_log/);
  const updated = await taskStore.read(task.id);
  assert.match(updated.checkpoints[0].summary, /Change hygiene: warn/);
  assert.deepEqual(updated.checkpoints[0].changed_files, ["src/index.js"]);
  await assert.rejects(registry.handlers.get("verify_change_hygiene")({}), /project_path or task_id is required/);
});
