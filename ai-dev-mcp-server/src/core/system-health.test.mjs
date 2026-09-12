import assert from "node:assert/strict";
import test from "node:test";
import { dashboardSourceFingerprint, renderSystemDashboard } from "./system-dashboard.mjs";
import {
  COVERAGE_THRESHOLDS,
  EMBEDDING_BACKEND_REQUIREMENTS,
  REQUIRED_SEARCH_PRESETS,
  REQUIRED_SYSTEM_NOTES,
  SYSTEM_LINE_CEILING,
  buildSystemSnapshot,
  countBy,
  createHealthReport,
  dashboardSkillSource,
  evaluateAutoCommands,
  evaluateDenseSmoke,
  evaluateEmbeddingBackend,
  evaluateFrontendQaEnvironment,
  evaluateFrontendQaRunner,
  evaluateHybridSmoke,
  evaluateProjectRegistry,
  evaluateRequiredNotes,
  evaluateSearchEval,
  evaluateSearchIndexFile,
  evaluateSearchIndexFreshness,
  evaluateSearchPresets,
  evaluateSearchSmoke,
  evaluateSkillCards,
  evaluateSkillOutcomes,
  evaluateSkillQuality,
  evaluateSkillRegistry,
  evaluateSkillRoutingBenchmark,
  evaluateSkillTaxonomy,
  evaluateSkillVisualGraph,
  evaluateVaultRoot,
  healthErrorDetails,
  healthRecommendations,
  healthSummary,
  overallHealthStatus
} from "./system-health.mjs";

test("a Frontend QA environment that is not ready says which piece is missing", () => {
  const ready = evaluateFrontendQaEnvironment({
    playwright_available: true, chromium_available: true, browser_launch_ok: true, playwright_source: "runner"
  });
  assert.equal(ready.status, "ok");
  assert.match(ready.summary, /ready from runner/);

  // The measured case: Playwright is installed, and the browser it wants is not
  // where it looks. "Not fully ready" was all this used to say.
  const noBrowser = evaluateFrontendQaEnvironment({
    playwright_available: true,
    chromium_available: false,
    browser_launch_ok: false,
    launch_error: "Chromium is not at /opt/pw-browsers/chromium-1243/chrome-linux64/chrome. Install it with `npx playwright install chromium`."
  });
  assert.equal(noBrowser.status, "warn");
  assert.match(noBrowser.summary, /the Chromium binary is missing/);
  assert.match(noBrowser.summary, /npx playwright install chromium/);

  const noPlaywright = evaluateFrontendQaEnvironment({ playwright_available: false });
  assert.match(noPlaywright.summary, /Playwright itself/);
});

test("required notes count what is missing, not what this layout cannot have", () => {
  const ok = evaluateRequiredNotes([
    { relative_path: "00-start-here.md", exists: false, source: "not-applicable" },
    { relative_path: "09-mcp/ai-dev-mcp-server/README.md", exists: true, source: "repository" },
    { relative_path: "01-system/AI Dev Control Center.md", exists: true, source: "vault" }
  ]);
  assert.equal(ok.status, "ok");
  assert.match(ok.summary, /1 read from the repository layout/);
  assert.match(ok.summary, /1 vault-only note\(s\) do not apply here/);

  const missing = evaluateRequiredNotes([
    { relative_path: "03-skills-catalog/registries/SKILL_CARDS.md", exists: false, source: "missing" },
    { relative_path: "00-start-here.md", exists: false, source: "not-applicable" }
  ]);
  assert.equal(missing.status, "warn");
  assert.equal(missing.summary, "1 required notes are missing.");
  assert.deepEqual(missing.details.missing.map((item) => item.relative_path), ["03-skills-catalog/registries/SKILL_CARDS.md"]);
});

test("countBy tallies by derived key and folds empty keys into unknown", () => {
  assert.deepEqual(countBy([{ s: "a" }, { s: "a" }, { s: "" }], (item) => item.s), { a: 2, unknown: 1 });
  assert.deepEqual(countBy([], (item) => item), {});
});

