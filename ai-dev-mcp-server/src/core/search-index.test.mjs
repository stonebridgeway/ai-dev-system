import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSearchIndexRuntime } from "./search-index.mjs";

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

/**
 * A runtime whose Python helper is a stub: every call is recorded, and the
 * answer comes from a queue the test controls. No process is ever spawned.
 */
async function createFixture(t, { responses = [], ranking = {}, exists = true, embed } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "search-index-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const calls = [];
  const queue = [...responses];
  const runtime = createSearchIndexRuntime({
    vaultRoot: "/vault",
    searchCliPath: "/vault/09-mcp/search-index/search_cli.py",
    searchIndexDir: path.join(root, "cache"),
    searchIndexPath: path.join(root, "cache", "ai-dev-search.sqlite"),
    defaultModelDir: "/models/bge-m3",
    pythonCommand: () => "python",
    embeddingPythonCommand: () => "embedding-python",
    pathExists: async () => exists,
    execFile: async (command, args) => {
      calls.push({ command, args });
      const next = queue.length > 1 ? queue.shift() : queue[0];
      return { stdout: JSON.stringify(next ?? {}), stderr: "" };
    },
    embedQuery: async (payload, options) => {
      calls.push({ command: "embedQuery", payload, options });
      if (embed) return embed(payload, options);
      return { embeddings: [[0.1, 0.2, 0.3]] };
    },
    hardNegativeRules: async () => [],
    readSkillIndex: async () => [],
    ranking: { ...PASSTHROUGH_RANKING, ...ranking }
  });
  // execFile is called as (python, [cliPath, ...args]); the test cares about args.
  const argsOf = (index) => calls[index].args.slice(1);
  const flagValue = (args, flag) => args[args.indexOf(flag) + 1];
  return { root, runtime, calls, argsOf, flagValue };
}

test("a missing search helper is reported, not silently skipped", async (t) => {
  const { runtime } = await createFixture(t, { exists: false });
  await assert.rejects(() => runtime.status(), /Search helper not found/);
});

test("a helper that answers with something other than JSON is a clear error", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "search-index-bad-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runtime = createSearchIndexRuntime({
    vaultRoot: "/vault",
    searchCliPath: "/cli.py",
    searchIndexDir: root,
    searchIndexPath: path.join(root, "i.sqlite"),
    defaultModelDir: "/models",
    pythonCommand: () => "python",
    embeddingPythonCommand: () => "embedding-python",
    pathExists: async () => true,
    execFile: async () => ({ stdout: "Traceback (most recent call last):", stderr: "" }),
    embedQuery: async () => ({}),
    hardNegativeRules: async () => [],
    readSkillIndex: async () => [],
    ranking: PASSTHROUGH_RANKING
  });
  await assert.rejects(() => runtime.status(), /Search helper returned invalid JSON/);
});

test("status asks the helper about the vault and reports the dirty reason", async (t) => {
  const { runtime, argsOf } = await createFixture(t, { responses: [{ stale: false, document_count: 12 }] });
  const clean = await runtime.status();
  assert.equal(clean.document_count, 12);
  assert.equal(clean.dirty_reason, "");
  assert.deepEqual(argsOf(0).slice(0, 5), ["status", "--vault-root", "/vault", "--index-path", argsOf(0)[4]]);
  assert.ok(argsOf(0).includes("--include-external-project-files"));

  runtime.markDirty("a note was written");
  assert.equal(runtime.dirtyReason(), "a note was written");
  assert.equal((await runtime.status()).dirty_reason, "a note was written");
  assert.ok(!(await runtime.status({ include_external_project_files: false })).dirty_reason === false);
});

test("marking dirty without a reason still marks it", async (t) => {
  const { runtime } = await createFixture(t, { responses: [{ stale: false }] });
  runtime.markDirty();
  assert.equal(runtime.dirtyReason(), "source changed");
  runtime.markDirty("");
  assert.equal(runtime.dirtyReason(), "source changed");
});

