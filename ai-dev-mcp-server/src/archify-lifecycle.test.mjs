import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { callTool, vaultRoot } from "./mcp-stdio.mjs";

function value(result) {
  return JSON.parse(result.content.find((item) => item.type === "text").text);
}
async function call(name, args) { return value(await callTool(name, args)); }
async function project(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "archify-lifecycle-"));
  await fs.mkdir(path.join(root, ".ai-dev"), { recursive: true });
  await fs.writeFile(path.join(root, ".ai-dev", "quality-gate.md"), "# Quality Gate\n\n## Default Verification\n", "utf8");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
async function example() {
  return JSON.parse(await fs.readFile(path.join(vaultRoot, "03-skills-catalog", "sources", "external", "archify", "examples", "web-app.architecture.json"), "utf8"));
}

test("diagram task can complete from a verified Archify delivery receipt", async (t) => {
  const root = await project(t);
  const task = await call("begin_task", { project_path: root, task: "Document the architecture diagram for the service" });
  assert.ok(task.acceptance_criteria.some((item) => /archify_deliver/i.test(item.text)));
  const delivery = await call("archify_deliver", { project_path: root, artifact_location: "project", output_path: "docs/diagram.html", diagram_type: "architecture", spec: await example() });
  assert.equal(delivery.evidence.kind, "archify_deliver");
  assert.equal(delivery.evidence.quality, "showcase");
  assert.equal(delivery.evidence.warnings, 0);
  await call("checkpoint_task", { task_id: task.id, summary: "Diagram authored", criteria: task.acceptance_criteria.filter((item) => !/automated checks|archify_deliver/i.test(item.text)).map((item) => ({ id: item.id, status: "met" })) });
  const verified = await call("verify_task", { task_id: task.id, run_quality: false, evidence: [delivery.evidence] });
  assert.equal(verified.verification.passed, true);
  assert.ok(verified.task.acceptance_criteria.find((item) => /archify_deliver/i.test(item.text)).status === "met");
  const complete = await call("complete_task", { task_id: task.id, summary: "Diagram delivered", write_report: false });
  assert.equal(complete.task.status, "complete");
});

test("diagram_specs quality gate blocks an invalid committed Archify specification", async (t) => {
  const root = await project(t);
  await fs.mkdir(path.join(root, "docs"));
  await fs.writeFile(path.join(root, "docs", "broken.architecture.json"), "{}\n", "utf8");
  const result = await call("run_quality_gate", { project_path: root, diagram_specs: "docs/*.architecture.json", update_registry: false });
  assert.equal(result.status, "failed");
  assert.equal(result.diagram_specs.status, "block");
  assert.equal(result.diagram_specs.files[0].status, "block");
});

test("diagram_specs quality gate passes a valid committed Archify specification", async (t) => {
  const root = await project(t);
  await fs.mkdir(path.join(root, "docs"));
  await fs.writeFile(path.join(root, "docs", "system.architecture.json"), JSON.stringify(await example(), null, 2), "utf8");
  const result = await call("run_quality_gate", { project_path: root, diagram_specs: "docs/*.architecture.json", update_registry: false });
  assert.notEqual(result.status, "failed");
  assert.equal(result.diagram_specs.status, "pass");
  assert.equal(result.diagram_specs.files[0].status, "pass");
});