test("health summary counts statuses and ignores unknown ones", () => {
  const checks = [
    { status: "ok" }, { status: "ok" }, { status: "warn" }, { status: "fail" }, { status: "skipped" },
    { status: "bogus" }
  ];
  assert.deepEqual(healthSummary(checks), { ok: 2, warn: 1, fail: 1, skipped: 1 });
});

test("overall status fails on critical failures and degrades on the rest", () => {
  assert.equal(overallHealthStatus([{ status: "ok", critical: true }]), "ok");
  assert.equal(overallHealthStatus([{ status: "warn", critical: true }]), "degraded");
  assert.equal(overallHealthStatus([{ status: "fail", critical: false }]), "degraded");
  assert.equal(overallHealthStatus([{ status: "fail", critical: true }]), "fail");
  assert.equal(overallHealthStatus([{ status: "fail" }]), "fail");
  assert.equal(overallHealthStatus([]), "ok");
});

test("error details survive non-Error throws", () => {
  assert.deepEqual(healthErrorDetails(new TypeError("bad")), { message: "bad", name: "TypeError" });
  assert.deepEqual(healthErrorDetails("plain"), { message: "plain", name: "Error" });
});

test("recommendations name every failure and warning, plus the dense smoke hint", () => {
  const recommendations = healthRecommendations([
    { name: "dense_smoke", status: "skipped", summary: "skipped" },
    { name: "search_smoke", status: "fail", summary: "no results" },
    { name: "required_notes", status: "warn", summary: "1 missing" },
    { name: "vault_root", status: "ok", summary: "fine" }
  ]);
  assert.equal(recommendations.length, 3);
  assert.match(recommendations[0], /include_dense_smoke=true/);
  assert.equal(recommendations[1], "Fix failed check: search_smoke - no results");
  assert.equal(recommendations[2], "Review warning: required_notes - 1 missing");
  assert.deepEqual(healthRecommendations([{ name: "dense_smoke", status: "ok", summary: "ran" }]), []);
});

test("health report records checks in order, turns throws into failures, and finishes", async () => {
  const report = createHealthReport();
  await report.runCheck("first", true, async () => ({ status: "ok", summary: "fine", details: { a: 1 } }));
  report.skip("second", false, "not requested");
  await report.runCheck("third", true, async () => {
    throw new Error("exploded");
  });
  await report.runCheck("fourth", false, async () => {
    throw "string failure";
  });
  const result = report.finish();

  assert.deepEqual(result.checks.map((check) => check.name), ["first", "second", "third", "fourth"]);
  assert.deepEqual(Object.keys(result.checks[0]), ["name", "status", "critical", "summary", "duration_ms", "details"]);
  assert.deepEqual(result.checks[1], {
    name: "second", status: "skipped", critical: false, summary: "not requested", duration_ms: 0, details: {}
  });
  assert.equal(result.checks[2].status, "fail");
  assert.deepEqual(result.checks[2].details, { message: "exploded", name: "Error" });
  assert.deepEqual(result.checks[3].details, { message: "string failure", name: "Error" });
  assert.equal(result.status, "fail");
  assert.deepEqual(result.summary, { ok: 1, warn: 0, fail: 2, skipped: 1 });
  assert.equal(result.recommendations.length, 2);
  assert.ok(Date.parse(result.started_at) <= Date.parse(result.finished_at));
  assert.ok(result.duration_ms >= 0);
});

test("vault root check separates missing, non-directory, and healthy roots", () => {
  assert.equal(evaluateVaultRoot({ exists: false }).status, "fail");
  assert.match(evaluateVaultRoot({ exists: true, is_directory: false }).summary, /not a directory/);
  assert.equal(evaluateVaultRoot({ exists: true, is_directory: true }).status, "ok");
});

