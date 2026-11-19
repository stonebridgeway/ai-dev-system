import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSearchIndexRuntime, searchUnavailableReason } from "./search-index.mjs";

/**
 * These tests drive the runtime's own logic — freshness, dense planning,
 * reranking, routing — against a stand-in for the index. The index itself is
 * tested against real files in `search-index-node.test.mjs` and the modules
 * it is made of.
 */

/** Ranking collaborators that do nothing, so a test sees the raw merge. */
const PASSTHROUGH_RANKING = {
  repairSearchMojibake: (value) => value,
  prioritizeKnowledgeResults: (_query, results) => results,
  rerankSearchResults: (_query, results) => results,
  isSkillCatalogQuery: () => false,
  routeSkills: () => ({ skills: [] })
};

function hit(overrides = {}) {
  return { title: "feature-builder", path: "a.md", scope: "skills", score: 1, ...overrides };
}

const ONNX = { backend: "onnx", available: true, reason: "ready", provenance: { backend: "onnx", revision: "abc", dtype: "int8", dimensions: 3 } };

/**
 * A runtime over a stand-in engine: every call is recorded, and each answer
 * comes from the handler the test gives for that method.
 */
async function createFixture(t, { answers = {}, ranking = {}, embed, describe = async () => ONNX, registry = [] } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "search-index-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const calls = [];
  const answer = (method, options) => {
    calls.push({ method, options });
    const handler = answers[method];
    return typeof handler === "function" ? handler(options) : handler;
  };
  const engine = {
    status: async (options) => ({ stale: false, ...(answer("status", options) ?? {}) }),
    densePlan: async (options) => answer("densePlan", options) ?? { records: [] },
    storeDense: async (options) => answer("storeDense", options) ?? { stored: options.vectors.length },
    rebuild: async (options) => ({ document_count: 3, ...(answer("rebuild", options) ?? {}) }),
    keyword: async (options) => answer("keyword", options) ?? [],
    hybrid: async (options) => answer("hybrid", options) ?? [],
    galaxy: async () => answer("galaxy") ?? { manifest: {} },
    knowledge: async (options) => answer("knowledge", options) ?? []
  };
  const runtime = createSearchIndexRuntime({
    vaultRoot: "/vault",
    searchIndexDir: path.join(root, "cache"),
    searchIndexPath: path.join(root, "cache", "ai-dev-search.sqlite"),
    defaultModelDir: "/models/bge-m3",
    embedQuery: async (payload, options) => {
      calls.push({ method: "embedQuery", payload, options });
      if (embed) return embed(payload, options);
      return { embeddings: payload.texts.map(() => [0.1, 0.2, 0.3]) };
    },
    denseIndexBackend: { describe },
    hardNegativeRules: async () => [],
    readSkillIndex: async () => registry,
    ranking: { ...PASSTHROUGH_RANKING, ...ranking },
    engine
  });
  const of = (method) => calls.filter((call) => call.method === method);
  return { root, runtime, calls, of };
}

test("search refuses to run on a Node without FTS5 and says which Node it needs", async (t) => {
  assert.equal(searchUnavailableReason({ support: () => ({ available: true, reason: "" }) }), null);
  const reason = searchUnavailableReason({ support: () => ({ available: false, reason: "no such module: fts5" }), version: "v23.11.1" });
  assert.match(reason, /Node\.js 22\.16 or newer \(or 24\+\).*this is Node v23\.11\.1: no such module: fts5/);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "search-index-old-node-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runtime = createSearchIndexRuntime({
    vaultRoot: "/vault",
    searchIndexDir: root,
    searchIndexPath: path.join(root, "i.sqlite"),
    defaultModelDir: "/models",
    embedQuery: async () => ({}),
    hardNegativeRules: async () => [],
    readSkillIndex: async () => [],
    ranking: PASSTHROUGH_RANKING,
    unavailable: () => reason
  });
  for (const call of [() => runtime.status(), () => runtime.search({ query: "x" }), () => runtime.hybridSearch({ query: "x" }),
    () => runtime.searchKnowledge({ query: "x" }), () => runtime.rebuild(), () => runtime.exportGalaxy()]) {
    await assert.rejects(call, /Node\.js 22\.16 or newer/);
  }
  // The project tools rebuild as a courtesy: their own work stands, and the index is reported as skipped.
  assert.deepEqual(await runtime.rebuildIfSupported({ include_external_project_files: true }), { skipped: reason });
});

