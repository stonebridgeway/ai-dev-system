/**
 * Pure analysis behind the system extension (`src/extensions/system.mjs`).
 *
 * Everything here is a plain function over data the extension has already
 * fetched: no vault paths, no file system, no process state. The extension
 * gathers the raw status objects through its `host` and hands them to these
 * evaluators, which decide `ok` / `warn` / `fail` and shape the details each
 * check reports. `buildSystemSnapshot` does the same for the machine snapshot
 * the System Dashboard renders.
 */
import { dashboardSourceFingerprint } from "./system-dashboard.mjs";

/**
 * The `mcp-stdio.mjs` line budget. `scripts/static-quality.mjs` enforces it and
 * the system snapshot reports it, both from here, so the gate and the dashboard
 * cannot drift apart.
 *
 * It is a ratchet: the file's actual size plus roughly 300 lines of working
 * room, re-pinned downwards after each extraction and never upwards. Stage 1 of
 * docs/ecc-upgrades/PLAN.md took the file from 10,018 lines to 4,776 across six
 * steps; this is that size plus the working room. New capabilities go into
 * `src/extensions/` rather than here, so the budget only has to cover editing
 * what is left.
 */
export const SYSTEM_LINE_CEILING = 5_076;

/** Coverage thresholds enforced by `npm run check`, reported for visibility. */
export const COVERAGE_THRESHOLDS = "85% lines / 60% branches / 85% functions";

/** Vault notes a healthy system is expected to carry. */
export const REQUIRED_SYSTEM_NOTES = Object.freeze([
  "00-start-here.md",
  "01-system/AI Dev Control Center.md",
  "09-mcp/README.md",
  "09-mcp/ai-dev-mcp-server/README.md",
  "09-mcp/ai-dev-mcp-server/docs/ARCHITECTURE.md",
  // The catalogue the runtime actually renders (`sync_skill_cards`). The list
  // used to name "03-skills-catalog/Skill Cards.md", which nothing writes, so
  // the check reported a note missing that could never appear.
  "03-skills-catalog/registries/SKILL_CARDS.md"
]);

/** Availability keys the BGE-M3 backend needs before dense search can run. */
export const EMBEDDING_BACKEND_REQUIREMENTS = Object.freeze([
  "search_index",
  "embeddings_python",
  "embed_helper",
  "worker_helper",
  "model_dir",
  "model_file",
  "modules_file"
]);

/** Search presets every install must expose. */
export const REQUIRED_SEARCH_PRESETS = Object.freeze([
  "balanced",
  "code",
  "docs",
  "skills",
  "projects",
  "debug",
  "frontend",
  "quality"
]);

/**
 * Tally items by a derived key, falling back to `unknown` for empty keys.
 *
 * @param {Iterable<*>} items
 * @param {(item: *) => string} selector
 * @returns {Record<string, number>}
 */
