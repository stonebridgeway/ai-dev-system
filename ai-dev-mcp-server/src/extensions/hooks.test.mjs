import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createExtensionTools } from "../tool-extensions.mjs";
import { createHookTools } from "./hooks.mjs";

test("hook tools install and report agent hooks through the host", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hook-tools-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const projectRoot = path.join(root, "project");
  await fs.mkdir(projectRoot);
  const host = {
    serverRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".."),
    resolveProjectIdentity: async (projectPath) => ({ project_root: projectPath, project_id: "project-test" })
  };
  const registry = createExtensionTools(host, [createHookTools]);
  const before = await registry.handlers.get("agent_hooks_status")({ project_path: projectRoot });
  assert.equal(before.installed, false);
  const installed = await registry.handlers.get("install_agent_hooks")({ project_path: projectRoot, targets: ["claude", "cursor"], profile: "strict" });
  assert.equal(installed.action, "hooks_installed");
  assert.ok(installed.written.includes(".claude/settings.json"));
  assert.ok(installed.written.includes(".cursor/hooks.json"));
  const after = await registry.handlers.get("agent_hooks_status")({ project_path: projectRoot });
  assert.equal(after.installed, true);
  assert.equal(after.profile, "strict");
  assert.ok(after.claude_entries >= 6);
  assert.ok(after.cursor_entries >= 5);
});

test("the policy tools edit .ai-dev/policy.json and agent_hooks_status reports what the guard would do", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "policy-tools-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const projectRoot = path.join(root, "project");
  await fs.mkdir(projectRoot);
  const host = {
    serverRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".."),
    resolveProjectIdentity: async (projectPath) => ({ project_root: projectPath, project_id: "project-test" })
  };
  const registry = createExtensionTools(host, [createHookTools]);
  await registry.handlers.get("install_agent_hooks")({ project_path: projectRoot });

  const created = await registry.handlers.get("upsert_policy_rule")({
    project_path: projectRoot,
    rule: {
      id: "block-terraform-destroy",
      event: "bash",
      pattern: "terraform\\s+destroy",
      action: "block",
      message: "Destroying infrastructure needs a human on the call.",
      example: "terraform destroy -auto-approve",
      counter_example: "terraform apply"
    }
  });
  assert.equal(created.action, "created");
  assert.equal(created.verification.fires_on_example, true);
  assert.match(created.next_step, /live without restarting the client/);

  await assert.rejects(
    registry.handlers.get("upsert_policy_rule")({
      project_path: projectRoot,
      rule: { id: "block-terraform-destroy-2", event: "bash", pattern: "terraform\\s+destroy", action: "block", message: "Again.", example: "terraform destroy" }
    }),
    /already carries this pattern/
  );

  const listed = await registry.handlers.get("list_policy_rules")({ project_path: projectRoot });
  assert.equal(listed.counts.total, 4);
  assert.equal(listed.counts.blocking, 2);
  assert.equal(listed.counts.broken, 0);

  const status = await registry.handlers.get("agent_hooks_status")({ project_path: projectRoot });
  assert.equal(status.policy_rules, 4);
  assert.equal(status.policy_rule_counts.enabled, 4);
  assert.deepEqual(status.policy_problems, []);
  const shown = status.rules.find((rule) => rule.id === "block-terraform-destroy");
  assert.equal(shown.effective_action, "block");
  assert.equal(shown.example, undefined, "the status view stays short: the example is in list_policy_rules");

  const disabled = await registry.handlers.get("upsert_policy_rule")({ project_path: projectRoot, rule: { id: "warn-eval", enabled: false } });
  assert.deepEqual(disabled.changed_fields, ["enabled"]);
  const removed = await registry.handlers.get("remove_policy_rule")({ project_path: projectRoot, id: "warn-inner-html" });
  assert.equal(removed.action, "removed");
  const after = await registry.handlers.get("agent_hooks_status")({ project_path: projectRoot });
  assert.equal(after.policy_rules, 3);
  assert.equal(after.policy_rule_counts.enabled, 2);

  const planned = await registry.handlers.get("upsert_policy_rule")({
    project_path: projectRoot,
    rule: { id: "warn-todo-comment", event: "file", pattern: "TODO\\(no-issue\\)", action: "warn", message: "File an issue and reference it.", example: "// TODO(no-issue): fix later" },
    dry_run: true
  });
  assert.equal(planned.dry_run, true);
  assert.match(planned.next_step, /Nothing was written/);
  assert.equal((await registry.handlers.get("list_policy_rules")({ project_path: projectRoot })).counts.total, 3);
});
