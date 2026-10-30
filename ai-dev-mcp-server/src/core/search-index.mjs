/**
 * The sqlite search index: keeping it fresh, querying it, and the ranking that
 * sits on top of what it finds.
 *
 * Everything runs on `node:sqlite` (Node 22.16+ and 24+, where it has FTS5):
 * status, rebuilds and dense vectors (`search-store.mjs`), keyword search
 * (`search-query.mjs`), hybrid search (`search-hybrid.mjs`), the galaxy export
 * (`galaxy-export.mjs`) and `search_knowledge` (`search-knowledge.mjs`). The
 * Python helper that did all of this in 2.x is gone; the file it wrote is the
 * file this reads and writes, to the byte. A Node without FTS5 gets an error
 * that says which Node it needs, not a fallback.
 *
 * Three things make a hybrid answer more than a lookup: the dense query vector,
 * embedded here by whichever backend is installed; the rerankers, which
 * re-order results against the golden cases; and deterministic intent routing,
 * which can put a routed workflow skill above everything the index found.
 *
 * Freshness is tracked, not recomputed: writers call `markDirty()` and the next
 * search refreshes once, in place, rewriting only what changed. Concurrent
 * searches share one refresh.
 *
 * The engine — what is asked of the index file — is an object of its own
 * ({@link createNodeSearchEngine}), so the runtime's own logic is tested against
 * a stand-in. The preset resolution and the score explanations around it are in
 * `src/core/search-runtime.mjs`.
 */
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { DENSE_COMMIT_EVERY, denseCoverage, embedDensePlan } from "./dense-index.mjs";
import { exportGalaxy } from "./galaxy-export.mjs";
import { createDocumentCache } from "./search-documents.mjs";
import { createHybridCache, hybridSearch as rankHybrid } from "./search-hybrid.mjs";
import { createKnowledgeCache, knowledgeSearch } from "./search-knowledge.mjs";
import { keywordSearch, MAX_RESULTS } from "./search-query.mjs";
import { createIndexReader, sqliteSupport } from "./search-sqlite.mjs";
import { densePlan, indexStatus, rebuildIndex, storeDenseVectors } from "./search-store.mjs";
import { csvValue } from "./text-format.mjs";
import { hint } from "./install-layout.mjs";

/** Which index file a vault reads and writes (`search-index-owner.mjs`). */
export { vaultIndexPath } from "./search-index-owner.mjs";

/** How long a fresh-index verdict is trusted before it is checked again. */
const FRESHNESS_CACHE_MS = 1000;

/**
 * Why search cannot run on this Node, as the error a caller sees; null when it can.
 *
 * @param {{ support?: () => { available: boolean, reason: string }, version?: string }} [options]
 * @returns {string|null}
 */
export function searchUnavailableReason({ support = sqliteSupport, version = process.version } = {}) {
  const { available, reason } = support();
  if (available) return null;
  return `Search needs Node.js 22.16 or newer (or 24+), where node:sqlite has FTS5; this is Node ${version}: ${reason}`;
}

/**
 * What the runtime asks of the index file, on `node:sqlite`.
 *
 * @param {{ vaultRoot: string, searchIndexPath: string, env?: NodeJS.ProcessEnv }} deps
 */
export function createNodeSearchEngine({ vaultRoot, searchIndexPath, env = process.env }) {
  const documentCache = createDocumentCache();
  // Parsed vectors and lowered texts, kept between searches.
  const hybridCache = createHybridCache();
  const knowledgeCache = createKnowledgeCache();
  let indexReader = null;

  /** The long-lived read connection searches go through. */
  function reader() {
    indexReader ??= createIndexReader(searchIndexPath);
    return indexReader;
  }

  /** Let go of the file, so a damaged one can be renamed away even on Windows. */
  function closeReader() {
    indexReader?.close();
    indexReader = null;
  }

  async function read(fn) {
    const result = await reader().read(fn);
    if (result === null) throw new Error(`Search index does not exist: ${searchIndexPath}`);
    return result;
  }

  return {
    status: ({ includeExternalProjectFiles }) => indexStatus({
      vaultRoot,
      indexPath: searchIndexPath,
      includeExternalProjectFiles,
      cache: documentCache,
      reader: reader()
    }),
    densePlan: (options) => densePlan({ vaultRoot, indexPath: searchIndexPath, ...options }),
    storeDense: (options) => storeDenseVectors({ indexPath: searchIndexPath, env, ...options }),
    rebuild: (options) => {
      closeReader();
      return rebuildIndex({ vaultRoot, indexPath: searchIndexPath, env, ...options });
    },
    keyword: (options) => read((db) => keywordSearch(db, options)),
    hybrid: (options) => read((db) => rankHybrid(db, { ...options, cache: hybridCache })),
    galaxy: () => read((db) => exportGalaxy(db)),
    knowledge: (options) => read((db) => knowledgeSearch(db, { ...options, cache: knowledgeCache }))
  };
}

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