test("where search runs, the courtesy rebuild is the rebuild", async (t) => {
  const { runtime, of } = await createFixture(t);
  const rebuilt = await runtime.rebuildIfSupported({ include_external_project_files: true });
  assert.deepEqual([rebuilt.document_count, rebuilt.engine], [3, "node"]);
  assert.equal(of("rebuild").length, 1);
});

test("status asks the index about the vault and reports the dirty reason", async (t) => {
  const { runtime, of } = await createFixture(t, { answers: { status: { document_count: 12 } } });
  const clean = await runtime.status();
  assert.deepEqual([clean.document_count, clean.dirty_reason, clean.engine], [12, "", "node"]);
  assert.deepEqual(of("status")[0].options, { includeExternalProjectFiles: true });

  runtime.markDirty("a note was written");
  assert.equal(runtime.dirtyReason(), "a note was written");
  assert.equal((await runtime.status()).dirty_reason, "a note was written");
  await runtime.status({ include_external_project_files: false });
  assert.deepEqual(of("status").at(-1).options, { includeExternalProjectFiles: false });
});

test("marking dirty without a reason still marks it", async (t) => {
  const { runtime } = await createFixture(t);
  runtime.markDirty();
  assert.equal(runtime.dirtyReason(), "source changed");
  runtime.markDirty("");
  assert.equal(runtime.dirtyReason(), "source changed");
});

test("a plain rebuild preserves existing dense vectors and clears the dirty flag", async (t) => {
  const { runtime, of } = await createFixture(t);
  runtime.markDirty("something changed");
  const rebuilt = await runtime.rebuild();
  assert.deepEqual([rebuilt.document_count, rebuilt.engine], [3, "node"]);
  assert.equal(runtime.dirtyReason(), "");
  const options = of("rebuild")[0].options;
  assert.deepEqual([options.preserveDense, options.denseEmbeddings, options.inPlace, options.suppliedVectors], [true, false, false, []]);
  assert.equal(of("densePlan").length, 0);
  assert.equal(of("embedQuery").length, 0);
});

test("a dense rebuild brings the documents up to date, then embeds and stores slice by slice, its knobs clamped", async (t) => {
  const records = [{ id: "a", content_hash: "ha", text: "passage: a" }, { id: "b", content_hash: "hb", text: "passage: b" }];
  const { runtime, of, calls } = await createFixture(t, { answers: { densePlan: { records, eligible: 5, reusable: 3 } } });
  const events = [];
  const rebuilt = await runtime.rebuild({
    dense_embeddings: true,
    dense_batch_size: 999,
    dense_text_limit: 1,
    dense_include_membrane: true,
    dense_incremental: false,
    in_place: true,
    onProgress: (event) => events.push(event)
  });
  assert.deepEqual(calls.map((call) => call.method).filter((name) => name !== "status"), ["rebuild", "densePlan", "embedQuery", "storeDense", "rebuild"],
    "documents first, then plan, embed, store, and the closing write");
  assert.deepEqual([of("rebuild")[0].options.inPlace, of("rebuild")[0].options.preserveDense, of("rebuild")[0].options.denseEmbeddings], [true, true, undefined]);
  assert.deepEqual(of("densePlan")[0].options, {
    includeExternalProjectFiles: true, textLimit: 300, includeMembrane: true, incremental: false, provenance: ONNX.provenance
  });
  assert.equal(of("embedQuery")[0].payload.batch_size, 32);
  const stored = of("storeDense")[0].options;
  assert.deepEqual(stored.vectors.map((vector) => vector.id), ["a", "b"]);
  assert.deepEqual([stored.provenance, stored.textLimit, stored.includeMembrane, stored.eligible], [ONNX.provenance, 300, true, 5]);
  const closing = of("rebuild")[1].options;
  assert.deepEqual(closing.suppliedVectors, [], "the vectors are stored already");
  assert.deepEqual([closing.denseEmbeddings, closing.preserveDense, closing.inPlace, closing.denseTextLimit, closing.denseIncremental], [true, false, false, 300, true]);
  assert.deepEqual([closing.denseBackend, closing.denseRevision, closing.denseDtype], ["onnx", "abc", "int8"]);
  assert.deepEqual([rebuilt.dense_planned_documents, rebuilt.dense_embedded_documents], [2, 2]);
  assert.deepEqual(events.map((event) => [event.phase, event.done, event.total]), [["embedding", 0, 2], ["embedding", 2, 2], ["embedding", 2, 2]]);
  assert.deepEqual([events[0].eligible, events[0].reused, events[0].etaSeconds], [5, 3, null]);
});

