/**
 * The sqlite search index: keeping it fresh, querying it, and merging the
 * hybrid ranking on top of what the Python helper returns.
 *
 * The index itself lives in `09-mcp/search-index/search_cli.py`; this module
 * owns when to rebuild it, what to ask it, and what to do with the answer. Three
 * things make the answer more than a passthrough: the dense query vector, which
 * is embedded here and handed to the helper as a file; the rerankers, which
 * re-order results against the golden cases; and deterministic intent routing,
 * which can put a routed workflow skill above everything the index found.
 *
 * Freshness is tracked, not recomputed: writers call `markDirty()` and the next
 * search rebuilds once. Concurrent searches share one rebuild.
 *
 * Nothing here is pure. The preset resolution and the score explanations that
 * sit around it are in `src/core/search-runtime.mjs`.
 */
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { atomicWriteJson } from "./atomic-files.mjs";
import { csvValue, stripBom } from "./text-format.mjs";

/** How long a fresh-index verdict is trusted before it is checked again. */
const FRESHNESS_CACHE_MS = 1000;

/** Result ceiling per request, whatever the caller asks for. */
const MAX_RESULTS = 50;

/**
 * Create the search index runtime.
 *
 * @param {object} deps
 * @param {string} deps.vaultRoot
 * @param {string} deps.searchCliPath - `search_cli.py`.
 * @param {string} deps.searchIndexDir - Where the sqlite file and scratch live.
 * @param {string} deps.searchIndexPath
 * @param {string} deps.defaultModelDir - Default dense model directory.
 * @param {() => string} deps.pythonCommand - Interpreter for the search helper.
 * @param {() => string} deps.embeddingPythonCommand - Interpreter for dense rebuilds.
 * @param {(target: string) => Promise<boolean>} deps.pathExists
 * @param {(command: string, args: string[], options: object) => Promise<{ stdout: string }>} deps.execFile
 * @param {(payload: object, options?: object) => Promise<object>} deps.embedQuery - Dense query embedding.
 * @param {() => Promise<object[]>} deps.hardNegativeRules - Reranker guardrails.
 * @param {() => Promise<object[]>} deps.readSkillIndex - Registry, for intent routing.
 * @param {object} deps.ranking - Pure ranking collaborators.
 * @returns {object} The runtime.
 */
/**
 * The results, with why the dense half was skipped attached where a caller can
 * find it and `JSON.stringify` cannot trip over it.
 *
 * @param {object[]} results
 * @param {string} issue - "" when dense ran.
 * @returns {object[]}
 */
function withDenseNote(results, issue) {
  if (issue) Object.defineProperty(results, "dense_unavailable", { value: issue, enumerable: false });
  return results;
}