export function countBy(items, selector) {
  const counts = {};
  for (const item of items) {
    const key = selector(item) || "unknown";
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

/**
 * Count checks per status.
 *
 * @param {Array<{ status: string }>} checks
 * @returns {{ ok: number, warn: number, fail: number, skipped: number }}
 */
export function healthSummary(checks) {
  const summary = { ok: 0, warn: 0, fail: 0, skipped: 0 };
  for (const check of checks) {
    if (Object.hasOwn(summary, check.status)) summary[check.status] += 1;
  }
  return summary;
}

/**
 * Overall verdict: a failed critical check fails the run, any other failure or
 * warning degrades it.
 *
 * @param {Array<{ status: string, critical?: boolean }>} checks
 * @returns {"ok"|"degraded"|"fail"}
 */
export function overallHealthStatus(checks) {
  if (checks.some((check) => check.status === "fail" && check.critical !== false)) return "fail";
  if (checks.some((check) => check.status === "fail" || check.status === "warn")) return "degraded";
  return "ok";
}

/**
 * Serializable shape for an error thrown inside a check.
 *
 * @param {unknown} err
 * @returns {{ message: string, name: string }}
 */
export function healthErrorDetails(err) {
  return {
    message: err instanceof Error ? err.message : String(err),
    name: err instanceof Error ? err.name : "Error"
  };
}

/**
 * Follow-up actions derived from the recorded checks.
 *
 * @param {Array<{ name: string, status: string, summary: string }>} checks
 * @returns {string[]}
 */
export function healthRecommendations(checks) {
  const recommendations = [];
  if (checks.some((check) => check.name === "dense_smoke" && check.status === "skipped")) {
    recommendations.push("Run system_health_check with include_dense_smoke=true after MCP restarts or embedding changes.");
  }
  for (const check of checks) {
    if (check.status === "fail") recommendations.push(`Fix failed check: ${check.name} - ${check.summary}`);
    if (check.status === "warn") recommendations.push(`Review warning: ${check.name} - ${check.summary}`);
  }
  return recommendations;
}

/**
 * Collector for a health run: records checks in order, turns a thrown error
 * into a failed check, and renders the final report.
 *
 * @returns {{ addCheck: Function, skip: Function, runCheck: Function, finish: Function }}
 */
export function createHealthReport() {
  const startedAt = new Date();
  const checks = [];

  const addCheck = ({ name, status, summary, details = {}, critical = true, duration_ms = 0 }) => {
    checks.push({ name, status, critical, summary, duration_ms, details });
  };

  const skip = (name, critical, summary) => {
    addCheck({ name, status: "skipped", critical, summary });
  };

  const runCheck = async (name, critical, fn) => {
    const start = Date.now();
    try {
      const result = await fn();
      addCheck({ name, critical, duration_ms: Date.now() - start, ...result });
    } catch (err) {
      addCheck({
        name,
        critical,
        status: "fail",
        summary: err instanceof Error ? err.message : String(err),
        duration_ms: Date.now() - start,
        details: healthErrorDetails(err)
      });
    }
  };

  const finish = () => {
    const finishedAt = new Date();
    return {
      status: overallHealthStatus(checks),
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      duration_ms: finishedAt.getTime() - startedAt.getTime(),
      summary: healthSummary(checks),
      checks,
      recommendations: healthRecommendations(checks)
    };
  };

  return { addCheck, skip, runCheck, finish };
}

/**
 * @param {{ exists: boolean, is_directory?: boolean }} status - `fileStatus` of the vault root.
 */
export function evaluateVaultRoot(status) {
  if (!status.exists) return { status: "fail", summary: "Vault root is missing.", details: status };
  if (!status.is_directory) return { status: "fail", summary: "Vault root is not a directory.", details: status };
  return { status: "ok", summary: "Vault root exists.", details: status };
}

/**
 * @param {Array<{ relative_path: string, exists: boolean, size_bytes: number }>} files
 */
export function evaluateRequiredNotes(files) {
  // A note carries where it was found. `not-applicable` is a note that belongs
  // to the Obsidian layout and has no place in a plain checkout — counting
  // those as missing told a healthy source install that it was broken.
  const missing = files.filter((file) => !file.exists && file.source !== "not-applicable");
  const elsewhere = files.filter((file) => file.source === "repository").length;
  const inapplicable = files.filter((file) => file.source === "not-applicable").length;
  const notes = [
    elsewhere ? `${elsewhere} read from the repository layout` : "",
    inapplicable ? `${inapplicable} vault-only note(s) do not apply here` : ""
  ].filter(Boolean).join(", ");
  return {
    status: missing.length ? "warn" : "ok",
    summary: missing.length
      ? `${missing.length} required notes are missing.`
      : `Core system notes exist${notes ? ` (${notes})` : ""}.`,
    details: { files, missing }
  };
}

/**
 * @param {{ exists: boolean, size_bytes?: number }} status - `fileStatus` of the SQLite index.
 */
export function evaluateSearchIndexFile(status) {
  if (!status.exists) return { status: "fail", summary: "SQLite search index is missing.", details: status };
  if (!status.size_bytes) return { status: "fail", summary: "SQLite search index is empty.", details: status };
  return { status: "ok", summary: "SQLite search index file exists.", details: status };
}

/**
 * @param {object} status - `search_index_status` payload.
 */
export function evaluateSearchIndexFreshness(status) {
  return {
    status: status.stale ? "warn" : "ok",
    summary: status.stale
      ? `Search index is stale: ${status.added_count} added, ${status.changed_count} changed, ${status.deleted_count} deleted.`
      : `Search index is current with ${status.current_document_count} document(s).`,
    details: status
  };
}

/**
 * @param {{ runner: object, manifest: object, artifactsRoot: string }} input - `fileStatus` of the
 *   frontend QA runner and its `package.json`, plus the artifact root.
 */
export function evaluateFrontendQaRunner({ runner, manifest, artifactsRoot }) {
  if (!runner.exists) return { status: "warn", summary: "Frontend QA runner is missing.", details: runner };
  if (!runner.size_bytes) return { status: "warn", summary: "Frontend QA runner is empty.", details: runner };
  return {
    status: manifest.exists ? "ok" : "warn",
    summary: manifest.exists
      ? "Frontend QA runner and package manifest exist."
      : "Frontend QA runner exists, but package manifest is missing.",
    details: { runner, package: manifest, artifacts_root: artifactsRoot }
  };
}

/**
 * @param {{ playwright_available?: boolean, chromium_available?: boolean, browser_launch_ok?: boolean, playwright_source?: string, launch_error?: string }} status
 */
export function evaluateFrontendQaEnvironment(status) {
  const ready = status.playwright_available && status.chromium_available && status.browser_launch_ok;
  // "not fully ready" is true and useless. The runner knows which of the three
  // pieces is missing and, for the usual case, where it looked for the browser.
  const missing = [
    status.playwright_available ? "" : "Playwright itself",
    status.chromium_available ? "" : "the Chromium binary",
    status.chromium_available && !status.browser_launch_ok ? "a browser that launches" : ""
  ].filter(Boolean).join(" and ");
  const because = String(status.launch_error || "").replace(/\s+/g, " ").trim();
  return {
    status: ready ? "ok" : "warn",
    summary: ready
      ? `Playwright Chromium is ready from ${status.playwright_source || "runner"}.`
      : `Frontend QA cannot run: ${missing || "its browser"} is missing.${because ? ` ${because}` : ""}`,
    details: status
  };
}

/**
 * @param {object} status - `embedding_status` payload.
 */
export function evaluateEmbeddingBackend(status) {
  const missing = EMBEDDING_BACKEND_REQUIREMENTS.filter((key) => !status.availability?.[key]?.exists);
  if (missing.length) {
    return {
      status: "fail",
      summary: `Embedding backend is missing required files: ${missing.join(", ")}.`,
      details: { missing, availability: status.availability, workers: status.workers }
    };
  }
  return {
    status: "ok",
    summary: status.workers.count > 0
      ? `Embedding backend files exist; ${status.workers.count} worker(s) currently tracked.`
      : "Embedding backend files exist; worker is not started yet.",
    details: {
      backend: status.backend,
      dense_model: status.dense_model,
      dense_dimensions: status.dense_dimensions,
      configured_device: status.configured_device,
      workers: status.workers,
      paths: status.paths
    }
  };
}

/**
 * @param {*} items - Parsed `skills.index.json`.
 */
export function evaluateSkillRegistry(items) {
  if (!Array.isArray(items)) return { status: "fail", summary: "Skill registry is not a JSON array.", details: { type: typeof items } };
  if (!items.length) return { status: "fail", summary: "Skill registry is empty.", details: { count: 0 } };
  const sources = countBy(items, (item) => item.source);
  const categories = countBy(items.flatMap((item) => item.categories || []), (item) => item);
  return {
    status: "ok",
    summary: `Skill registry loaded with ${items.length} skills.`,
    details: { count: items.length, sources, category_count: Object.keys(categories).length }
  };
}

/**
 * @param {{ registry: object|null, items: object[], groupIds: string[], indexPath: string, skillsMapPath: string }} input
 */
export function evaluateSkillTaxonomy({ registry, items, groupIds, indexPath, skillsMapPath }) {
  if (!registry) return { status: "fail", summary: "Skill taxonomy registry is missing.", details: { path: indexPath } };
  const missing = items.filter((item) => !item.primary_group).length;
  const knownGroups = new Set(groupIds);
  const invalid = items.filter((item) => item.primary_group && !knownGroups.has(item.primary_group)).length;
  const assigned = items.length - missing - invalid;
  const status = missing || invalid ? "fail" : "ok";
  return {
    status,
    summary: status === "ok"
      ? `Skill taxonomy assigned ${assigned}/${items.length} skills across ${registry.groups.length} group(s).`
      : `Skill taxonomy has ${missing} missing and ${invalid} invalid assignments.`,
    details: {
      schema_version: registry.schema_version,
      total: items.length,
      assigned,
      missing,
      invalid,
      groups: registry.groups.map((group) => ({ id: group.id, count: group.count })),
      index_path: indexPath,
      skills_map: skillsMapPath
    }
  };
}

/**
 * @param {{ registry: object|null, markdownFiles: number, indexPath: string }} input
 */
export function evaluateSkillVisualGraph({ registry, markdownFiles, indexPath }) {
  if (!registry) {
    return { status: "fail", summary: "Skill visual graph registry is missing.", details: { path: indexPath } };
  }
  const expectedFiles = 1
    + Number(registry.group_hubs || 0)
    + Number(registry.bucket_hubs || 0)
    + Number(registry.batch_pages || 0);
  const complete = registry.total_skills === registry.linked_unique_skills;
  const filesComplete = markdownFiles === expectedFiles;
  const status = complete && filesComplete ? "ok" : "fail";
  return {
    status,
    summary: status === "ok"
      ? `Skill visual graph links ${registry.linked_unique_skills}/${registry.total_skills} skills through ${registry.batch_pages} batch page(s).`
      : "Skill visual graph coverage or generated file count is incomplete.",
    details: {
      total_skills: registry.total_skills,
      linked_unique_skills: registry.linked_unique_skills,
      page_size: registry.page_size,
      batch_pages: registry.batch_pages,
      group_hubs: registry.group_hubs,
      bucket_hubs: registry.bucket_hubs,
      markdown_files: markdownFiles,
      expected_markdown_files: expectedFiles,
      index_path: indexPath,
      root_note: registry.root_note
    }
  };
}

/**
 * @param {{ quality: object, reportExists: boolean, reportPath: string, dashboardPath: string }} input -
 *   `quality` is a `summarizeSkillQuality` result.
 */
export function evaluateSkillQuality({ quality, reportExists, reportPath, dashboardPath }) {
  const schemaComplete = quality.schema_current === quality.total;
  const importantComplete = quality.important_structure_ready === quality.important_skills
    && !quality.important_failures.length;
  const status = schemaComplete && importantComplete && reportExists
    ? "ok"
    : (schemaComplete && importantComplete ? "warn" : "fail");
  return {
    status,
    summary: status === "ok"
      ? `Skill Schema v${quality.schema_version} covers ${quality.schema_current}/${quality.total}; important structurally ready skills ${quality.important_structure_ready}/${quality.important_skills}.`
      : `Skill quality is incomplete: schema ${quality.schema_current}/${quality.total}, important structurally ready ${quality.important_structure_ready}/${quality.important_skills}, report ${reportExists ? "present" : "missing"}.`,
    details: {
      ...quality,
      empirical_validation_note: "Structural readiness is tracked separately from verification-bound real task outcomes.",
      report_exists: reportExists,
      report_path: reportPath,
      dashboard_path: dashboardPath
    }
  };
}

/**
 * @param {{ report: object|null, reportMtime: string, inputMtimes: string[], reportPath: string, casesPath: string }} input -
 *   `report` is null when the benchmark has never been generated.
 */
export function evaluateSkillRoutingBenchmark({ report, reportMtime, inputMtimes, reportPath, casesPath }) {
  if (!report) {
    return {
      status: "fail",
      summary: "Skill routing benchmark report is missing.",
      details: { report_path: reportPath, cases_path: casesPath }
    };
  }
  const reportTime = Date.parse(reportMtime || "") || 0;
  const newestInput = Math.max(0, ...inputMtimes.map((value) => Date.parse(value || "") || 0));
  const fresh = reportTime >= newestInput;
  const passed = report.status === "pass" && Number(report.summary?.failed || 0) === 0;
  return {
    status: passed && fresh ? "ok" : "fail",
    summary: passed && fresh
      ? `Skill routing passed ${report.summary.passed}/${report.summary.total} golden case(s).`
      : `Skill routing benchmark is ${passed ? "stale" : "failing"}; rerun run_skill_routing_eval.`,
    details: {
      ...report.summary,
      benchmark_status: report.status,
      fresh,
      generated_at: report.generated_at,
      report_path: reportPath,
      cases_path: casesPath
    }
  };
}

/**
 * @param {{ outcomes: object, registryValidated: number, statePath: string }} input
 */
export function evaluateSkillOutcomes({ outcomes, registryValidated, statePath }) {
  const synchronized = registryValidated === outcomes.empirically_validated;
  return {
    status: synchronized ? "ok" : "warn",
    summary: outcomes.events
      ? `Recorded ${outcomes.events} verification-bound outcome(s) across ${outcomes.skills_observed} skill(s); ${outcomes.empirically_validated} empirically validated.`
      : "No verification-bound skill outcomes have been recorded yet; custom skills remain provisional.",
    details: {
      ...outcomes,
      registry_empirically_validated: registryValidated,
      registry_synchronized: synchronized,
      state_path: statePath
    }
  };
}

/**
 * @param {{ cards: object[], indexPath: string, catalogPath: string }} input
 */
export function evaluateSkillCards({ cards, indexPath, catalogPath }) {
  const bySource = countBy(cards, (card) => card.source || "unknown");
  return {
    status: cards.length ? "ok" : "warn",
    summary: cards.length ? `Skill cards loaded with ${cards.length} card(s).` : "Skill cards index is missing or empty.",
    details: {
      count: cards.length,
      by_source: bySource,
      index_path: indexPath,
      catalog_path: catalogPath
    }
  };
}

/**
 * @param {object[]} projects - `list_projects` payload.
 */
export function evaluateProjectRegistry(projects) {
  return {
    status: projects.length ? "ok" : "warn",
    summary: projects.length
      ? `Project registry has ${projects.length} project card(s).`
      : "Project registry has no project cards yet.",
    details: {
      count: projects.length,
      projects: projects.slice(0, 10).map((project) => ({
        name: project.name,
        project_path: project.project_path,
        card_path: project.card_path,
        status: project.status,
        quality_gate_status: project.quality_gate_status
      }))
    }
  };
}

/**
 * @param {Array<{ name: string }>} commands - `list_auto_commands` payload.
 */
export function evaluateAutoCommands(commands) {
  return {
    status: commands.length ? "ok" : "fail",
    summary: commands.length
      ? `Auto-command registry has ${commands.length} workflows.`
      : "Auto-command registry is empty.",
    details: { count: commands.length, names: commands.map((command) => command.name) }
  };
}

/**
 * @param {Array<{ name: string }>} presets - `list_search_presets` payload.
 */
export function evaluateSearchPresets(presets) {
  const names = presets.map((preset) => preset.name);
  const missing = REQUIRED_SEARCH_PRESETS.filter((name) => !names.includes(name));
  return {
    status: missing.length ? "fail" : "ok",
    summary: missing.length ? `Missing search presets: ${missing.join(", ")}.` : `Search presets loaded: ${names.join(", ")}.`,
    details: { count: presets.length, names, missing }
  };
}

/**
 * @param {object[]} results - Keyword (FTS) smoke search results.
 */
export function evaluateSearchSmoke(results) {
  return {
    status: results.length ? "ok" : "fail",
    summary: results.length ? `FTS search returned ${results.length} result(s).` : "FTS search returned no results.",
    details: {
      results: results.map((item) => ({ title: item.title, path: item.path, scope: item.scope, score: item.score }))
    }
  };
}

/**
 * @param {object[]} results - Hybrid smoke search results run with `dense_weight: 0`.
 */
export function evaluateHybridSmoke(results) {
  return {
    status: results.length ? "ok" : "fail",
    summary: results.length
      ? `Hybrid search without dense returned ${results.length} result(s).`
      : "Hybrid search without dense returned no results.",
    details: {
      results: results.map((item) => ({
        title: item.title,
        path: item.path,
        scope: item.scope,
        score: item.score,
        dense_score: item.dense_score
      }))
    }
  };
}

/**
 * @param {object[]} results - Hybrid smoke search results run with dense weighting.
 */
export function evaluateDenseSmoke(results) {
  const hasDense = results.some((item) => Number(item.dense_score) > 0);
  return {
    status: results.length && hasDense ? "ok" : "fail",
    summary: results.length && hasDense
      ? `Dense hybrid search returned ${results.length} result(s) with dense scores.`
      : "Dense hybrid search did not return dense-scored results.",
    details: {
      results: results.map((item) => ({
        title: item.title,
        path: item.path,
        score: item.score,
        dense_score: item.dense_score
      }))
    }
  };
}

/**
 * @param {object} evalResult - `run_search_eval` payload.
 */
export function evaluateSearchEval(evalResult) {
  const { failed, passed, skipped } = evalResult.summary;
  const status = evalResult.status === "ok" ? "ok" : (evalResult.status === "degraded" ? "warn" : "fail");
  return {
    status,
    summary: `Search eval: ${passed} passed, ${failed} failed, ${skipped} skipped.`,
    details: {
      include_dense: evalResult.include_dense,
      cases_path: evalResult.cases_path,
      summary: evalResult.summary,
      failed_cases: evalResult.cases
        .filter((item) => item.status === "fail")
        .map((item) => ({ id: item.id, query: item.query, preset: item.preset, error: item.error || "" }))
    }
  };
}

/**
 * Bucket a registry `source` value into the coarse families the dashboard counts.
 *
 * @param {string} source
 * @returns {string}
 */
export function dashboardSkillSource(source) {
  const value = String(source || "");
  if (value === "custom") return "custom";
  if (value.startsWith("membrane/")) return "membrane";
  if (value.startsWith("design/")) return "design";
  if (value.startsWith("external/")) return "external";
  return value || "unknown";
}

/**
 * Assemble the machine snapshot the System Dashboard renders, from live state
 * the caller has already read, and stamp it with its source fingerprint.
 *
 * @param {object} input - Live state.
 * @param {number} input.toolCount - Number of MCP tools the server advertises.
 * @param {object[]} input.skills - Parsed skill registry.
 * @param {*} input.cards - Skill card index (array, or an object with `total`/`items`).
 * @param {object|null} input.qualityReport - Saved skill quality report, when present.
 * @param {object[]} input.projects - Deduplicated project summaries.
 * @param {object} input.search - `search_index_status` payload.
 * @param {object} input.outcomes - Skill outcome store status.
 * @param {object} input.pilots - Pilot store status.
 * @param {object} input.overlaySummary - `summarizeSkillOverlays` result.
 * @param {number} input.searchEvalCases - Number of golden search eval cases.
 * @param {number} input.runtimeLines - Line count of `src/mcp-stdio.mjs`.
 * @param {string} [input.generatedAt] - ISO timestamp; defaults to now.
 * @returns {object} Snapshot with `source_fingerprint`.
 */
export function buildSystemSnapshot({
  toolCount,
  skills,
  cards,
  qualityReport,
  projects,
  search,
  outcomes,
  pilots,
  overlaySummary,
  searchEvalCases,
  runtimeLines,
  generatedAt = new Date().toISOString()
}) {
  const bySource = countBy(skills, (item) => dashboardSkillSource(item.source));
  const snapshot = {
    schema_version: 1,
    generated_at: generatedAt,
    tools: { total: toolCount },
    skills: {
      total: skills.length,
      custom: bySource.custom || 0,
      groups: new Set(skills.map((item) => item.primary_group).filter(Boolean)).size,
      cards: Array.isArray(cards) ? cards.length : Number(cards?.total || cards?.items?.length || 0),
      by_source: bySource
    },
    quality: {
      important_structure_ready: Number(qualityReport?.summary?.important_structure_ready || 0),
      important_empirical_ready: Number(qualityReport?.summary?.important_empirical_ready || 0),
      important_skills: Number(qualityReport?.summary?.important_skills || bySource.custom || 0),
      issues: Number(qualityReport?.issues_total || 0),
      generated_at: qualityReport?.generated_at || ""
    },
    projects: {
      total: projects.length,
      items: projects.map((project) => ({
        id: project.project_id || project.id || "",
        name: project.name,
        stack: project.stack || [],
        updated_at: project.updated_at || project.last_synced || ""
      }))
    },
    search: {
      documents: Number(search.indexed_document_count || 0),
      dense_vectors: Number(search.dense_documents || 0),
      pending_dense: Number(search.dense_pending_documents || 0),
      stale: Boolean(search.stale || search.dirty_reason),
      eval_cases: searchEvalCases,
      ranking_version: 2,
      source_fingerprint: search.source_fingerprint || ""
    },
    outcomes: {
      terminal: Number(outcomes.terminal_outcomes || outcomes.events || 0),
      attempts: Number(outcomes.verification_attempts || 0)
    },
    pilots: {
      completed: Number(pilots.summary.total || 0) - Number(pilots.summary.active || 0),
      human_confirmed: Number(pilots.summary.human_confirmed || 0)
    },
    overlays: {
      source_policies: overlaySummary.source_policies,
      specific_overlays: overlaySummary.specific_overlays,
      orphan_overlays: overlaySummary.orphan_overlays.length
    },
    runtime: {
      server_ready: true,
      modular: runtimeLines <= SYSTEM_LINE_CEILING,
      main_lines: runtimeLines,
      line_ceiling: SYSTEM_LINE_CEILING,
      coverage_thresholds: COVERAGE_THRESHOLDS
    }
  };
  snapshot.source_fingerprint = dashboardSourceFingerprint(snapshot);
  return snapshot;
}
