import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createExtensionTools } from "../tool-extensions.mjs";
import { createLifecycleTools } from "./lifecycle.mjs";

/**
 * A host that is entirely a recorder: every service answers from the fixture and
 * every call is captured, so the arc runs without a repository, a task store on
 * disk, or any of the four sibling tools it drives.
 */
function createFixture(overrides = {}) {
  const calls = [];
  const record = () => ({
    id: "task-1",
    task: "Implement the endpoint",
    status: "active",
    risk: "medium",
    project: { name: "Atlas", path: "/repo/atlas", types: ["backend"] },
    acceptance_criteria: [{ id: "AC-1", text: "Automated checks pass." }],
    skills: [],
    verifications: [],
    checkpoints: [],
    context: {},
    ...overrides.record
  });
  const host = {
    taskStateRoot: "/state",
    archifyReceiptsRoot: "/state/archify/receipts",
    taskStore: {
      begin: async (args) => { calls.push(["begin", args]); return { ...record(), ...args }; },
      read: async (id) => { calls.push(["read", id]); return record(); },
      checkpoint: async (id, args) => { calls.push(["checkpoint", id, args]); return record(); },
      addVerification: async (id, verification) => {
        calls.push(["addVerification", id, verification]);
        return { ...record(), verifications: [verification] };
      },
      complete: async (id, args) => {
        calls.push(["complete", id, args]);
        return { ...record(), status: "complete", completion: { at: "2026-01-01T00:00:00.000Z", summary: args.summary, verification_ids: ["verification-1"] } };
      }
    },
    skillOutcomeStore: {
      recordVerification: async (args) => { calls.push(["outcomeVerification", args]); return { recorded: true }; },
      recordCompletion: async (args) => { calls.push(["outcomeCompletion", args]); return { recorded: true }; }
    },
    resolveProjectIdentity: async (value) => ({
      project_root: "/repo/atlas", project_id: "project-1", repository_id: "repo-1",
      canonical_path: "/repo/atlas", aliases: ["/repo/atlas"], requested: value
    }),
    detectProject: async () => ({ project_name: "Atlas", stack: ["Node.js"], project_types: ["backend"], components: [], architecture: {} }),
    captureProjectState: async () => ({ git: { branch: "main" }, ...overrides.projectState }),
    readProjectTextIfExists: async (_root, relative) => overrides.projectText?.[relative] ?? "",
    readFrontendProductState: async () => overrides.frontendProductState ?? null,
    frontendProductDocumentHashes: async () => ({}),
    frontendReviewArtifactsCurrent: async () => ({ current: true, artifacts: [] }),
    findProjectCard: async () => ({ name: "Atlas" }),
    updateProjectCard: async (args) => { calls.push(["updateProjectCard", args]); return { updated: true }; },
    syncProjectCard: async (args) => { calls.push(["syncProjectCard", args]); return { synced: true }; },
    writeKnowledgeNote: async (args) => { calls.push(["writeKnowledgeNote", args]); return { action: "created", path: args.path }; },
    archifyProjectPath: (_root, value, field) => {
      if (!value) throw new Error(`${field} is required.`);
      // The receipt validator hashes the artifact, so the fixture points every
      // path at a file that really exists. The receipt behind it never does.
      return fileURLToPath(import.meta.url);
    },
    recommendSkills: async (args) => { calls.push(["recommendSkills", args]); return [{ name: "feature-builder", routing_role: "primary" }]; },
    runQualityGate: async (args) => {
      calls.push(["runQualityGate", args]);
      if (overrides.qualityGateThrows) throw new Error("Quality gate file not found.");
      return { status: overrides.qualityStatus ?? "passed" };
    },
    runSecurityScan: async (args) => {
      calls.push(["runSecurityScan", args]);
      return {
        status: overrides.securityStatus ?? "pass",
        summary: { checked: 0, skipped: 6, failed: 0, findings: 0, blocking: 0 },
        scanners: [],
        findings: [],
        markdown: "# Security scan: pass\n",
        next_step: "…"
      };
    },
    runFrontendQa: async (args) => {
      calls.push(["runFrontendQa", args]);
      if (overrides.frontendQaThrows) throw new Error("Frontend QA runner not found.");
      return { gate: "pass" };
    },
    preparePullRequest: async (args) => {
      calls.push(["preparePullRequest", args]);
      if (overrides.pullRequestThrows) throw new Error("No branch to describe.");
      return {
        path: ".ai-dev/pr/task-1.md", title: "feat: implement the endpoint", base_ref: "main",
        branch: "main", template: { path: ".github/pull_request_template.md" },
        outstanding: [], commands: ["git push -u origin main"]
      };
    },
    ...overrides.host
  };
  return { host, calls, registry: createExtensionTools(host, [createLifecycleTools]) };
}

