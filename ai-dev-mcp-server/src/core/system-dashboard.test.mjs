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
      line_ceiling: 10500,
      coverage_thresholds: "85% lines / 60% branches / 85% functions"
    }
  };
}

test("system dashboard is deterministic, generated, and freshness-bound", () => {
  const current = snapshot();
  current.source_fingerprint = dashboardSourceFingerprint(current);
  const markdown = renderSystemDashboard(current);
  assert.match(markdown, /79 tools/);
  assert.match(markdown, /Project Context Compiler/);
  assert.equal(dashboardFreshness(current, current).fresh, true);
  const changed = snapshot();
  changed.tools.total = 80;
  assert.equal(dashboardFreshness(current, changed).fresh, false);
});
