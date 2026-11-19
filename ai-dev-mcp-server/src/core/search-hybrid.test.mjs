import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  clampWeight,
  comparePythonStrings,
  createHybridCache,
  denseBlobToVector,
  denseDot,
  hybridSearch,
  lexicalBoost,
  parseSparseVector,
  queryExcludesMembrane,
  queryHasAppIntegrationIntent,
  queryVector,
  sparseDot
} from "./search-hybrid.mjs";
import { pythonSum } from "./python-compat.mjs";
import { densePlan, rebuildIndex } from "./search-store.mjs";
import { openDatabase, sqliteSupport } from "./search-sqlite.mjs";
import { removeAfterAll } from "../../test/fixtures/temp-folder.mjs";

const needsSqlite = { skip: !sqliteSupport().available && sqliteSupport().reason };

function write(root, rel, content) {
  const target = path.join(root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

/** Three notes and four skills, two of them Membrane connectors. */
async function buildFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "search-hybrid-"));
  removeAfterAll(root);
  const vault = path.join(root, "vault");
  write(vault, "02-knowledge/deploy-runbook.md", "# Deploy runbook\n\nHow to deploy to production and roll back a database migration safely.");
  write(vault, "02-knowledge/code-review.md", "# Code review checklist\n\nWhat a reviewer checks before approving a pull request: tests, naming, security.");
  write(vault, "07-quality-gates/release-gate.md", "# Release gate\n\nTests, lint and typecheck must pass before a release ships.");
  write(vault, "03-skills-catalog/registries/skills.index.json", JSON.stringify([
    { name: "code-reviewer", source: "custom", categories: ["code-review", "quality"], description: "Reviews code changes for defects, security and tests.", use_when: "a pull request needs review", path: "sources/custom/code-reviewer/SKILL.md" },
    { name: "deploy-helper", source: "external/tools", categories: ["devops", "release"], description: "Deploys services and rolls back failed releases.", use_when: "shipping to production", path: "sources/external/tools/deploy-helper/SKILL.md" },
    { name: "slack", source: "external/membrane", categories: ["integration", "chat"], description: "Slack integration: send messages, sync channels, webhooks.", use_when: "the user wants to connect Slack", path: "sources/external/membrane/skills/slack/SKILL.md" },
    { name: "review-bot", source: "external/membrane", categories: ["code-review"], description: "Code review bot integration for pull requests.", use_when: "connect a review bot", path: "sources/external/membrane/skills/review-bot/SKILL.md" }
  ]));
  const indexPath = path.join(root, "index.sqlite");
  await rebuildIndex({ vaultRoot: vault, indexPath });
  const db = openDatabase(indexPath);
  t.after(() => db.close());
  return { root, vault, indexPath, db };
}

const top = (results) => results.slice(0, 4).map((item) => [item.path, item.score, item.keyword_score, item.semantic_score]);

test("a stored sparse vector parses in the order it was written, in either JSON style", () => {
  const compact = parseSparseVector('{"512":0.5,"3":-0.25,"77":1e-05}');
  assert.deepEqual([...compact.dims], [512, 3, 77], "not in the numeric order a JavaScript object would put them");
  assert.deepEqual([...compact.weights], [0.5, -0.25, 0.00001]);
  const spaced = parseSparseVector('{"9": 0.125, "1": 0.5}');
  assert.deepEqual([[...spaced.dims], [...spaced.weights]], [[9, 1], [0.125, 0.5]]);
  for (const broken of ["", "{}", "[1,2]", '{"a":1}', '{"1":"x"}', "not json"]) {
    assert.equal(parseSparseVector(broken).dims.length, 0, broken);
  }
});

test("sparse dot runs over the shorter vector, in its own order, as the helper's loop did", () => {
  const left = parseSparseVector('{"1":0.1,"2":0.2,"3":0.3}');
  const right = parseSparseVector('{"3":0.7,"1":0.9}');
  // The shorter is `right`: 0.7·0.3 first, then 0.9·0.1.
  assert.equal(sparseDot(left, right), 0.7 * 0.3 + 0.9 * 0.1);
  assert.equal(sparseDot(right, left), 0.7 * 0.3 + 0.9 * 0.1);
  assert.equal(sparseDot(left, parseSparseVector("{}")), 0);
  assert.equal(sparseDot(left, parseSparseVector('{"9":1}')), 0, "no shared dimension");
  assert.equal(sparseDot(left, left), 0.1 * 0.1 + 0.2 * 0.2 + 0.3 * 0.3, "equal lengths: the left one's order");
});