const call = (registry, name, args) => registry.handlers.get(name)(args);

test("the extension exposes the four lifecycle tools, none of them read-only", () => {
  const { registry } = createFixture();
  assert.deepEqual(registry.definitions.map((item) => item.name),
    ["begin_task", "checkpoint_task", "verify_task", "complete_task"]);
  assert.deepEqual(registry.readOnly, []);
  for (const definition of registry.definitions) assert.equal(definition.inputSchema.type, "object");
  assert.deepEqual(registry.definitions[0].inputSchema.required, ["project_path", "task"]);
});

test("begin_task routes at most three skills and compiles a bounded context pack", async () => {
  const { registry, calls } = createFixture();
  const begun = await call(registry, "begin_task", { project_path: "/repo/atlas", task: "Implement the endpoint" });
  const [, routed] = calls.find(([name]) => name === "recommendSkills");
  assert.deepEqual(routed, { task: "Implement the endpoint", project_path: "/repo/atlas", limit: 3, membrane_policy: "exclude" });

  const [, begin] = calls.find(([name]) => name === "begin");
  assert.equal(begin.context.bounded, true);
  assert.ok(begin.context.context_pack_id);
  assert.equal(begin.context.project_brief_path, ".ai-dev/project-brief.md");
  assert.equal(begin.project.project_id, "project-1");
  assert.equal(begin.project.canonical_project_path, "/repo/atlas");
  assert.equal(begun.next_actions.length, 4);
  assert.match(begun.next_actions[0], /Confirm or refine acceptance criteria/);
});

test("checkpoint_task lints the report before it writes anything", async () => {
  const { registry, calls } = createFixture();
  const checkpointed = await call(registry, "checkpoint_task", {
    task_id: "task-1", summary: "Endpoint implemented and covered.", changed_files: ["api.mjs"]
  });
  assert.equal(checkpointed.completion_claims.status, "ok");
  assert.ok(calls.some(([name]) => name === "checkpoint"));

  const { registry: refused, calls: refusedCalls } = createFixture();
  await assert.rejects(
    () => call(refused, "checkpoint_task", {
      task_id: "task-1", summary: "Done.", notes: "Tests are failing but I'll fix them later."
    }),
    /tests_failing_deferred/
  );
  assert.equal(refusedCalls.some(([name]) => name === "checkpoint"), false);
});

test("a checkpoint on a plan-required task with no plan carries the warning", async () => {
  const { registry } = createFixture({
    record: { plan_policy: { plan_required: true, complexity: "large" }, plan: null }
  });
  const warned = await call(registry, "checkpoint_task", {
    task_id: "task-1", summary: "Refactor across the service.", changed_files: ["a.mjs"]
  });
  assert.match(warned.plan_warning, /requires a recorded plan\. Call plan_task/);

  // No changed files means no broad implementation to warn about yet.
  const quiet = await call(createFixture({
    record: { plan_policy: { plan_required: true, complexity: "large" }, plan: null }
  }).registry, "checkpoint_task", { task_id: "task-1", summary: "Nothing touched yet." });
  assert.equal("plan_warning" in quiet, false);
});

