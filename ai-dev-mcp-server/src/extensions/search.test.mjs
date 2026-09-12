import assert from "node:assert/strict";
import test from "node:test";
import { createExtensionTools } from "../tool-extensions.mjs";
import { SEARCH_PRESETS } from "../core/search-runtime.mjs";
import { createSearchTools } from "./search.mjs";

/** Mirrors the extension's own explain limits. */
const EXPLAIN_MAX = 20;
const EXPLAIN_DEFAULT = 5;

function hit(overrides = {}) {
  return {
    title: "feature-builder",
    path: "03-skills-catalog/cards/custom/feature-builder.md",
    scope: "skills",
    source: "custom",
    score: 0.8,
    keyword_score: 0.6,
    semantic_score: 0.2,
    dense_score: 0,
    preview: "Implement a behaviour change.",
    ...overrides
  };
}

/**
 * A host whose two search services are recorders: every call is captured and the
 * answer comes from the test. Nothing runs Python, sqlite or a model.
 */
function createFixture({ results = [hit()], cases = [], searchResults = null } = {}) {
  const calls = [];
  const host = {
    search: {
      status: async (args) => {
        calls.push(["status", args]);
        return { stale: false, document_count: 7 };
      },
      rebuild: async (args) => {
        calls.push(["rebuild", args]);
        return { document_count: 7 };
      },
      search: async (args) => {
        calls.push(["search", args]);
        return searchResults ?? results;
      },
      hybridSearch: async (args) => {
        calls.push(["hybridSearch", args]);
        return typeof results === "function" ? results(args) : results;
      }
    },
    embeddings: {
      embedTexts: async (args) => {
        calls.push(["embedTexts", args]);
        return { embeddings: [[0.1]] };
      },
      status: async (args) => {
        calls.push(["embeddingStatus", args]);
        return { backend: "bge-m3-local" };
      }
    },
    readSearchEvalCases: async (casesPath) => {
      calls.push(["readSearchEvalCases", casesPath]);
      return { path: "09-mcp/search-eval/search_eval_cases.json", schema_version: 2, description: "fixture", cases };
    }
  };
  return { host, calls, registry: createExtensionTools(host, [createSearchTools]) };
}

const call = (registry, name, args) => registry.handlers.get(name)(args);

test("the search extension exposes thirteen tools, all read-only but the rebuild", () => {
  const { registry } = createFixture();
  assert.deepEqual(registry.definitions.map((definition) => definition.name), [
    "search_index_status", "rebuild_search_index", "search_all", "hybrid_search",
    "list_search_presets", "preset_search", "explain_search", "run_search_eval",
    "embed_texts", "embedding_status", "search_projects", "search_notes", "search_skill_registry"
  ]);
  assert.ok(!registry.readOnly.includes("rebuild_search_index"));
  assert.equal(registry.readOnly.length, 12);
  for (const definition of registry.definitions) assert.equal(definition.inputSchema.type, "object");
});

test("index status and rebuild pass their arguments straight to the runtime", async () => {
  const { registry, calls } = createFixture();
  assert.equal((await call(registry, "search_index_status", { include_external_project_files: false })).document_count, 7);
  await call(registry, "rebuild_search_index", { dense_embeddings: true });
  assert.deepEqual(calls[0], ["status", { include_external_project_files: false }]);
  assert.deepEqual(calls[1], ["rebuild", { dense_embeddings: true }]);
});

test("search_all forwards every filter and defaults the rest", async () => {
  const { registry, calls } = createFixture();
  await call(registry, "search_all", { query: "x", scope: "skills", folders: "a" });
  assert.deepEqual(calls[0][1], {
    query: "x", scope: "skills", limit: 10, project: "", source: "", categories: "", folders: "a"
  });
  await call(registry, "search_all");
  assert.equal(calls[1][1].query, undefined);
  assert.equal(calls[1][1].scope, "all");
});

test("hybrid_search resolves the preset before reaching the index", async () => {
  const { registry, calls } = createFixture();
  await call(registry, "hybrid_search", { query: "x", preset: "docs" });
  const [, args] = calls[0];
  assert.equal(args.scope, SEARCH_PRESETS.docs.scope);
  assert.equal(args.dense_weight, SEARCH_PRESETS.docs.dense_weight);
  assert.equal(args.preset_name, "docs");
});