test("the question's vector is built as a document whose title and body are the question", () => {
  const vector = queryVector("deploy production");
  assert.ok(vector.dims.length > 0);
  assert.equal(vector.dims.length, vector.weights.length);
  const norm = Math.sqrt(pythonSum([...vector.weights].map((weight) => weight * weight)));
  assert.ok(Math.abs(norm - 1) < 1e-6, `unit length: ${norm}`);
});

test("dense dot is a float32 dot product summed as Python sums floats; other lengths score 0", () => {
  const query = Float32Array.from([0.1, 0.2, 0.3]);
  const vector = Float32Array.from([0.3, 0.2, 0.1]);
  assert.equal(denseDot(query, vector), pythonSum([query[0] * vector[0], query[1] * vector[1], query[2] * vector[2]]));
  assert.equal(denseDot(query, Float32Array.from([1, 2])), 0);
  assert.equal(denseDot(new Float32Array(0), vector), 0);
  const blob = new Uint8Array(new Float32Array([1.5, -2]).buffer);
  assert.deepEqual([...denseBlobToVector(blob)], [1.5, -2], "little-endian float32, as array('f') wrote it");
  assert.deepEqual([...denseBlobToVector(blob.subarray(0, 6))], [1.5], "a torn tail is left out");
  assert.equal(denseBlobToVector(null).length, 0);
});

test("weights, intents and the lexical boost", () => {
  assert.equal(clampWeight(0.5, 0.2), 0.5);
  assert.equal(clampWeight("0.7", 0.2), 0.7);
  assert.equal(clampWeight(3, 0.2), 1);
  assert.equal(clampWeight(-1, 0.2), 0);
  for (const bad of [Number.NaN, null, undefined, "x", "", true]) assert.equal(clampWeight(bad, 0.2), 0.2, String(bad));

  assert.equal(queryHasAppIntegrationIntent("sync Slack channels"), true);
  assert.equal(queryHasAppIntegrationIntent("Slack"), false, "an application without an action");
  assert.equal(queryHasAppIntegrationIntent("подключить фигма"), true);
  assert.equal(queryHasAppIntegrationIntent("application skill for invoices"), true);
  assert.equal(queryExcludesMembrane("code review without membrane noise"), true);
  assert.equal(queryExcludesMembrane("без мембран шума"), true);
  assert.equal(queryExcludesMembrane("membrane connectors"), false);
  assert.equal(queryExcludesMembrane("exclude vendored"), false, "Membrane has to be named");

  const row = { title: "Code review", path: "02-knowledge/review.md", source: "vault-note", categories: "", preview: "tests" };
  assert.equal(lexicalBoost(["code", "tests"], row), 0.15);
  assert.equal(lexicalBoost(["code", "deploy"], row), 0.075);
  assert.equal(lexicalBoost([], row), 0);
});

test("paths order as Python orders strings: by code point", () => {
  assert.ok(comparePythonStrings("a/�", "a/\u{1F600}") < 0, "U+FFFD comes before U+1F600, though UTF-16 says otherwise");
  assert.ok("a/�" > "a/\u{1F600}", "what plain comparison says");
  assert.ok(comparePythonStrings("abc", "abd") < 0);
  assert.ok(comparePythonStrings("ab", "abc") < 0);
  assert.equal(comparePythonStrings("same", "same"), 0);
});

