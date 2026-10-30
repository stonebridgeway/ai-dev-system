import assert from "node:assert/strict";
import test from "node:test";
import {
  RESPONSE_MODE_ENV,
  answerMeasures,
  beginTaskView,
  checkpointView,
  clip,
  completeView,
  shrink,
  skillGroupsView,
  skillRow,
  verifyView,
  wantsDetails
} from "./response-budget.mjs";

const record = {
  schema_version: 1,
  id: "task-1",
  status: "active",
  task: "Add authentication to the API",
  risk: "medium",
  project: { id: "project-1", name: "billing-api", path: "/repo/billing-api", components: [{ name: "billing-api" }] },
  plan_policy: { plan_required: false },
  acceptance_criteria: [{ id: "AC-1", text: "Requests without a token are refused", status: "pending" }],
  skills: [{ name: "feature-builder", source: "core", categories: ["a", "b"], use_when: "x".repeat(400), reason: "routed", routing_role: "primary", path: "sources/core/feature-builder/SKILL.md" }],
  context: { compiled_context: "- Stack: Node.js", selected_files: [{ path: "src/server.mjs", score: 5, reasons: ["name match"], sha256: "abc" }], components: [{ name: "c" }], project_identity: { id: "x" } },
  baseline: { head: "abc", dirty_files: [] },
  checkpoints: [{ at: "t1", summary: "first" }, { at: "t2", summary: "second" }],
  verifications: [{ id: "verification-1", passed: false, at: "t3", checks: [{ type: "quality_gate", result: { stdout: "x".repeat(9000) } }] }],
  snapshots: Array.from({ length: 7 }, (_, index) => ({ snapshot_id: `snapshot-${index + 1}`, turn: index + 1, trigger: "checkpoint", label: "turn", commit: `c${index}`, ref: `refs/ai-dev/snapshots/task-1/${index + 1}` })),
  next_actions: ["Checkpoint, then verify."]
};

test("the whole record is asked for by the call or by the environment, nothing else", () => {
  assert.equal(wantsDetails({}, {}), false);
  assert.equal(wantsDetails({ include_details: true }, {}), true);
  assert.equal(wantsDetails({ include_details: "yes" }, {}), false, "only the boolean, as the schema says");
  assert.equal(wantsDetails({}, { [RESPONSE_MODE_ENV]: " Full " }), true);
  assert.equal(wantsDetails({}, { [RESPONSE_MODE_ENV]: "summary" }), false);
});

test("a long output keeps its head and its tail, and says how much was cut", () => {
  assert.equal(clip("short"), "short");
  const long = `${"a".repeat(3000)}${"z".repeat(3000)}`;
  const clipped = clip(long, { head: 100, tail: 50 });
  assert.ok(clipped.startsWith("a".repeat(100)) && clipped.endsWith("z".repeat(50)));
  assert.match(clipped, /… 5850 characters cut; include_details: true returns all of it …/);
});

test("begin_task keeps the context pack, the criteria and lean skills, and leaves the rest to get_task", () => {
  const view = beginTaskView({ ...record, plan_warning: "This task requires a recorded plan." });
  assert.equal(view.id, "task-1");
  assert.equal(view.context.compiled_context, "- Stack: Node.js");
  assert.deepEqual(view.context.selected_files, [{ path: "src/server.mjs", score: 5, reasons: ["name match"] }]);
  assert.equal("project_identity" in view.context, false);
  assert.equal("components" in view.context, false);
  assert.deepEqual(view.project, { name: "billing-api", path: "/repo/billing-api" });
  assert.equal(view.skills[0].name, "feature-builder");
  assert.equal(view.skills[0].routing_role, "primary");
  assert.ok(view.skills[0].use_when.length <= 200);
  assert.equal("categories" in view.skills[0], false);
  assert.equal(view.plan_warning, "This task requires a recorded plan.", "what the tool put beside the record stays");
  for (const key of ["baseline", "verifications", "checkpoints", "snapshots"]) assert.equal(key in view, false, key);
  assert.match(view.details, /get_task/);
});

test("checkpoint_task answers the checkpoint, the snapshot, the criteria and what the tool added", () => {
  const view = checkpointView({ ...record, snapshot: { status: "created", snapshot_id: "snapshot-7" }, completion_claims: { status: "ok" } });
  assert.deepEqual(view.checkpoint, { at: "t2", summary: "second" });
  assert.equal(view.checkpoints, 2);
  assert.equal(view.snapshot.snapshot_id, "snapshot-7");
  assert.equal(view.completion_claims.status, "ok");
  assert.equal(view.snapshots.length, 5, "the latest five turns rollback_task can return to");
  assert.equal(view.snapshots.at(-1).ref, "refs/ai-dev/snapshots/task-1/7");
  assert.equal(view.snapshot_count, 7);
  assert.deepEqual(view.verification, { id: "verification-1", passed: false, at: "t3" });
  for (const key of ["context", "skills", "verifications", "baseline"]) assert.equal(key in view, false, key);
});

