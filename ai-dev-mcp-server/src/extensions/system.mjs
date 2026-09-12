import fs from "node:fs/promises";
import path from "node:path";
import { SKILL_GROUPS } from "../skill-taxonomy.mjs";
import { summarizeSkillQuality } from "../skill-quality.mjs";
import { summarizeSkillOverlays } from "../core/skill-overlays.mjs";
import {
  dashboardFreshness,
  renderSystemDashboard
} from "../core/system-dashboard.mjs";
import { resolveRuntimeNote } from "../core/runtime-assets.mjs";
import {
  REQUIRED_SYSTEM_NOTES,
  buildSystemSnapshot,
  createHealthReport,
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
  evaluateVaultRoot
} from "../core/system-health.mjs";

const DENSE_SMOKE_QUERY = "создай качественный интерфейс без ИИ слопа по утвержденным референсам";

async function readJsonStrict(target) {
  return JSON.parse((await fs.readFile(target, "utf8")).replace(/^\uFEFF/, ""));
}

function serverSourceDir(host) {
  return path.join(host.serverRoot, "src");
}

/**
 * Read every live source the System Dashboard summarizes and assemble the
 * machine snapshot. All I/O happens here; the shaping is pure
 * (`buildSystemSnapshot`).
 */
async function buildSnapshot(host) {
  const paths = host.vaultPaths;
  const [
    skills,
    cards,
    qualityReport,
    projects,
    search,
    outcomes,
    pilots,
    overlays,
    searchCases,
    runtimeSource
  ] = await Promise.all([
    host.readSkillIndex(),
    host.readJsonIfExists(host.safePath(paths.skillCardsIndex)),
    host.readJsonIfExists(host.safePath(paths.skillQualityIndex)),
    host.projectSummaries({ dedupe: true }),
    host.searchIndexStatus({ include_external_project_files: true }),
    host.skillOutcomeStore.status(),
    host.pilotStore.status(),
    host.readSkillOverlayDocument(),
    host.readSearchEvalCases(),
    fs.readFile(path.join(serverSourceDir(host), "mcp-stdio.mjs"), "utf8")
  ]);
  return buildSystemSnapshot({
    toolCount: host.toolCount(),
    skills,
    cards,
    qualityReport,
    projects,
    search,
    outcomes,
    pilots,
    overlaySummary: summarizeSkillOverlays(overlays, skills),
    searchEvalCases: searchCases.cases.length,
    runtimeLines: runtimeSource.split(/\r?\n/).length
  });
}

async function rebuildSystemDashboard(host, { rebuild_search = false } = {}) {
  const paths = host.vaultPaths;
  const snapshot = await buildSnapshot(host);
  await Promise.all([
    host.writeJson(paths.systemDashboardState, snapshot),
    host.writeText(paths.systemDashboard, renderSystemDashboard(snapshot))
  ]);
  host.markSearchIndexDirty("generated system dashboard updated");
  const searchRebuild = rebuild_search
    ? await host.rebuildSearchIndex({
      include_external_project_files: true,
      dense_embeddings: false,
      preserve_dense: true
    })
    : null;
  return {
    action: "system_dashboard_rebuilt",
    dashboard_path: paths.systemDashboard,
    state_path: paths.systemDashboardState,
    source_fingerprint: snapshot.source_fingerprint,
    snapshot,
    search_rebuilt: Boolean(searchRebuild),
    search: searchRebuild
  };
}

async function systemDashboardStatus(host) {
  const paths = host.vaultPaths;
  const [saved, current] = await Promise.all([
    host.readJsonIfExists(host.safePath(paths.systemDashboardState)),
    buildSnapshot(host)
  ]);
  return {
    dashboard_path: paths.systemDashboard,
    state_path: paths.systemDashboardState,
    generated: Boolean(saved),
    generated_at: saved?.generated_at || "",
    freshness: dashboardFreshness(saved, current),
    current,
    next_step: saved && dashboardFreshness(saved, current).fresh
      ? "Dashboard is current."
      : "Run rebuild_system_dashboard."
  };
}

/**
 * Run the health checks in a fixed order. Each check fetches what it needs
 * through `host` and hands the raw status to a pure evaluator; a check that
 * throws is recorded as a failure rather than aborting the run.
 */
