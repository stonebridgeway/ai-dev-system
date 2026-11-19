import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createExtensionTools } from "../tool-extensions.mjs";
import { SKILL_GROUPS } from "../skill-taxonomy.mjs";
import { SKILL_SCHEMA_VERSION } from "../skill-quality.mjs";
import { createSkillOverlayDocument } from "../core/skill-overlays.mjs";
import { resolvePythonCommand } from "../core/python-command.mjs";
import { REQUIRED_SEARCH_PRESETS, REQUIRED_SYSTEM_NOTES } from "../core/system-health.mjs";
import { createSystemTools } from "./system.mjs";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const VAULT_PATHS = {
  skillCardsIndex: "registries/skill-cards.index.json",
  skillCardsCatalog: "registries/SKILL_CARDS.md",
  skillGroupsIndex: "registries/skill-groups.index.json",
  skillsMap: "groups/Skills Map.md",
  skillGraphIndex: "registries/skill-graph.index.json",
  skillGraphPages: "groups/all-skills",
  skillQualityIndex: "registries/skill-quality.index.json",
  skillQualityDashboard: "Skill Quality Dashboard.md",
  skillRoutingReport: "registries/skill-routing-eval.json",
  skillRoutingEvalCases: "search-eval/skill_routing_eval_cases.json",
  systemDashboard: "System Dashboard.md",
  systemDashboardState: "system-dashboard.json"
};

const SKILLS = [
  {
    name: "feature-builder", source: "custom", primary_group: SKILL_GROUPS[0].id,
    skill_schema_version: SKILL_SCHEMA_VERSION, structure_status: "pass", empirical_status: "pass"
  },
  {
    name: "browser-qa", source: "membrane/application-skills", primary_group: SKILL_GROUPS[0].id,
    skill_schema_version: SKILL_SCHEMA_VERSION
  }
];

async function writeJsonFile(target, value) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(value, null, 2), "utf8");
}

/**
 * A vault-shaped fixture plus a host that answers every service the system
 * extension asks for, so the checks and the dashboard run without the real
 * vault, search index, or embedding backend.
 */