test("hybrid search answers what the Python helper answered on the same index", needsSqlite, async (t) => {
  const { db } = await buildFixture(t);
  // Printed by `search_cli.py hybrid` (dense weight 0) on this fixture.
  const expected = [
    ["code review", "all", [
      ["03-skills-catalog/sources/custom/code-reviewer/SKILL.md", 1.068911, 1, 0.736462],
      ["02-knowledge/code-review.md", 0.750708, 0.5, 0.697302],
      ["03-skills-catalog/sources/external/membrane/skills/review-bot/SKILL.md", 0.20959, 0.333333, 0.708695],
      ["02-knowledge/deploy-runbook.md", 0.070339, 0, 0.098602]
    ]],
    ["deploy production rollback", "all", [
      ["02-knowledge/deploy-runbook.md", 0.254758, 0, 0.372964],
      ["03-skills-catalog/sources/external/tools/deploy-helper/SKILL.md", 0.212308, 0, 0.365002],
      ["02-knowledge/code-review.md", 0.076186, 0, 0.117606],
      ["07-quality-gates/release-gate.md", 0.067003, 0, 0.087759]
    ]],
    ["slack integration sync", "all", [
      ["03-skills-catalog/sources/external/membrane/skills/slack/SKILL.md", 1.035939, 1, 0.6293],
      ["03-skills-catalog/sources/external/membrane/skills/review-bot/SKILL.md", 0.098199, 0, 0.156645],
      ["02-knowledge/code-review.md", 0.062962, 0, 0.074627],
      ["02-knowledge/deploy-runbook.md", 0.061802, 0, 0.070858]
    ]],
    ["без membrane шум code review", "all", [
      ["02-knowledge/code-review.md", 0.267584, 0, 0.495898],
      ["03-skills-catalog/sources/custom/code-reviewer/SKILL.md", 0.233847, 0, 0.516253],
      ["02-knowledge/deploy-runbook.md", 0.064019, 0, 0.078063],
      ["03-skills-catalog/sources/external/membrane/skills/review-bot/SKILL.md", 0.041548, 0, 0.759626]
    ]],
    ["review", "skills", [
      ["03-skills-catalog/sources/custom/code-reviewer/SKILL.md", 1.057487, 1, 0.699333],
      ["03-skills-catalog/sources/external/membrane/skills/review-bot/SKILL.md", 0.250704, 0.5, 0.715465],
      ["03-skills-catalog/sources/external/tools/deploy-helper/SKILL.md", 0.004714, 0, 0.015319],
      ["03-skills-catalog/sources/external/membrane/skills/slack/SKILL.md", 0.003008, 0, 0.02793]
    ]]
  ];
  for (const [query, scope, rows] of expected) {
    assert.deepEqual(top(hybridSearch(db, { query, scope, limit: 10, denseWeight: 0 })), rows, query);
  }
});

test("a hybrid result is shaped as the helper printed it, with the FTS snippet where the words matched", needsSqlite, async (t) => {
  const { db } = await buildFixture(t);
  const [first, second] = hybridSearch(db, { query: "deploy production", limit: 10 });
  assert.deepEqual(Object.keys(first), ["scope", "title", "path", "source", "categories", "score", "keyword_score", "semantic_score", "dense_score", "mode", "preview"]);
  assert.equal(first.mode, "hybrid");
  assert.match(first.preview, /\[deploy\]|\[production\]/, "the snippet marks the words");
  assert.ok(second.keyword_score === 0 ? !second.preview.includes("[") : true, "a document the words did not match shows its stored preview");
  // Capitals AND/OR/NOT are words here, as in keyword search.
  const operators = hybridSearch(db, { query: "deploy AND production", limit: 10 });
  assert.ok(operators[0].keyword_score > 0, JSON.stringify(operators[0]));
  assert.deepEqual(hybridSearch(db, { query: "   " }), []);
  assert.equal(hybridSearch(db, { query: "deploy", limit: 2 }).length, 2);
});

test("filters apply to every signal", needsSqlite, async (t) => {
  const { db } = await buildFixture(t);
  assert.ok(hybridSearch(db, { query: "review", scope: "skills", limit: 10 }).every((item) => item.scope === "skills"));
  assert.ok(hybridSearch(db, { query: "review", folders: "02-knowledge", limit: 10 }).every((item) => item.path.startsWith("02-knowledge")));
  assert.ok(hybridSearch(db, { query: "review", source: "custom", limit: 10 }).every((item) => item.source === "custom"));
});

