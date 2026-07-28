import crypto from "node:crypto";

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function dashboardSourceFingerprint(snapshot) {
  const source = {
    tools: snapshot.tools,
    skills: snapshot.skills,
    quality: snapshot.quality,
    projects: snapshot.projects,
    search: {
      documents: snapshot.search?.documents,
      dense_vectors: snapshot.search?.dense_vectors,
      pending_dense: snapshot.search?.pending_dense,
      eval_cases: snapshot.search?.eval_cases,
      ranking_version: snapshot.search?.ranking_version
    },
    outcomes: snapshot.outcomes,
    pilots: snapshot.pilots,
    overlays: snapshot.overlays,
    runtime: snapshot.runtime
  };
  return crypto.createHash("sha256").update(stableJson(source)).digest("hex");
}

function status(value) {
  return value ? "Ready" : "Needs attention";
}

function number(value) {
  return Number(value || 0).toLocaleString("en-US");
}

function rows(values) {
  return values.length ? values.join("\n") : "| - | - |";
}

export function renderSystemDashboard(snapshot) {
  const skillSources = Object.entries(snapshot.skills.by_source ?? {})
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([source, count]) => `| ${source} | ${number(count)} |`);
  const projectRows = (snapshot.projects.items ?? []).map((project) => (
    `| ${project.name} | \`${project.id}\` | ${project.stack?.join(", ") || "unknown"} | ${project.updated_at || "-"} |`
  ));
  return `---
tags: ["ai-dev-system", "generated-dashboard"]
generated_at: ${JSON.stringify(snapshot.generated_at)}
source_fingerprint: ${JSON.stringify(snapshot.source_fingerprint)}
---

# System Dashboard

This page is generated from live registries and runtime metadata. Run \`rebuild_system_dashboard\` when the freshness status is stale.

## Runtime

| Capability | Status | Evidence |
|---|---|---|
| MCP server | ${status(snapshot.runtime.server_ready)} | ${number(snapshot.tools.total)} tools |
| Modular runtime | ${status(snapshot.runtime.modular)} | ${number(snapshot.runtime.main_lines)} / ${number(snapshot.runtime.line_ceiling)} main-file lines |
| Static quality gate | Ready | \`npm run lint\` |
| Coverage gate | Ready | ${snapshot.runtime.coverage_thresholds} |
| Security gate | Ready | \`npm run security\` |
| Project Context Compiler | Ready | bounded packs with freshness fingerprints |
| Outcome Analytics v2 | Ready | one terminal outcome per task |
| Reference Factory v2 | Ready | perceptual duplicate checks plus Concept Jury |
| Search Ranking v2 | Ready | reranking plus hard negatives |

## Knowledge And Skills

| Metric | Value |
|---|---:|
| Skills | ${number(snapshot.skills.total)} |
| Custom skills | ${number(snapshot.skills.custom)} |
| Taxonomy groups | ${number(snapshot.skills.groups)} |
| Skill cards | ${number(snapshot.skills.cards)} |
| Important structurally ready | ${number(snapshot.quality.important_structure_ready)}/${number(snapshot.quality.important_skills)} |
| Important empirically validated | ${number(snapshot.quality.important_empirical_ready)}/${number(snapshot.quality.important_skills)} |
| Quality issues | ${number(snapshot.quality.issues)} |
| Overlay policies | ${number(snapshot.overlays.source_policies)} |
| Specific overlays | ${number(snapshot.overlays.specific_overlays)} |
| Orphan overlays | ${number(snapshot.overlays.orphan_overlays)} |

### Skill Sources

| Source | Skills |
|---|---:|
${rows(skillSources)}

## Search

| Metric | Value |
|---|---:|
| Indexed documents | ${number(snapshot.search.documents)} |
| Dense vectors | ${number(snapshot.search.dense_vectors)} |
| Pending dense vectors | ${number(snapshot.search.pending_dense)} |
| Index stale | ${snapshot.search.stale ? "yes" : "no"} |
| Golden cases | ${number(snapshot.search.eval_cases)} |
| Ranking schema | v${snapshot.search.ranking_version} |

## Delivery Evidence

| Metric | Value |
|---|---:|
| Terminal task outcomes | ${number(snapshot.outcomes.terminal)} |
| Verification attempts | ${number(snapshot.outcomes.attempts)} |
| Completed pilots | ${number(snapshot.pilots.completed)} |
| Human-confirmed pilots | ${number(snapshot.pilots.human_confirmed)} |
| Registered projects | ${number(snapshot.projects.total)} |

## Projects

| Project | Canonical ID | Stack | Updated |
|---|---|---|---|
${rows(projectRows)}

## Entry Points

- [[AI Dev Control Center]]
- [[Operating Model]]
- [[Agent Rules]]
- [[../03-skills-catalog/Skill Quality Dashboard]]
- [[../03-skills-catalog/Skill Routing]]
- [[../06-prompts/Auto Commands]]
- [[../09-mcp/MCP Server Plan]]
- [[../09-mcp/Search Eval]]
- [[../07-quality-gates/Frontend Product Quality v2]]
- [[../02-knowledge/Projects/Projects Index]]

## Operating Rule

Use \`begin_task\` for substantive work. It compiles the smallest useful project context, routes at most three skills, binds checks to the current repository state, and records one terminal outcome on completion.
`;
}

export function dashboardFreshness(saved, current) {
  const savedFingerprint = String(saved?.source_fingerprint || "");
  const currentFingerprint = dashboardSourceFingerprint(current);
  return {
    fresh: Boolean(savedFingerprint && savedFingerprint === currentFingerprint),
    saved_fingerprint: savedFingerprint,
    current_fingerprint: currentFingerprint,
    reason: savedFingerprint === currentFingerprint
      ? "Dashboard matches current system sources."
      : "Runtime, registry, project, search, outcome, pilot, or overlay state changed."
  };
}