async function createFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "system-tools-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const vaultRoot = path.join(root, "vault");
  const safePath = (relative) => path.join(vaultRoot, relative);

  for (const relative of REQUIRED_SYSTEM_NOTES) {
    await fs.mkdir(path.dirname(safePath(relative)), { recursive: true });
    await fs.writeFile(safePath(relative), `# ${relative}\n`, "utf8");
  }
  await fs.writeFile(path.join(root, "ai-dev-search.sqlite"), "sqlite", "utf8");
  await fs.writeFile(path.join(root, "frontend_qa_runner.mjs"), "export default 1;\n", "utf8");
  await writeJsonFile(path.join(root, "package.json"), { name: "frontend-qa" });
  await writeJsonFile(safePath(VAULT_PATHS.skillQualityIndex), { summary: {}, issues_total: 0 });
  await writeJsonFile(safePath(VAULT_PATHS.skillGraphIndex), {
    total_skills: 2, linked_unique_skills: 2, page_size: 80, batch_pages: 1, group_hubs: 1, bucket_hubs: 1,
    root_note: "all-skills.md"
  });
  // The skill_routing_benchmark check calls a report older than its inputs
  // stale, which fails a critical check and turns the whole health status into
  // "fail". Two things keep the fixture out of that state: the eval cases are
  // written first, and the report's mtime is pinned a minute ahead — ordering
  // alone still left the two in the same millisecond under a loaded test run.
  await writeJsonFile(safePath(VAULT_PATHS.skillRoutingEvalCases), { cases: [] });
  await writeJsonFile(safePath(VAULT_PATHS.skillRoutingReport), {
    status: "pass", summary: { passed: 3, total: 3, failed: 0 }, generated_at: "2026-02-01T00:00:00.000Z"
  });
  const reportFreshAt = new Date(Date.now() + 60_000);
  await fs.utimes(safePath(VAULT_PATHS.skillRoutingReport), reportFreshAt, reportFreshAt);
  await fs.mkdir(safePath(VAULT_PATHS.skillGraphPages), { recursive: true });
  for (const name of ["all-skills.md", "group.md", "bucket.md", "page-1.md"]) {
    await fs.writeFile(path.join(safePath(VAULT_PATHS.skillGraphPages), name), "# page\n", "utf8");
  }

  const calls = [];
  const host = {
    // The security_scanners check asks the host which binaries exist, so the
    // fixture answers for a machine with all of them rather than for whichever
    // machine runs the suite. It also asks a subcommand scanner whether its
    // plugin is really there, and that goes through the
    // host too — otherwise this unit test spawns a real `cargo` and its answer
    // depends on the machine running the suite.
    locateExecutable: async (executable) => `/usr/bin/${executable}`,
    runProcess: async (options) => {
      calls.push({ tool: "runProcess", options });
      if (options.args?.[0] === "--version" && /python/.test(options.executable)) {
        return { ok: true, exitCode: 0, stdout: "Python 3.12.1\n", stderr: "", timedOut: false };
      }
      return { ok: true, exitCode: 0, stdout: "cargo-audit-audit 0.21.0", stderr: "", timedOut: false };
    },
    vaultRoot,
    serverRoot,
    taskStateRoot: path.join(root, "state"),
    vaultPaths: VAULT_PATHS,
    searchIndexPath: path.join(root, "ai-dev-search.sqlite"),
    frontendQaRunnerPath: path.join(root, "frontend_qa_runner.mjs"),
    frontendQaPackagePath: path.join(root, "package.json"),
    frontendQaArtifactsRoot: path.join(root, "artifacts"),
    toolCount: () => 115,
    safePath,
    async fileStatus(target) {
      try {
        const stat = await fs.stat(target);
        return {
          exists: true, path: target, size_bytes: stat.size,
          mtime: stat.mtime.toISOString(), is_directory: stat.isDirectory()
        };
      } catch {
        return { exists: false, path: target };
      }
    },
    pathExists: (target) => fs.access(target).then(() => true, () => false),
    async readJsonIfExists(target) {
      try {
        return JSON.parse(await fs.readFile(target, "utf8"));
      } catch {
        return null;
      }
    },
    writeJson: (relative, value) => writeJsonFile(safePath(relative), value),
    async writeText(relative, value) {
      await fs.mkdir(path.dirname(safePath(relative)), { recursive: true });
      await fs.writeFile(safePath(relative), value, "utf8");
    },
    listMarkdownFiles: (target) => fs.readdir(target).then((names) => names.filter((name) => name.endsWith(".md"))),
    readSkillIndex: async () => SKILLS,
    readSkillGroupsIndex: async () => ({ schema_version: 3, groups: [{ id: SKILL_GROUPS[0].id, count: 2 }] }),
    readSkillCardsIndex: async () => [{ name: "feature-builder", source: "custom" }],
    readSkillOverlayDocument: async () => createSkillOverlayDocument(),
    readSearchEvalCases: async () => ({ path: "cases.json", cases: [{ id: "one" }, { id: "two" }] }),
    projectSummaries: async () => [{ project_id: "p-1", name: "One", stack: ["Node.js"], updated_at: "2026-02-02" }],
    listProjects: async () => [{ name: "One", project_path: "/p/1", card_path: "One.md", status: "registered" }],
    listAutoCommands: () => [{ name: "ship-feature" }],
    listSearchPresets: () => REQUIRED_SEARCH_PRESETS.map((name) => ({ name })),
    searchIndexStatus: async () => ({ stale: false, current_document_count: 12, indexed_document_count: 12, dense_documents: 4 }),
    rebuildSearchIndex: async (options) => {
      calls.push(["rebuildSearchIndex", options]);
      return { rebuilt: true };
    },
    searchIndex: async () => [{ title: "One", path: "one.md", scope: "all", score: 3 }],
    hybridSearchIndex: async (options) => [{
      title: "Two", path: "two.md", scope: options.scope, score: 4, dense_score: options.dense_weight ? 0.7 : 0
    }],
    runSearchEval: async () => ({
      status: "ok", include_dense: false, cases_path: "cases.json",
      summary: { passed: 2, failed: 0, skipped: 0 }, cases: []
    }),
    embeddingStatus: async () => ({
      backend: "onnx", dense_model: "BAAI/bge-m3", dense_dimensions: 1024, model_dir: "/models/bge-m3-onnx",
      installed: true, available: true, partial: [], worker: { started: false },
      dense_backend: {
        backend: "onnx", available: true, reason: "The verified ONNX export is on disk; no Python is involved.",
        onnx: { ready: true, dir: "/models/bge-m3-onnx", export: "Xenova/bge-m3", revision: "4de13258303883538bd53b696b452bf8099f0858", dtype: "int8", missing: [], mismatched: [] },
        legacy: { notes: [], command: "" }
      }
    }),
    frontendQaEnvironmentStatus: async () => ({
      playwright_available: true, chromium_available: true, browser_launch_ok: true, playwright_source: "vault"
    }),
    skillOutcomeStore: { status: async () => ({ events: 1, skills_observed: 1, empirically_validated: 1 }) },
    pilotStore: { status: async () => ({ summary: { total: 2, active: 1, human_confirmed: 1 } }) },
    markSearchIndexDirty: (reason) => calls.push(["markSearchIndexDirty", reason])
  };

  return { root, vaultRoot, host, calls, registry: createExtensionTools(host, [createSystemTools]) };
}