test("dense vectors count when the index has them and the caller embedded the question", needsSqlite, async (t) => {
  const { vault, indexPath } = await buildFixture(t);
  const provenance = { backend: "onnx", revision: "abc123", dtype: "int8" };
  const plan = await densePlan({ vaultRoot: vault, indexPath, provenance });
  // One axis per document; the query points along the release gate's.
  const axis = new Map(plan.records.map((record, index) => [record.id, index]));
  const vectors = plan.records.map((record) => ({
    id: record.id,
    content_hash: record.content_hash,
    vector: Array.from({ length: 1024 }, (_, index) => (index === axis.get(record.id) ? 1 : 0))
  }));
  await rebuildIndex({ vaultRoot: vault, indexPath, denseEmbeddings: true, suppliedVectors: vectors, denseBackend: "onnx", denseRevision: "abc123", denseDtype: "int8" });
  const db = openDatabase(indexPath);
  t.after(() => db.close());
  const gate = plan.records.find((record) => record.text.includes("release-gate.md"));
  const query = Array.from({ length: 1024 }, (_, index) => (index === axis.get(gate.id) ? 1 : 0));
  const withDense = hybridSearch(db, { query: "pull request", limit: 10, denseQueryVector: query });
  const gateResult = withDense.find((item) => item.path === "07-quality-gates/release-gate.md");
  assert.equal(gateResult?.dense_score, 1, "the document the question points at");
  assert.ok(withDense.filter((item) => item.dense_score > 0).length === 1);
  const without = hybridSearch(db, { query: "pull request", limit: 10 });
  assert.ok(without.every((item) => item.dense_score === 0), "no question vector, no dense half");
  const wrongWidth = hybridSearch(db, { query: "pull request", limit: 10, denseQueryVector: [1, 0, 0] });
  assert.ok(wrongWidth.every((item) => item.dense_score === 0), "a vector of another width scores nothing");
  const zeroWeight = hybridSearch(db, { query: "pull request", limit: 10, denseQueryVector: query, denseWeight: 0 });
  assert.ok(zeroWeight.every((item) => item.dense_score === 0));

  // Vectors from another model — a 2.x index's Python fp32 ones — are not in
  // the question's space and are not compared with it.
  const same = hybridSearch(db, { query: "pull request", limit: 10, denseQueryVector: query, denseProvenance: provenance });
  assert.equal(same.find((item) => item.path === "07-quality-gates/release-gate.md")?.dense_score, 1);
  const other = hybridSearch(db, { query: "pull request", limit: 10, denseQueryVector: query, denseProvenance: { backend: "python", revision: "unpinned", dtype: "fp32" } });
  assert.ok(other.every((item) => item.dense_score === 0), "another model's vectors score nothing");
  // Not one vector of the question's model: the dense half is left out of the
  // weights, as with no model at all, and the answer says why.
  assert.equal(other.dense_unmatched, true);
  assert.equal(Object.keys(other).includes("dense_unmatched"), false, "not part of the JSON a client gets");
  assert.deepEqual(other.map((item) => [item.path, item.score]), without.map((item) => [item.path, item.score]),
    "ranked exactly as without a question vector");
  assert.equal(same.dense_unmatched, undefined);
  assert.equal(without.dense_unmatched, undefined, "no question vector is not the same thing");
});

/**
 * Rows handed back by the statements that read sparse vectors, counted as
 * they are read: one statement prepared for a document, or for all of them,
 * says nothing about how many documents it read.
 */
function countVectorReads(db) {
  const reads = { rows: 0 };
  const prepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    const statement = prepare(sql);
    if (!/v\.vector AS BLOB/.test(sql)) return statement;
    return {
      get: (...args) => {
        const row = statement.get(...args);
        if (row) reads.rows += 1;
        return row;
      },
      all: (...args) => {
        const rows = statement.all(...args);
        reads.rows += rows.length;
        return rows;
      },
      * iterate(...args) {
        for (const row of statement.iterate(...args)) {
          reads.rows += 1;
          yield row;
        }
      }
    };
  };
  return reads;
}

