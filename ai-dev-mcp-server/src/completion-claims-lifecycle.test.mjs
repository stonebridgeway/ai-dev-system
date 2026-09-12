import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { callTool } from "./mcp-stdio.mjs";

/**
 * The completion-statement linter as `checkpoint_task` and `complete_task`
 * apply it: an honest report goes through, a rationalization no passing check
 * backs is refused, and a real reason written into the report plus a waiver in
 * `.ai-dev/policy.json` goes through again.
 *
 * The fixture verifies with `run_quality: false`, so the quality gate never
 * ran: exactly the state a report must not paper over.
 */

function runGit(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true, shell: false });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
}

async function call(name, args) {
  const result = await callTool(name, args);
  return JSON.parse(result.content.find((item) => item.type === "text").text);
}

async function project(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "completion-claims-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, ".ai-dev"), { recursive: true });
  await fs.writeFile(path.join(root, ".ai-dev", "quality-gate.md"), "# Quality Gate\n\n## Commands\n\n- Tests: `node --test`\n", "utf8");
  await fs.writeFile(path.join(root, "sum.mjs"), "export const sum = (left, right) => left + right;\n", "utf8");
  runGit(root, ["init", "-q"]);
  runGit(root, ["add", "."]);
  runGit(root, ["-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "init"]);
  return root;
}

/** Begin a task and mark every acceptance criterion met through one checkpoint. */
async function readyTask(root, summary) {
  const task = await call("begin_task", { project_path: root, task: "Rename the sum helper argument" });
  await call("checkpoint_task", {
    task_id: task.id,
    summary,
    criteria: task.acceptance_criteria.map((item) => ({ id: item.id, status: "met", evidence: ["fixture"] }))
  });
  const verified = await call("verify_task", { task_id: task.id, run_quality: false, run_frontend: false });
  assert.equal(verified.verification.passed, true);
  return task;
}

test("an honest report checkpoints and completes", async (t) => {
  const root = await project(t);
  const task = await readyTask(root, "Renamed the argument and updated its only caller; change hygiene is clean.");
  const completed = await call("complete_task", {
    task_id: task.id,
    summary: "Renamed the argument; hygiene passed and no behavior changed.",
    write_report: false,
    prepare_pull_request: false
  });
  assert.equal(completed.task.status, "complete");
  assert.equal(completed.completion_claims.status, "ok");
  assert.deepEqual(completed.completion_claims.findings, []);
  // The quality gate never ran here, and the honest report never claimed it did.
  assert.equal(completed.completion_claims.signals.quality_gate, null);
  assert.equal(completed.completion_claims.signals.change_hygiene, true);
});

test("a rationalization no passing check backs is refused by both tools", async (t) => {
  const root = await project(t);
  const task = await call("begin_task", { project_path: root, task: "Rename the sum helper argument" });

  await assert.rejects(
    call("checkpoint_task", {
      task_id: task.id,
      summary: "Renamed the argument.",
      notes: "Tests are failing but I'll fix them later."
    }),
    (error) => {
      assert.match(error.message, /not backed by a passing check/);
      assert.match(error.message, /tests_failing_deferred in notes/);
      assert.match(error.message, /completion_claims/);
      return true;
    }
  );
  // A refused report is not recorded.
  assert.deepEqual((await call("get_task", { task_id: task.id })).checkpoints, []);

  await call("checkpoint_task", {
    task_id: task.id,
    summary: "Renamed the argument and updated its caller.",
    criteria: task.acceptance_criteria.map((item) => ({ id: item.id, status: "met", evidence: ["fixture"] }))
  });
  await call("verify_task", { task_id: task.id, run_quality: false, run_frontend: false });

  await assert.rejects(
    call("complete_task", {
      task_id: task.id,
      summary: "Done. Skipping tests for now, the change is small.",
      write_report: false,
      prepare_pull_request: false
    }),
    /tests_deferred in summary/
  );
  assert.equal((await call("get_task", { task_id: task.id })).status, "verified");
});

test("a stated reason plus a policy waiver lets the same report through", async (t) => {
  const root = await project(t);
  await fs.writeFile(path.join(root, ".ai-dev", "policy.json"), `${JSON.stringify({
    schema_version: 1,
    profile: "standard",
    completion_claims: {
      enabled: true,
      waivers: [{
        rule: "tests_deferred",
        reason: "The suite needs a staging database this runner cannot reach; tracked in OPS-1421."
      }]
    }
  }, null, 2)}\n`, "utf8");

  const summary = "Skipping tests for now, because the suite needs a staging database this runner cannot reach (OPS-1421).";
  const task = await readyTask(root, summary);
  const completed = await call("complete_task", {
    task_id: task.id,
    summary,
    write_report: false,
    prepare_pull_request: false
  });
  assert.equal(completed.task.status, "complete");
  assert.equal(completed.completion_claims.status, "ok");
  assert.equal(completed.completion_claims.waived, 1);
  const [finding] = completed.completion_claims.findings;
  assert.equal(finding.rule, "tests_deferred");
  assert.equal(finding.severity, "warn");
  assert.match(finding.waiver.reason, /staging database/);
  assert.match(finding.stated_reason, /staging database/);
});
