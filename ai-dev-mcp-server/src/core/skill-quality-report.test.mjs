import assert from "node:assert/strict";
import test from "node:test";
import { createSkillOverlayDocument } from "./skill-overlays.mjs";
import {
  buildSkillQualityReport,
  relationshipIssues,
  renderSkillQualityDashboard,
  skillQualityByGroup,
  skillQualityRecommendations,
  skillQualityResponse
} from "./skill-quality-report.mjs";

const NO_DUPLICATES = Object.freeze({
  exact: [], near: [], near_total: 0, compared_non_integration_skills: 0,
  membrane_policy: "Duplicate analysis disabled."
});

function skill(overrides = {}) {
  return {
    name: "feature-builder",
    source: "custom",
    path: "custom/feature-builder/SKILL.md",
    primary_group: "repository-workflows",
    maturity: "validated",
    trust_level: "trusted-local",
    quality_profile: "custom",
    structure_score: 90,
    structure_grade: "A",
    structure_status: "pass",
    quality_score: 90,
    quality_grade: "A",
    quality_status: "pass",
    quality_basis: "structure",
    empirical_score: 0,
    empirical_status: "unproven",
    validation_status: "provisional",
    validation_evidence: [],
    quality_breakdown: {},
    quality_findings: [],
    skill_schema_version: 2,
    ...overrides
  };
}

test("relationship checks flag related and conflict targets nobody registered", () => {
  const registry = [{ name: "feature-builder" }, { name: "code-reviewer" }];
  const issues = relationshipIssues([
    skill({ related_skills: ["code-reviewer", "ghost"], conflicts: ["policy:one-workflow", "phantom"] })
  ], registry);

  assert.equal(issues.length, 2);
  assert.equal(issues[0].severity, "warn");
  assert.equal(issues[0].code, "missing-related-skill");
  assert.match(issues[0].message, /ghost/);
  assert.equal(issues[1].severity, "error");
  assert.equal(issues[1].code, "missing-conflict-target");
  assert.match(issues[1].message, /phantom/);
});

test("relationship checks are case-insensitive and pass a clean registry", () => {
  assert.deepEqual(
    relationshipIssues([skill({ related_skills: ["Code-Reviewer"] })], [{ name: "code-reviewer" }]),
    []
  );
});

test("group rollups average only the groups that have members", () => {
  const byGroup = skillQualityByGroup([
    skill({ primary_group: "repository-workflows", quality_score: 90, quality_status: "pass" }),
    skill({ primary_group: "repository-workflows", quality_score: 60, quality_status: "warn" }),
    skill({ primary_group: "frontend-ui", quality_score: 30, quality_status: "fail" })
  ]);
  assert.deepEqual(byGroup["repository-workflows"], { count: 2, average_score: 75, pass: 1, warn: 1, fail: 0 });
  assert.deepEqual(byGroup["frontend-ui"], { count: 1, average_score: 30, pass: 0, warn: 0, fail: 1 });
  assert.equal("security" in byGroup, false);
  assert.deepEqual(skillQualityByGroup([]), {});
});

test("recommendations name every problem and fall back to a pass line", () => {
  const clean = skillQualityRecommendations({
    summary: {
      total: 2, schema_current: 2, important_failures: [],
      important_empirical_ready: 1, important_skills: 1, finding_counts: {}
    },
    issueCounts: {},
    duplicates: NO_DUPLICATES
  });
  assert.deepEqual(clean, ["Skill library quality checks passed for the selected scope."]);

  const noisy = skillQualityRecommendations({
    summary: {
      total: 3, schema_current: 1, important_failures: ["a", "b"],
      important_empirical_ready: 0, important_skills: 2,
      finding_counts: { "generic-integration-description": 4 }
    },
    issueCounts: { error: 2 },
    duplicates: { exact: [["x", "y"]], near_total: 1 }
  });
  assert.equal(noisy.length, 7);
  assert.match(noisy[0], /Run rebuild_index/);
  assert.match(noisy[1], /Fix failing important skills: a, b\./);
  assert.match(noisy[2], /Structural quality is not proof/);
  assert.match(noisy[3], /Review 2 schema or relationship error/);
  assert.match(noisy[4], /4 integration skill\(s\)/);
  assert.match(noisy[5], /exact duplicate groups/);
  assert.match(noisy[6], /near-duplicate candidates/);
});