test("system tools expose the three system contracts with read-only hints", async (t) => {
  const { registry } = await createFixture(t);
  assert.deepEqual(registry.definitions.map((definition) => definition.name), [
    "system_health_check",
    "rebuild_system_dashboard",
    "system_dashboard_status"
  ]);
  assert.deepEqual(registry.readOnly, ["system_health_check", "system_dashboard_status"]);
  for (const definition of registry.definitions) assert.equal(definition.inputSchema.type, "object");
});

test("health check runs every check through the host", async (t) => {
  const { registry } = await createFixture(t);
  const result = await registry.handlers.get("system_health_check")({});

  assert.deepEqual(result.checks.map((check) => check.name), [
    "vault_root", "runtime_home", "required_notes", "search_index_file", "search_index_freshness", "frontend_qa_runner",
    "frontend_qa_environment", "security_scanners", "ui_ux_knowledge", "embedding_backend", "skill_registry", "skill_taxonomy",
    "skill_visual_graph", "skill_quality", "skill_routing_benchmark", "skill_outcomes", "skill_cards",
    "project_registry", "auto_commands", "search_presets", "search_smoke", "hybrid_smoke_no_dense",
    "dense_smoke", "search_eval"
  ]);
  const failing = result.checks.filter((check) => check.status !== "ok" && check.status !== "skipped");
  assert.deepEqual(failing, [], `unexpected non-ok checks: ${JSON.stringify(failing)}`);
  assert.equal(result.status, "ok");
  assert.deepEqual(result.summary, { ok: 22, warn: 0, fail: 0, skipped: 2 });
  const uiUx = result.checks.find((check) => check.name === "ui_ux_knowledge");
  assert.deepEqual([uiUx.status, uiUx.details.version, uiUx.details.command], ["ok", "3.12.1", resolvePythonCommand()]);
  assert.match(uiUx.summary, /^query_ui_ux_knowledge and generate_ui_ux_design_system run their helper with .*\(Python 3\.12\.1\)/);
  const scanners = result.checks.find((check) => check.name === "security_scanners");
  assert.match(scanners.summary, /10 of 10 security scanners installed/);
  assert.equal(result.recommendations.length, 1);
  assert.match(result.recommendations[0], /include_dense_smoke=true/);
});

// Nothing told a user that this machine cannot run a single scanner, so
// `run_security_scan` came back empty and nobody knew why until they read it.
test("a machine with no security scanner installed is warned about, not failed", async (t) => {
  const { calls, host, registry } = await createFixture(t);
  host.locateExecutable = async () => "";
  const result = await registry.handlers.get("system_health_check")({});

  const check = result.checks.find((item) => item.name === "security_scanners");
  assert.equal(check.status, "warn");
  assert.equal(check.critical, false, "a gap in tooling is not a broken system");
  assert.match(check.summary, /None of the 10 security scanners is installed/);
  assert.deepEqual(check.details.installed, []);
  // Nothing on the PATH means nothing to probe either.
  assert.equal(calls.some((call) => call?.tool === "runProcess"), false);
  // Non-critical, so the run is degraded rather than failed, and the warning is
  // repeated where a reader looks for what to do next.
  assert.equal(result.status, "degraded");
  assert.ok(result.recommendations.some((item) => item.includes("security_scanners")));
});

test("health check honours the include flags and the smoke limit", async (t) => {
  const { host, registry } = await createFixture(t);
  const limits = [];
  host.searchIndex = async (options) => {
    limits.push(options.limit);
    return [{ title: "One", path: "one.md", scope: "all", score: 1 }];
  };
  const result = await registry.handlers.get("system_health_check")({
    include_embedding_status: false,
    include_registry: false,
    include_skill_cards: false,
    include_projects: false,
    include_auto_commands: false,
    include_presets: false,
    include_dense_smoke: true,
    include_search_eval: true,
    smoke_limit: 99
  });

  const byName = Object.fromEntries(result.checks.map((check) => [check.name, check.status]));
  for (const name of [
    "embedding_backend", "skill_registry", "skill_taxonomy", "skill_visual_graph", "skill_quality",
    "skill_routing_benchmark", "skill_outcomes", "skill_cards", "project_registry", "auto_commands", "search_presets"
  ]) {
    assert.equal(byName[name], "skipped", name);
  }
  assert.equal(byName.dense_smoke, "ok");
  assert.equal(byName.search_eval, "ok");
  assert.deepEqual(limits, [5]);
  assert.equal(result.recommendations.length, 0);
});