test("a cancel between batches keeps every stored slice, skips the closing write and says how many are left", async (t) => {
  const records = Array.from({ length: 150 }, (_, index) => ({ id: `d${index}`, content_hash: `h${index}`, text: `passage: ${index}` }));
  const controller = new AbortController();
  const { runtime, of } = await createFixture(t, {
    answers: { densePlan: { records, eligible: 150, reusable: 0 } },
    embed: async (payload) => {
      if (of("storeDense").length === 1) controller.abort();
      return { embeddings: payload.texts.map(() => [0.1, 0.2, 0.3]) };
    }
  });
  const failure = await runtime.rebuild({ dense_embeddings: true, dense_batch_size: 8, signal: controller.signal }).then(() => null, (error) => error);
  assert.equal(failure?.name, "AbortError");
  assert.match(failure.message, /^Embedding cancelled: 64 of 150 document\(s\) were embedded and are kept; the other 86 wait for the next run\.$/);
  assert.equal(of("storeDense").length, 1, "one slice of 64 was stored");
  assert.equal(of("rebuild").length, 1, "the documents were refreshed; the closing write did not happen");
  assert.equal(runtime.dirtyReason(), "", "nothing marked dirty by a cancel");
});

test("a dense rebuild with no model says what to install instead of reaching for an interpreter", async (t) => {
  const { runtime, of } = await createFixture(t, {
    describe: async () => ({ backend: "onnx", available: false, reason: "Dense search is not installed. Run `npm run setup -- --model`." })
  });
  await assert.rejects(runtime.rebuild({ dense_embeddings: true }), /no embedding model can run here\. Dense search is not installed\. Run `npm run setup -- --model`/);
  assert.equal(of("rebuild").length, 0, "nothing is written");
  assert.equal(of("embedQuery").length, 0);
});

test("a dense rebuild hands the embedder the model folder and device the caller named", async (t) => {
  const { runtime, of } = await createFixture(t, { answers: { densePlan: { records: [{ id: "a", content_hash: "h", text: "passage: t" }] } } });
  await runtime.rebuild({ dense_embeddings: true, dense_model_dir: "/custom/bge-m3-onnx", dense_device: "cuda" });
  const { payload } = of("embedQuery")[0];
  assert.deepEqual([payload.model_dir, payload.device], ["/custom/bge-m3-onnx", "cuda"]);
  assert.equal(of("rebuild")[1].options.denseModelDir, path.resolve("/custom/bge-m3-onnx"), "the index records the folder the vectors came from");
  await runtime.rebuild({ dense_embeddings: true });
  const fallback = of("embedQuery")[1].payload;
  assert.deepEqual([fallback.model_dir, fallback.device], ["/models/bge-m3", process.env.BGE_M3_DEVICE || "cpu"], "unnamed, the runtime's own folder");
});

test("a fresh index is left alone; a stale one is rebuilt once", async (t) => {
  const { runtime, of } = await createFixture(t);
  assert.equal((await runtime.ensureFresh()).action, "current");
  assert.equal(of("status").length, 1);
  // Within the freshness window the verdict is reused rather than re-checked.
  await runtime.ensureFresh();
  assert.equal(of("status").length, 1);
});

