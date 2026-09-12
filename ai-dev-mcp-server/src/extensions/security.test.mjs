import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createExtensionTools } from "../tool-extensions.mjs";
import { createSecurityTools } from "./security.mjs";

function createFixture(overrides = {}) {
  const calls = [];
  const host = {
    resolveProjectIdentity: async (value) => ({ project_root: overrides.projectRoot ?? "/repo/atlas", requested: value }),
    taskStore: {
      read: async (id) => { calls.push(["read", id]); return { id, status: overrides.taskStatus ?? "active", project: { path: "/repo/atlas" }, checkpoints: [] }; },
      checkpoint: async (id, args) => { calls.push(["checkpoint", id, args]); return { id, checkpoints: [args] }; }
    }
  };
  return { registry: createExtensionTools(host, [createSecurityTools]), calls, host };
}

const call = (registry, name, args) => registry.handlers.get(name)(args);

test("the tool needs a project or a task, and is not read-only", () => {
  const { registry } = createFixture();
  // Not read-only: it starts the project's own scanners, and trivy writes a
  // vulnerability database into the user's cache.
  assert.deepEqual(registry.readOnly, []);
  const [definition] = registry.definitions;
  assert.equal(definition.name, "run_security_scan");
  // The description has to name the finding shape and the gate, because that is
  // what an agent reads before deciding whether to act on a warning.
  assert.match(definition.description, /\{ tool, kind, severity, file, line, message, rule \}/);
  assert.match(definition.description, /skipped with the reason — never as a failure/);
  assert.deepEqual(definition.inputSchema.properties.scanners.items.enum, [
    "npm_audit", "pip_audit", "cargo_audit", "gitleaks", "semgrep", "trivy_fs"
  ]);
});

test("a scan with nothing installed reports it instead of claiming the project is clean", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "security-ext-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const { registry } = createFixture({ projectRoot: root });
  // No marker files and (in the worst case) real binaries: naming one scanner
  // that needs a lock file keeps this hermetic.
  const result = await call(registry, "run_security_scan", { project_path: root, scanners: ["cargo_audit"], offline: true });
  assert.equal(result.status, "pass");
  assert.equal(result.summary.checked, 0);
  assert.match(result.next_step, /No scanner could run here/);
  assert.match(result.markdown, /# Security scan: pass/);
  assert.equal(result.scanners[0].status, "skipped");
  assert.equal(result.project_path, path.resolve(root));
});

test("a scan can be attached to a task as a checkpoint note", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "security-ext-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const { registry, calls } = createFixture({ projectRoot: root });
  await call(registry, "run_security_scan", { task_id: "task-1", scanners: ["cargo_audit"], offline: true, record_checkpoint: true });
  const [, , checkpoint] = calls.find(([name]) => name === "checkpoint");
  assert.match(checkpoint.summary, /^Security scan: pass \(0 blocking, 0 findings, 1 scanners skipped\)/);
  assert.match(checkpoint.notes, /# Security scan: pass/);

  const complete = createFixture({ projectRoot: root, taskStatus: "complete" });
  const result = await call(complete.registry, "run_security_scan", { task_id: "task-1", scanners: ["cargo_audit"], offline: true, record_checkpoint: true });
  assert.equal(result.checkpoint, null, "a completed task takes no more checkpoints");
});

test("neither a project nor a task is an error the caller can act on", async () => {
  const { registry } = createFixture();
  await assert.rejects(() => call(registry, "run_security_scan", {}), /project_path or task_id is required/);
  await assert.rejects(
    () => call(registry, "run_security_scan", { project_path: "/repo/atlas", scanners: ["bandit"] }),
    /Unknown scanner: bandit/
  );
});
