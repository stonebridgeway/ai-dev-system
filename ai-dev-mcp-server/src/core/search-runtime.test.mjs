import assert from "node:assert/strict";
import test from "node:test";
import {
  SEARCH_PRESETS,
  SEARCH_PRESET_ALIASES,
  appliedSearchPresetSummary,
  clampSearchWeight,
  explainScoreAdjustment,
  explainSearchProfile,
  explainSearchResult,
  explainSearchTuningNotes,
  getSearchPreset,
  listSearchPresets,
  normalizedSearchWeights,
  optionProvided,
  presetOption,
  resolveSearchPresetArgs,
  roundSearchNumber,
  searchPresetName
} from "./search-runtime.mjs";

const EQUAL_WEIGHTS = { keyword_weight: 1, semantic_weight: 1, dense_weight: 1 };

function scored(overrides = {}) {
  return {
    title: "feature-builder",
    path: "03-skills-catalog/cards/custom/feature-builder.md",
    scope: "skills",
    source: "custom",
    score: 0.5,
    keyword_score: 0.6,
    semantic_score: 0.2,
    dense_score: 0.1,
    preview: "Implement a behaviour change.",
    ...overrides
  };
}

test("every preset declares the three weights and a scope", () => {
  const names = Object.keys(SEARCH_PRESETS);
  assert.deepEqual(names, ["balanced", "code", "docs", "skills", "projects", "debug", "frontend", "quality"]);
  for (const [name, preset] of Object.entries(SEARCH_PRESETS)) {
    for (const key of ["description", "use_when", "scope", "limit", "keyword_weight", "semantic_weight", "dense_weight"]) {
      assert.ok(preset[key] !== undefined, `${name} is missing ${key}`);
    }
  }
});

test("every alias points at a real preset", () => {
  for (const [alias, name] of Object.entries(SEARCH_PRESET_ALIASES)) {
    assert.ok(SEARCH_PRESETS[name], `${alias} -> ${name}`);
  }
});

test("preset names are normalized, aliased, and default to balanced", () => {
  assert.equal(searchPresetName("  Skills  "), "skills");
  assert.equal(searchPresetName("SKILL"), "skills");
  assert.equal(searchPresetName("bug"), "debug");
  assert.equal(searchPresetName(""), "balanced");
  assert.equal(searchPresetName(undefined), "balanced");
  assert.equal(searchPresetName("front end"), "front-end");
});

test("an unknown preset is refused with a pointer to the list", () => {
  assert.throws(() => getSearchPreset("not-a-preset"), /Unknown search preset: not-a-preset/);
  assert.equal(getSearchPreset("docs").name, "docs");
  assert.equal(getSearchPreset().name, "balanced");
});

test("the preset listing carries aliases and a weights block", () => {
  const listed = listSearchPresets();
  assert.equal(listed.length, Object.keys(SEARCH_PRESETS).length);
  const skills = listed.find((item) => item.name === "skills");
  assert.ok(skills.aliases.includes("skill"));
  assert.deepEqual(skills.weights, {
    keyword: skills.keyword_weight,
    semantic: skills.semantic_weight,
    dense: skills.dense_weight
  });
  assert.ok(listed.find((item) => item.name === "balanced").aliases.includes("default"));
});

test("an option counts as provided only when it carries a value", () => {
  assert.equal(optionProvided({ a: 1 }, "a"), true);
  assert.equal(optionProvided({ a: 0 }, "a"), true);
  assert.equal(optionProvided({ a: false }, "a"), true);
  assert.equal(optionProvided({ a: "" }, "a"), false);
  assert.equal(optionProvided({ a: null }, "a"), false);
  assert.equal(optionProvided({ a: undefined }, "a"), false);
  assert.equal(optionProvided({}, "a"), false);
  assert.equal(presetOption({ a: 2 }, "a", 9), 2);
  assert.equal(presetOption({ a: "" }, "a", 9), 9);
});

test("resolving a preset fills scope, limit and weights from it", () => {
  const resolved = resolveSearchPresetArgs({ query: "x", preset: "docs" });
  assert.equal(resolved.preset.name, "docs");
  assert.equal(resolved.search.scope, SEARCH_PRESETS.docs.scope);
  assert.equal(resolved.search.limit, SEARCH_PRESETS.docs.limit);
  assert.equal(resolved.search.keyword_weight, SEARCH_PRESETS.docs.keyword_weight);
  assert.equal(resolved.search.preset_name, "docs");
  assert.equal(resolved.search.rerank, true);
});

test("explicit options beat the preset, and the limit is clamped", () => {
  const resolved = resolveSearchPresetArgs({
    query: "x", preset: "docs", scope: "skills", limit: 999, keyword_weight: 0.9, intent_routing: true, rerank: false
  });
  assert.equal(resolved.search.scope, "skills");
  assert.equal(resolved.search.limit, 50);
  assert.equal(resolved.search.keyword_weight, 0.9);
  assert.equal(resolved.search.intent_routing, true);
  assert.equal(resolved.search.rerank, false);
  assert.equal(resolveSearchPresetArgs({ query: "x", limit: 0 }).search.limit, SEARCH_PRESETS.balanced.limit);
  assert.equal(resolveSearchPresetArgs({ query: "x", preset: "docs" }, { defaultLimit: 3 }).search.limit, SEARCH_PRESETS.docs.limit);
});

