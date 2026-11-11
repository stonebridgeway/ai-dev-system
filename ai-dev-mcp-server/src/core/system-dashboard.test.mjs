import assert from "node:assert/strict";
import test from "node:test";
import {
  dashboardFreshness,
  dashboardSourceFingerprint,
  renderSystemDashboard
} from "./system-dashboard.mjs";

function snapshot() {
  return {
    generated_at: "2026-07-27T00:00:00.000Z",
    tools: { total: 79 },
    skills: { total: 3108, custom: 20, groups: 12, cards: 34, by_source: { custom: 20 } },
    quality: { important_structure_ready: 20, important_empirical_ready: 0, important_skills: 20, issues: 4 },
    projects: { total: 1, items: [{ id: "project-one", name: "One", stack: ["Node.js"], updated_at: "today" }] },
    search: { documents: 3000, dense_vectors: 200, pending_dense: 0, stale: false, eval_cases: 45, ranking_version: 2 },
    outcomes: { terminal: 3, attempts: 6 },
    pilots: { completed: 0, human_confirmed: 0 },
    overlays: { source_policies: 4, specific_overlays: 0, orphan_overlays: 0 },
    runtime: {
      server_ready: true,
      modular: true,
      main_lines: 10000,
      line_ceiling: 10500
    },
    checks: [
      { name: "vault_root", status: "ok", summary: "Vault root exists." },
      { name: "search_index_freshness", status: "warn", summary: "Search index is stale: 1 added, 0 changed, 0 deleted." },
      { name: "frontend_qa_environment", status: "skipped", summary: "Frontend QA is not set up: Chromium | Playwright\nmissing." },
      { name: "skill_registry", status: "fail", summary: "Skill registry is empty." }
    ]
  };
}

test("system dashboard is deterministic, generated, and freshness-bound", () => {
  const current = snapshot();
  current.source_fingerprint = dashboardSourceFingerprint(current);
  const markdown = renderSystemDashboard(current);
  assert.match(markdown, /79 tools/);
  assert.match(markdown, /2026-07-27T00:00:00.000Z; `system_health_check` runs them again now/);
  assert.equal(dashboardFreshness(current, current).fresh, true);
  const changed = snapshot();
  changed.tools.total = 80;
  assert.equal(dashboardFreshness(current, changed).fresh, false);
  // Writing the page changes the vault, so a check of the index's freshness
  // would turn it stale by being written: checks do not move the fingerprint.
  const rechecked = snapshot();
  rechecked.checks[1].status = "ok";
  assert.equal(dashboardFreshness(current, rechecked).fresh, true);
});

test("the runtime rows are the health checks as they ran, never a constant Ready", () => {
  const markdown = renderSystemDashboard(snapshot());
  const runtime = markdown.slice(markdown.indexOf("## Runtime"), markdown.indexOf("## Knowledge And Skills"));
  assert.match(runtime, /\| Vault root \| Ready \| Vault root exists\. \|/);
  assert.match(runtime, /\| Search index freshness \| Needs attention \| Search index is stale: 1 added/);
  assert.match(runtime, /\| Frontend QA environment \| Not set up \| Frontend QA is not set up: Chromium \\\| Playwright missing\. \|/);
  assert.match(runtime, /\| Skill registry \| Failing \| Skill registry is empty\. \|/);
  for (const constant of ["Static quality gate", "Coverage gate", "Security gate", "Archify diagrams", "Project Context Compiler", "Outcome Analytics v2", "Reference Factory v2", "Search Ranking v2"]) {
    assert.doesNotMatch(runtime, new RegExp(constant), constant);
  }
  // A table row per check: two fixed rows, four checks.
  assert.equal(runtime.split("\n").filter((line) => line.startsWith("| ") && !line.startsWith("| Capability")).length, 6);
});
