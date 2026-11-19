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
  // And a run where not one of them ran has to say so where an agent reads it.
  assert.match(definition.description, /unchecked, not pass/);
  assert.match(definition.description, /kind is dependency, malware, secret, sast or misconfig/);
  assert.deepEqual(definition.inputSchema.properties.scanners.items.enum, [
    "npm_audit", "pnpm_audit", "yarn_audit", "bun_audit", "osv_scanner", "pip_audit", "cargo_audit", "gitleaks", "semgrep", "trivy_fs"
  ]);
});

test("a scan with nothing installed reports it instead of claiming the project is clean", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "security-ext-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const { registry } = createFixture({ projectRoot: root });
  // No marker files and (in the worst case) real binaries: naming one scanner
  // that needs a lock file keeps this hermetic.
  const result = await call(registry, "run_security_scan", { project_path: root, scanners: ["cargo_audit"], offline: true });
  // `unchecked`, not `pass`: nothing ran, so nothing was found clean.
  assert.equal(result.status, "unchecked");
  assert.equal(result.summary.checked, 0);
  assert.match(result.next_step, /No scanner could run here/);
  assert.match(result.markdown, /# Security scan: unchecked/);
  assert.equal(result.scanners[0].status, "skipped");
  assert.equal(result.project_path, path.resolve(root));
});

test("a scan can be attached to a task as a checkpoint note", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "security-ext-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const { registry, calls } = createFixture({ projectRoot: root });
  await call(registry, "run_security_scan", { task_id: "task-1", scanners: ["cargo_audit"], offline: true, record_checkpoint: true });
  const [, , checkpoint] = calls.find(([name]) => name === "checkpoint");
  assert.match(checkpoint.summary, /^Security scan: unchecked \(0 blocking, 0 findings, 1 scanners skipped\)/);
  assert.match(checkpoint.notes, /# Security scan: unchecked/);

  const complete = createFixture({ projectRoot: root, taskStatus: "complete" });
  const result = await call(complete.registry, "run_security_scan", { task_id: "task-1", scanners: ["cargo_audit"], offline: true, record_checkpoint: true });
  assert.equal(result.checkpoint, null, "a completed task takes no more checkpoints");
});

test("the fix plan changes nothing, and says so when nothing could be scanned", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "security-ext-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  await fs.writeFile(path.join(root, "package-lock.json"), "{}", "utf8");
  const before = await fs.readFile(path.join(root, "package-lock.json"), "utf8");
  const { registry, calls } = createFixture({ projectRoot: root });
  const definition = registry.definitions.find((item) => item.name === "plan_security_fixes");
  assert.match(definition.description, /change nothing/);
  assert.match(definition.description, /only after they confirm/);
  assert.deepEqual(registry.readOnly, [], "it runs scanners and asks the registry");

  // Offline, every dependency scanner is skipped: an empty plan, and a next
  // step that refuses to read that as clean.
  const result = await call(registry, "plan_security_fixes", { task_id: "task-1", offline: true, record_checkpoint: true, min_release_age_days: -3 });
  assert.equal(result.summary.items, 0);
  assert.equal(result.min_release_age_days, 7, "a negative quarantine is the default, not no quarantine");
  assert.equal(result.scan.status, "unchecked");
  assert.match(result.next_step, /No dependency scanner could run here/);
  assert.match(result.markdown, /# Security fix plan: 0 item\(s\)/);
  const [, , checkpoint] = calls.find(([name]) => name === "checkpoint");
  assert.match(checkpoint.summary, /^Security fix plan: 0 item\(s\), 0 malware, 0 breaking/);
  assert.equal(await fs.readFile(path.join(root, "package-lock.json"), "utf8"), before);
  // The run is stamped, unchecked or not, so the Stop hook knows it happened.
  const stamp = JSON.parse(await fs.readFile(path.join(root, ".ai-dev", "security", "last-scan.json"), "utf8"));
  assert.deepEqual({ via: stamp.via, status: stamp.status, scanners: stamp.scanners }, { via: "plan_security_fixes", status: "unchecked", scanners: [] });
  assert.ok(Date.parse(stamp.at) > Date.now() - 60_000);
  await assert.rejects(() => call(registry, "plan_security_fixes", {}), /project_path or task_id is required/);
});

test("neither a project nor a task is an error the caller can act on", async () => {
  const { registry } = createFixture();
  await assert.rejects(() => call(registry, "run_security_scan", {}), /project_path or task_id is required/);
  await assert.rejects(
    () => call(registry, "run_security_scan", { project_path: "/repo/atlas", scanners: ["bandit"] }),
    /Unknown scanner: bandit/
  );
});