test("required notes warn on missing files and list them", () => {
  const files = REQUIRED_SYSTEM_NOTES.map((relative_path, index) => ({
    relative_path, exists: index > 0, size_bytes: 10
  }));
  const missing = evaluateRequiredNotes(files);
  assert.equal(missing.status, "warn");
  assert.equal(missing.summary, "1 required notes are missing.");
  assert.equal(missing.details.missing.length, 1);
  assert.equal(evaluateRequiredNotes(files.map((file) => ({ ...file, exists: true }))).status, "ok");
});

test("search index file check distinguishes missing from empty", () => {
  assert.match(evaluateSearchIndexFile({ exists: false }).summary, /missing/);
  assert.match(evaluateSearchIndexFile({ exists: true, size_bytes: 0 }).summary, /empty/);
  assert.equal(evaluateSearchIndexFile({ exists: true, size_bytes: 4096 }).status, "ok");
});

test("search index freshness reports drift counts", () => {
  const stale = evaluateSearchIndexFreshness({ stale: true, added_count: 2, changed_count: 1, deleted_count: 0 });
  assert.equal(stale.status, "warn");
  assert.equal(stale.summary, "Search index is stale: 2 added, 1 changed, 0 deleted.");
  const fresh = evaluateSearchIndexFreshness({ stale: false, current_document_count: 900 });
  assert.equal(fresh.status, "ok");
  assert.match(fresh.summary, /900 document\(s\)/);
});

test("frontend QA runner check needs both the runner and its manifest", () => {
  const artifactsRoot = "/artifacts";
  assert.match(evaluateFrontendQaRunner({
    runner: { exists: false }, manifest: { exists: true }, artifactsRoot
  }).summary, /runner is missing/);
  assert.match(evaluateFrontendQaRunner({
    runner: { exists: true, size_bytes: 0 }, manifest: { exists: true }, artifactsRoot
  }).summary, /runner is empty/);
  const noManifest = evaluateFrontendQaRunner({
    runner: { exists: true, size_bytes: 20 }, manifest: { exists: false }, artifactsRoot
  });
  assert.equal(noManifest.status, "warn");
  const ready = evaluateFrontendQaRunner({
    runner: { exists: true, size_bytes: 20 }, manifest: { exists: true }, artifactsRoot
  });
  assert.equal(ready.status, "ok");
  assert.equal(ready.details.artifacts_root, artifactsRoot);
});

test("frontend QA environment is ready only when Playwright can launch Chromium", () => {
  const ready = evaluateFrontendQaEnvironment({
    playwright_available: true, chromium_available: true, browser_launch_ok: true, playwright_source: "vault"
  });
  assert.equal(ready.status, "ok");
  assert.match(ready.summary, /ready from vault/);
  assert.match(evaluateFrontendQaEnvironment({
    playwright_available: true, chromium_available: true, browser_launch_ok: true
  }).summary, /ready from runner/);
  assert.equal(evaluateFrontendQaEnvironment({ playwright_available: false }).status, "warn");
});

function embeddingAvailability(overrides = {}) {
  const availability = {};
  for (const key of EMBEDDING_BACKEND_REQUIREMENTS) availability[key] = { exists: true };
  return { ...availability, ...overrides };
}

test("embedding backend fails on any missing helper and reports worker state otherwise", () => {
  const missing = evaluateEmbeddingBackend({
    availability: embeddingAvailability({ model_file: { exists: false } }),
    workers: { count: 0 }
  });
  assert.equal(missing.status, "fail");
  assert.deepEqual(missing.details.missing, ["model_file"]);
  assert.match(evaluateEmbeddingBackend({ availability: embeddingAvailability(), workers: { count: 0 } }).summary, /not started yet/);
  const running = evaluateEmbeddingBackend({
    availability: embeddingAvailability(),
    workers: { count: 2 },
    backend: "bge-m3-local",
    paths: { model_dir: "/models" }
  });
  assert.equal(running.status, "ok");
  assert.match(running.summary, /2 worker\(s\)/);
  assert.equal(running.details.paths.model_dir, "/models");
  assert.equal(evaluateEmbeddingBackend({ workers: { count: 0 } }).details.missing.length, EMBEDDING_BACKEND_REQUIREMENTS.length);
});