test("a plain rebuild preserves existing dense vectors and clears the dirty flag", async (t) => {
  const { runtime, argsOf, flagValue } = await createFixture(t, { responses: [{ document_count: 3 }] });
  runtime.markDirty("something changed");
  const rebuilt = await runtime.rebuild();
  assert.equal(rebuilt.document_count, 3);
  assert.equal(runtime.dirtyReason(), "");
  assert.ok(argsOf(0).includes("--preserve-dense"));
  assert.ok(!argsOf(0).includes("--dense-embeddings"));
  assert.equal(flagValue(argsOf(0), "--vault-root"), "/vault");
});

test("a dense rebuild switches interpreter and clamps its dense knobs", async (t) => {
  const { runtime, calls, argsOf, flagValue } = await createFixture(t, { responses: [{ document_count: 3 }] });
  await runtime.rebuild({
    dense_embeddings: true,
    dense_batch_size: 999,
    dense_text_limit: 1,
    dense_include_membrane: true,
    dense_incremental: false,
    dense_device: "cuda"
  });
  assert.equal(calls[0].command, "embedding-python");
  const args = argsOf(0);
  assert.ok(args.includes("--dense-embeddings"));
  assert.ok(!args.includes("--preserve-dense"));
  assert.equal(flagValue(args, "--dense-batch-size"), "32");
  assert.equal(flagValue(args, "--dense-text-limit"), "300");
  assert.equal(flagValue(args, "--dense-device"), "cuda");
  assert.ok(args.includes("--dense-include-membrane"));
  assert.ok(args.includes("--no-dense-incremental"));
});

test("a fresh index is left alone; a stale one is rebuilt once", async (t) => {
  const { runtime, calls } = await createFixture(t, { responses: [{ stale: false }] });
  const current = await runtime.ensureFresh();
  assert.equal(current.action, "current");
  assert.equal(calls.length, 1);

  // Within the freshness window the verdict is reused rather than re-checked.
  await runtime.ensureFresh();
  assert.equal(calls.length, 1);
});

test("a dirty flag forces a rebuild even when the helper calls the index fresh", async (t) => {
  const { runtime, calls } = await createFixture(t, { responses: [{ stale: false }] });
  runtime.markDirty("a skill was written");
  const refreshed = await runtime.ensureFresh();
  assert.equal(refreshed.action, "rebuilt");
  assert.equal(runtime.dirtyReason(), "");
  // status, rebuild, status again.
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((call) => call.args[1]), ["status", "rebuild", "status"]);
});

test("a caller arriving mid-rebuild joins it instead of starting another", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "search-index-concurrent-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const calls = [];
  let releaseRebuild;
  const rebuildStarted = new Promise((resolve) => {
    releaseRebuild = resolve;
  });
  let unblock;
  const held = new Promise((resolve) => {
    unblock = resolve;
  });
  const runtime = createSearchIndexRuntime({
    vaultRoot: "/vault",
    searchCliPath: "/cli.py",
    searchIndexDir: root,
    searchIndexPath: path.join(root, "i.sqlite"),
    defaultModelDir: "/models",
    pythonCommand: () => "python",
    embeddingPythonCommand: () => "embedding-python",
    pathExists: async () => true,
    execFile: async (_command, args) => {
      calls.push(args[1]);
      if (args[1] === "rebuild") {
        releaseRebuild();
        await held;
      }
      return { stdout: JSON.stringify({ stale: true }), stderr: "" };
    },
    embedQuery: async () => ({}),
    hardNegativeRules: async () => [],
    readSkillIndex: async () => [],
    ranking: PASSTHROUGH_RANKING
  });

  const first = runtime.ensureFresh();
  await rebuildStarted;
  const second = runtime.ensureFresh();
  unblock();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.action, "rebuilt");
  assert.equal(b, a);
  assert.equal(calls.filter((name) => name === "rebuild").length, 1);
});