test("the report sorts issues by severity, then weakest score, then name", () => {
  const report = buildSkillQualityReport({
    items: [
      skill({ name: "weak", quality_score: 10, quality_status: "fail", quality_findings: [{ severity: "error", code: "missing-section", message: "no body" }] }),
      skill({ name: "strong", quality_score: 95, quality_findings: [{ severity: "warn", code: "thin-use-when", message: "short" }] })
    ],
    registry: [{ name: "weak", source: "custom" }, { name: "strong", source: "custom" }],
    overlays: createSkillOverlayDocument("2026-01-01T00:00:00.000Z"),
    readErrors: [{ severity: "error", skill: "broken", code: "source-read-failed", message: "ENOENT", score: 0 }],
    duplicates: NO_DUPLICATES,
    filters: { source: "", group: "", min_score: 0 },
    maxIssues: 200,
    overlaysPath: "03-skills-catalog/registries/skill-overlays.json",
    generatedAt: "2026-02-03T04:05:06.000Z"
  });

  assert.equal(report.action, "validated");
  assert.equal(report.generated_at, "2026-02-03T04:05:06.000Z");
  assert.equal(report.source_read_errors, 1);
  assert.deepEqual(report.issues.map((issue) => issue.code), ["source-read-failed", "missing-section", "thin-use-when"]);
  assert.deepEqual(report.issue_counts, { error: 2, warn: 1 });
  assert.equal(report.issues_total, 3);
  assert.deepEqual(report.important_skills.map((item) => item.name), ["weak", "strong"]);
  assert.equal(report.skills[0].name, "weak");
  assert.equal("markdown" in report.skills[0], false);
});

test("the report caps the issue list and keeps at least one issue", () => {
  const findings = Array.from({ length: 5 }, (_, index) => ({ severity: "warn", code: `c${index}`, message: "m" }));
  const base = {
    items: [skill({ quality_findings: findings })],
    registry: [{ name: "feature-builder", source: "custom" }],
    overlays: createSkillOverlayDocument("2026-01-01T00:00:00.000Z"),
    readErrors: [],
    duplicates: NO_DUPLICATES,
    filters: { source: "", group: "", min_score: 0 },
    overlaysPath: "overlays.json"
  };
  assert.equal(buildSkillQualityReport({ ...base, maxIssues: 2 }).issues.length, 2);
  assert.equal(buildSkillQualityReport({ ...base, maxIssues: 1 }).issues.length, 1);
  // A falsy or absent cap means the 200 default, not zero issues.
  assert.equal(buildSkillQualityReport({ ...base, maxIssues: 0 }).issues.length, 5);
  assert.equal(buildSkillQualityReport({ ...base, maxIssues: -3 }).issues.length, 1);
  assert.equal(buildSkillQualityReport({ ...base, maxIssues: 5000 }).issues.length, 5);
  assert.equal(buildSkillQualityReport({ ...base, maxIssues: 2 }).issues_total, 5);
});

