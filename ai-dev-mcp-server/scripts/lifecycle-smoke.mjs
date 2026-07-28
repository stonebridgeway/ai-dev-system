import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(scriptDir, "..");
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-lifecycle-"));
const projectRoot = path.join(tempRoot, "project");
const stateRoot = path.join(tempRoot, "state");
await fs.mkdir(path.join(projectRoot, ".ai-dev"), { recursive: true });
await fs.writeFile(path.join(projectRoot, "package.json"), JSON.stringify({
  name: "ai-dev-lifecycle-fixture",
  private: true,
  type: "module"
}, null, 2), "utf8");
await fs.writeFile(path.join(projectRoot, "sum.mjs"), "export const sum = (left, right) => left + right;\n", "utf8");
await fs.writeFile(path.join(projectRoot, "sum.test.mjs"), [
  'import assert from "node:assert/strict";',
  'import test from "node:test";',
  'import { sum } from "./sum.mjs";',
  'test("sum", () => assert.equal(sum(2, 3), 5));',
  ""
].join("\n"), "utf8");
await fs.writeFile(path.join(projectRoot, ".ai-dev", "quality-gate.md"), [
  "# Quality Gate",
  "",
  "## Commands",
  "",
  "- Tests: `node --test`",
  ""
].join("\n"), "utf8");

function runGit(args) {
  const result = spawnSync("git", ["-C", projectRoot, ...args], {
    encoding: "utf8",
    windowsHide: true,
    shell: false
  });
  if (result.status !== 0) {
    throw new Error(`Git fixture setup failed: ${result.stderr || result.stdout}`);
  }
}

runGit(["init"]);
runGit(["add", "."]);
runGit([
  "-c",
  "user.name=AI Dev Lifecycle Smoke",
  "-c",
  "user.email=lifecycle-smoke@example.invalid",
  "commit",
  "-m",
  "Create lifecycle fixture"
]);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(serverRoot, "src", "server.mjs")],
  cwd: serverRoot,
  env: {
    ...process.env,
    AI_DEV_STATE_ROOT: stateRoot
  },
  stderr: "pipe"
});
const client = new Client(
  { name: "ai-dev-lifecycle-smoke", version: "1.0.0" },
  { capabilities: {} }
);
const stderr = [];
transport.stderr?.on("data", (chunk) => stderr.push(chunk));

async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) {
    throw new Error(`${name} failed: ${result.content?.map((item) => item.text || "").join("\n")}`);
  }
  assert(result.structuredContent?.result, `${name} did not return structured content`);
  return result.structuredContent.result;
}

try {
  await client.connect(transport);
  const begun = await call("begin_task", {
    project_path: projectRoot,
    task: "Implement and verify the fixture sum behavior"
  });
  assert.equal(begun.status, "active");
  assert(begun.skills.length > 0 && begun.skills.length <= 3);

  const manualCriteria = begun.acceptance_criteria
    .filter((criterion) => !/automated checks pass/i.test(criterion.text))
    .map((criterion) => ({
      id: criterion.id,
      status: "met",
      note: "Satisfied by the isolated lifecycle smoke fixture.",
      evidence: ["lifecycle-smoke"]
    }));
  await call("checkpoint_task", {
    task_id: begun.id,
    summary: "Fixture implementation and regression test are present.",
    changed_files: ["sum.mjs", "sum.test.mjs"],
    criteria: manualCriteria
  });

  const verified = await call("verify_task", {
    task_id: begun.id,
    run_quality: true,
    run_frontend: false
  });
  assert.equal(verified.verification.passed, true);
  assert.equal(verified.verification.checks[0].result.status, "passed");
  assert.equal(verified.skill_outcomes.recorded, true);

  const remaining = verified.task.acceptance_criteria
    .filter((criterion) => criterion.status === "pending")
    .map((criterion) => ({
      id: criterion.id,
      status: "met",
      note: "Satisfied by passing verification.",
      evidence: [verified.verification.id]
    }));
  if (remaining.length) {
    await call("checkpoint_task", {
      task_id: begun.id,
      summary: "All remaining criteria are bound to passing verification.",
      criteria: remaining
    });
  }

  const completed = await call("complete_task", {
    task_id: begun.id,
    summary: "Lifecycle smoke completed with current-state verification.",
    write_report: false
  });
  assert.equal(completed.task.status, "complete");
  const outcomes = await call("skill_outcome_status", {});
  assert.equal(outcomes.events, 1);
  process.stdout.write(`${JSON.stringify({
    status: "pass",
    task_id: begun.id,
    routed_skills: begun.skills.map((item) => item.name),
    quality_status: verified.verification.checks[0].result.status,
    task_status: completed.task.status,
    outcome_events: outcomes.events
  }, null, 2)}\n`);
} catch (error) {
  const serverStderr = Buffer.concat(stderr).toString("utf8").trim();
  if (serverStderr) process.stderr.write(`${serverStderr}\n`);
  throw error;
} finally {
  await client.close().catch(() => {});
  await fs.rm(tempRoot, { recursive: true, force: true });
}