test("the preset list is data, and needs no runtime at all", async () => {
  const { registry, calls } = createFixture();
  const presets = await call(registry, "list_search_presets", {});
  assert.equal(presets.length, Object.keys(SEARCH_PRESETS).length);
  assert.deepEqual(calls, []);
});

test("preset_search reports the applied preset and returns plain results by default", async () => {
  const { registry } = createFixture();
  const plain = await call(registry, "preset_search", { query: "x", preset: "skills" });
  assert.equal(plain.result_count, 1);
  assert.equal(plain.applied.preset.name, "skills");
  assert.equal(plain.tuning_notes, undefined);
  assert.equal(plain.results[0].title, "feature-builder");
  assert.equal("score_parts" in plain.results[0], false);
});

test("preset_search with explain=true breaks each score down", async () => {
  const { registry } = createFixture();
  const explained = await call(registry, "preset_search", { query: "x", explain: true });
  assert.ok(explained.tuning_notes.length > 0);
  assert.ok(explained.results[0].score_parts.keyword.raw > 0);
  assert.equal(explained.results[0].rank, 1);
});

test("explain_search clamps its own limit and always explains", async () => {
  const { registry, calls } = createFixture();
  const explained = await call(registry, "explain_search", { query: "x", limit: 999 });
  assert.equal(calls[0][1].limit, EXPLAIN_MAX);
  assert.equal(explained.query, "x");
  assert.ok(explained.notes.length === 2);
  assert.ok(explained.results[0].likely_reason);

  // With no explicit limit the preset's own limit wins; the explain default only
  // applies to a preset that does not set one.
  const { registry: defaulted, calls: defaultCalls } = createFixture();
  await call(defaulted, "explain_search", { query: "x" });
  assert.equal(defaultCalls[0][1].limit, SEARCH_PRESETS.balanced.limit);
  assert.ok(EXPLAIN_DEFAULT < EXPLAIN_MAX);
});

test("an eval run with no cases fails rather than passing vacuously", async () => {
  const { registry } = createFixture({ cases: [] });
  const run = await call(registry, "run_search_eval", {});
  assert.equal(run.status, "fail");
  assert.equal(run.summary.total, 0);
  assert.match(run.recommendations[0], /Add or unfilter search eval cases/);
});

test("an eval run scores each case and reports the metrics over the scored ones", async () => {
  const { registry } = createFixture({
    cases: [
      { id: "hit", query: "a", expected: [{ title: "feature-builder" }] },
      { id: "miss", query: "b", expected: [{ title: "absent" }] },
      { id: "no-criteria", query: "c" }
    ]
  });
  const run = await call(registry, "run_search_eval", { include_dense: false });
  assert.equal(run.status, "fail");
  assert.deepEqual(
    { total: run.summary.total, passed: run.summary.passed, failed: run.summary.failed, skipped: run.summary.skipped },
    { total: 3, passed: 1, failed: 1, skipped: 1 }
  );
  assert.equal(run.summary.metrics.top_1_accuracy, 0.5);
  assert.equal(run.include_dense, false);
  assert.equal(run.cases_path, "09-mcp/search-eval/search_eval_cases.json");
  for (const item of run.cases) assert.ok(Number.isFinite(item.duration_ms));
});

test("a case with no query fails as a case, without stopping the run", async () => {
  const { registry } = createFixture({
    cases: [{ id: "broken" }, { id: "hit", query: "a", expected: [{ title: "feature-builder" }] }]
  });
  const run = await call(registry, "run_search_eval", {});
  assert.equal(run.summary.total, 2);
  assert.equal(run.cases[0].error, "Case query is required.");
  assert.equal(run.cases[1].status, "pass");
});