export function createSearchIndexRuntime({
  vaultRoot,
  searchCliPath,
  searchIndexDir,
  searchIndexPath,
  defaultModelDir,
  pythonCommand,
  embeddingPythonCommand,
  pathExists,
  execFile,
  embedQuery,
  hardNegativeRules,
  readSkillIndex,
  ranking
}) {
  const {
    repairSearchMojibake,
    prioritizeKnowledgeResults,
    rerankSearchResults,
    isSkillCatalogQuery,
    routeSkills
  } = ranking;

  let refreshPromise = null;
  let dirtyReason = "";
  let lastStatus = null;
  let lastStatusAt = 0;

  /**
   * Record that something a search would read has changed. The cached freshness
   * verdict is dropped with it, so the next query re-checks rather than trusting
   * a verdict taken before the write.
   */
  function markDirty(reason = "source changed") {
    dirtyReason = String(reason || "source changed");
    lastStatus = null;
    lastStatusAt = 0;
  }

  /** Why the index is considered stale right now, or "". */
  function dirtyReasonNow() {
    return dirtyReason;
  }

  async function runSearchCli(args, { timeoutMs = 600000, command = pythonCommand() } = {}) {
    if (!(await pathExists(searchCliPath))) {
      throw new Error(`Search helper not found: ${searchCliPath}`);
    }

    const output = await execFile(command, [searchCliPath, ...args], { timeoutMs });
    try {
      return JSON.parse(stripBom(output.stdout));
    } catch (err) {
      throw new Error(`Search helper returned invalid JSON: ${err instanceof Error ? err.message : String(err)}\n${output.stdout}`);
    }
  }

  /** What the helper thinks of the index: counts, schema, staleness. */
  async function status({ include_external_project_files = true } = {}) {
    const args = [
      "status",
      "--vault-root",
      vaultRoot,
      "--index-path",
      searchIndexPath
    ];
    if (include_external_project_files) args.push("--include-external-project-files");
    const result = await runSearchCli(args, { timeoutMs: 120000, command: pythonCommand() });
    result.dirty_reason = dirtyReason;
    return result;
  }

  /**
   * Rebuild the index. Dense embeddings are opt-in and expensive; without them
   * the existing dense vectors are preserved by default rather than dropped.
   */
  async function rebuild({
    include_external_project_files = true,
    dense_embeddings = false,
    dense_model_dir = process.env.BGE_M3_MODEL_DIR || defaultModelDir,
    dense_device = process.env.BGE_M3_DEVICE || "cpu",
    dense_batch_size = 8,
    dense_text_limit = 1200,
    dense_include_membrane = false,
    dense_incremental = true,
    preserve_dense = true
  } = {}) {
    await fs.mkdir(searchIndexDir, { recursive: true });
    const args = [
      "rebuild",
      "--vault-root",
      vaultRoot,
      "--index-path",
      searchIndexPath
    ];
    if (include_external_project_files) args.push("--include-external-project-files");
    if (!dense_embeddings && preserve_dense) args.push("--preserve-dense");
    if (dense_embeddings) {
      args.push(
        "--dense-embeddings",
        "--dense-model-dir",
        path.resolve(String(dense_model_dir || defaultModelDir)),
        "--dense-device",
        String(dense_device || "cpu"),
        "--dense-batch-size",
        String(Math.max(1, Math.min(Number(dense_batch_size) || 8, 32))),
        "--dense-text-limit",
        String(Math.max(300, Math.min(Number(dense_text_limit) || 1200, 12000)))
      );
      if (dense_include_membrane) args.push("--dense-include-membrane");
      if (dense_incremental === false) args.push("--no-dense-incremental");
    }
    const rebuilt = await runSearchCli(args, {
      timeoutMs: dense_embeddings ? 3600000 : 600000,
      command: dense_embeddings ? embeddingPythonCommand() : pythonCommand()
    });
    dirtyReason = "";
    lastStatus = null;
    lastStatusAt = 0;
    return rebuilt;
  }

  /**
   * Make sure the index reflects the vault before a query reads it.
   *
   * Concurrent callers share one rebuild, and a recent clean verdict is trusted
   * for a second so a burst of searches does not re-stat the whole vault.
   */
  async function ensureFresh({ force_check = false } = {}) {
    if (refreshPromise) return refreshPromise;

    const now = Date.now();
    if (
      !force_check &&
      !dirtyReason &&
      lastStatus &&
      now - lastStatusAt < FRESHNESS_CACHE_MS
    ) {
      return { action: "current", status: lastStatus };
    }

    const current = await status({ include_external_project_files: true });
    lastStatus = current;
    lastStatusAt = Date.now();
    if (!current.stale && !dirtyReason) {
      return { action: "current", status: current };
    }

    refreshPromise = (async () => {
      const rebuilt = await rebuild({
        include_external_project_files: true,
        dense_embeddings: false,
        preserve_dense: true
      });
      const refreshed = await status({ include_external_project_files: true });
      lastStatus = refreshed;
      lastStatusAt = Date.now();
      dirtyReason = "";
      return { action: "rebuilt", previous_status: current, rebuild: rebuilt, status: refreshed };
    })();

    try {
      return await refreshPromise;
    } finally {
      refreshPromise = null;
    }
  }

  /** Keyword and sparse-semantic search over the index. */
  async function search({
    query,
    scope = "all",
    limit = 10,
    project = "",
    source = "",
    categories = "",
    folders = "",
    ensure_fresh = true
  }) {
    if (!query || typeof query !== "string") {
      throw new Error("query is required.");
    }
    if (ensure_fresh) await ensureFresh();
    return runSearchCli([
      "search",
      "--index-path",
      searchIndexPath,
      "--query",
      query,
      "--scope",
      scope || "all",
      "--limit",
      String(Math.max(1, Math.min(Number(limit) || 10, MAX_RESULTS))),
      "--project",
      project || "",
      "--source",
      csvValue(source),
      "--categories",
      csvValue(categories),
      "--folders",
      csvValue(folders)
    ], { timeoutMs: 120000 });
  }

  /**
   * Hybrid search: keyword, sparse semantic and dense signals combined by the
   * helper, then reranked and optionally routed here.
   *
   * The dense query vector is embedded in this process and passed to the helper
   * as a file, so the helper never loads the model itself. The helper is always
   * asked for 50 results and the caller's limit is applied after reranking —
   * trimming first would hide the candidates reranking exists to promote.
   */
  async function hybridSearch({
    query,
    scope = "all",
    limit = 10,
    project = "",
    source = "",
    categories = "",
    folders = "",
    semantic_weight = 0.20,
    keyword_weight = 0.45,
    dense_weight = 0.35,
    dense_model_dir = process.env.BGE_M3_MODEL_DIR || defaultModelDir,
    dense_device = process.env.BGE_M3_DEVICE || "cpu",
    intent_routing = false,
    rerank = true,
    preset_name = "",
    ensure_fresh = true
  }) {
    if (!query || typeof query !== "string") {
      throw new Error("query is required.");
    }
    const normalizedQuery = repairSearchMojibake(query);
    const requestedLimit = Math.max(1, Math.min(Number(limit) || 10, MAX_RESULTS));
    const selectedDenseWeight = Number.isFinite(Number(dense_weight)) ? Number(dense_weight) : 0.35;
    if (ensure_fresh) await ensureFresh();

    let denseQueryVectorPath = "";
    // Why the dense half did not run, when it did not. Hybrid search is
    // keyword + sparse + dense, and the first two need no model: a missing
    // BGE-M3 used to throw out of here and take the whole search with it,
    // though the documented contract is that dense is the optional part.
    let denseIssue = "";
    if (selectedDenseWeight > 0) {
      try {
        const denseQuery = await embedQuery({
          texts: [normalizedQuery],
          prefix: "query: ",
          normalize: true,
          batch_size: 1,
          precision: 8,
          include_embeddings: true,
          model_dir: dense_model_dir,
          device: dense_device
        }, { timeoutMs: 300000 });
        const vector = denseQuery.embeddings?.[0];
        if (Array.isArray(vector) && vector.length) {
          await fs.mkdir(searchIndexDir, { recursive: true });
          denseQueryVectorPath = path.join(searchIndexDir, `.dense-query-${process.pid}-${Date.now()}.json`);
          await atomicWriteJson(denseQueryVectorPath, vector, { spaces: 0 });
        } else {
          denseIssue = "the embedding backend returned no vector for this query";
        }
      } catch (error) {
        denseIssue = String(error?.message ?? error).replace(/\s+/g, " ").trim();
      }
    }

    const args = [
      "hybrid",
      "--index-path",
      searchIndexPath,
      "--query",
      normalizedQuery,
      "--scope",
      scope || "all",
      "--limit",
      "50",
      "--project",
      project || "",
      "--source",
      csvValue(source),
      "--categories",
      csvValue(categories),
      "--folders",
      csvValue(folders),
      "--semantic-weight",
      String(Number.isFinite(Number(semantic_weight)) ? Number(semantic_weight) : 0.20),
      "--keyword-weight",
      String(Number.isFinite(Number(keyword_weight)) ? Number(keyword_weight) : 0.45),
      "--dense-weight",
      String(selectedDenseWeight),
      "--dense-model-dir",
      path.resolve(String(dense_model_dir || defaultModelDir)),
      "--dense-device",
      String(dense_device || "cpu")
    ];
    if (denseQueryVectorPath) {
      args.push("--dense-query-vector-path", denseQueryVectorPath);
    }

    try {
      const results = await runSearchCli(args, {
        timeoutMs: selectedDenseWeight > 0 ? 300000 : 120000,
        command: pythonCommand()
      });
      let ranked = results;
      if (
        intent_routing
        && ["all", "knowledge"].includes(String(scope || "all"))
        && !project
        && !csvValue(folders)
        && !csvValue(source)
      ) {
        ranked = prioritizeKnowledgeResults(normalizedQuery, ranked);
      }
      if (rerank) {
        ranked = rerankSearchResults(normalizedQuery, ranked, {
          scope,
          preset: preset_name,
          hardNegativeRules: await hardNegativeRules()
        });
      }
      if (!intent_routing || !["all", "skills"].includes(String(scope || "all"))) {
        return withDenseNote(ranked.slice(0, requestedLimit), denseIssue);
      }
      if (project || csvValue(folders)) return withDenseNote(ranked.slice(0, requestedLimit), denseIssue);
      if (isSkillCatalogQuery(normalizedQuery)) return withDenseNote(ranked.slice(0, requestedLimit), denseIssue);
      const selectedSources = new Set(csvValue(source).split(",").map((item) => item.trim().toLowerCase()).filter(Boolean));
      if (selectedSources.size && !selectedSources.has("custom")) return withDenseNote(ranked.slice(0, requestedLimit), denseIssue);

      const route = routeSkills({ task: normalizedQuery, maxSkills: 3 });
      const registry = await readSkillIndex();
      const customByName = new Map(
        registry
          .filter((item) => item.source === "custom")
          .map((item) => [String(item.name || "").toLowerCase(), item])
      );
      const routed = route.skills
        .map((selection, index) => {
          const item = customByName.get(String(selection.name || "").toLowerCase());
          if (!item) return null;
          return {
            scope: "skills",
            title: item.name,
            path: item.path,
            source: item.source,
            categories: Array.isArray(item.categories) ? item.categories.join(", ") : String(item.categories || ""),
            score: Number((2 - index * 0.01).toFixed(6)),
            keyword_score: 0,
            semantic_score: 0,
            dense_score: 0,
            mode: "routed-hybrid",
            preview: item.description || item.use_when || "",
            routing_role: selection.role,
            routing_reason: selection.reason,
            routing_rule: selection.rule,
            retrieval_stage: "deterministic-intent-router"
          };
        })
        .filter(Boolean);
      const routedNames = new Set(routed.map((item) => item.title.toLowerCase()));
      return [...routed, ...ranked.filter((item) => !routedNames.has(String(item.title || "").toLowerCase()))]
        .slice(0, requestedLimit);
    } finally {
      if (denseQueryVectorPath) {
        await fs.rm(denseQueryVectorPath, { force: true }).catch(() => {});
      }
    }
  }

  return { markDirty, dirtyReason: dirtyReasonNow, status, rebuild, ensureFresh, search, hybridSearch };
}
