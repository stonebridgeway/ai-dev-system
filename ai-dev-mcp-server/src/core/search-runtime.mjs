/**
 * What a search request means and how its answer is explained.
 *
 * The presets are the vocabulary an agent actually uses: `code` biases toward
 * exact names, `docs` toward meaning, `skills` toward the registry. Resolving
 * one into concrete weights and filters, normalizing those weights, and
 * explaining afterwards which signal produced each result are all plain
 * functions over data — the sqlite index and the embedding backend live in
 * `src/core/search-index.mjs` and `src/core/embedding-workers.mjs`, and the MCP
 * surface in `src/extensions/search.mjs`.
 */
import { csvValue } from "./text-format.mjs";

export const SEARCH_PRESETS = Object.freeze({
  balanced: {
    description: "Default hybrid search for mixed knowledge, project, and skill lookup.",
    use_when: "General AI Dev System lookup when the target source is not obvious.",
    scope: "all",
    limit: 10,
    keyword_weight: 0.45,
    semantic_weight: 0.20,
    dense_weight: 0.35
  },
  code: {
    description: "Code and repository lookup biased toward exact names, paths, commands, symbols, and project files.",
    use_when: "Finding AGENTS.md, project maps, commands, filenames, stack notes, or repo-local AI-dev files.",
    scope: "all",
    limit: 10,
    keyword_weight: 0.65,
    semantic_weight: 0.15,
    dense_weight: 0.20,
    intent_routing: true
  },
  docs: {
    description: "Knowledge-base lookup biased toward meaning and explanatory notes.",
    use_when: "Finding architecture notes, runbooks, system docs, decisions, or conceptual explanations.",
    scope: "knowledge",
    limit: 8,
    keyword_weight: 0.25,
    semantic_weight: 0.25,
    dense_weight: 0.50,
    intent_routing: true
  },
  skills: {
    description: "Skill registry lookup for choosing or reading task-specific skills.",
    use_when: "Finding relevant custom, design, Membrane, or integration skills.",
    scope: "skills",
    limit: 10,
    keyword_weight: 0.35,
    semantic_weight: 0.25,
    dense_weight: 0.40,
    intent_routing: true
  },
  projects: {
    description: "Project registry lookup biased toward registered project cards and project context.",
    use_when: "Finding a project, its stack, quality status, risks, active tasks, or recommended skills.",
    scope: "projects",
    limit: 8,
    keyword_weight: 0.50,
    semantic_weight: 0.20,
    dense_weight: 0.30
  },
  debug: {
    description: "Bug/debug lookup biased toward exact errors, commands, failing checks, and known investigation workflows.",
    use_when: "Investigating failures, stack traces, regressions, CI issues, or quality gate problems.",
    scope: "all",
    limit: 10,
    keyword_weight: 0.60,
    semantic_weight: 0.20,
    dense_weight: 0.20,
    intent_routing: true
  },
  frontend: {
    description: "Frontend/design lookup biased toward visual intent and design workflow meaning.",
    use_when: "Finding UI, UX, redesign, landing page, responsive, browser-check, or design-taste guidance.",
    scope: "all",
    limit: 10,
    keyword_weight: 0.25,
    semantic_weight: 0.25,
    dense_weight: 0.50,
    intent_routing: true
  },
  quality: {
    description: "Quality-gate lookup for verification, tests, review standards, and safety checks.",
    use_when: "Finding checks, quality gates, review rules, test strategy, or verification commands.",
    scope: "quality",
    limit: 8,
    keyword_weight: 0.45,
    semantic_weight: 0.25,
    dense_weight: 0.30
  }
});

export const SEARCH_PRESET_ALIASES = Object.freeze({
  default: "balanced",
  all: "balanced",
  general: "balanced",
  repo: "code",
  repository: "code",
  command: "code",
  commands: "code",
  symbol: "code",
  symbols: "code",
  knowledge: "docs",
  doc: "docs",
  document: "docs",
  documentation: "docs",
  note: "docs",
  notes: "docs",
  skill: "skills",
  project: "projects",
  registry: "projects",
  bug: "debug",
  bugs: "debug",
  error: "debug",
  failure: "debug",
  ci: "debug",
  design: "frontend",
  ui: "frontend",
  ux: "frontend",
  front: "frontend",
  review: "quality",
  tests: "quality",
  test: "quality",
  gate: "quality"
});

