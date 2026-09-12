import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { createExtensionTools } from "../tool-extensions.mjs";
import { createCoverageTools } from "./coverage.mjs";

function runGit(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true, shell: false });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

async function fixture(t) {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "coverage-tools-"));
  t.after(() => fs.rm(created, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const root = await fs.realpath(created);
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "router.ts"), "export const resolve = () => 1;\n");
  await fs.writeFile(path.join(root, "src", "legacy.ts"), "export const old = () => 1;\n");
  // A real project ignores its coverage output, and so must the change set the
  // ranking is weighed against.
  await fs.writeFile(path.join(root, ".gitignore"), "coverage/\nlcov.info\n");
  runGit(root, ["init", "-q", "-b", "main"]);
  runGit(root, ["add", "."]);
  runGit(root, ["-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "init"]);
  return root;
}

function registryFor(projectRoot) {
  return createExtensionTools({
    resolveProjectIdentity: async (projectPath) => ({ project_root: projectPath, project_id: "project-test" }),
    taskStore: { read: async () => ({ project: { path: projectRoot } }) }
  }, [createCoverageTools]);
}

test("coverage_gaps says what is missing and where to start, or that there is no report", async (t) => {
  const projectRoot = await fixture(t);
  const registry = registryFor(projectRoot);

  const none = await registry.handlers.get("coverage_gaps")({ project_path: projectRoot });
  assert.equal(none.status, "no_report");
  assert.deepEqual(none.gaps, []);
  assert.match(none.next_step, /Run the project's test command with coverage enabled/);
  assert.match((await registry.handlers.get("coverage_gaps")({ project_path: projectRoot, report_path: "build/lcov.info" })).next_step, /build\/lcov\.info/);
  await assert.rejects(registry.handlers.get("coverage_gaps")({}), /project_path or task_id is required/);

  await fs.mkdir(path.join(projectRoot, "coverage"), { recursive: true });
  await fs.writeFile(path.join(projectRoot, "coverage", "lcov.info"), [
    `SF:${projectRoot}/src/router.ts`,
    "FN:1,resolve", "FNDA:0,resolve", "FN:2,render", "FNDA:0,render",
    "DA:1,0", "DA:2,0", "DA:3,4",
    "LF:3", "LH:1", "end_of_record",
    `SF:${projectRoot}/src/legacy.ts`,
    "DA:1,0", "DA:2,0", "DA:3,0", "DA:4,0",
    "LF:4", "LH:0", "end_of_record",
    ""
  ].join("\n"));

  // Nothing is uncommitted yet, so there is no change set to weigh by and the
  // whole project is ranked.
  const project = await registry.handlers.get("coverage_gaps")({ project_path: projectRoot });
  assert.equal(project.status, "gaps");
  assert.equal(project.scope, "project");
  assert.equal(project.changed_files, 0);
  assert.equal(project.report.format, "lcov");
  assert.equal(project.totals.line_percent, 14.29);
  assert.deepEqual(project.gaps.map((gap) => gap.file), ["src/router.ts", "src/legacy.ts"],
    "two uncovered functions outweigh two more uncovered lines");

  // Touch one file and it leads, whatever the rest of the project looks like.
  await fs.appendFile(path.join(projectRoot, "src", "legacy.ts"), "export const two = 2;\n");
  const changed = await registry.handlers.get("coverage_gaps")({ project_path: projectRoot });
  assert.equal(changed.scope, "changed");
  assert.equal(changed.changed_files_in_report, 1);
  assert.deepEqual(changed.gaps.map((gap) => gap.file), ["src/legacy.ts"]);
  assert.deepEqual(changed.gaps[0].ranges, ["1-4"]);
  assert.match(changed.next_step, /Start with src\/legacy\.ts/);

  const both = await registry.handlers.get("coverage_gaps")({ task_id: "task-1", changed_only: false });
  assert.deepEqual(both.gaps.map((gap) => gap.file), ["src/legacy.ts", "src/router.ts"]);
  assert.equal(both.gaps.find((gap) => gap.file === "src/router.ts").uncovered_functions[0].name, "resolve");

  const limited = await registry.handlers.get("coverage_gaps")({ project_path: projectRoot, changed_only: false, limit: 1 });
  assert.equal(limited.gaps.length, 1);
});

test("a report where everything is covered is not a list of gaps", async (t) => {
  const projectRoot = await fixture(t);
  await fs.writeFile(path.join(projectRoot, "lcov.info"), [
    "SF:src/router.ts", "DA:1,2", "LF:1", "LH:1", "end_of_record", ""
  ].join("\n"));
  const result = await registryFor(projectRoot).handlers.get("coverage_gaps")({ project_path: projectRoot });
  assert.equal(result.status, "covered");
  assert.deepEqual(result.gaps, []);
  assert.equal(result.totals.line_percent, 100);
  assert.match(result.next_step, /Nothing uncovered/);
});
