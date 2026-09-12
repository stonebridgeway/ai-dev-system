/**
 * The MCP surface over search.
 *
 * Thirteen tools, three layers under them. The sqlite index and its freshness
 * live in `src/core/search-index.mjs`; the BGE-M3 worker pool lives in
 * `src/core/embedding-workers.mjs`; the presets, the score explanations and the
 * golden-case verdicts are pure functions in `src/core/search-runtime.mjs` and
 * `src/core/search-eval.mjs`. What is here is argument handling and the shape of
 * each answer.
 *
 * Both runtimes are built once by `mcp-stdio.mjs` and arrive as `host.search`
 * and `host.embeddings`, because they are services rather than tools: the system
 * extension's health checks and the runtime's own writers use them too.
 */
import {
  appliedSearchPresetSummary,
  explainSearchResult,
  explainSearchTuningNotes,
  listSearchPresets,
  normalizedSearchWeights,
  optionProvided,
  resolveSearchPresetArgs,
  searchPresetName
} from "../core/search-runtime.mjs";
import {
  evaluateSearchEvalCase,
  searchEvalRecommendations,
  searchEvalStatus
} from "../core/search-eval.mjs";
import { csvValue, toStringList } from "../core/text-format.mjs";

/** `explain_search` returns fewer, richer rows than a plain search. */
const EXPLAIN_DEFAULT_LIMIT = 5;
const EXPLAIN_MAX_LIMIT = 20;

/** Most golden cases one `run_search_eval` call may run. */
const MAX_EVAL_CASES = 200;

/** Why the dense half of a hybrid search did not run, when it did not. */
function denseNote(results) {
  const issue = results?.dense_unavailable;
  return issue
    ? { dense: { used: false, reason: `Ranked on keywords and sparse aliases only: ${issue}` } }
    : {};
}

/** Preset-driven hybrid search, optionally with the scoring breakdown. */
async function presetSearch(host, options = {}) {
  const explain = Boolean(options.explain);
  const resolved = resolveSearchPresetArgs(options, { defaultLimit: 10 });
  const results = await host.search.hybridSearch(resolved.search);
  const weights = normalizedSearchWeights(resolved.search);
  return {
    query: resolved.search.query,
    result_count: results.length,
    applied: appliedSearchPresetSummary(resolved),
    // Keyword and sparse always run; dense is the optional half, and when it is
    // missing the answer says so rather than pretending it ranked.
    ...denseNote(results),
    tuning_notes: explain ? explainSearchTuningNotes(results, weights) : undefined,
    results: explain
      ? results.map((item, index) => explainSearchResult(item, index, weights))
      : results
  };
}

/** Why each result scored what it did, and what that says about the query. */
async function explainSearch(host, options = {}) {
  const resolved = resolveSearchPresetArgs(options, { defaultLimit: EXPLAIN_DEFAULT_LIMIT });
  resolved.search.limit = Math.max(
    1,
    Math.min(Number(resolved.search.limit) || EXPLAIN_DEFAULT_LIMIT, EXPLAIN_MAX_LIMIT)
  );
  const results = await host.search.hybridSearch(resolved.search);
  const weights = normalizedSearchWeights(resolved.search);
  return {
    query: resolved.search.query,
    scope: resolved.search.scope,
    result_count: results.length,
    applied: appliedSearchPresetSummary(resolved),
    weights: appliedSearchPresetSummary(resolved).weights,
    ...denseNote(results),
    notes: [
      "weighted_score_before_adjustments is computed from returned component scores and normalized weights.",
      "score_adjustment captures lexical boosts, vault-note preference, and source penalties applied inside the search helper."
    ],
    tuning_notes: explainSearchTuningNotes(results, weights),
    results: results.map((item, index) => explainSearchResult(item, index, weights))
  };
}

/**
 * Run the golden cases and report how the ranking did.
 *
 * A case that throws is a failed case, not a failed run: one broken query must
 * not hide the verdict on the rest. `fail_fast` stops at the first failure when
 * the caller wants the first problem rather than the whole picture.
 */
