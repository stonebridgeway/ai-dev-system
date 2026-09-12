import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { observationsFileName } from "../core/instinct-proposals.mjs";
import { InstinctStore } from "../core/instincts.mjs";
import { SessionStore } from "../core/session-memory.mjs";
import { TaskStore } from "../core/task-lifecycle.mjs";
import { createExtensionTools } from "../tool-extensions.mjs";
import { createInstinctTools } from "./instincts.mjs";

test("instinct tools record, list, update, evolve into vault drafts, export, and import", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "instinct-tools-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, "project");
  const vaultRoot = path.join(root, "vault");
  await fs.mkdir(projectRoot);
  await fs.mkdir(vaultRoot);
  const stateRoot = path.join(root, "state");
  const taskStore = new TaskStore({ stateRoot });
  const instinctStore = new InstinctStore({ stateRoot });
  const dirty = [];
  const host = {
    taskStore,
    instinctStore,
    vaultRoot,
    resolveProjectIdentity: async (projectPath) => ({ project_root: projectPath, project_id: "project-test" }),
    detectProject: async () => ({ stack: ["Python", "FastAPI"], project_types: ["api"] }),
    markSearchIndexDirty: (reason) => dirty.push(reason)
  };
  const registry = createExtensionTools(host, [createInstinctTools]);
  const task = await taskStore.begin({ task: "Fix flaky tests", project: { project_name: "svc", project_path: projectRoot }, skills: [], baseline: { fingerprint: "a" } });

  await assert.rejects(registry.handlers.get("record_instinct")({ trigger: "x", action: "y" }), /project_path or task_id is required/);
  const recorded = await registry.handlers.get("record_instinct")({ task_id: task.id, trigger: "when a pytest test is flaky", action: "pin the reproduction rate before fixing", domain: "testing", note: "happened twice" });
  assert.equal(recorded.action, "instinct_created");
  assert.equal(recorded.instinct.project_id, "project-test");
  assert.deepEqual(recorded.instinct.stack, ["Python", "FastAPI"]);
  for (const [trigger, action] of [["when adding a regression test", "name it by the behavior it protects"], ["when tests share state", "isolate fixtures per test"]]) {
    await registry.handlers.get("record_instinct")({ project_path: projectRoot, trigger, action, domain: "testing", confidence: 0.75 });
  }
  const globalOne = await registry.handlers.get("record_instinct")({ trigger: "when handling user input", action: "validate at the boundary", domain: "security", scope: "global", confidence: 0.8 });
  assert.equal(globalOne.instinct.scope, "global");

  const listed = await registry.handlers.get("list_instincts")({ project_path: projectRoot });
  assert.equal(listed.count, 4);
  const confirmed = await registry.handlers.get("update_instinct")({ id: recorded.instinct.id, action: "confirm", note: "helped" });
  assert.equal(confirmed.action, "instinct_confirmed");
  assert.equal(confirmed.instinct.confidence, 0.35);

  const preview = await registry.handlers.get("evolve_instincts")({ project_path: projectRoot, min_cluster_size: 3 });
  assert.equal(preview.action, "evolution_previewed");
  assert.equal(preview.clusters.length, 1);
  assert.match(preview.clusters[0].markdown, /^---\nname: learned-testing-project/);
  const evolved = await registry.handlers.get("evolve_instincts")({ project_path: projectRoot, min_cluster_size: 3, write_drafts: true });
  assert.equal(evolved.action, "instincts_evolved");
  const draftPath = path.join(vaultRoot, "03-skills-catalog", "sources", "custom", "learned-testing-project", "SKILL.md");
  assert.match(await fs.readFile(draftPath, "utf8"), /## Workflow/);
  assert.equal(dirty.length, 1);
  assert.equal((await registry.handlers.get("list_instincts")({ project_path: projectRoot, domain: "testing" })).count, 0);

  const exported = await registry.handlers.get("export_instincts")({ scope: "global" });
  assert.equal(exported.instincts.length, 1);
  const imported = await registry.handlers.get("import_instincts")({ entries: exported.instincts, scope: "global" });
  assert.equal(imported.imported, 1);
  assert.equal(imported.reinforced, 1, "same global instinct merges instead of duplicating");
  await assert.rejects(registry.handlers.get("import_instincts")({ entries: exported.instincts, scope: "project" }), /project_path is required/);
});

