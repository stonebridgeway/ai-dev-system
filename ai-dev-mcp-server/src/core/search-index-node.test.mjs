import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSearchIndexRuntime } from "./search-index.mjs";
import { sqliteSupport } from "./search-sqlite.mjs";
import { removeAfterAll } from "../../test/fixtures/temp-folder.mjs";

const needsSqlite = { skip: !sqliteSupport().available && sqliteSupport().reason };

const PASSTHROUGH_RANKING = {
  repairSearchMojibake: (value) => value,
  prioritizeKnowledgeResults: (_query, results) => results,
  rerankSearchResults: (_query, results) => results,
  isSkillCatalogQuery: () => false,
  routeSkills: () => ({ skills: [] })
};

function write(root, rel, content) {
  const target = path.join(root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

/** A runtime over a real vault and index; every embedding request is recorded. */
function createFixture(t, { describe = null, embed = null, refreshSkillRegistry } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "search-node-"));
  removeAfterAll(root);
  const vaultRoot = path.join(root, "vault");
  write(vaultRoot, "02-knowledge/deploy.md", "# Deploy runbook\n\nHow to deploy to production and roll back a database migration.");
  write(vaultRoot, "02-knowledge/review.md", "# Code review checklist\n\nWhat a reviewer checks before approving.");
  write(vaultRoot, "07-quality-gates/gate.md", "# Release gate\n\nTests, lint and typecheck before a release.");
  write(vaultRoot, "03-skills-catalog/registries/skills.index.json", JSON.stringify([
    { name: "code-reviewer", source: "custom", categories: ["code-review"], description: "Reviews code for defects.", path: "sources/custom/code-reviewer/SKILL.md" },
    { name: "deploy-helper", source: "external/tools", categories: ["devops"], description: "Deploys services.", path: "sources/external/deploy-helper/SKILL.md" }
  ]));
  const calls = [];
  const searchIndexDir = path.join(root, "cache");
  const runtime = createSearchIndexRuntime({
    vaultRoot,
    searchIndexDir,
    searchIndexPath: path.join(searchIndexDir, "ai-dev-search.sqlite"),
    defaultModelDir: path.join(root, "models", "bge-m3"),
    embedQuery: async (payload) => {
      calls.push({ command: "embedQuery", payload });
      return embed ? embed(payload) : { embeddings: [] };
    },
    denseIndexBackend: describe ? { describe } : undefined,
    hardNegativeRules: async () => [],
    readSkillIndex: async () => [],
    refreshSkillRegistry,
    ranking: PASSTHROUGH_RANKING,
    env: {}
  });
  return { runtime, calls, vaultRoot, indexPath: path.join(searchIndexDir, "ai-dev-search.sqlite") };
}

test("status, the first search and its rebuild run without Python", needsSqlite, async (t) => {
  const { runtime, calls } = createFixture(t);
  const before = await runtime.status();
  assert.deepEqual([before.engine, before.index_exists, before.reasons], ["node", false, ["index_missing"]]);
  const results = await runtime.search({ query: "deploy production" });
  assert.equal(results[0].title, "Deploy runbook");
  assert.match(results[0].preview, /\[deploy\]/i);
  const after = await runtime.status();
  assert.deepEqual([after.stale, after.current_document_count, after.dirty_reason], [false, 5, ""]);
  assert.deepEqual(calls, []);
  assert.equal(runtime.engine().engine, "node");
});

test("a change marked dirty is picked up by rewriting just that document", needsSqlite, async (t) => {
  const { runtime, vaultRoot } = createFixture(t);
  await runtime.rebuild();
  write(vaultRoot, "02-knowledge/rollback.md", "# Rollback drill\n\nPractise the rollback.");
  runtime.markDirty("note written");
  const refreshed = await runtime.ensureFresh();
  assert.equal(refreshed.action, "rebuilt");
  assert.deepEqual([refreshed.rebuild.write_mode, refreshed.rebuild.rewritten_documents, refreshed.rebuild.engine], ["in_place", 1, "node"]);
  assert.equal((await runtime.search({ query: "rollback drill" }))[0].title, "Rollback drill");
  assert.equal((await runtime.ensureFresh()).action, "current");
});

test("search filters by scope, source and folder as the helper did", needsSqlite, async (t) => {
  const { runtime } = createFixture(t);
  await runtime.rebuild();
  const skills = await runtime.search({ query: "code review", scope: "skills" });
  assert.deepEqual(skills.map((item) => item.title), ["code-reviewer"]);
  const external = await runtime.search({ query: "deploy", source: ["external"] });
  assert.deepEqual(external.map((item) => item.title), ["deploy-helper"]);
  const quality = await runtime.search({ query: "release", scope: "quality" });
  assert.deepEqual(quality.map((item) => item.path), ["07-quality-gates/gate.md"]);
  const inFolder = await runtime.search({ query: "deploy", folders: "02-knowledge/" });
  assert.deepEqual(inFolder.map((item) => item.path), ["02-knowledge/deploy.md"]);
  assert.deepEqual(await runtime.search({ query: "  ", ensure_fresh: false }), []);
  await assert.rejects(() => runtime.search({ query: "" }), /query is required/);
});

test("a question with AND, OR or NOT in capitals still finds its documents (\u0414-117)", needsSqlite, async (t) => {
  const { runtime, vaultRoot } = createFixture(t);
  write(vaultRoot, "02-knowledge/fridays.md", "# Release notes\n\nThe pipeline does not deploy on Fridays.");
  await runtime.rebuild();
  assert.deepEqual((await runtime.search({ query: "deploy AND production" })).map((item) => item.title), ["Deploy runbook"]);
  // A word, not an operator: as FTS5's NOT it would have kept the runbook and
  // dropped the note that mentions Fridays; as a word both "not" and
  // "Fridays" are required, and only the note has them.
  assert.deepEqual((await runtime.search({ query: "deploy NOT Fridays" })).map((item) => item.title), ["Release notes"]);
  assert.deepEqual((await runtime.search({ query: "deploy OR rollback" })).map((item) => item.title), [],
    "OR is a word too: no document has deploy, or* and rollback together");
});