test("search refuses an empty query and passes filters through as csv", async (t) => {
  const { runtime, argsOf, flagValue } = await createFixture(t, { responses: [[hit()]] });
  await assert.rejects(() => runtime.search({ query: "" }), /query is required/);
  await assert.rejects(() => runtime.search({ query: 7 }), /query is required/);

  const results = await runtime.search({
    query: "feature builder",
    scope: "skills",
    limit: 999,
    folders: ["a", "b"],
    source: ["custom"],
    ensure_fresh: false
  });
  assert.deepEqual(results, [hit()]);
  const args = argsOf(0);
  assert.equal(flagValue(args, "--query"), "feature builder");
  assert.equal(flagValue(args, "--scope"), "skills");
  assert.equal(flagValue(args, "--limit"), "50");
  assert.equal(flagValue(args, "--folders"), "a,b");
  assert.equal(flagValue(args, "--source"), "custom");
});

test("hybrid search asks for fifty candidates and trims after ranking", async (t) => {
  const many = Array.from({ length: 20 }, (_, index) => hit({ title: `r${index}` }));
  const { runtime, argsOf, flagValue } = await createFixture(t, { responses: [many] });
  const results = await runtime.hybridSearch({ query: "x", limit: 3, dense_weight: 0, ensure_fresh: false });
  assert.equal(results.length, 3);
  assert.equal(flagValue(argsOf(0), "--limit"), "50");
  assert.equal(flagValue(argsOf(0), "--dense-weight"), "0");
});

test("a zero dense weight never touches the embedding backend", async (t) => {
  const { runtime, calls } = await createFixture(t, { responses: [[hit()]] });
  await runtime.hybridSearch({ query: "x", dense_weight: 0, ensure_fresh: false });
  assert.equal(calls.filter((call) => call.command === "embedQuery").length, 0);
});

test("a positive dense weight embeds the query and hands the vector over as a file", async (t) => {
  const { runtime, calls, root } = await createFixture(t, { responses: [[hit()]] });
  await runtime.hybridSearch({ query: "x", dense_weight: 0.35, ensure_fresh: false });
  const embed = calls.find((call) => call.command === "embedQuery");
  assert.ok(embed);
  assert.deepEqual(embed.payload.texts, ["x"]);
  assert.equal(embed.payload.prefix, "query: ");
  const helperCall = calls.find((call) => call.args?.[1] === "hybrid");
  const vectorPath = helperCall.args[helperCall.args.indexOf("--dense-query-vector-path") + 1];
  assert.ok(vectorPath.startsWith(path.join(root, "cache")));
  // The scratch file is cleaned up once the helper has read it.
  assert.equal(await fs.access(vectorPath).then(() => true, () => false), false);
});

test("a nonsense weight falls back rather than reaching the helper as NaN", async (t) => {
  const { runtime, argsOf, flagValue } = await createFixture(t, { responses: [[hit()]] });
  await runtime.hybridSearch({ query: "x", dense_weight: "nope", semantic_weight: "nope", keyword_weight: "nope", ensure_fresh: false });
  assert.equal(flagValue(argsOf(1), "--dense-weight"), "0.35");
  assert.equal(flagValue(argsOf(1), "--semantic-weight"), "0.2");
  assert.equal(flagValue(argsOf(1), "--keyword-weight"), "0.45");
});

