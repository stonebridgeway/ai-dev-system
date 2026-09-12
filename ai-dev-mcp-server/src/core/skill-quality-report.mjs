/**
 * The `validate_skill_library` verdict: its report, its recommendations and the
 * Obsidian dashboard rendered from it.
 *
 * The extension reads every SKILL.md, scores it and runs duplicate analysis;
 * what arrives here is already-enriched records plus the duplicate result, so
 * the whole judgement — which relationships dangle, which overlays are invalid,
 * how issues rank, what the caller should do next — is a pure function of data.
 */
import { SKILL_GROUPS } from "../skill-taxonomy.mjs";
import { SKILL_SCHEMA_VERSION, summarizeSkillQuality } from "../skill-quality.mjs";
import {
  skillOverlayKey,
  summarizeSkillOverlays,
  validateSkillOverlayDocument
} from "./skill-overlays.mjs";
import { countBy } from "./system-health.mjs";
import { groupWikiLink } from "./skill-catalog.mjs";

/** Issue ordering: errors first, then the weakest skills, then by name. */
const SEVERITY_PRIORITY = { error: 0, warn: 1, info: 2 };

/**
 * Relationship checks across the whole registry: a `related_skills` or
 * `conflicts` entry that names a skill nobody registered.
 *
 * @param {object[]} items - Skills in scope of the current filters.
 * @param {object[]} registry - Every registered skill, used as the name set.
 * @returns {object[]} Issue records.
 */
export function relationshipIssues(items, registry) {
  const names = new Set(registry.map((item) => String(item.name || "").toLowerCase()));
  const issues = [];
  for (const item of items) {
    for (const related of item.related_skills || []) {
      if (!names.has(String(related).toLowerCase())) {
        issues.push({
          severity: "warn",
          skill: item.name,
          source: item.source,
          path: item.path,
          code: "missing-related-skill",
          message: `Related skill does not exist in the registry: ${related}`
        });
      }
    }
    for (const conflict of item.conflicts || []) {
      if (!String(conflict).startsWith("policy:") && !names.has(String(conflict).toLowerCase())) {
        issues.push({
          severity: "error",
          skill: item.name,
          source: item.source,
          path: item.path,
          code: "missing-conflict-target",
          message: `Conflict target does not exist in the registry: ${conflict}`
        });
      }
    }
  }
  return issues;
}

/** Per-group counts and averages for the skills in scope. */
export function skillQualityByGroup(items) {
  const byGroup = {};
  for (const taxonomyGroup of SKILL_GROUPS) {
    const members = items.filter((item) => item.primary_group === taxonomyGroup.id);
    if (!members.length) continue;
    byGroup[taxonomyGroup.id] = {
      count: members.length,
      average_score: Number((members.reduce((total, item) => total + item.quality_score, 0) / members.length).toFixed(2)),
      pass: members.filter((item) => item.quality_status === "pass").length,
      warn: members.filter((item) => item.quality_status === "warn").length,
      fail: members.filter((item) => item.quality_status === "fail").length
    };
  }
  return byGroup;
}

/** What the caller should do about this report, in the order it matters. */
export function skillQualityRecommendations({ summary, issueCounts, duplicates }) {
  const recommendations = [];
  if (summary.schema_current !== summary.total) recommendations.push("Run rebuild_index to persist Schema v2 metadata for every skill.");
  if (summary.important_failures.length) recommendations.push(`Fix failing important skills: ${summary.important_failures.join(", ")}.`);
  if (summary.important_empirical_ready < summary.important_skills) {
    recommendations.push("Structural quality is not proof of real task success. Run routing benchmarks and collect task verification outcomes before promoting custom skills to validated.");
  }
  if ((issueCounts.error || 0) > 0) recommendations.push(`Review ${issueCounts.error} schema or relationship error(s) listed in the quality report.`);
  if ((summary.finding_counts?.["generic-integration-description"] || 0) > 0) {
    recommendations.push(`${summary.finding_counts["generic-integration-description"]} integration skill(s) use generic routing descriptions; prefer specific catalog entries when scores are otherwise close.`);
  }
  if (duplicates.exact.length) recommendations.push("Review exact duplicate groups and keep one authoritative source when appropriate.");
  if (duplicates.near_total) recommendations.push("Review near-duplicate candidates before deleting or merging any skill.");
  if (!recommendations.length) recommendations.push("Skill library quality checks passed for the selected scope.");
  return recommendations;
}