test("without the model the dense smoke is not advised, and asked for it fails with the reason", async (t) => {
  const { host, registry } = await createFixture(t);
  const reason = "Dense search is not installed: the model is not on this machine. Run `npm run setup -- --model` to download it.";
  host.embeddingStatus = async () => ({
    backend: "onnx", installed: false, available: false, reason, partial: [], worker: { started: false },
    dense_backend: { backend: "onnx", available: false, reason, onnx: { ready: false, dir: "/m", missing: ["config.json"], mismatched: [] }, legacy: { notes: [], command: "" } }
  });
  let denseQueries = 0;
  host.hybridSearchIndex = async (options) => {
    if (options.dense_weight) denseQueries += 1;
    return [{ title: "Two", path: "two.md", scope: options.scope, score: 4, dense_score: 0 }];
  };
  const quiet = await registry.handlers.get("system_health_check")({});
  assert.equal(quiet.checks.find((check) => check.name === "embedding_backend").status, "skipped");
  assert.equal(quiet.status, "ok", "an install without the optional model is healthy");
  assert.equal(quiet.recommendations.some((item) => /include_dense_smoke/.test(item)), false);
  const asked = await registry.handlers.get("system_health_check")({ include_dense_smoke: true });
  const smoke = asked.checks.find((check) => check.name === "dense_smoke");
  assert.equal(smoke.status, "fail");
  assert.equal(smoke.summary, `Dense search cannot run here, so the smoke test had nothing to test. ${reason}`);
  assert.equal(denseQueries, 0, "no dense query is sent to a model that is not there");
});

test("a check that throws is recorded as a failure instead of aborting the run", async (t) => {
  const { host, registry } = await createFixture(t);
  host.searchIndexStatus = async () => {
    throw new Error("Search helper not found");
  };
  const result = await registry.handlers.get("system_health_check")({ include_search_smoke: false });
  const freshness = result.checks.find((check) => check.name === "search_index_freshness");
  assert.equal(freshness.status, "fail");
  assert.equal(freshness.summary, "Search helper not found");
  assert.deepEqual(freshness.details, { message: "Search helper not found", name: "Error" });
  assert.equal(result.status, "degraded");
});

test("missing generated registries fail their checks with the vault path", async (t) => {
  const { vaultRoot, registry } = await createFixture(t);
  await fs.rm(path.join(vaultRoot, VAULT_PATHS.skillGraphIndex));
  await fs.rm(path.join(vaultRoot, VAULT_PATHS.skillRoutingReport));
  const result = await registry.handlers.get("system_health_check")({ include_search_smoke: false });
  const graph = result.checks.find((check) => check.name === "skill_visual_graph");
  const benchmark = result.checks.find((check) => check.name === "skill_routing_benchmark");
  assert.equal(graph.status, "fail");
  assert.deepEqual(graph.details, { path: VAULT_PATHS.skillGraphIndex });
  assert.equal(benchmark.status, "fail");
  assert.equal(benchmark.details.report_path, VAULT_PATHS.skillRoutingReport);
  assert.equal(result.status, "fail");
});

test("the benchmark ages against the cases file the runtime actually reads", async (t) => {
  // In a checkout the golden cases are outside the seed that stands in for a
  // vault, so the vault-relative path in the report points at nothing: editing
  // the cases left the health check saying "fresh" and nobody was ever told to
  // rerun the benchmark. Measured on this repository before the fix.
  const { vaultRoot, host, registry } = await createFixture(t);
  const elsewhere = path.join(vaultRoot, "..", "outside", "skill_routing_eval_cases.json");
  await fs.mkdir(path.dirname(elsewhere), { recursive: true });
  await writeJsonFile(elsewhere, { cases: [] });
  host.skillRoutingEvalCasesPath = elsewhere;
  // Newer than the report the fixture wrote, which is what a person editing
  // their golden cases produces.
  const later = new Date(Date.now() + 60_000);
  await fs.utimes(elsewhere, later, later);

  const result = await registry.handlers.get("system_health_check")({ include_search_smoke: false });
  const benchmark = result.checks.find((check) => check.name === "skill_routing_benchmark");
  assert.equal(benchmark.status, "fail");
  assert.equal(benchmark.details.fresh, false);
  assert.match(benchmark.summary, /stale/);
  // The report still names the layout rather than someone's absolute path.
  assert.equal(benchmark.details.cases_path, VAULT_PATHS.skillRoutingEvalCases);
});