test("a dirty flag forces a rebuild even when the index looks fresh, in place", async (t) => {
  const { runtime, calls } = await createFixture(t);
  runtime.markDirty("a skill was written");
  const refreshed = await runtime.ensureFresh();
  assert.equal(refreshed.action, "rebuilt");
  assert.equal(runtime.dirtyReason(), "");
  assert.deepEqual(calls.map((call) => call.method), ["status", "rebuild", "status"]);
  assert.equal(calls[1].options.inPlace, true);
});

test("a caller arriving mid-rebuild joins it instead of starting another", async (t) => {
  let releaseRebuild;
  const rebuildStarted = new Promise((resolve) => {
    releaseRebuild = resolve;
  });
  let unblock;
  const held = new Promise((resolve) => {
    unblock = resolve;
  });
  const { runtime, of } = await createFixture(t, {
    answers: {
      status: { stale: true },
      rebuild: async () => {
        releaseRebuild();
        await held;
        return {};
      }
    }
  });
  const first = runtime.ensureFresh();
  await rebuildStarted;
  const second = runtime.ensureFresh();
  unblock();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.action, "rebuilt");
  assert.equal(b, a);
  assert.equal(of("rebuild").length, 1);
});

test("search refuses an empty query and passes filters through as csv", async (t) => {
  const { runtime, of } = await createFixture(t, { answers: { keyword: [hit()] } });
  await assert.rejects(() => runtime.search({ query: "" }), /query is required/);
  await assert.rejects(() => runtime.search({ query: 7 }), /query is required/);
  const results = await runtime.search({
    query: "feature builder", scope: "skills", limit: 999, folders: ["a", "b"], source: ["custom"], ensure_fresh: false
  });
  assert.deepEqual(results, [hit()]);
  assert.deepEqual(of("keyword")[0].options, {
    query: "feature builder", scope: "skills", limit: 50, project: "", source: "custom", categories: "", folders: "a,b"
  });
  assert.equal(of("status").length, 0, "no freshness check when told not to");
});

test("search_knowledge runs over the index after a freshness check", async (t) => {
  const { runtime, calls } = await createFixture(t, { answers: { knowledge: [{ path: "a.md", score: 4, preview: "a" }] } });
  await assert.rejects(() => runtime.searchKnowledge({ query: "" }), /query is required/);
  assert.deepEqual(await runtime.searchKnowledge({ query: "code review", limit: 5 }), [{ path: "a.md", score: 4, preview: "a" }]);
  assert.deepEqual(calls.map((call) => call.method), ["status", "knowledge"]);
  assert.deepEqual(calls[1].options, { query: "code review", limit: 5 });
});

test("the galaxy export is read from the index in memory", async (t) => {
  const exported = { manifest: { schema: 1 }, semanticBytes: new Uint8Array(0), denseBytes: new Uint8Array(0) };
  const { runtime } = await createFixture(t, { answers: { galaxy: exported } });
  assert.equal(await runtime.exportGalaxy(), exported);
});

test("hybrid search asks for fifty candidates and trims after ranking", async (t) => {
  const many = Array.from({ length: 20 }, (_, index) => hit({ title: `r${index}` }));
  const { runtime, of } = await createFixture(t, { answers: { hybrid: many } });
  const results = await runtime.hybridSearch({ query: "x", limit: 3, dense_weight: 0, ensure_fresh: false });
  assert.equal(results.length, 3);
  assert.equal(of("hybrid")[0].options.limit, 50);
  assert.equal(of("hybrid")[0].options.denseWeight, 0);
});

test("a zero dense weight never touches the embedding backend", async (t) => {
  const { runtime, of } = await createFixture(t, { answers: { hybrid: [hit()] } });
  await runtime.hybridSearch({ query: "x", dense_weight: 0, ensure_fresh: false });
  assert.equal(of("embedQuery").length, 0);
  assert.equal(of("hybrid")[0].options.denseQueryVector, null);
});