test("skill registry check rejects non-arrays and empty registries", () => {
  assert.deepEqual(evaluateSkillRegistry({}).details, { type: "object" });
  assert.equal(evaluateSkillRegistry([]).status, "fail");
  const ok = evaluateSkillRegistry([
    { source: "custom", categories: ["a", "b"] },
    { source: "external/ecc", categories: ["a"] },
    { source: "custom" }
  ]);
  assert.equal(ok.status, "ok");
  assert.deepEqual(ok.details.sources, { custom: 2, "external/ecc": 1 });
  assert.equal(ok.details.category_count, 2);
});

test("skill taxonomy check counts missing and invalid group assignments", () => {
  const registry = { schema_version: 3, groups: [{ id: "delivery", count: 2 }] };
  const base = { registry, groupIds: ["delivery"], indexPath: "index.json", skillsMapPath: "Skills Map.md" };
  const ok = evaluateSkillTaxonomy({ ...base, items: [{ primary_group: "delivery" }, { primary_group: "delivery" }] });
  assert.equal(ok.status, "ok");
  assert.equal(ok.details.assigned, 2);
  assert.match(ok.summary, /2\/2 skills across 1 group\(s\)/);
  const broken = evaluateSkillTaxonomy({ ...base, items: [{}, { primary_group: "ghost" }] });
  assert.equal(broken.status, "fail");
  assert.equal(broken.details.missing, 1);
  assert.equal(broken.details.invalid, 1);
  const absent = evaluateSkillTaxonomy({ ...base, registry: null, items: [] });
  assert.deepEqual(absent.details, { path: "index.json" });
});

test("skill visual graph check compares coverage and generated page count", () => {
  const registry = {
    total_skills: 10, linked_unique_skills: 10, page_size: 80, batch_pages: 1, group_hubs: 2, bucket_hubs: 3,
    root_note: "all-skills.md"
  };
  const ok = evaluateSkillVisualGraph({ registry, markdownFiles: 7, indexPath: "graph.json" });
  assert.equal(ok.status, "ok");
  assert.equal(ok.details.expected_markdown_files, 7);
  assert.equal(evaluateSkillVisualGraph({ registry, markdownFiles: 6, indexPath: "graph.json" }).status, "fail");
  assert.equal(evaluateSkillVisualGraph({
    registry: { ...registry, linked_unique_skills: 9 }, markdownFiles: 7, indexPath: "graph.json"
  }).status, "fail");
  assert.equal(evaluateSkillVisualGraph({ registry: null, markdownFiles: 0, indexPath: "graph.json" }).status, "fail");
  assert.equal(evaluateSkillVisualGraph({
    registry: { total_skills: 0, linked_unique_skills: 0 }, markdownFiles: 1, indexPath: "graph.json"
  }).status, "ok");
});

function qualitySummary(overrides = {}) {
  return {
    schema_version: 2,
    schema_current: 10,
    total: 10,
    important_skills: 4,
    important_structure_ready: 4,
    important_failures: [],
    ...overrides
  };
}

test("skill quality check needs schema coverage, ready skills, and a saved report", () => {
  const paths = { reportPath: "quality.json", dashboardPath: "Dashboard.md" };
  const ok = evaluateSkillQuality({ quality: qualitySummary(), reportExists: true, ...paths });
  assert.equal(ok.status, "ok");
  assert.equal(ok.details.report_exists, true);
  assert.match(ok.summary, /Skill Schema v2 covers 10\/10/);
  assert.equal(evaluateSkillQuality({ quality: qualitySummary(), reportExists: false, ...paths }).status, "warn");
  assert.equal(evaluateSkillQuality({
    quality: qualitySummary({ schema_current: 9 }), reportExists: true, ...paths
  }).status, "fail");
  assert.equal(evaluateSkillQuality({
    quality: qualitySummary({ important_failures: ["one"] }), reportExists: true, ...paths
  }).status, "fail");
});

