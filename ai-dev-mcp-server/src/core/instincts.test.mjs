import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  InstinctStore,
  effectiveConfidence,
  initialConfidence,
  instinctId,
  renderInstinctSkillDraft,
  renderInstinctsMarkdown
} from "./instincts.mjs";

test("instinct ids, initial confidence, and decay follow the ECC scale", () => {
  assert.equal(instinctId("when writing new functions", "Use functional patterns over classes"), "writing-new-functions-use-functional-patterns-over-classes");
  assert.equal(initialConfidence(1), 0.3);
  assert.equal(initialConfidence(4), 0.5);
  assert.equal(initialConfidence(7), 0.7);
  assert.equal(initialConfidence(12), 0.85);
  assert.equal(effectiveConfidence({ confidence: 0.7, last_observed_at: "2026-01-01T00:00:00.000Z" }, "2026-01-29T00:00:00.000Z"), 0.62);
  assert.equal(effectiveConfidence({ confidence: 0.35, last_observed_at: "2026-01-01T00:00:00.000Z" }, "2026-12-01T00:00:00.000Z"), 0.3, "decay floor");
  assert.equal(effectiveConfidence({ confidence: 0.25, last_observed_at: "2026-01-01T00:00:00.000Z" }, "2026-12-01T00:00:00.000Z"), 0.25, "never raised by the floor");
});