async function runSearchEval(host, options = {}) {
  const includeDense = options.include_dense !== false;
  const casesFile = await host.readSearchEvalCases(options.cases_path || "");
  const selectedIds = new Set(toStringList(options.case_ids));
  const selectedPresets = new Set(toStringList(options.presets).map(searchPresetName));
  const maxCases = Math.max(1, Math.min(Number(options.max_cases) || 50, MAX_EVAL_CASES));
  let cases = casesFile.cases;
  if (selectedIds.size) {
    cases = cases.filter((testCase) => selectedIds.has(String(testCase.id || "")));
  }
  if (selectedPresets.size) {
    cases = cases.filter((testCase) => selectedPresets.has(searchPresetName(testCase.preset || "balanced")));
  }
  cases = cases.slice(0, maxCases);

  const caseResults = [];
  for (const testCase of cases) {
    const startedAt = Date.now();
    const id = String(testCase.id || testCase.query || "unnamed-case");
    try {
      if (!testCase.query || typeof testCase.query !== "string") {
        caseResults.push({
          id,
          status: "fail",
          error: "Case query is required.",
          duration_ms: Date.now() - startedAt
        });
        if (options.fail_fast) break;
        continue;
      }

      const resolved = resolveSearchPresetArgs({
        ...testCase,
        rerank: optionProvided(options, "rerank") ? options.rerank : testCase.rerank,
        dense_model_dir: optionProvided(options, "dense_model_dir") ? options.dense_model_dir : testCase.dense_model_dir,
        dense_device: optionProvided(options, "dense_device") ? options.dense_device : testCase.dense_device
      }, { defaultLimit: 10 });
      if (!includeDense && !optionProvided(testCase, "dense_weight")) {
        resolved.search.dense_weight = 0;
      }

      const results = await host.search.hybridSearch(resolved.search);
      const evaluation = evaluateSearchEvalCase(testCase, results);
      caseResults.push({
        id,
        status: evaluation.status,
        query: resolved.search.query,
        preset: resolved.preset.name,
        applied: appliedSearchPresetSummary(resolved),
        result_count: results.length,
        duration_ms: Date.now() - startedAt,
        ...evaluation
      });
      if (options.fail_fast && evaluation.status === "fail") break;
    } catch (err) {
      caseResults.push({
        id,
        status: "fail",
        query: testCase.query || "",
        preset: searchPresetName(testCase.preset || "balanced"),
        error: err.message,
        duration_ms: Date.now() - startedAt
      });
      if (options.fail_fast) break;
    }
  }

  const summary = {
    total: caseResults.length,
    passed: caseResults.filter((item) => item.status === "pass").length,
    failed: caseResults.filter((item) => item.status === "fail").length,
    skipped: caseResults.filter((item) => item.status === "skipped").length
  };
  const scoredCases = caseResults.filter((item) => item.status !== "skipped");
  summary.metrics = {
    mean_reciprocal_rank: scoredCases.length
      ? scoredCases.reduce((sum, item) => sum + Number(item.reciprocal_rank || 0), 0) / scoredCases.length
      : 0,
    top_1_accuracy: scoredCases.length
      ? scoredCases.filter((item) => item.top_1).length / scoredCases.length
      : 0,
    mean_ndcg: scoredCases.length
      ? scoredCases.reduce((sum, item) => sum + Number(item.ndcg || 0), 0) / scoredCases.length
      : 0,
    negative_violations: scoredCases.reduce((sum, item) => sum + Number(item.negative_checks?.violations?.length || 0), 0),
    visible_duplicate_count: scoredCases.reduce((sum, item) => sum + Number(item.duplicate_checks?.visible_duplicate_count || 0), 0),
    collapsed_duplicate_count: scoredCases.reduce((sum, item) => sum + Number(item.duplicate_checks?.collapsed_duplicate_count || 0), 0)
  };

  return {
    status: searchEvalStatus(summary),
    cases_path: casesFile.path,
    schema_version: casesFile.schema_version,
    description: casesFile.description,
    include_dense: includeDense,
    reranker_enabled: options.rerank !== false,
    filters: {
      case_ids: [...selectedIds],
      presets: [...selectedPresets],
      max_cases: maxCases
    },
    summary,
    recommendations: searchEvalRecommendations(summary, includeDense),
    cases: caseResults
  };
}

/**
 * Search tools: the index and its freshness, the four ways to query it, the
 * scoring explanation, the golden-case harness, and the embedding backend.
 *
 * @param {object} host - Shared runtime services from `mcp-stdio.mjs`.
 */