test("reranking and knowledge routing are applied only when asked", async (t) => {
  const seen = [];
  const { runtime } = await createFixture(t, {
    responses: [[hit()]],
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

test("intent routing puts routed custom skills above what the index found", async (t) => {
  const { runtime } = await createFixture(t, {
    responses: [[hit({ title: "something-else" })]],
    ranking: {
      routeSkills: () => ({ skills: [{ name: "feature-builder", role: "workflow", reason: "because", rule: "r1" }] })
    }
  });
  const runtimeWithRegistry = runtime;
  const results = await runtimeWithRegistry.hybridSearch({
    query: "x", scope: "skills", intent_routing: true, dense_weight: 0, ensure_fresh: false
  });
  // The registry is empty in this fixture, so no routed row can be built.
  assert.deepEqual(results.map((item) => item.title), ["something-else"]);
});

test("a routed skill present in the registry is prepended and de-duplicated", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "search-index-routed-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runtime = createSearchIndexRuntime({
    vaultRoot: "/vault",
    searchCliPath: "/cli.py",
    searchIndexDir: root,
    searchIndexPath: path.join(root, "i.sqlite"),
    defaultModelDir: "/models",
    pythonCommand: () => "python",
    embeddingPythonCommand: () => "embedding-python",
    pathExists: async () => true,
    execFile: async () => ({
      stdout: JSON.stringify([hit({ title: "feature-builder" }), hit({ title: "other" })]),
      stderr: ""
    }),
    embedQuery: async () => ({}),
    hardNegativeRules: async () => [],
    readSkillIndex: async () => [
      { name: "feature-builder", source: "custom", path: "custom/feature-builder/SKILL.md", categories: ["workflow"], description: "d" }
    ],
    ranking: {
      ...PASSTHROUGH_RANKING,
      routeSkills: () => ({ skills: [{ name: "feature-builder", role: "workflow", reason: "because", rule: "r1" }] })
    }
  });
  const results = await runtime.hybridSearch({
    query: "x", scope: "skills", intent_routing: true, dense_weight: 0, ensure_fresh: false
  });
  assert.deepEqual(results.map((item) => item.title), ["feature-builder", "other"]);
  assert.equal(results[0].mode, "routed-hybrid");
  assert.equal(results[0].retrieval_stage, "deterministic-intent-router");
  assert.equal(results[0].routing_rule, "r1");
  assert.equal(results[0].categories, "workflow");
});

test("routing stands down when the caller narrowed the search themselves", async (t) => {
  const routed = {
    routeSkills: () => ({ skills: [{ name: "feature-builder", role: "workflow", reason: "because", rule: "r1" }] })
  };
  for (const narrowing of [
    { project: "atlas" },
    { folders: "03-skills-catalog" },
    { source: "design/taste-skill" },
    { scope: "projects" }
  ]) {
    const { runtime } = await createFixture(t, { responses: [[hit({ title: "other" })]], ranking: routed });
    const results = await runtime.hybridSearch({
      query: "x", scope: "skills", intent_routing: true, dense_weight: 0, ensure_fresh: false, ...narrowing
    });
    assert.deepEqual(results.map((item) => item.title), ["other"], JSON.stringify(narrowing));
  }
});

test("an explicit skill-catalog query is answered by the index, not the router", async (t) => {
  const { runtime } = await createFixture(t, {
    responses: [[hit({ title: "other" })]],
    ranking: {
      isSkillCatalogQuery: () => true,
      routeSkills: () => ({ skills: [{ name: "feature-builder", role: "workflow", reason: "b", rule: "r" }] })
    }
  });
  const results = await runtime.hybridSearch({
    query: "list every skill", scope: "skills", intent_routing: true, dense_weight: 0, ensure_fresh: false
  });
  assert.deepEqual(results.map((item) => item.title), ["other"]);
});

test("a missing model degrades the search instead of ending it", async (t) => {
  // Keyword and sparse need no model; dense is the optional half, and the
  // README says so. It used to throw out of the dense branch and take the whole
  // query with it, so `hybrid_search`, `preset_search` and `explain_search` were
  // dead until someone downloaded 2.3 GB of weights.
  const { runtime } = await createFixture(t, {
    responses: [[{ path: "01-system/Operating Model.md", title: "Operating Model", score: 1 }]],
    embed: async () => {
      throw new Error("BGE-M3 worker exited with code 1. Model directory does not exist: /models/bge-m3");
    }
  });
  const results = await runtime.hybridSearch({ query: "operating model", dense_weight: 0.35, ensure_fresh: false });
  assert.equal(results.length, 1);
  assert.match(results.dense_unavailable, /Model directory does not exist/);
  // The note rides alongside the array rather than inside it: a caller that
  // serializes the results sees exactly what it saw before.
  assert.equal(JSON.parse(JSON.stringify(results)).length, 1);
  assert.equal(Object.keys(results[0]).includes("dense_unavailable"), false);
});

test("a dense query that works leaves no complaint behind", async (t) => {
  const { runtime, calls } = await createFixture(t, {
    responses: [[{ path: "a.md", title: "A", score: 1 }]]
  });
  const results = await runtime.hybridSearch({ query: "operating model", dense_weight: 0.35, ensure_fresh: false });
  assert.equal(results.dense_unavailable, undefined);
  assert.ok(calls.some((call) => call.command === "embedQuery"));
});