test("searching an index that is not there says so", needsSqlite, async (t) => {
  const { runtime } = createFixture(t);
  await assert.rejects(() => runtime.search({ query: "deploy", ensure_fresh: false }), /Search index does not exist/);
});

test("ONNX vectors are planned, embedded and stored in one rebuild, without Python", needsSqlite, async (t) => {
  const provenance = { backend: "onnx", revision: "rev1", dtype: "int8", dimensions: 1024 };
  const { runtime, calls } = createFixture(t, {
    describe: async () => ({ backend: "onnx", available: true, provenance }),
    embed: ({ texts }) => ({ embeddings: texts.map((_, index) => Array.from({ length: 1024 }, (__, position) => ((index + position) % 7) / 7)) })
  });
  const rebuilt = await runtime.rebuild({ dense_embeddings: true });
  assert.deepEqual(
    [rebuilt.engine, rebuilt.dense_enabled, rebuilt.dense_backend, rebuilt.dense_planned_documents, rebuilt.dense_embedded_documents, rebuilt.dense_documents],
    ["node", true, "onnx", 5, 5, 5]
  );
  assert.ok(calls.every((call) => call.command === "embedQuery"));
  const again = await runtime.rebuild({ dense_embeddings: true });
  assert.deepEqual([again.dense_planned_documents, again.dense_reused_documents], [0, 5], "a second run reuses every vector");
  const refreshed = await runtime.rebuild();
  assert.deepEqual([refreshed.dense_preserved, refreshed.dense_documents], [true, 5]);
  assert.equal((await runtime.status()).dense_documents, 5);
});

test("the legacy Python backend embeds the passages, and Node writes them into the index", needsSqlite, async (t) => {
  const legacy = { backend: "python", available: true, reason: "legacy", provenance: { backend: "python", revision: "unpinned", dtype: "fp32", dimensions: 1024 } };
  const { runtime, calls } = createFixture(t, {
    describe: async () => legacy,
    embed: (payload) => ({ embeddings: payload.texts.map(() => Array.from({ length: 1024 }, (_, index) => (index === 0 ? 1 : 0))) })
  });
  const built = await runtime.rebuild({ dense_embeddings: true });
  assert.equal(built.engine, "node");
  assert.ok(built.dense_documents > 0, JSON.stringify(built));
  assert.equal(built.dense_documents, built.dense_embedded_documents);
  assert.ok(calls.some((call) => call.command === "embedQuery"));
  const status = await runtime.status();
  assert.deepEqual([status.dense_backend, status.dense_documents], ["python", built.dense_documents]);
});

test("a dense rebuild with no model leaves the index as it was and says what to install", needsSqlite, async (t) => {
  const { runtime, calls } = createFixture(t, {
    describe: async () => ({ backend: "onnx", available: false, reason: "Dense search is not installed. Run `npm run setup -- --model`." })
  });
  await runtime.rebuild();
  const before = await runtime.status();
  await assert.rejects(runtime.rebuild({ dense_embeddings: true }), /no embedding model can run here\. Dense search is not installed/);
  const after = await runtime.status();
  assert.deepEqual([after.indexed_document_count, after.built_at, after.stale], [before.indexed_document_count, before.built_at, false], "the index is untouched");
  assert.equal(calls.filter((call) => call.command === "embedQuery").length, 0);
});

test("hybrid search runs in Node: the question embedded here, a missing model only drops the dense half", needsSqlite, async (t) => {
  const { runtime, calls } = createFixture(t, { embed: () => { throw new Error("model not installed"); } });
  const results = await runtime.hybridSearch({ query: "deploy production" });
  assert.equal(results[0].title, "Deploy runbook");
  assert.equal(results[0].mode, "hybrid");
  assert.ok(results[0].keyword_score > 0 && results[0].semantic_score > 0, JSON.stringify(results[0]));
  assert.equal(results[0].dense_score, 0);
  assert.match(results.dense_unavailable, /model not installed/);
  assert.equal(calls.filter((call) => call.command === "embedQuery").length, 1, "the question was embedded once, here");
  assert.deepEqual([...await runtime.hybridSearch({ query: "   " })], [], "a blank question finds nothing rather than everything");
});

test("status and rebuild bring the skill registry up to date first, and survive it failing", needsSqlite, async (t) => {
  // The index takes its skill documents from the registry; a registry still
  // listing skills a pull removed would put them straight back in the index.
  const order = [];
  let fail = false;
  const { runtime, vaultRoot } = createFixture(t, {
    refreshSkillRegistry: async () => {
      order.push("registry");
      if (fail) throw new Error("read-only vault");
      write(vaultRoot, "03-skills-catalog/registries/skills.index.json", JSON.stringify([
        { name: "code-reviewer", source: "custom", categories: ["code-review"], description: "Reviews code for defects.", path: "sources/custom/code-reviewer/SKILL.md" }
      ]));
    }
  });
  const built = await runtime.rebuild({});
  assert.equal(order[0], "registry");
  assert.equal(built.document_count, 4, "three notes and the one skill the refreshed registry lists");
  order.length = 0;
  const status = await runtime.status();
  assert.deepEqual([order[0], status.stale], ["registry", false]);
  fail = true;
  const still = await runtime.status();
  assert.equal(still.stale, false, "a registry that cannot be rebuilt leaves status answering as before");
});