export function searchPresetName(value = "balanced") {
  const normalized = String(value || "balanced").toLowerCase().trim().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return SEARCH_PRESET_ALIASES[normalized] || normalized || "balanced";
}

export function getSearchPreset(value = "balanced") {
  const name = searchPresetName(value);
  const preset = SEARCH_PRESETS[name];
  if (!preset) {
    throw new Error(`Unknown search preset: ${value}. Use list_search_presets to see valid presets.`);
  }
  return { name, ...preset };
}

export function listSearchPresets() {
  const aliasesByPreset = new Map();
  for (const [alias, name] of Object.entries(SEARCH_PRESET_ALIASES)) {
    if (!aliasesByPreset.has(name)) aliasesByPreset.set(name, []);
    aliasesByPreset.get(name).push(alias);
  }
  return Object.entries(SEARCH_PRESETS).map(([name, preset]) => ({
    name,
    aliases: aliasesByPreset.get(name) || [],
    ...preset,
    weights: {
      keyword: preset.keyword_weight,
      semantic: preset.semantic_weight,
      dense: preset.dense_weight
    }
  }));
}

export function optionProvided(options, key) {
  return Object.prototype.hasOwnProperty.call(options, key) && options[key] !== undefined && options[key] !== null && options[key] !== "";
}

export function presetOption(options, key, fallback) {
  return optionProvided(options, key) ? options[key] : fallback;
}

export function resolveSearchPresetArgs(options = {}, { defaultLimit = 10 } = {}) {
  const preset = getSearchPreset(options.preset || "balanced");
  const limitFallback = preset.limit || defaultLimit;
  const limit = Math.max(1, Math.min(Number(presetOption(options, "limit", limitFallback)) || limitFallback, 50));
  return {
    preset,
    search: {
      query: options.query,
      scope: presetOption(options, "scope", preset.scope || "all"),
      limit,
      project: presetOption(options, "project", ""),
      source: presetOption(options, "source", ""),
      categories: presetOption(options, "categories", ""),
      folders: presetOption(options, "folders", ""),
      semantic_weight: Number(presetOption(options, "semantic_weight", preset.semantic_weight ?? 0.20)),
      keyword_weight: Number(presetOption(options, "keyword_weight", preset.keyword_weight ?? 0.45)),
      dense_weight: Number(presetOption(options, "dense_weight", preset.dense_weight ?? 0.35)),
      dense_model_dir: presetOption(options, "dense_model_dir", undefined),
      dense_device: presetOption(options, "dense_device", "cpu"),
      intent_routing: Boolean(presetOption(options, "intent_routing", preset.intent_routing ?? false)),
      rerank: Boolean(presetOption(options, "rerank", true)),
      preset_name: preset.name
    }
  };
}

export function appliedSearchPresetSummary(resolved) {
  const weights = normalizedSearchWeights(resolved.search);
  return {
    preset: {
      name: resolved.preset.name,
      description: resolved.preset.description,
      use_when: resolved.preset.use_when
    },
    scope: resolved.search.scope,
    limit: resolved.search.limit,
    filters: {
      project: resolved.search.project || "",
      source: resolved.search.source || "",
      categories: csvValue(resolved.search.categories),
      folders: csvValue(resolved.search.folders)
    },
    weights: {
      requested: {
        keyword: clampSearchWeight(resolved.search.keyword_weight, 0.45),
        semantic: clampSearchWeight(resolved.search.semantic_weight, 0.20),
        dense: clampSearchWeight(resolved.search.dense_weight, 0.35)
      },
      normalized: {
        keyword: roundSearchNumber(weights.keyword),
        semantic: roundSearchNumber(weights.semantic),
        dense: roundSearchNumber(weights.dense)
      }
    },
    reranker: {
      enabled: resolved.search.rerank !== false,
      version: 2,
      hard_negative_rules: "golden cases plus domain conflicts"
    }
  };
}

export function clampSearchWeight(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(number, 1));
}