/**
 * Create the search index runtime.
 *
 * @param {object} deps
 * @param {string} deps.vaultRoot
 * @param {string} deps.searchIndexDir - Where the sqlite file lives.
 * @param {string} deps.searchIndexPath
 * @param {string} deps.defaultModelDir - Default dense model directory.
 * @param {(payload: object, options?: object) => Promise<object>} deps.embedQuery - Dense embedding, query or passages.
 * @param {{ describe: () => Promise<object> }} [deps.denseIndexBackend] - Which dense backend would embed, and its provenance.
 * @param {() => Promise<object[]>} deps.hardNegativeRules - Reranker guardrails.
 * @param {() => Promise<object[]>} deps.readSkillIndex - Registry, for intent routing.
 * @param {() => Promise<unknown>} [deps.refreshSkillRegistry] - Rebuilds the skill registry when
 *   its skills changed on disk; the index's skill documents are read from it.
 * @param {object} deps.ranking - Pure ranking collaborators.
 * @param {NodeJS.ProcessEnv} [deps.env]
 * @param {ReturnType<typeof createNodeSearchEngine>} [deps.engine] - A stand-in, for tests.
 * @param {() => string|null} [deps.unavailable] - Why search cannot run here, or null.
 * @returns {object} The runtime.
 */
export function createSearchIndexRuntime({
  vaultRoot,
  searchIndexDir,
  searchIndexPath,
  defaultModelDir,
  embedQuery,
  denseIndexBackend,
  hardNegativeRules,
  readSkillIndex,
  refreshSkillRegistry = async () => {},
  ranking,
  env = process.env,
  engine: engineOverride = null,
  unavailable = () => searchUnavailableReason()
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
  let nodeEngine = engineOverride;
  let blocked;

  /** The engine, or the reason this Node cannot search, thrown. */
  function engine() {
    blocked ??= engineOverride ? null : unavailable();
    if (blocked) throw new Error(blocked);
    nodeEngine ??= createNodeSearchEngine({ vaultRoot, searchIndexPath, env });
    return nodeEngine;
  }

  /** Which engine answered, on what the caller gets back — always this one now. */
  function stamped(result) {
    if (result && typeof result === "object" && !Array.isArray(result)) result.engine = "node";
    return result;
  }

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

  /** The skill registry brought up to date first; a failure there leaves the registry as it is. */
  async function freshRegistry() {
    await Promise.resolve().then(refreshSkillRegistry).catch(() => {});
  }

  /** What the index holds against what the vault says: counts, schema, staleness. */
  async function status({ include_external_project_files = true } = {}) {
    const chosen = engine();
    await freshRegistry();
    const result = await chosen.status({ includeExternalProjectFiles: Boolean(include_external_project_files) });
    result.dirty_reason = dirtyReason;
    // Coverage is what the current model can use; another model's vectors wait.
    if (denseIndexBackend) {
      const current = await denseIndexBackend.describe().catch(() => null);
      denseCoverage(result, current?.provenance ?? null);
    }
    return stamped(result);
  }

  /**
   * Embed the planned passages a slice at a time, storing each slice as soon
   * as it is done, with progress after every batch. A cancel between batches
   * keeps every slice already stored and says how many are left.
   *
   * @returns {Promise<number>} Passages embedded and stored.
   */
  async function embedAndStore({ chosen, planned, plan, batchSize, textLimit, includeMembrane, embed, onProgress, signal }) {
    const { records } = planned;
    const started = Date.now();
    let done = 0;
    const report = (count) => {
      if (!onProgress) return;
      const elapsed = (Date.now() - started) / 1000;
      onProgress({
        phase: "embedding",
        done: count,
        total: records.length,
        eligible: planned.eligible,
        reused: planned.reusable,
        etaSeconds: count > 0 ? Math.round((elapsed / count) * (records.length - count)) : null
      });
    };
    report(0);
    for (let index = 0; index < records.length; index += DENSE_COMMIT_EVERY) {
      let vectors;
      try {
        vectors = await embedDensePlan({
          records: records.slice(index, index + DENSE_COMMIT_EVERY),
          embed,
          dimensions: plan.provenance.dimensions,
          batchSize,
          onProgress: (count) => report(done + count),
          signal
        });
      } catch (error) {
        if (!error?.cancelled) throw error;
        throw Object.assign(new Error(`Embedding cancelled: ${done} of ${records.length} document(s) were embedded and are kept; `
          + `the other ${records.length - done} wait for the next run.`), { name: "AbortError", cancelled: true, embedded: done });
      }
      await chosen.storeDense({ vectors, provenance: plan.provenance, textLimit, includeMembrane, eligible: planned.eligible });
      done += vectors.length;
      report(done);
    }
    return done;
  }

  /**
   * Rebuild the index. Dense embeddings are opt-in and expensive; without them
   * the existing dense vectors are preserved by default rather than dropped.
   *
   * With them: the documents are brought up to date first, the passages that
   * need a vector are planned and embedded by the model a slice at a time,
   * each slice stored as it is done, and the closing rebuild keeps what was
   * stored. `onProgress` hears after every batch and `signal` stops between
   * batches; either way nothing embedded is lost.
   * Without a model the answer is an error that says what to install.
   *
   * `onProgress` hears the text index being written (`indexing`) and the
   * documents being embedded (`embedding`); `signal` stops either between two
   * slices. A cancelled text write is rolled back whole. Over MCP both come
   * from the request — its progress token and its
   * cancellation — never from the arguments, which are JSON.
   */
  async function rebuild({
    include_external_project_files = true,
    dense_embeddings = false,
    dense_model_dir = defaultModelDir,
    dense_device = process.env.BGE_M3_DEVICE || "cpu",
    dense_batch_size = 8,
    dense_text_limit = 1200,
    dense_include_membrane = false,
    dense_incremental = true,
    preserve_dense = true,
    in_place = false,
    onProgress,
    signal
  } = {}) {
    const chosen = engine();
    const watch = {
      onProgress: typeof onProgress === "function" ? onProgress : null,
      signal: typeof signal?.aborted === "boolean" ? signal : null
    };
    await freshRegistry();
    if (watch.signal?.aborted) throw Object.assign(new Error("The rebuild was cancelled before it began."), { name: "AbortError", cancelled: true });
    await fs.mkdir(searchIndexDir, { recursive: true });
    const textLimit = Math.max(300, Math.min(Number(dense_text_limit) || 1200, 12000));
    const batchSize = Math.max(1, Math.min(Number(dense_batch_size) || 8, 32));
    const includeMembrane = Boolean(dense_embeddings && dense_include_membrane);
    let plan = null;
    let planned = null;
    let embedded = 0;
    if (dense_embeddings) {
      plan = denseIndexBackend ? await denseIndexBackend.describe() : null;
      if (!plan?.available) {
        throw new Error(`Dense vectors were asked for, but no embedding model can run here. ${plan?.reason ?? "No dense backend is configured."}`);
      }
      // Every vector embedded below needs its document in the index already.
      await chosen.rebuild({ includeExternalProjectFiles: Boolean(include_external_project_files), inPlace: true, preserveDense: true, ...watch });
      planned = await chosen.densePlan({
        includeExternalProjectFiles: Boolean(include_external_project_files),
        textLimit,
        includeMembrane,
        incremental: dense_incremental !== false,
        provenance: plan.provenance
      });
      embedded = await embedAndStore({
        chosen,
        planned,
        plan,
        batchSize,
        textLimit,
        includeMembrane,
        ...watch,
        // The model and device the caller named, as the 2.x helper was given
        // them; the ONNX model has its own and ignores both.
        embed: (texts) => embedQuery({
          texts,
          normalize: true,
          include_embeddings: true,
          batch_size: batchSize,
          model_dir: dense_model_dir,
          device: dense_device
        }, { timeoutMs: 3600000 })
      });
    }
    const rebuilt = await chosen.rebuild({
      includeExternalProjectFiles: Boolean(include_external_project_files),
      inPlace: Boolean(in_place) && !dense_embeddings,
      preserveDense: !dense_embeddings && Boolean(preserve_dense),
      denseEmbeddings: Boolean(dense_embeddings),
      suppliedVectors: [],
      denseModelDir: path.resolve(String(dense_model_dir || defaultModelDir)),
      denseTextLimit: dense_embeddings ? textLimit : 1200,
      denseIncludeMembrane: includeMembrane,
      // What was planned is stored by now: the closing write keeps what still
      // fits, whether or not the caller asked to reuse old vectors.
      denseIncremental: true,
      ...(plan ? { denseBackend: plan.provenance.backend, denseRevision: plan.provenance.revision, denseDtype: plan.provenance.dtype } : {}),
      ...watch
    });
    if (planned) {
      rebuilt.dense_planned_documents = planned.records.length;
      rebuilt.dense_embedded_documents = embedded;
    }
    dirtyReason = "";
    lastStatus = null;
    lastStatusAt = 0;
    return stamped(rebuilt);
  }

  /**
   * A rebuild for callers whose own work does not depend on search —
   * `prepare_project`, `refresh_project_memory`. On a Node where search cannot
   * run, what they wrote stands and the answer says the index was skipped and
   * why, instead of reporting their finished work as failed.
   */
  async function rebuildIfSupported(options) {
    try {
      engine();
    } catch (error) {
      return { skipped: error.message };
    }
    return rebuild(options);
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
        preserve_dense: true,
        in_place: true
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

  /**
   * What the Knowledge Galaxy is drawn from — documents, their sparse and dense
   * vectors, and their wikilinks — in the shape `parseGalaxyExport` reads.
   */
  async function exportGalaxyData() {
    return engine().galaxy();
  }

  /** Keyword search over the index. */
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
    const chosen = engine();
    if (ensure_fresh) await ensureFresh();
    return chosen.keyword({
      query,
      scope: scope || "all",
      limit: Math.max(1, Math.min(Number(limit) || 10, MAX_RESULTS)),
      project: project || "",
      source: csvValue(source),
      categories: csvValue(categories),
      folders: csvValue(folders)
    });
  }

  /**
   * `search_knowledge`: every word of the question looked for in each indexed
   * document's path and text, best first.
   */
  async function searchKnowledge({ query, limit = 10, ensure_fresh = true }) {
    if (!query || typeof query !== "string") throw new Error("query is required.");
    const chosen = engine();
    if (ensure_fresh) await ensureFresh();
    return chosen.knowledge({ query, limit });
  }

  /**
   * Hybrid search: keyword, sparse semantic and dense signals combined in the
   * index, then reranked and optionally routed here.
   *
   * The dense query vector is embedded in this process and handed over in
   * memory. The index is always asked for 50 results and the caller's limit is
   * applied after reranking — trimming first would hide the candidates
   * reranking exists to promote.
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
    dense_model_dir = defaultModelDir,
    dense_device = process.env.BGE_M3_DEVICE || "cpu",
    intent_routing = false,
    rerank = true,
    preset_name = "",
    ensure_fresh = true
  }) {
    if (!query || typeof query !== "string") {
      throw new Error("query is required.");
    }
    const chosen = engine();
    const normalizedQuery = repairSearchMojibake(query);
    const requestedLimit = Math.max(1, Math.min(Number(limit) || 10, MAX_RESULTS));
    const selectedDenseWeight = Number.isFinite(Number(dense_weight)) ? Number(dense_weight) : 0.35;
    if (ensure_fresh) await ensureFresh();

    let denseQueryVector = null;
    let denseProvenance = null;
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
        if (Array.isArray(vector) && vector.length) denseQueryVector = vector;
        else denseIssue = "the embedding backend returned no vector for this query";
        if (denseQuery.backend && denseQuery.revision && denseQuery.dtype) {
          denseProvenance = { backend: denseQuery.backend, revision: denseQuery.revision, dtype: denseQuery.dtype };
        }
      } catch (error) {
        denseIssue = String(error?.message ?? error).replace(/\s+/g, " ").trim();
      }
    }

    const results = await chosen.hybrid({
      query: normalizedQuery,
      scope: scope || "all",
      limit: MAX_RESULTS,
      project: project || "",
      source: csvValue(source),
      categories: csvValue(categories),
      folders: csvValue(folders),
      semanticWeight: Number.isFinite(Number(semantic_weight)) ? Number(semantic_weight) : 0.20,
      keywordWeight: Number.isFinite(Number(keyword_weight)) ? Number(keyword_weight) : 0.45,
      denseWeight: selectedDenseWeight,
      denseQueryVector,
      denseProvenance
    });
    // A question embedded, and not one document has a vector of its model —
    // a 2.x index made by another one: the dense half
    // did not run, and the answer says so instead of ranking as if it had.
    if (results.dense_unmatched && !denseIssue) {
      denseIssue = `no indexed document has a vector of the installed model yet; \`${hint("npm run setup -- --model")}\` embeds them`;
    }
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
  }

  return {
    markDirty,
    dirtyReason: dirtyReasonNow,
    status,
    rebuild,
    rebuildIfSupported,
    ensureFresh,
    search,
    searchKnowledge,
    hybridSearch,
    exportGalaxy: exportGalaxyData,
    engine: () => ({ engine: "node", reason: "" })
  };
}