test("a positive dense weight embeds the query here and hands the vector over in memory", async (t) => {
  const { runtime, of, root } = await createFixture(t, { answers: { hybrid: [hit()] } });
  await runtime.hybridSearch({ query: "x", dense_weight: 0.35, ensure_fresh: false });
  const [embed] = of("embedQuery");
  assert.deepEqual([embed.payload.texts, embed.payload.prefix, embed.payload.precision], [["x"], "query: ", 8]);
  assert.deepEqual(of("hybrid")[0].options.denseQueryVector, [0.1, 0.2, 0.3]);
  // Nothing was written to hand it over.
  assert.equal(await fs.readdir(path.join(root, "cache")).then((files) => files.length, () => 0), 0);
});

test("a nonsense weight falls back rather than reaching the index as NaN", async (t) => {
  const { runtime, of } = await createFixture(t, { answers: { hybrid: [hit()] } });
  await runtime.hybridSearch({ query: "x", dense_weight: "nope", semantic_weight: "nope", keyword_weight: "nope", ensure_fresh: false });
  const options = of("hybrid")[0].options;
  assert.deepEqual([options.denseWeight, options.semanticWeight, options.keywordWeight], [0.35, 0.2, 0.45]);
});

test("reranking and knowledge routing are applied only when asked", async (t) => {
  const seen = [];
  const { runtime } = await createFixture(t, {
    answers: { hybrid: [hit()] },
    ranking: {
      rerankSearchResults: (query, results, options) => {
        seen.push(["rerank", options.scope, options.preset]);
        return results;
      },
      prioritizeKnowledgeResults: (query, results) => {
        seen.push(["knowledge"]);
        return results;
      }
    }
  });
  await runtime.hybridSearch({ query: "x", dense_weight: 0, rerank: false, ensure_fresh: false });
  assert.deepEqual(seen, []);
  await runtime.hybridSearch({ query: "x", dense_weight: 0, preset_name: "docs", scope: "knowledge", intent_routing: true, ensure_fresh: false });
  assert.deepEqual(seen, [["knowledge"], ["rerank", "knowledge", "docs"]]);
});

test("intent routing builds no row for a skill the registry does not have", async (t) => {
  const { runtime } = await createFixture(t, {
    answers: { hybrid: [hit({ title: "something-else" })] },
    ranking: { routeSkills: () => ({ skills: [{ name: "feature-builder", role: "workflow", reason: "because", rule: "r1" }] }) }
  });
  const results = await runtime.hybridSearch({ query: "x", scope: "skills", intent_routing: true, dense_weight: 0, ensure_fresh: false });
  assert.deepEqual(results.map((item) => item.title), ["something-else"]);
});

test("a routed skill present in the registry is prepended and de-duplicated", async (t) => {
  const { runtime } = await createFixture(t, {
    answers: { hybrid: [hit({ title: "feature-builder" }), hit({ title: "other" })] },
    registry: [{ name: "feature-builder", source: "custom", path: "custom/feature-builder/SKILL.md", categories: ["workflow"], description: "d" }],
    ranking: { routeSkills: () => ({ skills: [{ name: "feature-builder", role: "workflow", reason: "because", rule: "r1" }] }) }
  });
  const results = await runtime.hybridSearch({ query: "x", scope: "skills", intent_routing: true, dense_weight: 0, ensure_fresh: false });
  assert.deepEqual(results.map((item) => item.title), ["feature-builder", "other"]);
  assert.deepEqual([results[0].mode, results[0].retrieval_stage, results[0].routing_rule, results[0].categories],
    ["routed-hybrid", "deterministic-intent-router", "r1", "workflow"]);
});