/**
 * Assemble the full machine report written to the vault.
 *
 * @param {object} input
 * @param {object[]} input.items - Enriched skills in scope.
 * @param {object[]} input.registry - Every registered skill (unfiltered).
 * @param {object} input.overlays - The normalization overlay document.
 * @param {object[]} input.readErrors - Issues raised while reading sources.
 * @param {object} input.duplicates - Duplicate analysis result.
 * @param {object} input.filters - Echo of the caller's filters.
 * @param {number} input.maxIssues - Cap on the issue list in the report.
 * @param {string} input.overlaysPath - Vault path blamed for overlay errors.
 * @param {string} [input.generatedAt]
 * @returns {object}
 */
export function buildSkillQualityReport({
  items,
  registry,
  overlays,
  readErrors,
  duplicates,
  filters,
  maxIssues,
  overlaysPath,
  generatedAt = new Date().toISOString()
}) {
  const qualityIssues = items.flatMap((item) => (item.quality_findings || []).map((finding) => ({
    ...finding,
    skill: item.name,
    source: item.source,
    path: item.path,
    score: item.quality_score
  })));
  const overlayErrors = validateSkillOverlayDocument(overlays, {
    knownGroups: SKILL_GROUPS.map((item) => item.id),
    knownSkills: registry.map((item) => skillOverlayKey(item.source, item.name))
  }).map((message) => ({
    severity: "error",
    skill: "skill-overlays",
    source: "local-overlay",
    path: overlaysPath,
    code: "invalid-skill-overlay",
    message
  }));
  const allIssues = [...readErrors, ...overlayErrors, ...relationshipIssues(items, registry), ...qualityIssues]
    .sort((a, b) => (
      (SEVERITY_PRIORITY[a.severity] ?? 3) - (SEVERITY_PRIORITY[b.severity] ?? 3)
      || Number(a.score || 0) - Number(b.score || 0)
      || String(a.skill || "").localeCompare(String(b.skill || ""))
    ));
  const summary = summarizeSkillQuality(items);
  const issueCounts = countBy(allIssues, (issue) => issue.severity || "unknown");
  return {
    action: "validated",
    generated_at: generatedAt,
    schema_version: SKILL_SCHEMA_VERSION,
    filters,
    summary,
    source_read_errors: readErrors.length,
    overlays: summarizeSkillOverlays(overlays, registry),
    by_group: skillQualityByGroup(items),
    important_skills: items.filter((item) => item.source === "custom").map((item) => ({
      name: item.name,
      primary_group: item.primary_group,
      maturity: item.maturity,
      trust_level: item.trust_level,
      structure_score: item.structure_score,
      structure_status: item.structure_status,
      empirical_status: item.empirical_status,
      validation_status: item.validation_status,
      quality_basis: item.quality_basis,
      quality_score: item.quality_score,
      quality_grade: item.quality_grade,
      quality_status: item.quality_status,
      frameworks: item.frameworks || [],
      conflicts: item.conflicts || [],
      path: item.path
    })),
    issues_total: allIssues.length,
    issue_counts: issueCounts,
    issues: allIssues.slice(0, Math.max(1, Math.min(Number(maxIssues) || 200, 1000))),
    duplicates,
    skills: items.map((item) => ({
      name: item.name,
      source: item.source,
      path: item.path,
      primary_group: item.primary_group,
      maturity: item.maturity,
      trust_level: item.trust_level,
      quality_profile: item.quality_profile,
      structure_score: item.structure_score,
      structure_grade: item.structure_grade,
      structure_status: item.structure_status,
      quality_score: item.quality_score,
      quality_grade: item.quality_grade,
      quality_status: item.quality_status,
      quality_basis: item.quality_basis,
      empirical_score: item.empirical_score,
      empirical_status: item.empirical_status,
      validation_status: item.validation_status,
      validation_evidence: item.validation_evidence,
      quality_breakdown: item.quality_breakdown,
      quality_findings: item.quality_findings,
      frameworks: item.frameworks || [],
      languages: item.languages || [],
      conflicts: item.conflicts || [],
      requires: item.requires || [],
      content_hash: item.content_hash,
      skill_schema_version: item.skill_schema_version
    })),
    recommendations: skillQualityRecommendations({ summary, issueCounts, duplicates })
  };
}