test("propose_instincts turns a session's observation log into candidates nobody has confirmed yet", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "propose-instincts-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, "project");
  await fs.mkdir(projectRoot);
  const stateRoot = path.join(root, "state");
  const instinctStore = new InstinctStore({ stateRoot });
  const sessionStore = new SessionStore({ stateRoot });
  const identity = { project_root: projectRoot, project_id: "project-test", repository_id: "repository-test" };
  const host = {
    instinctStore,
    sessionStore,
    taskStore: new TaskStore({ stateRoot }),
    resolveProjectIdentity: async () => identity,
    detectProject: async () => ({ stack: ["TypeScript"], project_types: ["backend"] })
  };
  const registry = createExtensionTools(host, [createInstinctTools]);

  const empty = await registry.handlers.get("propose_instincts")({ project_path: projectRoot });
  assert.equal(empty.status, "no_observations");
  assert.deepEqual(empty.proposals, []);
  assert.match(empty.next_step, /install_agent_hooks/);

  // The log the session-end hook leaves behind, written where it writes it.
  const directory = sessionStore.directoryFor("repository-test");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, observationsFileName("s-1")), JSON.stringify({
    schema_version: 1,
    session_id: "s-1",
    updated_at: "2026-09-12T10:00:00.000Z",
    project_path: projectRoot,
    events: [
      { k: "tool", n: "Bash", c: "npm test" },
      { k: "user", t: "No, never edit the generated client by hand" },
      { k: "tool", n: "Bash", c: "npm test" },
      { k: "tool", n: "Bash", c: "npm test" }
    ]
  }, null, 2));

  const dry = await registry.handlers.get("propose_instincts")({ project_path: projectRoot, dry_run: true });
  assert.equal(dry.status, "proposed");
  assert.equal(dry.session_id, "s-1");
  assert.equal(dry.signals.tool_calls, 3);
  assert.ok(dry.proposals.length >= 2);
  assert.equal((await instinctStore.list({ projectId: "project-test", includeRetired: true })).length, 0, "a dry run stores nothing");

  const proposed = await registry.handlers.get("propose_instincts")({ project_path: projectRoot });
  assert.equal(proposed.status, "proposed");
  for (const item of proposed.proposals) assert.equal(item.status, "proposed");
  assert.match(proposed.next_step, /list_instincts\(status: "proposed"\)/);

  // Proposals are memory, not behaviour: they are listed only when asked for,
  // and never injected into a context pack.
  assert.equal((await registry.handlers.get("list_instincts")({ project_path: projectRoot })).count, 0);
  const review = await registry.handlers.get("list_instincts")({ project_path: projectRoot, status: "proposed" });
  assert.equal(review.count, proposed.proposals.length);
  const injected = await instinctStore.rankForContext({ projectId: "project-test", threshold: 0 });
  assert.equal(injected.instincts.length, 0);

  // Confirming one is what makes it a behaviour; the rest can be retired.
  const confirmed = await registry.handlers.get("update_instinct")({ id: proposed.proposals[0].id, action: "confirm" });
  assert.equal(confirmed.instinct.status, "active");
  assert.equal((await registry.handlers.get("list_instincts")({ project_path: projectRoot })).count, 1);

  // A second run over the same log proposes nothing new rather than inflating
  // the confidence of what it already said.
  const again = await registry.handlers.get("propose_instincts")({ project_path: projectRoot });
  assert.equal(again.status, "nothing_new");
  assert.deepEqual(again.proposals, []);
  assert.ok(again.skipped.length >= 2);
  assert.match(again.skipped[0].reason, /already recorded as/);
});