test("dashboard rebuild writes the note and snapshot, and status compares fingerprints", async (t) => {
  const { vaultRoot, host, calls, registry } = await createFixture(t);

  const stale = await registry.handlers.get("system_dashboard_status")({});
  assert.equal(stale.generated, false);
  assert.equal(stale.generated_at, "");
  assert.equal(stale.next_step, "Run rebuild_system_dashboard.");
  assert.equal(stale.current.tools.total, 115);
  assert.equal(stale.current.skills.total, 2);
  assert.equal(stale.current.search.eval_cases, 2);
  assert.equal(stale.current.pilots.completed, 1);
  assert.ok(stale.current.runtime.main_lines > 0);

  const rebuilt = await registry.handlers.get("rebuild_system_dashboard")({});
  assert.equal(rebuilt.action, "system_dashboard_rebuilt");
  assert.equal(rebuilt.search_rebuilt, false);
  assert.equal(rebuilt.search, null);
  assert.equal(rebuilt.source_fingerprint, rebuilt.snapshot.source_fingerprint);
  assert.deepEqual(calls.filter(Array.isArray), [["markSearchIndexDirty", "generated system dashboard updated"]]);
  const markdown = await fs.readFile(path.join(vaultRoot, VAULT_PATHS.systemDashboard), "utf8");
  assert.match(markdown, /115 tools/);
  // The runtime rows are the health checks as they ran, without the
  // ones the dashboard does not run.
  const checked = rebuilt.snapshot.checks.map((check) => check.name);
  assert.ok(checked.includes("vault_root") && checked.includes("skill_registry"), checked.join(", "));
  assert.ok(!checked.includes("dense_smoke") && !checked.includes("search_eval"));
  assert.match(markdown, /\| Vault root \| Ready \| Vault root exists\. \|/);
  assert.doesNotMatch(markdown, /Search Ranking v2|Reference Factory v2/);
  const saved = JSON.parse(await fs.readFile(path.join(vaultRoot, VAULT_PATHS.systemDashboardState), "utf8"));
  assert.equal(saved.source_fingerprint, rebuilt.source_fingerprint);

  const fresh = await registry.handlers.get("system_dashboard_status")({});
  assert.equal(fresh.generated, true);
  assert.equal(fresh.freshness.fresh, true);
  assert.equal(fresh.next_step, "Dashboard is current.");

  host.toolCount = () => 116;
  const drifted = await registry.handlers.get("system_dashboard_status")({});
  assert.equal(drifted.freshness.fresh, false);
  assert.equal(drifted.next_step, "Run rebuild_system_dashboard.");
});

test("before setup the dashboard says what to run, not which file is missing", async (t) => {
  const { host, registry } = await createFixture(t);
  host.readSkillIndex = async () => {
    const error = new Error("ENOENT: no such file or directory, open '/vault/03-skills-catalog/registries/skills.index.json'");
    Object.assign(error, { code: "ENOENT", path: "/vault/03-skills-catalog/registries/skills.index.json" });
    throw error;
  };
  for (const tool of ["rebuild_system_dashboard", "system_dashboard_status"]) {
    await assert.rejects(registry.handlers.get(tool)({}), /^Error: The skill registry is not built yet \(\/vault\/03-skills-catalog\/registries\/skills\.index\.json\): run `ai-dev setup` first\./, tool);
  }
  host.readSkillIndex = async () => {
    throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
  };
  await assert.rejects(registry.handlers.get("rebuild_system_dashboard")({}), /EACCES/, "another failure is told as it is");
});

test("rebuild_system_dashboard can chain a search index rebuild", async (t) => {
  const { calls, registry } = await createFixture(t);
  const result = await registry.handlers.get("rebuild_system_dashboard")({ rebuild_search: true });
  assert.equal(result.search_rebuilt, true);
  assert.deepEqual(result.search, { rebuilt: true });
  assert.deepEqual(calls.filter(Array.isArray)[1], ["rebuildSearchIndex", {
    include_external_project_files: true,
    dense_embeddings: false,
    preserve_dense: true
  }]);
});