/**
 * The trimmed view `validate_skill_library` returns to the caller: the full
 * skill list and the long issue tail stay in the written report.
 *
 * @param {object} report - Result of `buildSkillQualityReport`.
 * @param {{ reportPath: string|null, dashboardPath: string|null }} written
 * @returns {object}
 */
export function skillQualityResponse(report, { reportPath, dashboardPath }) {
  return {
    action: report.action,
    generated_at: report.generated_at,
    schema_version: report.schema_version,
    filters: report.filters,
    summary: report.summary,
    source_read_errors: report.source_read_errors,
    by_group: report.by_group,
    important_skills: report.important_skills,
    issues_total: report.issues_total,
    issue_counts: report.issue_counts,
    issues: report.issues.slice(0, 20),
    duplicates: report.duplicates,
    recommendations: report.recommendations,
    report_path: reportPath,
    dashboard_path: dashboardPath
  };
}

/**
 * Render the Obsidian dashboard for a quality report.
 *
 * @param {object} report - Result of `buildSkillQualityReport`.
 * @param {{ reportPath: string, overlaysPath: string }} paths - Vault paths the
 *   "Files" section points at.
 * @returns {string}
 */
export function renderSkillQualityDashboard(report, { reportPath, overlaysPath }) {
  const summary = report.summary;
  const importantRows = report.important_skills.map((item) =>
    `| ${item.name} | ${item.primary_group} | ${item.maturity} | ${item.validation_status} | ${item.empirical_status} | ${item.trust_level} | ${item.structure_score} | ${item.structure_status} |`
  );
  const issueRows = report.issues.slice(0, 40).map((issue) =>
    `| ${issue.severity} | ${issue.skill} | ${issue.code} | ${String(issue.message || "").replaceAll("|", "/")} |`
  );
  const domainRows = Object.entries(report.by_group)
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
    .map(([group, data]) => `| ${groupWikiLink(group)} | ${data.count} | ${data.average_score} | ${data.pass} | ${data.warn} | ${data.fail} |`);
  const findingRows = Object.entries(summary.finding_counts || {})
    .slice(0, 20)
    .map(([code, count]) => `| ${code} | ${count} |`);
  return `---
tags: ["skill-quality", "skill-dashboard"]
skill_schema_version: ${report.schema_version}
generated_at: ${JSON.stringify(report.generated_at)}
---

# Skill Quality Dashboard

Machine-generated quality view for the complete skill library. Trust describes provenance, not an absolute security guarantee.

## Summary

| Metric | Value |
|---|---:|
| Skills | ${summary.total} |
| Schema v2 | ${summary.schema_current} |
| Average score | ${summary.average_score} |
| Pass | ${summary.by_status.pass || 0} |
| Warn | ${summary.by_status.warn || 0} |
| Fail | ${summary.by_status.fail || 0} |
| Important structurally ready | ${summary.important_structure_ready}/${summary.important_skills} |
| Important empirically validated | ${summary.important_empirical_ready}/${summary.important_skills} |
| Provisional validation | ${summary.by_validation_status.provisional || 0} |
| Issues | ${report.issues_total} |
| Exact duplicate groups | ${report.duplicates.exact.length} |
| Near duplicate candidates | ${report.duplicates.near_total} |
| Overlay source policies | ${report.overlays?.source_policies || 0} |
| Specific skill overlays | ${report.overlays?.specific_overlays || 0} |
| Orphan overlays | ${report.overlays?.orphan_overlays?.length || 0} |

## Finding Counts

| Finding | Skills |
|---|---:|
${findingRows.length ? findingRows.join("\n") : "| none | 0 |"}

## Domains

| Domain | Skills | Average | Pass | Warn | Fail |
|---|---:|---:|---:|---:|---:|
${domainRows.join("\n")}

## Important Skills

| Skill | Group | Maturity | Validation | Empirical | Trust | Structure | Status |
|---|---|---|---|---|---|---:|---|
${importantRows.join("\n")}

## Top Issues

| Severity | Skill | Code | Message |
|---|---|---|---|
${issueRows.length ? issueRows.join("\n") : "| info | - | none | No issues for the selected validation scope. |"}

## Duplicate Policy

${report.duplicates.membrane_policy}

## Files

- Machine report: \`${reportPath}\`
- Normalization overlays: \`${overlaysPath}\`
- Skill taxonomy: [[Skill Taxonomy]]
- Complete graph: [[groups/all-skills/Index|Complete Skill Graph]]
`;
}