test("verify_task keeps why a check failed: the failing command's output, clipped, and every error and hint", () => {
  const stdout = `TAP version 13\nnot ok 1 - a request with no token is rejected\n${"x".repeat(6000)}\n# tests 4\n# fail 1\n`;
  const view = verifyView({
    task: record,
    verification: {
      id: "verification-2",
      passed: false,
      checks: [
        { type: "quality_gate", result: { status: "failed", parsed_commands: ["a"], selected_commands: ["a"], safety: {}, results: [
          { label: "Tests", command: "node --test", status: "failed", exit_code: 1, stdout },
          { label: "Lint", command: "npm run lint", status: "passed", exit_code: 0, stdout: "all good".repeat(500) }
        ] } },
        { type: "quality_gate", result: { status: "unavailable", error: "Quality gate file not found.", hint: "prepare_project writes one." } },
        { type: "security_scan", result: { status: "unchecked", summary: "no scanner ran", scanners: [{ id: "npm_audit", status: "skipped", reason: "no lockfile", duration_ms: 3 }] } }
      ],
      evidence: { status: "failed", source_head: "abc", source_state_fingerprint: "f" }
    },
    current_project_state: { head: "abc", branch: "main", dirty: true, dirty_files: ["a"], status_hash: "h", content_hash: "c" }
  });
  const [gate, missing, scan] = view.verification.checks;
  assert.equal("parsed_commands" in gate.result, false);
  const [failing, passing] = gate.result.results;
  assert.match(failing.stdout, /^TAP version 13\nnot ok 1/);
  assert.match(failing.stdout, /# tests 4\n# fail 1\n$/);
  assert.ok(failing.stdout.length < stdout.length);
  assert.equal("stdout" in passing, false, "a passing command's output says nothing its status does not");
  assert.deepEqual(missing.result, { status: "unavailable", error: "Quality gate file not found.", hint: "prepare_project writes one." });
  assert.deepEqual(scan.result.scanners, [{ id: "npm_audit", status: "skipped" }]);
  assert.deepEqual(view.current_project_state, { head: "abc", branch: "main", dirty: true, dirty_files: ["a"] });
  assert.equal(view.task.id, "task-1");
  assert.equal("verifications" in view.task, false);
});

test("complete_task answers the closed task, its pull request and the completion summary", () => {
  const view = completeView({
    task: { ...record, status: "complete", completion: { at: "t9", summary: "Done and verified.", project_state: { head: "abc" } } },
    pull_request: { path: ".ai-dev/pr/task-1.md", title: "feat: add authentication" },
    skill_outcomes: { recorded: 2, outcome: "success", summaries: { "feature-builder": {}, "auth-reviewer": {} } },
    next_step: "Push the branch."
  });
  assert.equal(view.task.status, "complete");
  assert.deepEqual(view.task.completion, { at: "t9", summary: "Done and verified." });
  assert.equal(view.pull_request.path, ".ai-dev/pr/task-1.md");
  assert.deepEqual(view.skill_outcomes, { recorded: 2, outcome: "success", skills: ["feature-builder", "auth-reviewer"] });
  assert.equal(view.next_step, "Push the branch.");
});

test("a skill row keeps what a person and an agent choose by; the groups keep five example names", () => {
  const row = skillRow({ name: "tdd-workflow", source: "external/ecc", description: "d".repeat(500), primary_group: "testing-quality", primary_group_label: "Testing & Quality", quality_score: 91, categories: ["x"], related_skills: ["y"], score: 3.2 });
  assert.deepEqual(Object.keys(row).sort(), ["description", "name", "primary_group", "primary_group_label", "quality_score", "score", "source"]);
  assert.ok(row.description.length <= 200);
  const repeated = skillRow({ name: "a", description: "Use it when a form needs tests.", use_when: "Use it when a form needs tests." });
  assert.equal("use_when" in repeated, false, "a use_when that repeats the description is said once");
  assert.equal(skillRow({ name: "b", description: "Forms.", use_when: "When a form needs tests." }).use_when, "When a form needs tests.");
  const groups = skillGroupsView({ total_skills: 2, groups: [{ id: "g", count: 2, examples: Array.from({ length: 20 }, (_, index) => ({ name: `s${index}`, path: "p" })) }] });
  assert.deepEqual(groups.groups[0].examples, ["s0", "s1", "s2", "s3", "s4"]);
  assert.equal(groups.total_skills, 2);
});

test("an unknown result is bounded: long strings clipped, long lists cut with a count", () => {
  const value = shrink({ notes: "n".repeat(5000), items: Array.from({ length: 25 }, (_, index) => index) });
  assert.ok(value.notes.length < 5000);
  assert.equal(value.items.length, 21);
  assert.equal(value.items.at(-1), "… 5 more; include_details: true returns all");
});

test("a call is measured by sizes and hashes, and the same arguments hash the same in any key order", () => {
  const first = answerMeasures({ b: 1, a: { d: 2, c: 3 } }, "answer");
  const second = answerMeasures({ a: { c: 3, d: 2 }, b: 1 }, "answer");
  assert.equal(first.argsHash, second.argsHash);
  assert.equal(first.resultHash, second.resultHash);
  assert.equal(first.bytesOut, 6);
  assert.equal(first.argsHash.length, 16);
  assert.notEqual(answerMeasures({}, "other").resultHash, first.resultHash);
});