test("a query that throws fails that case only", async () => {
  const { registry } = createFixture({
    results: (args) => {
      if (args.query === "boom") throw new Error("index unavailable");
      return [hit()];
    },
    cases: [
      { id: "boom", query: "boom", expected: [{ title: "feature-builder" }] },
      { id: "ok", query: "a", expected: [{ title: "feature-builder" }] }
    ]
  });
  const run = await call(registry, "run_search_eval", {});
  assert.equal(run.cases[0].status, "fail");
  assert.equal(run.cases[0].error, "index unavailable");
  assert.equal(run.cases[1].status, "pass");
});

test("fail_fast stops at the first failure", async () => {
  const { registry } = createFixture({
    cases: [
      { id: "miss", query: "a", expected: [{ title: "absent" }] },
      { id: "hit", query: "b", expected: [{ title: "feature-builder" }] }
    ]
  });
  const run = await call(registry, "run_search_eval", { fail_fast: true });
  assert.equal(run.summary.total, 1);
  assert.equal(run.cases[0].id, "miss");
});

test("cases can be filtered by id, by preset, and capped", async () => {
  const cases = [
    { id: "one", query: "a", preset: "skills", expected: [{ title: "feature-builder" }] },
    { id: "two", query: "b", preset: "docs", expected: [{ title: "feature-builder" }] },
    { id: "three", query: "c", preset: "skills", expected: [{ title: "feature-builder" }] }
  ];
  const byId = await call(createFixture({ cases }).registry, "run_search_eval", { case_ids: ["two"] });
  assert.deepEqual(byId.cases.map((item) => item.id), ["two"]);
  assert.deepEqual(byId.filters.case_ids, ["two"]);

  const byCsv = await call(createFixture({ cases }).registry, "run_search_eval", { case_ids: "one,three" });
  assert.deepEqual(byCsv.cases.map((item) => item.id), ["one", "three"]);

  const byPreset = await call(createFixture({ cases }).registry, "run_search_eval", { presets: ["skill"] });
  assert.deepEqual(byPreset.cases.map((item) => item.id), ["one", "three"]);
  assert.deepEqual(byPreset.filters.presets, ["skills"]);

  const capped = await call(createFixture({ cases }).registry, "run_search_eval", { max_cases: 2 });
  assert.equal(capped.summary.total, 2);
  assert.equal(capped.filters.max_cases, 2);
});

test("include_dense=false zeroes the dense weight unless the case set one", async () => {
  const { registry, calls } = createFixture({
    cases: [
      { id: "default", query: "a", expected: [{ title: "feature-builder" }] },
      { id: "explicit", query: "b", dense_weight: 0.9, expected: [{ title: "feature-builder" }] }
    ]
  });
  await call(registry, "run_search_eval", { include_dense: false });
  const searches = calls.filter(([name]) => name === "hybridSearch");
  assert.equal(searches[0][1].dense_weight, 0);
  assert.equal(searches[1][1].dense_weight, 0.9);
});

test("embedding tools hand their arguments to the backend untouched", async () => {
  const { registry, calls } = createFixture();
  await call(registry, "embed_texts", { text: "hello", use_worker: false });
  await call(registry, "embedding_status", { device: "cuda" });
  assert.deepEqual(calls[0], ["embedTexts", { text: "hello", use_worker: false }]);
  assert.deepEqual(calls[1], ["embeddingStatus", { device: "cuda" }]);
});

test("the narrow wrappers pin their own scope", async () => {
  const { registry, calls } = createFixture();
  await call(registry, "search_projects", { query: "atlas", project: "one" });
  assert.deepEqual(calls[0][1], { query: "atlas", scope: "projects", project: "one", limit: 10 });

  await call(registry, "search_skill_registry", { query: "frontend", source: "custom", limit: 4 });
  assert.deepEqual(calls[1][1], { query: "frontend", scope: "skills", source: "custom", categories: "", limit: 4 });
});

test("search_notes widens to every scope once folders are named", async () => {
  const { registry, calls } = createFixture();
  await call(registry, "search_notes", { query: "design" });
  assert.deepEqual(calls[0][1], { query: "design", scope: "knowledge", folders: "", limit: 10 });

  await call(registry, "search_notes", { query: "design", folders: ["a", "b"] });
  assert.deepEqual(calls[1][1], { query: "design", scope: "all", folders: "a,b", limit: 10 });
});