test("the cache keeps parsed vectors between searches and drops what the index no longer has", needsSqlite, async (t) => {
  const { vault, indexPath } = await buildFixture(t);
  const db = openDatabase(indexPath);
  t.after(() => db.close());
  const cache = createHybridCache();
  const reads = countVectorReads(db);
  const first = hybridSearch(db, { query: "code review", limit: 10, cache });
  assert.equal(cache.documents.size, 7);
  assert.equal(reads.rows, 7, "a cold cache reads each document once");
  const again = hybridSearch(db, { query: "code review", limit: 10, cache });
  assert.deepEqual(again, first);
  assert.equal(reads.rows, 7, "a warm search reads no vector");

  // A note rewritten, one removed: the next search reads that one note again and forgets the other.
  write(vault, "02-knowledge/code-review.md", "# Code review checklist\n\nWhat a reviewer checks: tests and naming.");
  fs.rmSync(path.join(vault, "07-quality-gates", "release-gate.md"));
  await rebuildIndex({ vaultRoot: vault, indexPath, inPlace: true });
  const after = hybridSearch(db, { query: "code review", limit: 10, cache });
  assert.equal(cache.documents.size, 6);
  assert.equal(reads.rows, 8, "one vector read: the rewritten note's");
  assert.ok(after.some((item) => item.path === "02-knowledge/code-review.md"));
  assert.ok(!after.some((item) => item.path === "07-quality-gates/release-gate.md"));
});

test("a cold cache over many documents reads them in one pass, and answers as reading them one by one does", needsSqlite, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "search-hybrid-bulk-"));
  removeAfterAll(root);
  const vault = path.join(root, "vault");
  const topics = ["release review", "deploy rollback", "code review checklist", "database migration", "frontend testing"];
  for (let index = 0; index < 80; index += 1) {
    const folder = index < 40 ? "first" : "second";
    write(vault, `02-knowledge/${folder}/note-${String(index).padStart(2, "0")}.md`, `# Note ${index}\n\nAbout ${topics[index % topics.length]}, part ${index}.`);
  }
  const indexPath = path.join(root, "index.sqlite");
  await rebuildIndex({ vaultRoot: vault, indexPath });
  const db = openDatabase(indexPath);
  t.after(() => db.close());
  const reads = countVectorReads(db);

  // 80 documents missing: more than the 64 read one statement each.
  const bulk = createHybridCache();
  const first = hybridSearch(db, { query: "release review", limit: 20, cache: bulk });
  assert.equal(reads.rows, 80, "one pass over the table");
  assert.equal(bulk.documents.size, 80);

  // The same cache filled 40 documents at a time, one statement per document.
  const single = createHybridCache();
  hybridSearch(db, { query: "release review", folders: "02-knowledge/first", cache: single });
  hybridSearch(db, { query: "release review", folders: "02-knowledge/second", cache: single });
  assert.equal(reads.rows, 160);
  assert.deepEqual(hybridSearch(db, { query: "release review", limit: 20, cache: single }), first);
  assert.equal(reads.rows, 160, "nothing left to read");
});

test("all-zero weights fall back to the defaults, as the helper's did", needsSqlite, async (t) => {
  const { db } = await buildFixture(t);
  const defaults = hybridSearch(db, { query: "code review", limit: 10, denseWeight: 0 });
  // The defaults on this fixture are the ones pinned against the helper above.
  assert.equal(defaults[0].path, "03-skills-catalog/sources/custom/code-reviewer/SKILL.md");
  assert.deepEqual(hybridSearch(db, { query: "code review", limit: 10, keywordWeight: 0, semanticWeight: 0, denseWeight: 0 }), defaults);
  assert.deepEqual(
    hybridSearch(db, { query: "code review", limit: 10, keywordWeight: -1, semanticWeight: "x", denseWeight: 0 }).map((item) => item.path),
    hybridSearch(db, { query: "code review", limit: 10, keywordWeight: 0, semanticWeight: 0.2, denseWeight: 0 }).map((item) => item.path),
    "a negative weight is 0, a word is the default"
  );
});

test("a search that fails partway leaves no transaction open behind it", needsSqlite, async (t) => {
  const { db } = await buildFixture(t);
  const prepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    if (/JOIN semantic_vectors/.test(sql)) throw new Error("disk I/O error");
    return prepare(sql);
  };
  assert.throws(() => hybridSearch(db, { query: "code review", limit: 10 }), /disk I\/O error/);
  db.prepare = prepare;
  assert.equal(db.isTransaction, false);
  assert.ok(hybridSearch(db, { query: "code review", limit: 3 }).length > 0, "the next search begins its own transaction");
});