test("an invalid overlay document becomes an error issue blamed on the overlay file", () => {
  const report = buildSkillQualityReport({
    items: [],
    registry: [],
    overlays: { ...createSkillOverlayDocument("2026-01-01T00:00:00.000Z"), skills: { "custom:ghost": { routing_priority: "urgent", unknown_field: 1 } } },
    readErrors: [],
    duplicates: NO_DUPLICATES,
    filters: { source: "", group: "", min_score: 0 },
    maxIssues: 200,
    overlaysPath: "overlays.json"
  });
  assert.equal(report.issues.length, 2);
  assert.deepEqual(report.issues.map((issue) => issue.code), ["invalid-skill-overlay", "invalid-skill-overlay"]);
  assert.deepEqual(report.issues.map((issue) => issue.path), ["overlays.json", "overlays.json"]);
  assert.match(report.issues[0].message, /unknown overlay fields: unknown_field/);
  assert.match(report.issues[1].message, /routing_priority must be/);
});

test("the tool response trims the skill list and the issue tail", () => {
  const report = {
    action: "validated",
    generated_at: "2026-01-01T00:00:00.000Z",
    schema_version: 2,
    filters: { source: "", group: "", min_score: 0 },
    summary: { total: 1 },
    source_read_errors: 0,
    by_group: {},
    important_skills: [],
    issues_total: 30,
    issue_counts: { warn: 30 },
    issues: Array.from({ length: 30 }, (_, index) => ({ code: `c${index}` })),
    duplicates: NO_DUPLICATES,
    recommendations: ["ok"],
    skills: [{ name: "a" }],
    overlays: {}
  };
  const response = skillQualityResponse(report, { reportPath: "report.json", dashboardPath: "dash.md" });
  assert.equal(response.issues.length, 20);
  assert.equal(response.issues_total, 30);
  assert.equal("skills" in response, false);
  assert.equal("overlays" in response, false);
  assert.equal(response.report_path, "report.json");
  assert.equal(skillQualityResponse(report, { reportPath: null, dashboardPath: null }).dashboard_path, null);
});

test("the dashboard renders every section and points at the files it came from", () => {
  const report = buildSkillQualityReport({
    items: [skill({ quality_findings: [{ severity: "warn", code: "thin-use-when", message: "pipe | inside" }] })],
    registry: [{ name: "feature-builder", source: "custom" }],
    overlays: createSkillOverlayDocument("2026-01-01T00:00:00.000Z"),
    readErrors: [],
    duplicates: { ...NO_DUPLICATES, membrane_policy: "Membrane duplicates are expected." },
    filters: { source: "", group: "", min_score: 0 },
    maxIssues: 200,
    overlaysPath: "overlays.json",
    generatedAt: "2026-02-03T04:05:06.000Z"
  });
  const dashboard = renderSkillQualityDashboard(report, { reportPath: "report.json", overlaysPath: "overlays.json" });

  assert.match(dashboard, /^---\ntags: \["skill-quality", "skill-dashboard"\]\n/);
  assert.match(dashboard, /generated_at: "2026-02-03T04:05:06\.000Z"/);
  assert.match(dashboard, /# Skill Quality Dashboard/);
  assert.match(dashboard, /\| Skills \| 1 \|/);
  assert.match(dashboard, /## Domains/);
  assert.match(dashboard, /\| warn \| feature-builder \| thin-use-when \| pipe \/ inside \|/);
  assert.match(dashboard, /Membrane duplicates are expected\./);
  assert.match(dashboard, /- Machine report: `report\.json`/);
  assert.match(dashboard, /- Normalization overlays: `overlays\.json`/);
});

test("the dashboard degrades to placeholder rows when there is nothing to show", () => {
  const report = buildSkillQualityReport({
    items: [],
    registry: [],
    overlays: createSkillOverlayDocument("2026-01-01T00:00:00.000Z"),
    readErrors: [],
    duplicates: NO_DUPLICATES,
    filters: { source: "", group: "", min_score: 0 },
    maxIssues: 200,
    overlaysPath: "overlays.json"
  });
  const dashboard = renderSkillQualityDashboard(report, { reportPath: "report.json", overlaysPath: "overlays.json" });
  assert.match(dashboard, /\| none \| 0 \|/);
  assert.match(dashboard, /No issues for the selected validation scope\./);
});