test("skill routing benchmark check needs a passing and fresh report", () => {
  const paths = { reportPath: "report.json", casesPath: "cases.json" };
  const report = { status: "pass", summary: { passed: 12, total: 12, failed: 0 }, generated_at: "2026-01-02T00:00:00.000Z" };
  const fresh = evaluateSkillRoutingBenchmark({
    report, reportMtime: "2026-01-02T00:00:00.000Z",
    inputMtimes: ["2026-01-01T00:00:00.000Z", "2026-01-01T12:00:00.000Z"], ...paths
  });
  assert.equal(fresh.status, "ok");
  assert.equal(fresh.details.fresh, true);
  assert.match(fresh.summary, /passed 12\/12/);
  const stale = evaluateSkillRoutingBenchmark({
    report, reportMtime: "2026-01-01T00:00:00.000Z", inputMtimes: ["2026-01-03T00:00:00.000Z"], ...paths
  });
  assert.equal(stale.status, "fail");
  assert.match(stale.summary, /is stale/);
  const failing = evaluateSkillRoutingBenchmark({
    report: { status: "fail", summary: { passed: 10, total: 12, failed: 2 } },
    reportMtime: "2026-01-02T00:00:00.000Z", inputMtimes: [""], ...paths
  });
  assert.match(failing.summary, /is failing/);
  const missing = evaluateSkillRoutingBenchmark({ report: null, ...paths });
  assert.deepEqual(missing.details, { report_path: "report.json", cases_path: "cases.json" });
});

test("skill outcomes check warns when the registry and the ledger disagree", () => {
  const outcomes = { events: 4, skills_observed: 2, empirically_validated: 2 };
  const synced = evaluateSkillOutcomes({ outcomes, registryValidated: 2, statePath: "/state.json" });
  assert.equal(synced.status, "ok");
  assert.equal(synced.details.registry_synchronized, true);
  assert.match(synced.summary, /Recorded 4 verification-bound outcome\(s\)/);
  const drifted = evaluateSkillOutcomes({ outcomes, registryValidated: 1, statePath: "/state.json" });
  assert.equal(drifted.status, "warn");
  assert.match(evaluateSkillOutcomes({
    outcomes: { events: 0, skills_observed: 0, empirically_validated: 0 }, registryValidated: 0, statePath: "/state.json"
  }).summary, /No verification-bound skill outcomes/);
});

test("skill cards check warns on an empty index", () => {
  const cards = [{ source: "custom" }, { source: "custom" }, {}];
  const ok = evaluateSkillCards({ cards, indexPath: "cards.json", catalogPath: "CARDS.md" });
  assert.equal(ok.status, "ok");
  assert.deepEqual(ok.details.by_source, { custom: 2, unknown: 1 });
  assert.equal(evaluateSkillCards({ cards: [], indexPath: "cards.json", catalogPath: "CARDS.md" }).status, "warn");
});

test("project registry check previews at most ten projects", () => {
  const projects = Array.from({ length: 12 }, (item, index) => ({
    name: `project-${index}`, project_path: `/p/${index}`, card_path: `card-${index}.md`,
    status: "registered", quality_gate_status: "passed"
  }));
  const ok = evaluateProjectRegistry(projects);
  assert.equal(ok.status, "ok");
  assert.equal(ok.details.count, 12);
  assert.equal(ok.details.projects.length, 10);
  assert.equal(evaluateProjectRegistry([]).status, "warn");
});