test("store records, merges similar observations, adjusts, ranks, promotes, and clusters", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "instincts-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new InstinctStore({ stateRoot: root });
  await assert.rejects(store.record({ trigger: "x", action: "" }), /trigger and action are required/);
  await assert.rejects(store.record({ trigger: "x", action: "y" }), /projectId is required/);

  const first = await store.record({ trigger: "when editing React components", action: "Use hooks instead of class components", domain: "code-style", projectId: "project-a", projectName: "app", stack: ["React"], note: "user corrected class component", now: "2026-01-01T00:00:00.000Z" });
  assert.equal(first.created, true);
  assert.equal(first.instinct.confidence, 0.3);
  const merged = await store.record({ trigger: "when editing react components", action: "use hooks instead of class components!", domain: "code-style", projectId: "project-a", now: "2026-01-02T00:00:00.000Z" });
  assert.equal(merged.created, false);
  assert.equal(merged.instinct.observations, 2);
  assert.equal(merged.instinct.confidence, 0.35);
  const third = await store.record({ trigger: "when editing React components", action: "Use hooks instead of class components", projectId: "project-a", observations: 4, now: "2026-01-03T00:00:00.000Z" });
  assert.equal(third.instinct.observations, 6);
  assert.equal(third.instinct.confidence, 0.7, "jumps to the scale value for 6 observations");

  await store.record({ trigger: "when handling user input", action: "Validate at the boundary with a schema", domain: "security", scope: "global", confidence: 0.8, now: "2026-01-03T00:00:00.000Z" });
  await store.record({ trigger: "when a test fails", action: "Read the assertion before touching code", domain: "debugging", projectId: "project-b", confidence: 0.9, now: "2026-01-03T00:00:00.000Z" });

  const visible = await store.list({ projectId: "project-a", now: "2026-01-03T00:00:00.000Z" });
  assert.deepEqual(visible.map((item) => item.scope), ["global", "project"]);
  const ranked = await store.rankForContext({ projectId: "project-a", stack: ["React", "TypeScript"], task: "Refactor the checkout React components", now: "2026-01-03T00:00:00.000Z" });
  assert.equal(ranked.instincts[0].id, first.instinct.id, "project + stack + task boosts win over a global 0.8");
  assert.match(ranked.markdown, /^Active instincts/);
  assert.match(ranked.markdown, /\[project 70%\] Use hooks instead of class components \(when editing React components\)/);

  const confirmed = await store.adjust(first.instinct.id, "confirm", { note: "helped" });
  assert.equal(confirmed.confidence, 0.75);
  let contradicted = await store.adjust(first.instinct.id, "contradict", { note: "user wanted a class here" });
  assert.equal(contradicted.confidence, 0.65);
  for (let index = 0; index < 5; index += 1) contradicted = await store.adjust(first.instinct.id, "contradict");
  assert.equal(contradicted.status, "retired");
  assert.equal((await store.list({ projectId: "project-a" })).some((item) => item.id === first.instinct.id), false);
  assert.equal((await store.list({ projectId: "project-a", includeRetired: true })).some((item) => item.id === first.instinct.id), true);
  await assert.rejects(store.adjust("nope", "confirm"), /Unknown instinct/);
  await assert.rejects(store.adjust(first.instinct.id, "explode"), /Unknown adjustment/);

  await store.record({ trigger: "when a test fails", action: "Read the assertion before touching code", domain: "debugging", projectId: "project-c", confidence: 0.85, now: "2026-01-04T00:00:00.000Z" });
  const candidates = await store.promotionCandidates();
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].projects, 2);
  const promoted = await store.adjust(candidates[0].id, "promote");
  assert.equal(promoted.scope, "global");
  await assert.rejects(store.adjust(candidates[0].id, "promote"), /already global/);

  for (const [trigger, action] of [["when writing tests", "Use table-driven cases"], ["when a test is flaky", "Pin the reproduction rate first"], ["when adding a regression test", "Name it by behavior"]]) {
    await store.record({ trigger, action, domain: "testing", projectId: "project-a", confidence: 0.75, now: "2026-01-05T00:00:00.000Z" });
  }
  const clusters = await store.clusters({ projectId: "project-a", minSize: 3 });
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].domain, "testing");
  assert.match(clusters[0].skill_name, /^learned-testing-project/);
  const draft = renderInstinctSkillDraft(clusters[0], { projectName: "Shop" });
  assert.match(draft.markdown, /^---\nname: learned-testing-project[a-z0-9-]*\ndescription: "Use when working on testing tasks in the Shop project/);
  assert.match(draft.markdown, /## Workflow\n\n1\. When /);
  assert.match(draft.markdown, /\d\. When writing tests: Use table-driven cases \(confidence 75%/);
  assert.match(draft.markdown, /## Guardrails/);
  await store.markPromoted(clusters[0].instincts.map((item) => item.id), { skill: draft.name });
  assert.equal((await store.list({ projectId: "project-a", domain: "testing" })).length, 0, "promoted instincts leave the active list");

  const exported = await store.exportInstincts({ scope: "global", minConfidence: 0.5, now: "2026-01-06T00:00:00.000Z" });
  assert.ok(exported.instincts.length >= 2);
  assert.equal(exported.instincts[0].evidence, undefined);
  const other = new InstinctStore({ stateRoot: path.join(root, "other") });
  const imported = await other.importInstincts(exported.instincts, { scope: "global" });
  assert.equal(imported.length, exported.instincts.length);
  assert.ok(imported.every((item) => item.instinct.confidence <= 0.7), "imports are capped at 0.7");
  assert.equal(renderInstinctsMarkdown([]), "");
});

test("instincts are scoped by repository, so a worktree and its main checkout learn from each other", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "instincts-worktree-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new InstinctStore({ stateRoot: root });
  const checkout = { repositoryId: "repository-1", projectId: "project-checkout" };
  const worktree = { repositoryId: "repository-1", projectId: "project-worktree" };

  const recorded = await store.record({
    ...worktree,
    projectName: "app",
    trigger: "when a migration fails",
    action: "Re-run it against a scratch database first",
    domain: "debugging",
    confidence: 0.8,
    now: "2026-01-01T00:00:00.000Z"
  });
  assert.equal(recorded.instinct.repository_id, "repository-1");
  assert.deepEqual((await store.list(checkout)).map((item) => item.id), [recorded.instinct.id], "visible from the main checkout");
  const ranked = await store.rankForContext({ ...checkout, task: "Fix the failed migration", now: "2026-01-01T12:00:00.000Z" });
  assert.equal(ranked.instincts[0].id, recorded.instinct.id);

  // The same observation from the main checkout reinforces it instead of forking a copy.
  const again = await store.record({ ...checkout, trigger: "when a migration fails", action: "Re-run it against a scratch database first", now: "2026-01-02T00:00:00.000Z" });
  assert.equal(again.created, false);
  assert.equal((await store.list(worktree)).length, 1);
  assert.equal((await store.list({ repositoryId: "repository-2", projectId: "project-other" })).length, 0, "another clone keeps its own memory");
});

test("instincts written under the old project key are read, then adopted by the first repository write", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "instincts-migration-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new InstinctStore({ stateRoot: root });

  const legacy = await store.record({ projectId: "project-legacy", trigger: "when touching the parser", action: "Add a fixture first", domain: "testing", confidence: 0.75, now: "2026-01-01T00:00:00.000Z" });
  assert.equal(legacy.instinct.repository_id, "", "outside a clone the project id stays the only key");

  const scope = { repositoryId: "repository-1", projectId: "project-legacy" };
  const store2 = new InstinctStore({ stateRoot: root });
  assert.deepEqual((await store2.list(scope)).map((item) => item.id), [legacy.instinct.id], "reading falls back to the project key");

  await store2.record({ ...scope, trigger: "when releasing", action: "Tag after the gate passes", domain: "workflow", confidence: 0.75, now: "2026-01-02T00:00:00.000Z" });
  const stored = JSON.parse(await fs.readFile(path.join(root, "instincts.json"), "utf8"));
  assert.equal(stored.instincts.find((item) => item.id === legacy.instinct.id).repository_id, "repository-1", "the first repository write adopts it");
  // A worktree of the same clone now sees the migrated instinct too.
  assert.equal((await store2.list({ repositoryId: "repository-1", projectId: "project-worktree" })).length, 2);
});