export function normalizedSearchWeights({ keyword_weight = 0.45, semantic_weight = 0.20, dense_weight = 0.35 } = {}) {
  let keyword = clampSearchWeight(keyword_weight, 0.45);
  let semantic = clampSearchWeight(semantic_weight, 0.20);
  let dense = clampSearchWeight(dense_weight, 0.35);
  let total = keyword + semantic + dense;
  if (total <= 0) {
    keyword = 0.45;
    semantic = 0.20;
    dense = 0.35;
    total = keyword + semantic + dense;
  }
  return {
    keyword: keyword / total,
    semantic: semantic / total,
    dense: dense / total
  };
}

export function roundSearchNumber(value, digits = 6) {
  const number = Number(value) || 0;
  const factor = 10 ** digits;
  return Math.round(number * factor) / factor;
}

export function explainSearchProfile(result) {
  const parts = [
    { name: "keyword", score: Number(result.keyword_score) || 0 },
    { name: "semantic", score: Number(result.semantic_score) || 0 },
    { name: "dense", score: Number(result.dense_score) || 0 }
  ].sort((a, b) => b.score - a.score);
  const top = parts[0];
  if (!top || top.score <= 0) return "weak match; result is mostly from boosts or fallback scoring";
  if (top.name === "keyword") return "keyword/FTS match is the strongest signal";
  if (top.name === "dense") return "dense BGE-M3 meaning match is the strongest signal";
  return "local sparse semantic match is the strongest signal";
}

export function explainScoreAdjustment(value) {
  if (value >= 0.03) return "positive adjustment from lexical boost or vault-note preference";
  if (value <= -0.03) return "negative adjustment from source penalty or other ranking guardrail";
  return "close to pure weighted score";
}

export function explainSearchResult(result, index, weights) {
  const keywordRaw = Number(result.keyword_score) || 0;
  const semanticRaw = Number(result.semantic_score) || 0;
  const denseRaw = Number(result.dense_score) || 0;
  const keywordContribution = keywordRaw * weights.keyword;
  const semanticContribution = semanticRaw * weights.semantic;
  const denseContribution = denseRaw * weights.dense;
  const weightedScore = keywordContribution + semanticContribution + denseContribution;
  const adjustment = (Number(result.score) || 0) - weightedScore;
  return {
    rank: index + 1,
    title: result.title,
    path: result.path,
    scope: result.scope,
    source: result.source,
    score: result.score,
    original_rank: result.original_rank,
    original_score: result.original_score,
    rerank_adjustment: result.rerank_adjustment,
    rerank_reasons: result.rerank_reasons || [],
    hard_negative: Boolean(result.hard_negative),
    hard_negative_reasons: result.hard_negative_reasons || [],
    weighted_score_before_adjustments: roundSearchNumber(weightedScore),
    score_adjustment: roundSearchNumber(adjustment),
    score_parts: {
      keyword: {
        raw: roundSearchNumber(keywordRaw),
        weight: roundSearchNumber(weights.keyword),
        contribution: roundSearchNumber(keywordContribution)
      },
      semantic: {
        raw: roundSearchNumber(semanticRaw),
        weight: roundSearchNumber(weights.semantic),
        contribution: roundSearchNumber(semanticContribution)
      },
      dense: {
        raw: roundSearchNumber(denseRaw),
        weight: roundSearchNumber(weights.dense),
        contribution: roundSearchNumber(denseContribution)
      }
    },
    likely_reason: explainSearchProfile(result),
    adjustment_note: explainScoreAdjustment(adjustment),
    preview: result.preview
  };
}

export function explainSearchTuningNotes(results, weights) {
  const notes = [];
  const hasDense = results.some((item) => Number(item.dense_score) > 0);
  const hasKeyword = results.some((item) => Number(item.keyword_score) > 0);
  if (!hasDense && weights.dense > 0) {
    notes.push("Dense weight is enabled, but returned results have no dense score. Rebuild the index with dense_embeddings=true or check the dense backend.");
  }
  if (!hasKeyword) {
    notes.push("Keyword score is zero for these results; the query is being answered mostly by semantic meaning rather than exact terms.");
  }
  if (results.length >= 2 && Number(results[0].score) - Number(results[1].score) < 0.03) {
    notes.push("Top results are close; read the first few before choosing context.");
  }
  if (!notes.length) {
    notes.push("Ranking signals look healthy: at least one exact, sparse, or dense signal is contributing to the returned results.");
  }
  return notes;
}
