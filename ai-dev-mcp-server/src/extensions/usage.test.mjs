import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TaskStore } from "../core/task-lifecycle.mjs";
import { UsageLedger } from "../core/usage-ledger.mjs";
import { createExtensionTools } from "../tool-extensions.mjs";
import { createUsageTools } from "./usage.mjs";

test("usage tools scope reports by task and project", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "usage-tools-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, "project");
  await fs.mkdir(projectRoot);
  const taskStore = new TaskStore({ stateRoot: path.join(root, "state") });
  const usageLedger = new UsageLedger({ stateRoot: path.join(root, "state") });
  const host = {
    taskStore,
    usageLedger,
    resolveProjectIdentity: async (projectPath) => ({ project_root: projectPath, project_id: "project-test" }),
    readProjectTextIfExists: async (base, relativePath) => fs.readFile(path.join(base, relativePath), "utf8").catch(() => "")
  };
  const registry = createExtensionTools(host, [createUsageTools]);
  const task = await taskStore.begin({
    task: "Measure cost",
    project: { project_name: "fixture", project_path: projectRoot },
    skills: [],
    baseline: { fingerprint: "a" }
  });

  const recorded = await registry.handlers.get("record_usage")({
    task_id: task.id,
    model: "claude-opus-5",
    input_tokens: 1200,
    output_tokens: 300,
    cost_usd: 0.07,
    source: "session-runner"
  });
  assert.equal(recorded.event.project_path, projectRoot);
  await usageLedger.recordToolCall({ tool: "verify_task", ok: true, durationMs: 50, taskId: task.id, projectPath: projectRoot });

  const byTask = await registry.handlers.get("usage_report")({ task_id: task.id });
  assert.equal(byTask.events, 2);
  assert.equal(byTask.tasks[0].cost_usd, 0.07);
  const byProject = await registry.handlers.get("usage_report")({ project_path: projectRoot });
  assert.equal(byProject.events, 2);
  await assert.rejects(registry.handlers.get("record_usage")({ model: "x" }), /needs input_tokens/);
});

test("usage_report prices unpriced events, with the project's own rates when it sets them", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "usage-rates-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, "project");
  await fs.mkdir(path.join(projectRoot, ".ai-dev"), { recursive: true });
  const usageLedger = new UsageLedger({ stateRoot: path.join(root, "state") });
  const host = {
    taskStore: new TaskStore({ stateRoot: path.join(root, "state") }),
    usageLedger,
    resolveProjectIdentity: async (projectPath) => ({ project_root: projectPath, project_id: "project-test" }),
    readProjectTextIfExists: async (base, relativePath) => fs.readFile(path.join(base, relativePath), "utf8").catch(() => "")
  };
  const registry = createExtensionTools(host, [createUsageTools]);
  const report = () => registry.handlers.get("usage_report")({ project_path: projectRoot });

  // A hook capture: tokens, no cost. The published price for Claude Opus 5
  // input is $5 per million.
  await registry.handlers.get("record_usage")({
    project_path: projectRoot,
    model: "claude-opus-5",
    input_tokens: 1_000_000,
    output_tokens: 0,
    source: "hook:cost-capture"
  });
  const published = await report();
  assert.equal(published.usage.cost_usd, 5);
  assert.equal(published.usage.estimated_cost_usd, 5);
  assert.equal(published.usage.reported_cost_usd, 0);
  assert.equal(published.periods.today.cost_usd, 5);
  assert.deepEqual(published.rates.overrides, []);
  assert.equal(published.rates.policy_path, null);

  // Prices move, so the project can correct one without waiting for a release.
  await fs.writeFile(path.join(projectRoot, ".ai-dev", "policy.json"), JSON.stringify({ profile: "standard", model_rates: { "claude-opus-5": { input: 7, output: 30 } } }));
  const overridden = await report();
  assert.equal(overridden.usage.cost_usd, 7);
  assert.deepEqual(overridden.rates.overrides, ["claude-opus-5"]);
  assert.equal(overridden.rates.policy_path, ".ai-dev/policy.json");
  assert.equal(overridden.models[0].rate_usd_per_mtok.input, 7);

  // A policy nobody can parse must not take the report down with it.
  await fs.writeFile(path.join(projectRoot, ".ai-dev", "policy.json"), "{ not json");
  const broken = await report();
  assert.equal(broken.usage.cost_usd, 5);
  assert.match(broken.rates.warning, /not valid JSON/);
});