async function systemHealthCheck(host, {
  include_search_smoke = true,
  include_dense_smoke = false,
  include_embedding_status = true,
  include_registry = true,
  include_skill_cards = true,
  include_projects = true,
  include_auto_commands = true,
  include_presets = true,
  include_search_eval = false,
  smoke_limit = 2
} = {}) {
  const paths = host.vaultPaths;
  const report = createHealthReport();
  const safeSmokeLimit = Math.max(1, Math.min(Number(smoke_limit) || 2, 5));

  await report.runCheck("vault_root", true, async () => (
    evaluateVaultRoot(await host.fileStatus(host.vaultRoot))
  ));

  await report.runCheck("required_notes", false, async () => {
    const files = [];
    for (const relative of REQUIRED_SYSTEM_NOTES) {
      // The vault layout first, then this repository's own — the same two
      // layouts the helper trees are resolved through (`runtime-assets.mjs`).
      const resolved = resolveRuntimeNote({
        relative,
        vaultRoot: host.vaultRoot,
        repositoryRoot: host.serverRoot ? path.resolve(host.serverRoot, "..") : host.vaultRoot
      });
      const status = await host.fileStatus(resolved.path);
      files.push({
        relative_path: relative,
        path: resolved.path,
        source: resolved.source,
        exists: status.exists,
        size_bytes: status.size_bytes || 0
      });
    }
    return evaluateRequiredNotes(files);
  });

  await report.runCheck("search_index_file", true, async () => (
    evaluateSearchIndexFile(await host.fileStatus(host.searchIndexPath))
  ));

  await report.runCheck("search_index_freshness", false, async () => (
    evaluateSearchIndexFreshness(await host.searchIndexStatus({ include_external_project_files: true }))
  ));

  await report.runCheck("frontend_qa_runner", false, async () => evaluateFrontendQaRunner({
    runner: await host.fileStatus(host.frontendQaRunnerPath),
    manifest: await host.fileStatus(host.frontendQaPackagePath),
    artifactsRoot: host.frontendQaArtifactsRoot
  }));

  await report.runCheck("frontend_qa_environment", false, async () => (
    evaluateFrontendQaEnvironment(await host.frontendQaEnvironmentStatus())
  ));

  if (include_embedding_status) {
    await report.runCheck("embedding_backend", true, async () => (
      evaluateEmbeddingBackend(await host.embeddingStatus({}))
    ));
  } else {
    report.skip("embedding_backend", true, "Embedding status check skipped.");
  }

  if (include_registry) {
    await report.runCheck("skill_registry", true, async () => evaluateSkillRegistry(await host.readSkillIndex()));
    await report.runCheck("skill_taxonomy", true, async () => evaluateSkillTaxonomy({
      registry: await host.readSkillGroupsIndex({ rebuildIfMissing: false }),
      items: await host.readSkillIndex(),
      groupIds: SKILL_GROUPS.map((group) => group.id),
      indexPath: paths.skillGroupsIndex,
      skillsMapPath: paths.skillsMap
    }));
    await report.runCheck("skill_visual_graph", true, async () => {
      const registryPath = host.safePath(paths.skillGraphIndex);
      if (!(await host.pathExists(registryPath))) {
        return evaluateSkillVisualGraph({ registry: null, markdownFiles: 0, indexPath: paths.skillGraphIndex });
      }
      const registry = await readJsonStrict(registryPath);
      const files = await host.listMarkdownFiles(host.safePath(paths.skillGraphPages));
      return evaluateSkillVisualGraph({ registry, markdownFiles: files.length, indexPath: paths.skillGraphIndex });
    });
    await report.runCheck("skill_quality", true, async () => evaluateSkillQuality({
      quality: summarizeSkillQuality(await host.readSkillIndex()),
      reportExists: await host.pathExists(host.safePath(paths.skillQualityIndex)),
      reportPath: paths.skillQualityIndex,
      dashboardPath: paths.skillQualityDashboard
    }));
    await report.runCheck("skill_routing_benchmark", true, async () => {
      const reportPath = host.safePath(paths.skillRoutingReport);
      // Where the cases actually are, not where a report says they are: in a
      // checkout the vault-relative path points into a seed that has no
      // `09-mcp/`, so the file the benchmark reads never aged the report.
      const casesPath = host.skillRoutingEvalCasesPath || host.safePath(paths.skillRoutingEvalCases);
      const routerPath = path.join(serverSourceDir(host), "core", "skill-router.mjs");
      const reportStatus = await host.fileStatus(reportPath);
      if (!reportStatus.exists) {
        return evaluateSkillRoutingBenchmark({
          report: null,
          reportPath: paths.skillRoutingReport,
          casesPath: paths.skillRoutingEvalCases
        });
      }
      const [casesStatus, routerStatus] = await Promise.all([
        host.fileStatus(casesPath),
        host.fileStatus(routerPath)
      ]);
      return evaluateSkillRoutingBenchmark({
        report: await readJsonStrict(reportPath),
        reportMtime: reportStatus.mtime,
        inputMtimes: [casesStatus.mtime, routerStatus.mtime],
        reportPath: paths.skillRoutingReport,
        casesPath: paths.skillRoutingEvalCases
      });
    });
    await report.runCheck("skill_outcomes", false, async () => {
      const outcomes = await host.skillOutcomeStore.status();
      const items = await host.readSkillIndex();
      return evaluateSkillOutcomes({
        outcomes,
        registryValidated: items.filter((item) => item.source === "custom" && item.empirical_status === "pass").length,
        statePath: path.join(host.taskStateRoot, "skill-outcomes.json")
      });
    });
  } else {
    report.skip("skill_registry", true, "Skill registry check skipped.");
    report.skip("skill_taxonomy", true, "Skill taxonomy check skipped.");
    report.skip("skill_visual_graph", true, "Skill visual graph check skipped.");
    report.skip("skill_quality", true, "Skill quality check skipped.");
    report.skip("skill_routing_benchmark", true, "Skill routing benchmark check skipped.");
    report.skip("skill_outcomes", false, "Skill outcome check skipped.");
  }

  if (include_skill_cards) {
    await report.runCheck("skill_cards", false, async () => evaluateSkillCards({
      cards: await host.readSkillCardsIndex({ syncIfMissing: false }),
      indexPath: paths.skillCardsIndex,
      catalogPath: paths.skillCardsCatalog
    }));
  } else {
    report.skip("skill_cards", false, "Skill cards check skipped.");
  }

  if (include_projects) {
    await report.runCheck("project_registry", false, async () => evaluateProjectRegistry(await host.listProjects()));
  } else {
    report.skip("project_registry", false, "Project registry check skipped.");
  }

  if (include_auto_commands) {
    await report.runCheck("auto_commands", true, async () => evaluateAutoCommands(host.listAutoCommands()));
  } else {
    report.skip("auto_commands", true, "Auto-command check skipped.");
  }

  if (include_presets) {
    await report.runCheck("search_presets", true, async () => evaluateSearchPresets(host.listSearchPresets()));
  } else {
    report.skip("search_presets", true, "Search preset check skipped.");
  }

  if (include_search_smoke) {
    await report.runCheck("search_smoke", true, async () => evaluateSearchSmoke(await host.searchIndex({
      query: "Project Bootstrap AGENTS quality gate",
      scope: "all",
      limit: safeSmokeLimit,
      ensure_fresh: false
    })));
    await report.runCheck("hybrid_smoke_no_dense", true, async () => evaluateHybridSmoke(await host.hybridSearchIndex({
      query: "frontend design skill",
      scope: "all",
      limit: safeSmokeLimit,
      dense_weight: 0,
      ensure_fresh: false
    })));
  } else {
    report.skip("search_smoke", true, "Search smoke checks skipped.");
  }

  if (include_dense_smoke) {
    await report.runCheck("dense_smoke", true, async () => evaluateDenseSmoke(await host.hybridSearchIndex({
      query: DENSE_SMOKE_QUERY,
      scope: "knowledge",
      limit: safeSmokeLimit,
      keyword_weight: 0.25,
      semantic_weight: 0.25,
      dense_weight: 0.50,
      ensure_fresh: false
    })));
  } else {
    report.skip("dense_smoke", false, "Dense smoke skipped. Set include_dense_smoke=true to test BGE-M3 end-to-end.");
  }

  if (include_search_eval) {
    await report.runCheck("search_eval", true, async () => (
      evaluateSearchEval(await host.runSearchEval({ include_dense: false, max_cases: 10 }))
    ));
  } else {
    report.skip("search_eval", false, "Search eval skipped. Set include_search_eval=true to run golden cases without dense scoring.");
  }

  return report.finish();
}