test("auto command and search preset checks fail on missing entries", () => {
  assert.equal(evaluateAutoCommands([{ name: "ship" }]).status, "ok");
  assert.equal(evaluateAutoCommands([]).status, "fail");
  const presets = REQUIRED_SEARCH_PRESETS.map((name) => ({ name }));
  assert.equal(evaluateSearchPresets(presets).status, "ok");
  const incomplete = evaluateSearchPresets(presets.slice(1));
  assert.equal(incomplete.status, "fail");
  assert.deepEqual(incomplete.details.missing, [REQUIRED_SEARCH_PRESETS[0]]);
});

test("smoke checks require results, and the dense smoke requires dense scores", () => {
  const results = [{ title: "One", path: "one.md", scope: "all", score: 3, dense_score: 0.5 }];
  assert.equal(evaluateSearchSmoke(results).status, "ok");
  assert.deepEqual(Object.keys(evaluateSearchSmoke(results).details.results[0]), ["title", "path", "scope", "score"]);
  assert.equal(evaluateSearchSmoke([]).status, "fail");
  assert.equal(evaluateHybridSmoke(results).status, "ok");
  assert.deepEqual(Object.keys(evaluateHybridSmoke(results).details.results[0]), ["title", "path", "scope", "score", "dense_score"]);
  assert.equal(evaluateHybridSmoke([]).status, "fail");
  assert.equal(evaluateDenseSmoke(results).status, "ok");
  assert.deepEqual(Object.keys(evaluateDenseSmoke(results).details.results[0]), ["title", "path", "score", "dense_score"]);
  assert.equal(evaluateDenseSmoke([{ ...results[0], dense_score: 0 }]).status, "fail");
  assert.equal(evaluateDenseSmoke([]).status, "fail");
});

test("search eval check maps eval status and lists failed cases", () => {
  const evalResult = {
    status: "degraded",
    include_dense: false,
    cases_path: "cases.json",
    summary: { passed: 8, failed: 1, skipped: 1 },
    cases: [
      { id: "one", status: "pass" },
      { id: "two", status: "fail", query: "q", preset: "balanced", error: "" }
    ]
  };
  const degraded = evaluateSearchEval(evalResult);
  assert.equal(degraded.status, "warn");
  assert.equal(degraded.summary, "Search eval: 8 passed, 1 failed, 1 skipped.");
  assert.deepEqual(degraded.details.failed_cases, [{ id: "two", query: "q", preset: "balanced", error: "" }]);
  assert.equal(evaluateSearchEval({ ...evalResult, status: "ok" }).status, "ok");
  assert.equal(evaluateSearchEval({ ...evalResult, status: "fail" }).status, "fail");
});

test("dashboard skill source buckets registry sources", () => {
  assert.equal(dashboardSkillSource("custom"), "custom");
  assert.equal(dashboardSkillSource("membrane/application-skills"), "membrane");
  assert.equal(dashboardSkillSource("design/ui"), "design");
  assert.equal(dashboardSkillSource("external/ecc"), "external");
  assert.equal(dashboardSkillSource("vendor"), "vendor");
  assert.equal(dashboardSkillSource(""), "unknown");
  assert.equal(dashboardSkillSource(null), "unknown");
});

function snapshotInput(overrides = {}) {
  return {
    toolCount: 115,
    skills: [
      { source: "custom", primary_group: "delivery" },
      { source: "custom", primary_group: "quality" },
      { source: "membrane/application-skills", primary_group: "delivery" },
      { source: "design/ui" }
    ],
    cards: [{ name: "one" }, { name: "two" }],
    qualityReport: {
      summary: { important_structure_ready: 2, important_empirical_ready: 1, important_skills: 2 },
      issues_total: 3,
      generated_at: "2026-02-01T00:00:00.000Z"
    },
    projects: [{ project_id: "p-1", name: "One", stack: ["Node.js"], updated_at: "2026-02-02" }],
    search: {
      indexed_document_count: 3000, dense_documents: 200, dense_pending_documents: 0,
      stale: false, source_fingerprint: "abc"
    },
    outcomes: { terminal_outcomes: 3, verification_attempts: 6 },
    pilots: { summary: { total: 4, active: 1, human_confirmed: 2 } },
    overlaySummary: { source_policies: 4, specific_overlays: 1, orphan_overlays: ["ghost"] },
    searchEvalCases: 45,
    runtimeLines: SYSTEM_LINE_CEILING - 350,
    generatedAt: "2026-02-03T00:00:00.000Z",
    ...overrides
  };
}