test("weights are clamped into [0,1] and fall back on nonsense", () => {
  assert.equal(clampSearchWeight(0.5, 0.45), 0.5);
  assert.equal(clampSearchWeight(-2, 0.45), 0);
  assert.equal(clampSearchWeight(9, 0.45), 1);
  assert.equal(clampSearchWeight("nope", 0.45), 0.45);
  assert.equal(clampSearchWeight(undefined, 0.45), 0.45);
});

test("weights are normalized to sum to one, and all-zero falls back to the defaults", () => {
  const equal = normalizedSearchWeights(EQUAL_WEIGHTS);
  assert.equal(roundSearchNumber(equal.keyword + equal.semantic + equal.dense), 1);
  assert.equal(roundSearchNumber(equal.keyword), roundSearchNumber(1 / 3));

  const zeroed = normalizedSearchWeights({ keyword_weight: 0, semantic_weight: 0, dense_weight: 0 });
  assert.equal(roundSearchNumber(zeroed.keyword), roundSearchNumber(0.45));
  assert.equal(roundSearchNumber(zeroed.dense), roundSearchNumber(0.35));

  const denseOff = normalizedSearchWeights({ keyword_weight: 0.5, semantic_weight: 0.5, dense_weight: 0 });
  assert.equal(denseOff.dense, 0);
  assert.equal(roundSearchNumber(denseOff.keyword + denseOff.semantic), 1);
  assert.equal(roundSearchNumber(normalizedSearchWeights().keyword + normalizedSearchWeights().semantic + normalizedSearchWeights().dense), 1);
});

test("rounding keeps six digits by default", () => {
  assert.equal(roundSearchNumber(1 / 3), 0.333333);
  assert.equal(roundSearchNumber(1 / 3, 2), 0.33);
  assert.equal(roundSearchNumber("nope"), 0);
});

test("the applied summary echoes the filters and both weight views", () => {
  const resolved = resolveSearchPresetArgs({
    query: "x", preset: "code", project: "atlas", folders: ["a", "b"], source: "custom"
  });
  const summary = appliedSearchPresetSummary(resolved);
  assert.equal(summary.preset.name, "code");
  assert.equal(summary.filters.project, "atlas");
  assert.equal(summary.filters.folders, "a,b");
  assert.equal(summary.filters.source, "custom");
  assert.equal(summary.reranker.enabled, true);
  assert.equal(summary.reranker.version, 2);
  assert.equal(roundSearchNumber(
    summary.weights.normalized.keyword + summary.weights.normalized.semantic + summary.weights.normalized.dense
  ), 1);
});

test("the strongest component names why a result ranked", () => {
  assert.match(explainSearchProfile(scored()), /keyword\/FTS match/);
  assert.match(explainSearchProfile(scored({ keyword_score: 0, dense_score: 0.9 })), /dense BGE-M3 meaning match/);
  assert.match(explainSearchProfile(scored({ keyword_score: 0, dense_score: 0, semantic_score: 0.5 })), /local sparse semantic match/);
  assert.match(explainSearchProfile(scored({ keyword_score: 0, dense_score: 0, semantic_score: 0 })), /weak match/);
});

test("the adjustment note separates boosts, penalties and neither", () => {
  assert.match(explainScoreAdjustment(0.2), /positive adjustment/);
  assert.match(explainScoreAdjustment(-0.2), /negative adjustment/);
  assert.match(explainScoreAdjustment(0.001), /close to pure weighted score/);
});

test("a result explanation reconstructs the weighted score and the leftover", () => {
  const weights = normalizedSearchWeights(EQUAL_WEIGHTS);
  const explained = explainSearchResult(scored({ score: 0.4 }), 0, weights);
  assert.equal(explained.rank, 1);
  assert.equal(explained.title, "feature-builder");
  const expected = roundSearchNumber((0.6 + 0.2 + 0.1) / 3);
  assert.equal(explained.weighted_score_before_adjustments, expected);
  assert.equal(explained.score_adjustment, roundSearchNumber(0.4 - expected));
  assert.equal(explained.score_parts.keyword.raw, 0.6);
  assert.equal(explained.score_parts.dense.weight, roundSearchNumber(weights.dense));
  assert.deepEqual(explained.rerank_reasons, []);
  assert.equal(explained.hard_negative, false);
});

test("tuning notes flag a dense weight with no dense scores, and a keyword-free result set", () => {
  const denseWeights = normalizedSearchWeights({ keyword_weight: 0.5, semantic_weight: 0.2, dense_weight: 0.3 });
  const noDense = explainSearchTuningNotes([scored({ dense_score: 0 })], denseWeights);
  assert.ok(noDense.some((note) => /Rebuild the index with dense_embeddings=true/.test(note)));

  const noKeyword = explainSearchTuningNotes([scored({ keyword_score: 0 })], denseWeights);
  assert.ok(noKeyword.some((note) => /answered mostly by semantic meaning/.test(note)));
});

test("tuning notes warn when the top two results are within a hair of each other", () => {
  const weights = normalizedSearchWeights(EQUAL_WEIGHTS);
  const close = explainSearchTuningNotes([scored({ score: 0.5 }), scored({ score: 0.49 })], weights);
  assert.ok(close.some((note) => /Top results are close/.test(note)));

  const apart = explainSearchTuningNotes([scored({ score: 0.9 }), scored({ score: 0.1 })], weights);
  assert.ok(!apart.some((note) => /Top results are close/.test(note)));
});

test("healthy rankings get one positive note rather than silence", () => {
  const weights = normalizedSearchWeights({ keyword_weight: 1, semantic_weight: 0, dense_weight: 0 });
  const notes = explainSearchTuningNotes([scored()], weights);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /Ranking signals look healthy/);
});