export function createSearchTools(host) {
  return {
    definitions: [
  {
    name: "search_index_status",
    description: "Inspect search-index freshness against current vault/project sources, including added, changed, deleted, and pending dense documents.",
    inputSchema: {
      type: "object",
      properties: {
        include_external_project_files: { type: "boolean", default: true }
      }
    }
  },
  {
    name: "rebuild_search_index",
    description: "Rebuild the local SQLite FTS search index for knowledge notes, project cards, project AI-dev files, and skill metadata.",
    inputSchema: {
      type: "object",
      properties: {
        include_external_project_files: { type: "boolean", default: true },
        dense_embeddings: { type: "boolean", default: false },
        dense_model_dir: { type: "string" },
        dense_device: { type: "string", default: "cpu" },
        dense_batch_size: { type: "number", default: 8 },
        dense_text_limit: { type: "number", default: 1200 },
        dense_include_membrane: { type: "boolean", default: false },
        dense_incremental: { type: "boolean", default: true },
        preserve_dense: { type: "boolean", default: true }
      }
    }
  },
  {
    name: "search_all",
    description: "Search the self-refreshing local SQLite FTS index across knowledge, projects, workflows, quality notes, and skills.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        scope: { type: "string", default: "all" },
        limit: { type: "number", default: 10 },
        project: { type: "string" },
        source: { type: "string" },
        categories: {
          type: "array",
          items: { type: "string" },
          default: []
        },
        folders: {
          type: "array",
          items: { type: "string" },
          default: []
        }
      },
      required: ["query"]
    }
  },
  {
    name: "hybrid_search",
    description: "Hybrid semantic plus keyword search across knowledge, projects, workflows, quality notes, and skills. Optional preset applies task-specific weights and scope defaults.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        preset: { type: "string", default: "balanced" },
        scope: { type: "string" },
        limit: { type: "number" },
        project: { type: "string" },
        source: { type: "string" },
        categories: {
          type: "array",
          items: { type: "string" },
          default: []
        },
        folders: {
          type: "array",
          items: { type: "string" },
          default: []
        },
        semantic_weight: { type: "number" },
        keyword_weight: { type: "number" },
        dense_weight: { type: "number" },
        intent_routing: { type: "boolean", description: "Prepend up to three deterministic custom-skill candidates for development intent." },
        rerank: { type: "boolean", default: true, description: "Apply Search Ranking v2 intent, scope, curation, and hard-negative reranking." },
        dense_model_dir: { type: "string" },
        dense_device: { type: "string", default: "cpu" }
      },
      required: ["query"]
    }
  },
  {
    name: "list_search_presets",
    description: "List task-specific search presets with default scopes and keyword/sparse/dense weights.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "preset_search",
    description: "Run hybrid search through a named preset such as balanced, code, docs, skills, projects, debug, frontend, or quality.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        preset: { type: "string", default: "balanced" },
        explain: { type: "boolean", default: false },
        scope: { type: "string" },
        limit: { type: "number" },
        project: { type: "string" },
        source: { type: "string" },
        categories: {
          type: "array",
          items: { type: "string" },
          default: []
        },
        folders: {
          type: "array",
          items: { type: "string" },
          default: []
        },
        semantic_weight: { type: "number" },
        keyword_weight: { type: "number" },
        dense_weight: { type: "number" },
        intent_routing: { type: "boolean" },
        rerank: { type: "boolean", default: true },
        dense_model_dir: { type: "string" },
        dense_device: { type: "string", default: "cpu" }
      },
      required: ["query"]
    }
  },
  {
    name: "explain_search",
    description: "Explain why hybrid_search ranked results the way it did, including preset, keyword, sparse semantic, dense BGE-M3, and adjustment signals.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        preset: { type: "string", default: "balanced" },
        scope: { type: "string" },
        limit: { type: "number" },
        project: { type: "string" },
        source: { type: "string" },
        categories: {
          type: "array",
          items: { type: "string" },
          default: []
        },
        folders: {
          type: "array",
          items: { type: "string" },
          default: []
        },
        semantic_weight: { type: "number" },
        keyword_weight: { type: "number" },
        dense_weight: { type: "number" },
        intent_routing: { type: "boolean" },
        rerank: { type: "boolean", default: true },
        dense_model_dir: { type: "string" },
        dense_device: { type: "string", default: "cpu" }
      },
      required: ["query"]
    }
  },
  {
    name: "run_search_eval",
    description: "Run golden search evaluation cases against preset/hybrid search and report pass/fail ranking quality.",
    inputSchema: {
      type: "object",
      properties: {
        cases_path: {
          type: "string",
          description: "Optional path to a JSON cases file. Relative to the AI Dev System root unless absolute inside the vault."
        },
        case_ids: {
          type: "array",
          items: { type: "string" },
          default: []
        },
        presets: {
          type: "array",
          items: { type: "string" },
          default: []
        },
        include_dense: { type: "boolean", default: true },
        rerank: { type: "boolean", default: true },
        max_cases: { type: "number", default: 50 },
        fail_fast: { type: "boolean", default: false },
        dense_model_dir: { type: "string" },
        dense_device: { type: "string", default: "cpu" }
      }
    }
  },
  {
    name: "embed_texts",
    description: "Generate local BGE-M3 embeddings for short texts using the installed CPU backend.",
    inputSchema: {
      type: "object",
      properties: {
        texts: {
          type: "array",
          items: { type: "string" },
          default: []
        },
        text: { type: "string" },
        prefix: { type: "string", default: "" },
        normalize: { type: "boolean", default: true },
        batch_size: { type: "number", default: 8 },
        precision: { type: "number", default: 6 },
        include_embeddings: { type: "boolean", default: true },
        model_dir: { type: "string" },
        device: { type: "string", default: "cpu" },
        timeout_ms: { type: "number", default: 180000 },
        use_worker: { type: "boolean", default: true }
      }
    }
  },
  {
    name: "embedding_status",
    description: "Inspect the local BGE-M3 embedding backend, model files, search index, and warm worker state without loading the model.",
    inputSchema: {
      type: "object",
      properties: {
        model_dir: { type: "string" },
        device: { type: "string", default: "cpu" }
      }
    }
  },
  {
    name: "search_projects",
    description: "Search registered project cards and indexed repo-local AI-dev files.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        project: { type: "string" },
        limit: { type: "number", default: 10 }
      },
      required: ["query"]
    }
  },
  {
    name: "search_notes",
    description: "Search indexed AI Dev System Markdown notes, optionally restricted to folders.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        folders: {
          type: "array",
          items: { type: "string" },
          default: []
        },
        scope: { type: "string", default: "knowledge" },
        limit: { type: "number", default: 10 }
      },
      required: ["query"]
    }
  },
  {
    name: "search_skill_registry",
    description: "Search the indexed skill registry with optional source and category filters.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        source: { type: "string" },
        categories: {
          type: "array",
          items: { type: "string" },
          default: []
        },
        limit: { type: "number", default: 10 }
      },
      required: ["query"]
    }
  }
    ],
    handlers: {
      search_index_status: (args) => host.search.status(args),
      rebuild_search_index: (args) => host.search.rebuild(args),
      search_all: ({ query, scope = "all", limit = 10, project = "", source = "", categories = "", folders = "" } = {}) => (
        host.search.search({ query, scope, limit, project, source, categories, folders })
      ),
      hybrid_search: async (args = {}) => (
        host.search.hybridSearch(resolveSearchPresetArgs(args, { defaultLimit: 10 }).search)
      ),
      list_search_presets: () => listSearchPresets(),
      preset_search: (args) => presetSearch(host, args),
      explain_search: (args) => explainSearch(host, args),
      run_search_eval: (args) => runSearchEval(host, args),
      embed_texts: (args) => host.embeddings.embedTexts(args),
      embedding_status: (args) => host.embeddings.status(args),
      search_projects: ({ query, project = "", limit = 10 } = {}) => (
        host.search.search({ query, scope: "projects", project, limit })
      ),
      search_notes: ({ query, folders = "", limit = 10, scope = "knowledge" } = {}) => {
        const selectedFolders = csvValue(folders);
        return host.search.search({
          query,
          scope: selectedFolders ? "all" : scope,
          folders: selectedFolders,
          limit
        });
      },
      search_skill_registry: ({ query, source = "", categories = "", limit = 10 } = {}) => (
        host.search.search({ query, scope: "skills", source, categories, limit })
      )
    },
    readOnly: [
      "search_index_status",
      "search_all",
      "hybrid_search",
      "list_search_presets",
      "preset_search",
      "explain_search",
      "run_search_eval",
      "embed_texts",
      "embedding_status",
      "search_projects",
      "search_notes",
      "search_skill_registry"
    ]
  };
}