test("routing stands down when the caller narrowed the search themselves", async (t) => {
  const routed = { routeSkills: () => ({ skills: [{ name: "feature-builder", role: "workflow", reason: "because", rule: "r1" }] }) };
  for (const narrowing of [{ project: "atlas" }, { folders: "03-skills-catalog" }, { source: "design/taste-skill" }, { scope: "projects" }]) {
    const { runtime } = await createFixture(t, {
      answers: { hybrid: [hit({ title: "other" })] },
      registry: [{ name: "feature-builder", source: "custom", path: "p", categories: [], description: "d" }],
      ranking: routed
    });
    const results = await runtime.hybridSearch({ query: "x", scope: "skills", intent_routing: true, dense_weight: 0, ensure_fresh: false, ...narrowing });
    assert.deepEqual(results.map((item) => item.title), ["other"], JSON.stringify(narrowing));
  }
});

test("an explicit skill-catalog query is answered by the index, not the router", async (t) => {
  const { runtime } = await createFixture(t, {
    answers: { hybrid: [hit({ title: "other" })] },
    registry: [{ name: "feature-builder", source: "custom", path: "p", categories: [], description: "d" }],
    ranking: {
      isSkillCatalogQuery: () => true,
      routeSkills: () => ({ skills: [{ name: "feature-builder", role: "workflow", reason: "b", rule: "r" }] })
    }
  });
  const results = await runtime.hybridSearch({ query: "list every skill", scope: "skills", intent_routing: true, dense_weight: 0, ensure_fresh: false });
  assert.deepEqual(results.map((item) => item.title), ["other"]);
});

test("a missing model degrades the search instead of ending it", async (t) => {
  // Keyword and sparse need no model; dense is the optional half.
  const { runtime, of } = await createFixture(t, {
    answers: { hybrid: [{ path: "01-system/Operating Model.md", title: "Operating Model", score: 1 }] },
    embed: async () => {
      throw new Error("Dense search is not installed. Run `npm run setup -- --model`.");
    }
  });
  const results = await runtime.hybridSearch({ query: "operating model", dense_weight: 0.35, ensure_fresh: false });
  assert.equal(results.length, 1);
  assert.match(results.dense_unavailable, /Dense search is not installed/);
  assert.equal(of("hybrid")[0].options.denseQueryVector, null);
  // The note rides alongside the array rather than inside it.
  assert.equal(JSON.parse(JSON.stringify(results)).length, 1);
  assert.equal(Object.keys(results[0]).includes("dense_unavailable"), false);
});

test("vectors all from another model: the search says the dense half had nothing to compare", async (t) => {
  const { runtime } = await createFixture(t, {
    answers: { hybrid: () => Object.defineProperty([{ path: "a.md", title: "A", score: 1 }], "dense_unmatched", { value: true }) }
  });
  const results = await runtime.hybridSearch({ query: "operating model", dense_weight: 0.35, ensure_fresh: false });
  assert.equal(results.dense_unavailable, "no indexed document has a vector of the installed model yet; `npm run setup -- --model` embeds them");
  assert.equal(JSON.parse(JSON.stringify(results)).length, 1);
});

test("status counts the current model's vectors and names another model's as waiting", async (t) => {
  const python = { backend: "python", revision: "unpinned", dtype: "fp32" };
  const { runtime } = await createFixture(t, {
    answers: { status: { dense_documents: 365, dense_pending_documents: 0, dense_eligible_documents: 365, dense_models: [{ ...python, documents: 365 }] } }
  });
  const status = await runtime.status();
  assert.deepEqual([status.dense_documents, status.dense_pending_documents, status.dense_other_model_documents], [0, 365, 365]);
  const broken = await createFixture(t, {
    answers: { status: { dense_documents: 5, dense_pending_documents: 0, dense_models: [{ ...python, documents: 5 }] } },
    describe: async () => { throw new Error("no runtime"); }
  });
  assert.equal((await broken.runtime.status()).dense_documents, 5, "a backend that cannot answer leaves the index's own numbers");
});

test("a dense query that works leaves no complaint behind", async (t) => {
  const { runtime, of } = await createFixture(t, { answers: { hybrid: [{ path: "a.md", title: "A", score: 1 }] } });
  const results = await runtime.hybridSearch({ query: "operating model", dense_weight: 0.35, ensure_fresh: false });
  assert.equal(results.dense_unavailable, undefined);
  assert.equal(of("embedQuery").length, 1);
});