test("verify_task runs the gate and hygiene, and a passing run meets its criterion", async () => {
  const { registry, calls } = createFixture();
  const verified = await call(registry, "verify_task", { task_id: "task-1" });
  const [, gate] = calls.find(([name]) => name === "runQualityGate");
  assert.deepEqual(gate, { project_path: "/repo/atlas", labels: [], dry_run: false, update_registry: false, register_if_missing: false });
  assert.deepEqual(verified.verification.checks.map((item) => item.type), ["quality_gate", "change_hygiene", "security_scan"]);
  assert.equal(verified.verification.passed, true);
  // The scanners run next to hygiene, and a run where none of them could run is
  // a pass with `checked: 0` rather than a failure nobody can act on.
  assert.deepEqual(calls.find(([name]) => name === "runSecurityScan")[1], { project_path: "/repo/atlas", scanners: undefined });
  const securityCheck = verified.verification.checks.at(-1).result;
  assert.equal(securityCheck.summary.checked, 0);
  assert.equal("markdown" in securityCheck, false, "the report text stays out of the task record");
  assert.match(verified.verification.id, /^verification-\d+-[0-9a-f]{8}$/);
  assert.equal(verified.skill_outcomes.recorded, true);
  const [, , criteria] = calls.find(([name]) => name === "checkpoint");
  assert.deepEqual(criteria.criteria, [{ id: "AC-1", status: "met", evidence: [verified.verification.id] }]);
});

test("an epic cannot close while a child is open, or while a child record is gone", async () => {
  const { registry, host, calls } = createFixture({ record: { epic: { children: ["task-child-1", "task-child-2"] } } });
  const parentRead = host.taskStore.read;
  const children = new Map([
    ["task-child-1", { id: "task-child-1", task: "Extract the parser", status: "complete" }],
    ["task-child-2", { id: "task-child-2", task: "Wire it into the router", status: "active" }]
  ]);
  host.taskStore.read = async (id) => (children.has(id) ? children.get(id) : parentRead(id));

  await assert.rejects(
    () => call(registry, "complete_task", { task_id: "task-1", summary: "Router split into modules." }),
    /1 unfinished child task[\s\S]*task-child-2 \(active\): Wire it into the router/
  );
  assert.equal(calls.some(([name]) => name === "complete"), false, "nothing was written");

  // A child whose record is gone is the same refusal: the evidence is missing.
  host.taskStore.read = async (id) => {
    if (id === "task-child-1") return { id, task: "Extract the parser", status: "complete" };
    if (id === "task-child-2") throw new Error("Unknown task: task-child-2");
    return parentRead(id);
  };
  await assert.rejects(
    () => call(registry, "complete_task", { task_id: "task-1", summary: "Router split into modules." }),
    /task-child-2: the child task record is gone/
  );

  // Every child complete, and the parent closes like any other task.
  host.taskStore.read = async (id) => (
    id.startsWith("task-child") ? { id, task: "child", status: "complete" } : parentRead(id)
  );
  const completed = await call(registry, "complete_task", { task_id: "task-1", summary: "Router split into modules." });
  assert.equal(completed.task.status, "complete");
});