/**
 * System tools: the health check that exercises vault paths, registries,
 * search and the embedding backend, plus the System Dashboard snapshot the
 * vault renders from live MCP, skill, project, search, outcome, pilot and
 * overlay state.
 *
 * Everything the checks read comes through `host`; the verdicts themselves are
 * pure functions in `src/core/system-health.mjs`.
 *
 * @param {object} host - Shared runtime services from `mcp-stdio.mjs`.
 */
export function createSystemTools(host) {
  return {
    definitions: [
      {
        name: "system_health_check",
        description: "Run an AI Dev System health check for vault paths, search index, skill/project registries, search presets, BGE-M3 backend, worker state, and optional search smoke tests.",
        inputSchema: {
          type: "object",
          properties: {
            include_search_smoke: { type: "boolean", default: true },
            include_dense_smoke: { type: "boolean", default: false },
            include_embedding_status: { type: "boolean", default: true },
            include_registry: { type: "boolean", default: true },
            include_skill_cards: { type: "boolean", default: true },
            include_projects: { type: "boolean", default: true },
            include_auto_commands: { type: "boolean", default: true },
            include_presets: { type: "boolean", default: true },
            include_search_eval: { type: "boolean", default: false },
            smoke_limit: { type: "number", default: 2 }
          }
        }
      },
      {
        name: "rebuild_system_dashboard",
        description: "Regenerate the Obsidian System Dashboard and machine snapshot from live MCP, skill, project, search, outcome, pilot, and overlay state.",
        inputSchema: {
          type: "object",
          properties: {
            rebuild_search: { type: "boolean", default: false }
          }
        }
      },
      {
        name: "system_dashboard_status",
        description: "Compare the generated System Dashboard fingerprint with current runtime and registry sources.",
        inputSchema: {
          type: "object",
          properties: {}
        }
      }
    ],
    handlers: {
      system_health_check: (args) => systemHealthCheck(host, args),
      rebuild_system_dashboard: (args) => rebuildSystemDashboard(host, args),
      system_dashboard_status: () => systemDashboardStatus(host)
    },
    readOnly: ["system_health_check", "system_dashboard_status"]
  };
}