test("system snapshot summarizes live state and renders through the dashboard", () => {
  const snapshot = buildSystemSnapshot(snapshotInput());
  assert.equal(snapshot.schema_version, 1);
  assert.equal(snapshot.generated_at, "2026-02-03T00:00:00.000Z");
  assert.deepEqual(snapshot.tools, { total: 115 });
  assert.deepEqual(snapshot.skills, {
    total: 4, custom: 2, groups: 2, cards: 2, by_source: { custom: 2, membrane: 1, design: 1 }
  });
  assert.deepEqual(snapshot.quality, {
    important_structure_ready: 2, important_empirical_ready: 1, important_skills: 2, issues: 3,
    generated_at: "2026-02-01T00:00:00.000Z"
  });
  assert.deepEqual(snapshot.projects.items, [
    { id: "p-1", name: "One", stack: ["Node.js"], updated_at: "2026-02-02" }
  ]);
  assert.deepEqual(snapshot.search, {
    documents: 3000, dense_vectors: 200, pending_dense: 0, stale: false, eval_cases: 45,
    ranking_version: 2, source_fingerprint: "abc"
  });
  assert.deepEqual(snapshot.outcomes, { terminal: 3, attempts: 6 });
  assert.deepEqual(snapshot.pilots, { completed: 3, human_confirmed: 2 });
  assert.deepEqual(snapshot.overlays, { source_policies: 4, specific_overlays: 1, orphan_overlays: 1 });
  assert.deepEqual(snapshot.runtime, {
    server_ready: true,
    modular: true,
    main_lines: SYSTEM_LINE_CEILING - 350,
    line_ceiling: SYSTEM_LINE_CEILING,
    coverage_thresholds: COVERAGE_THRESHOLDS
  });
  assert.equal(snapshot.source_fingerprint, dashboardSourceFingerprint(snapshot));
  assert.match(renderSystemDashboard(snapshot), /115 tools/);
});

test("system snapshot falls back when quality, projects, and card shapes are sparse", () => {
  const snapshot = buildSystemSnapshot(snapshotInput({
    qualityReport: null,
    cards: { total: 7 },
    projects: [{ id: "p-2", name: "Two", last_synced: "2026-02-04" }],
    search: { dirty_reason: "source changed" },
    outcomes: { events: 9 },
    runtimeLines: SYSTEM_LINE_CEILING + 1
  }));
  assert.equal(snapshot.skills.cards, 7);
  assert.equal(snapshot.quality.important_skills, snapshot.skills.custom);
  assert.equal(snapshot.quality.generated_at, "");
  assert.deepEqual(snapshot.projects.items, [{ id: "p-2", name: "Two", stack: [], updated_at: "2026-02-04" }]);
  assert.equal(snapshot.search.stale, true);
  assert.equal(snapshot.search.source_fingerprint, "");
  assert.equal(snapshot.outcomes.terminal, 9);
  assert.equal(snapshot.runtime.modular, false);
  assert.equal(buildSystemSnapshot(snapshotInput({ cards: { items: [1, 2, 3] } })).skills.cards, 3);
  assert.equal(buildSystemSnapshot(snapshotInput({ cards: null })).skills.cards, 0);
  assert.equal(buildSystemSnapshot(snapshotInput({ projects: [{ name: "No id" }] })).projects.items[0].id, "");
  assert.ok(buildSystemSnapshot(snapshotInput({ generatedAt: undefined })).generated_at);
});