test("coverage_min adds a check, and no report means the floor is unproven", async () => {
  const { registry } = createFixture();
  const without = await call(registry, "verify_task", { task_id: "task-1" });
  assert.equal(without.verification.checks.some((item) => item.type === "coverage"), false,
    "no floor was asked for, so none is checked");

  const asked = await call(createFixture().registry, "verify_task", { task_id: "task-1", coverage_min: 80 });
  const coverage = asked.verification.checks.find((item) => item.type === "coverage");
  assert.equal(coverage.result.status, "no_report");
  assert.equal(coverage.result.minimum, 80);
  assert.match(coverage.result.error, /Run the project's test command with coverage enabled/);
  assert.equal(asked.verification.passed, false);
});

test("an unavailable runner becomes a failing check rather than an exception", async () => {
  const { registry } = createFixture({ qualityGateThrows: true });
  const verified = await call(registry, "verify_task", { task_id: "task-1", run_hygiene: false });
  assert.deepEqual(verified.verification.checks[0].result, {
    status: "unavailable", error: "Quality gate file not found."
  });
  assert.equal(verified.verification.passed, false);
});

test("a non-frontend project asked for frontend QA is refused by shape, without running it", async () => {
  const { registry, calls } = createFixture();
  const verified = await call(registry, "verify_task", {
    task_id: "task-1", run_quality: false, run_hygiene: false, run_frontend: true
  });
  assert.deepEqual(verified.verification.checks[0].result, {
    gate: "block", status: "not_frontend", error: "Task project is not detected as frontend."
  });
  assert.equal(calls.some(([name]) => name === "runFrontendQa"), false);
});

test("a frontend project runs Frontend QA with the registry left alone", async () => {
  const { registry, calls } = createFixture({ record: { project: { name: "Web", path: "/repo/web", types: ["frontend"] } } });
  await call(registry, "verify_task", {
    task_id: "task-1", run_quality: false, run_hygiene: false, run_frontend: true,
    frontend_options: { routes: ["/"] }
  });
  const [, qa] = calls.find(([name]) => name === "runFrontendQa");
  assert.deepEqual(qa, {
    routes: ["/"], project_path: "/repo/atlas", project_name: "Web",
    update_registry: false, register_if_missing: false
  });
});

test("a visual task on a frontend project without product state is blocked", async () => {
  const { registry } = createFixture({
    record: {
      task: "Redesign the dashboard UI from a design system reference",
      project: { name: "Web", path: "/repo/web", types: ["frontend"] }
    }
  });
  const verified = await call(registry, "verify_task", { task_id: "task-1", run_quality: false, run_hygiene: false });
  const product = verified.verification.checks.find((item) => item.type === "frontend_product");
  assert.deepEqual(product.result, {
    ok: false, gate: "handoff",
    blockers: ["Frontend Product Quality v2 is not prepared for this visual task."]
  });
});

test("a non-visual task on a frontend project is not held to the product gate", async () => {
  const { registry } = createFixture({ record: { project: { name: "Web", path: "/repo/web", types: ["frontend"] } } });
  const verified = await call(registry, "verify_task", { task_id: "task-1", run_quality: false, run_hygiene: false });
  assert.equal(verified.verification.checks.some((item) => item.type === "frontend_product"), false);
});

test("Archify evidence is validated against the receipt store, and bad evidence is refused", async () => {
  const { registry } = createFixture();
  await assert.rejects(
    () => call(registry, "verify_task", { task_id: "task-1", evidence: "nope" }),
    /evidence must be an array\./
  );
  await assert.rejects(
    () => call(registry, "verify_task", { task_id: "task-1", evidence: [{ kind: "archify_deliver" }] }),
    /html_path is required\./
  );
  const verified = await call(registry, "verify_task", {
    task_id: "task-1", run_quality: false, run_hygiene: false,
    evidence: [{ kind: "archify_deliver", html_path: "diagram.html", artifact_sha256: "0".repeat(64) }]
  });
  assert.equal(verified.verification.checks[0].type, "archify_deliver");
  assert.equal(verified.verification.checks[0].result.ok, false);
});

test("a completed task cannot be verified again", async () => {
  const { registry, calls } = createFixture({ record: { status: "complete" } });
  await assert.rejects(
    () => call(registry, "verify_task", { task_id: "task-1" }),
    /Completed task cannot be verified again\./
  );
  assert.equal(calls.some(([name]) => name === "runQualityGate"), false);
});

test("complete_task writes the note, prepares the pull request and says what is left", async () => {
  const { registry, calls } = createFixture();
  const completed = await call(registry, "complete_task", { task_id: "task-1", summary: "Shipped." });
  const [, note] = calls.find(([name]) => name === "writeKnowledgeNote");
  assert.equal(note.path, "02-knowledge/Task Runs/task-1.md");
  assert.equal(note.overwrite, true);
  assert.match(note.content, /# Implement the endpoint/);
  assert.equal(completed.pull_request.path, ".ai-dev/pr/task-1.md");
  assert.equal(completed.pull_request.template, ".github/pull_request_template.md");
  assert.match(completed.next_step, /prepared in \.ai-dev\/pr\/task-1\.md/);
  assert.equal(completed.completion_claims.status, "ok");
  assert.equal(completed.skill_outcomes.recorded, true);
});

test("a project outside git gets no pull request and no advice about one", async () => {
  const { registry, calls } = createFixture({ projectState: { git: null } });
  const completed = await call(registry, "complete_task", { task_id: "task-1", summary: "Shipped." });
  assert.equal("pull_request" in completed, false);
  assert.equal("next_step" in completed, false);
  assert.equal(calls.some(([name]) => name === "preparePullRequest"), false);
});

test("a failed pull request preparation is reported, not thrown", async () => {
  const { registry } = createFixture({ pullRequestThrows: true });
  const completed = await call(registry, "complete_task", { task_id: "task-1", summary: "Shipped." });
  assert.deepEqual(completed.pull_request, { path: "", error: "No branch to describe." });
  assert.match(completed.next_step, /^Call prepare_pull_request/);
});

test("write_report: false skips the note; prepare_pull_request: false skips the description", async () => {
  const { registry, calls } = createFixture();
  const completed = await call(registry, "complete_task", {
    task_id: "task-1", summary: "Shipped.", write_report: false, prepare_pull_request: false
  });
  assert.equal(completed.report, null);
  assert.equal(calls.some(([name]) => name === "writeKnowledgeNote"), false);
  assert.equal(calls.some(([name]) => name === "preparePullRequest"), false);
  assert.match(completed.next_step, /^Call prepare_pull_request/);
});

test("a task in a live worktree is told to merge it, and a removed one is not", async () => {
  const live = await call(createFixture({
    record: { context: { worktree: { branch: "task/isolated" } } }
  }).registry, "complete_task", { task_id: "task-1", summary: "Shipped." });
  assert.deepEqual(live.worktree, { branch: "task/isolated" });
  assert.match(live.next_step, /Merge or open a PR from task\/isolated/);

  const removed = await call(createFixture({
    record: { context: { worktree: { branch: "task/isolated", removed_at: "2026-01-02T00:00:00.000Z" } } }
  }).registry, "complete_task", { task_id: "task-1", summary: "Shipped." });
  assert.equal("worktree" in removed, false);
  assert.equal(/remove_task_worktree/.test(removed.next_step), false);
});

test("supplied evidence is verified before the task is completed", async () => {
  const { registry, calls } = createFixture();
  await call(registry, "complete_task", {
    task_id: "task-1", summary: "Shipped.",
    evidence: [{ kind: "archify_deliver", html_path: "diagram.html", artifact_sha256: "0".repeat(64) }]
  });
  assert.ok(calls.some(([name]) => name === "addVerification"), "no verification ran before completion");
  // Neither runner is asked for: the pre-completion run only checks the evidence.
  assert.equal(calls.some(([name]) => name === "runQualityGate"), false);
  assert.equal(calls.some(([name]) => name === "runFrontendQa"), false);
});

test("a rationalized completion summary is refused before the task is closed", async () => {
  const { registry, calls } = createFixture();
  await assert.rejects(
    () => call(registry, "complete_task", { task_id: "task-1", summary: "Done, tests are failing but I'll fix them later." }),
    /claims more than the evidence shows/
  );
  assert.equal(calls.some(([name]) => name === "complete"), false);
});

test("an Archify delivery is written onto the project card", async () => {
  const { registry, calls } = createFixture();
  await call(registry, "verify_task", {
    task_id: "task-1", run_quality: false, run_hygiene: false,
    evidence: [{ kind: "archify_deliver", html_path: "diagram.html", artifact_sha256: "0".repeat(64) }]
  });
  const [, update] = calls.find(([name]) => name === "updateProjectCard");
  assert.equal(update.section, "Archify Diagram Deliveries");
  assert.equal(update.mode, "replace");
  assert.equal(update.update_index, false);
  assert.ok(calls.some(([name]) => name === "syncProjectCard"));
});


test("a blocking security finding fails verification, and the scan can be turned off", async () => {
  const { registry, calls } = createFixture({ securityStatus: "block" });
  const blocked = await call(registry, "verify_task", { task_id: "task-1" });
  assert.equal(blocked.verification.passed, false);
  assert.equal(blocked.verification.checks.at(-1).result.status, "block");

  const without = await call(createFixture().registry, "verify_task", { task_id: "task-1", run_security_scan: false });
  assert.deepEqual(without.verification.checks.map((item) => item.type), ["quality_gate", "change_hygiene"]);
  assert.equal(without.verification.passed, true);

  const named = createFixture();
  await call(named.registry, "verify_task", { task_id: "task-1", security_scanners: ["gitleaks"] });
  assert.deepEqual(named.calls.find(([name]) => name === "runSecurityScan")[1], { project_path: "/repo/atlas", scanners: ["gitleaks"] });
  assert.ok(calls.length > 0);
});
