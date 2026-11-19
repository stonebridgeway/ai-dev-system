// The node:test port of `search-index/test_search_freshness.py`, the Python
// helper's own suite, deleted with the helper: the
// same cases, against the Node engine.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { collectDocuments, denseContentHash, densePassageText, isMembraneSource, shaId } from "./search-documents.mjs";
import { galaxyPreview, exportGalaxy, semanticRow } from "./galaxy-export.mjs";
import { HYBRID_CANDIDATE_LIMIT, hybridSearch } from "./search-hybrid.mjs";
import { collapseSearchResults } from "./search-query.mjs";
import { SEMANTIC_DIMENSIONS } from "./search-semantic.mjs";
import { semanticTerms } from "./search-semantic.mjs";
import { createIndexReader, openDatabase, sqliteSupport } from "./search-sqlite.mjs";
import {
  DENSE_DIMENSIONS,
  DENSE_MODEL_NAME,
  densePlan,
  indexStatus,
  LEGACY_DENSE_BACKEND,
  LEGACY_DENSE_DTYPE,
  rebuildIndex,
  UNPINNED_REVISION
} from "./search-store.mjs";
import { withRebuildLock } from "./search-writer.mjs";
import { removeAfterAll } from "../../test/fixtures/temp-folder.mjs";

const needsSqlite = { skip: !sqliteSupport().available && sqliteSupport().reason };

/** The helper test's fixture: one note and an empty registry. */
function setUp(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "search-freshness-"));
  removeAfterAll(temp);
  const vault = path.join(temp, "vault");
  const indexPath = path.join(vault, "09-mcp", "search-index", "test.sqlite");
  fs.mkdirSync(path.join(vault, "02-knowledge"), { recursive: true });
  fs.mkdirSync(path.join(vault, "03-skills-catalog", "registries"), { recursive: true });
  fs.writeFileSync(path.join(vault, "03-skills-catalog", "registries", "skills.index.json"), "[]\n");
  const note = path.join(vault, "02-knowledge", "sample.md");
  fs.writeFileSync(note, "# Sample\n\nInitial searchable content.\n");
  const options = (overrides = {}) => ({ vaultRoot: vault, indexPath, includeExternalProjectFiles: true, preserveDense: true, ...overrides });
  return { temp, vault, indexPath, note, options };
}

/** One stored vector for the first document, stamped with a provenance, and meta that says dense is on. */
function seedDenseVector({ vault, indexPath }, backend, revision, dtype, metaExtra = {}) {
  const [doc] = collectDocuments({ vaultRoot: vault }).docs;
  const hash = denseContentHash(densePassageText(doc, 1200));
  const db = openDatabase(indexPath);
  try {
    db.prepare(`INSERT OR REPLACE INTO dense_vectors(id, vector, dimensions, model, backend, revision, dtype, content_hash, mtime)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(doc.id, new Uint8Array(4 * DENSE_DIMENSIONS), DENSE_DIMENSIONS, DENSE_MODEL_NAME, backend, revision, dtype, hash, doc.mtime);
    const meta = { dense_enabled: "true", dense_text_limit: "1200", dense_include_membrane: "false", dense_documents: "1", dense_pending_documents: "0", ...metaExtra };
    for (const [key, value] of Object.entries(meta)) db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)").run(key, value);
  } finally {
    db.close();
  }
  return { doc, hash };
}

/** A dense rebuild that supplies no vectors, so only reuse can fill the index. */
function denseRebuild(fixture, provenance) {
  return rebuildIndex(fixture.options({ denseEmbeddings: true, suppliedVectors: [], ...provenance }));
}

const vectorOf = (width) => Array.from({ length: width }, () => 0.01);

test("a taxonomy alias connects Russian and English terms", () => {
  const russian = new Set(semanticTerms("\u0433\u0440\u0443\u043f\u043f\u044b \u0441\u043a\u0438\u043b\u043b\u043e\u0432 \u0434\u043e\u043c\u0435\u043d\u044b \u043f\u043e\u0434\u0433\u0440\u0443\u043f\u043f\u044b \u043c\u0430\u0440\u0448\u0440\u0443\u0442\u0438\u0437\u0430\u0446\u0438\u044f \u0438 \u0441\u0432\u044f\u0437\u0430\u043d\u043d\u044b\u0435 \u043d\u0430\u0432\u044b\u043a\u0438"));
  const english = new Set(semanticTerms("skill taxonomy groups subgroups routing and related skills"));
  assert.ok(russian.has("alias:skill_taxonomy"));
  assert.ok(english.has("alias:skill_taxonomy"));
});

test("status detects an added, a changed and a deleted note", needsSqlite, async (t) => {
  const fixture = setUp(t);
  await rebuildIndex(fixture.options({ preserveDense: false }));
  assert.equal((await indexStatus(fixture.options())).stale, false);
  const added = path.join(fixture.vault, "02-knowledge", "added.md");
  fs.writeFileSync(added, "# Added\n");
  let status = await indexStatus(fixture.options());
  assert.deepEqual([status.stale, status.added_count], [true, 1]);
  await rebuildIndex(fixture.options());
  fs.writeFileSync(fixture.note, "# Sample\n\nChanged searchable content.\n");
  status = await indexStatus(fixture.options());
  assert.equal(status.changed_count, 1);
  await rebuildIndex(fixture.options());
  fs.rmSync(added);
  status = await indexStatus(fixture.options());
  assert.equal(status.deleted_count, 1);
});

test("a fast rebuild keeps only the vectors that still match", needsSqlite, async (t) => {
  const fixture = setUp(t);
  await rebuildIndex(fixture.options({ preserveDense: false }));
  seedDenseVector(fixture, LEGACY_DENSE_BACKEND, UNPINNED_REVISION, LEGACY_DENSE_DTYPE);
  let rebuilt = await rebuildIndex(fixture.options());
  assert.deepEqual([rebuilt.dense_enabled, rebuilt.dense_documents, rebuilt.dense_pending_documents], [true, 1, 0]);
  fs.writeFileSync(fixture.note, "# Sample\n\nDense content changed.\n");
  rebuilt = await rebuildIndex(fixture.options());
  assert.deepEqual([rebuilt.dense_enabled, rebuilt.dense_documents, rebuilt.dense_pending_documents], [true, 0, 1]);
});

test("vectors from another backend are not reused", needsSqlite, async (t) => {
  const fixture = setUp(t);
  await rebuildIndex(fixture.options({ preserveDense: false }));
  seedDenseVector(fixture, "python", UNPINNED_REVISION, "fp32");
  const kept = await denseRebuild(fixture, { denseBackend: "python", denseDtype: "fp32" });
  assert.equal(kept.dense_documents, 1, "the same backend reuses its own vector");
  const moved = await denseRebuild(fixture, { denseBackend: "onnx", denseDtype: "int8" });
  assert.deepEqual([moved.dense_documents, moved.dense_pending_documents], [0, 1]);
});

test("a changed revision or dtype invalidates the stored vector", needsSqlite, async (t) => {
  const fixture = setUp(t);
  await rebuildIndex(fixture.options({ preserveDense: false }));
  seedDenseVector(fixture, "onnx", "aaaa", "int8");
  assert.equal((await denseRebuild(fixture, { denseBackend: "onnx", denseRevision: "aaaa", denseDtype: "int8" })).dense_documents, 1);
  seedDenseVector(fixture, "onnx", "aaaa", "int8");
  assert.equal((await denseRebuild(fixture, { denseBackend: "onnx", denseRevision: "bbbb", denseDtype: "int8" })).dense_pending_documents, 1);
  seedDenseVector(fixture, "onnx", "aaaa", "int8");
  assert.equal((await denseRebuild(fixture, { denseBackend: "onnx", denseRevision: "aaaa", denseDtype: "fp32" })).dense_pending_documents, 1);
});

test("an index without provenance columns is embedded again in full", needsSqlite, async (t) => {
  const fixture = setUp(t);
  await rebuildIndex(fixture.options({ preserveDense: false }));
  const db = openDatabase(fixture.indexPath);
  db.exec(`DROP TABLE dense_vectors;
    CREATE TABLE dense_vectors(id TEXT PRIMARY KEY, vector BLOB NOT NULL, dimensions INTEGER NOT NULL, model TEXT NOT NULL, content_hash TEXT NOT NULL, mtime REAL NOT NULL)`);
  db.close();
  const plan = await densePlan({ vaultRoot: fixture.vault, indexPath: fixture.indexPath });
  assert.deepEqual([plan.reusable, plan.records.length], [0, 1]);
});

test("a dense plan lists the passages a backend elsewhere must embed", needsSqlite, async (t) => {
  const fixture = setUp(t);
  await rebuildIndex(fixture.options({ preserveDense: false }));
  const plan = await densePlan({ vaultRoot: fixture.vault, indexPath: fixture.indexPath, provenance: { backend: "onnx", dtype: "int8" } });
  assert.ok(plan.records.length > 0);
  assert.equal(plan.provenance.backend, "onnx");
  assert.equal(plan.reusable, 0);
  for (const record of plan.records) assert.ok(record.text && record.content_hash);
});

test("Membrane is recognised by source in either layout (\u0414-91)", () => {
  for (const source of ["external/membrane", "membrane/application-skills", "Membrane", "external/membrane-cli"]) assert.equal(isMembraneSource(source), true, source);
  for (const source of ["external/archify", "vault-note", "", null, undefined]) assert.equal(isMembraneSource(source), false, String(source));
});

test("a dense plan leaves out Membrane from the seed layout unless asked", needsSqlite, async (t) => {
  const fixture = setUp(t);
  fs.writeFileSync(path.join(fixture.vault, "03-skills-catalog", "registries", "skills.index.json"), `${JSON.stringify([
    { name: "slack", source: "external/membrane", type: "app-integration", description: "Slack connector" },
    { name: "archify", source: "external/archify", type: "external-skill", description: "Diagrams" }
  ])}\n`);
  await rebuildIndex(fixture.options({ preserveDense: false }));
  const slack = shaId("skill", "external/membrane", "slack");
  const archify = shaId("skill", "external/archify", "archify");
  const planned = new Set((await densePlan({ vaultRoot: fixture.vault, indexPath: fixture.indexPath })).records.map((record) => record.id));
  assert.ok(planned.has(archify));
  assert.ok(!planned.has(slack));
  const everything = await densePlan({ vaultRoot: fixture.vault, indexPath: fixture.indexPath, includeMembrane: true });
  assert.ok(everything.records.some((record) => record.id === slack));
});

test("supplied vectors are written, with their provenance, by a process that has no model", needsSqlite, async (t) => {
  const fixture = setUp(t);
  await rebuildIndex(fixture.options({ preserveDense: false }));
  const plan = await densePlan({ vaultRoot: fixture.vault, indexPath: fixture.indexPath, provenance: { backend: "onnx", dtype: "int8" } });
  const rebuilt = await rebuildIndex(fixture.options({
    denseEmbeddings: true,
    denseBackend: "onnx",
    denseRevision: "4de1325",
    denseDtype: "int8",
    suppliedVectors: plan.records.map((record) => ({ id: record.id, content_hash: record.content_hash, vector: vectorOf(DENSE_DIMENSIONS) }))
  }));
  assert.deepEqual(
    [rebuilt.dense_documents, rebuilt.dense_pending_documents, rebuilt.dense_backend, rebuilt.dense_revision],
    [plan.records.length, 0, "onnx", "4de1325"]
  );
});

test("a document edited after the plan stays pending", needsSqlite, async (t) => {
  const fixture = setUp(t);
  await rebuildIndex(fixture.options({ preserveDense: false }));
  const plan = await densePlan({ vaultRoot: fixture.vault, indexPath: fixture.indexPath, provenance: { backend: "onnx", dtype: "int8" } });
  const rebuilt = await rebuildIndex(fixture.options({
    denseEmbeddings: true,
    denseBackend: "onnx",
    denseDtype: "int8",
    suppliedVectors: plan.records.map((record) => ({ id: record.id, content_hash: "stale-hash", vector: vectorOf(DENSE_DIMENSIONS) }))
  }));
  assert.deepEqual([rebuilt.dense_documents, rebuilt.dense_pending_documents], [0, plan.records.length]);
});

test("a supplied vector of the wrong width is dropped", needsSqlite, async (t) => {
  const fixture = setUp(t);
  await rebuildIndex(fixture.options({ preserveDense: false }));
  const plan = await densePlan({ vaultRoot: fixture.vault, indexPath: fixture.indexPath, provenance: { backend: "onnx", dtype: "int8" } });
  const rebuilt = await rebuildIndex(fixture.options({
    denseEmbeddings: true,
    denseBackend: "onnx",
    denseDtype: "int8",
    suppliedVectors: plan.records.map((record) => ({ id: record.id, content_hash: record.content_hash, vector: vectorOf(768) }))
  }));
  assert.equal(rebuilt.dense_documents, 0);
});

test("a fast rebuild keeps vectors from whichever backend made them", needsSqlite, async (t) => {
  const fixture = setUp(t);
  await rebuildIndex(fixture.options({ preserveDense: false }));
  seedDenseVector(fixture, "onnx", "4de1325", "int8", { dense_backend: "onnx", dense_revision: "4de1325", dense_dtype: "int8" });
  // No backend on the call: a fast rebuild does not pass one.
  const kept = await rebuildIndex(fixture.options());
  assert.deepEqual(
    [kept.dense_documents, kept.dense_pending_documents, kept.dense_backend, kept.dense_revision, kept.dense_dtype],
    [1, 0, "onnx", "4de1325", "int8"]
  );
});

test("a busy index is an error after the retries, never an empty answer", async (t) => {
  const fixture = setUp(t);
  fs.mkdirSync(path.dirname(fixture.indexPath), { recursive: true });
  fs.writeFileSync(fixture.indexPath, "");
  const reader = createIndexReader(fixture.indexPath, { delays: [0, 0] });
  t.after(() => reader.close());
  let attempts = 0;
  await assert.rejects(
    reader.read(() => {
      attempts += 1;
      throw Object.assign(new Error("database is locked"), { errcode: 5 });
    }),
    /remained busy after 3 attempts/
  );
  assert.equal(attempts, 3);
});

test("the rebuild lock keeps a second owner out", needsSqlite, async (t) => {
  const fixture = setUp(t);
  await withRebuildLock(fixture.indexPath, async () => {
    await assert.rejects(
      withRebuildLock(fixture.indexPath, async () => assert.fail("a second owner entered"), { env: { AI_DEV_SEARCH_REBUILD_LOCK_TIMEOUT: "0" } }),
      /rebuild lock/
    );
  });
});

test("a skill card and its source collapse to one canonical result", () => {
  const results = collapseSearchResults([
    { scope: "skills", title: "frontend-quality-gate", path: "03-skills-catalog/cards/custom/frontend-quality-gate.md", source: "vault-note", score: 0.9 },
    { scope: "skills", title: "frontend-quality-gate", path: "03-skills-catalog/sources/custom/frontend-quality-gate/SKILL.md", source: "custom", score: 0.7 }
  ]);
  assert.equal(results.length, 1);
  assert.equal(results[0].path, "03-skills-catalog/sources/custom/frontend-quality-gate/SKILL.md");
  assert.equal(results[0].score, 0.9);
  assert.equal(results[0].duplicate_count, 1);
});

test("an unrelated skill-group note is not collapsed by title", () => {
  const results = collapseSearchResults([
    { scope: "skills", title: "Frontend", path: "03-skills-catalog/groups/frontend.md", source: "vault-note", score: 0.9 },
    { scope: "skills", title: "Frontend", path: "03-skills-catalog/groups/frontend-index.md", source: "vault-note", score: 0.8 }
  ]);
  assert.equal(results.length, 2);
});

test("the hybrid candidate pool does not depend on the output limit", needsSqlite, async (t) => {
  const fixture = setUp(t);
  await rebuildIndex(fixture.options({ preserveDense: false }));
  const db = openDatabase(fixture.indexPath);
  t.after(() => db.close());
  const limits = [];
  const prepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    const statement = prepare(sql);
    if (!/bm25\(docs_fts\) AS raw_score/.test(sql)) return statement;
    return { all: (...params) => { limits.push(params.at(-1)); return statement.all(...params); } };
  };
  const base = { query: "searchable content", semanticWeight: 0.2, keywordWeight: 0.8, denseWeight: 0 };
  hybridSearch(db, { ...base, limit: 1 });
  hybridSearch(db, { ...base, limit: 20 });
  assert.deepEqual(limits, [HYBRID_CANDIDATE_LIMIT, HYBRID_CANDIDATE_LIMIT]);
});

test("the galaxy export holds one row per document in both spaces", needsSqlite, async (t) => {
  const fixture = setUp(t);
  fs.writeFileSync(
    path.join(fixture.vault, "02-knowledge", "linked.md"),
    "# Linked\n\nSee [[sample]], [[Sample|again]], [[other#heading]] and ![[diagram.png]].\n"
  );
  await rebuildIndex(fixture.options({ preserveDense: false }));
  seedDenseVector(fixture, "onnx", "4de1325", "int8");
  const db = openDatabase(fixture.indexPath);
  t.after(() => db.close());
  const { manifest, semanticBytes, denseBytes, summary } = exportGalaxy(db);
  assert.equal(manifest.document_count, 2);
  assert.equal(manifest.dense_documents, 1);
  assert.equal(manifest.dense_dimensions, DENSE_DIMENSIONS);
  assert.equal(semanticBytes.byteLength, 2 * 4 * SEMANTIC_DIMENSIONS);
  assert.equal(denseBytes.byteLength, 4 * DENSE_DIMENSIONS);
  assert.deepEqual(manifest.nodes.map((node) => node.dense).sort(), [-1, 0]);
  const linked = manifest.nodes.find((node) => node.title === "Linked");
  // Alias and heading are stripped, repeats collapse, and an embed is a link
  // too: the renderer drops what no note answers to.
  assert.deepEqual(linked.links, ["sample", "Sample", "other", "diagram.png"]);
  assert.equal(summary.wikilinks, 4);
});

test("the galaxy export folds a skill card into its skill", needsSqlite, async (t) => {
  const fixture = setUp(t);
  fs.writeFileSync(path.join(fixture.vault, "03-skills-catalog", "registries", "skills.index.json"), JSON.stringify([{
    name: "sample-skill",
    source: "custom",
    path: "sources/custom/sample-skill/SKILL.md",
    description: "Review a change for the defects a careful reader would catch first."
  }]));
  const card = path.join(fixture.vault, "03-skills-catalog", "cards", "custom", "sample-skill.md");
  fs.mkdirSync(path.dirname(card), { recursive: true });
  fs.writeFileSync(card, "---\ncard_kind: skill-card\n---\n# sample-skill\n\nPart of [[Security]].\n");
  await rebuildIndex(fixture.options({ preserveDense: false }));
  const db = openDatabase(fixture.indexPath);
  t.after(() => db.close());
  const { manifest, summary } = exportGalaxy(db);
  const skills = manifest.nodes.filter((node) => node.title === "sample-skill");
  assert.equal(skills.length, 1);
  assert.equal(summary.collapsed_documents, 1);
  // The registry entry wins, as it does in search; the card's link and path survive on it.
  assert.equal(skills[0].path, "03-skills-catalog/sources/custom/sample-skill/SKILL.md");
  assert.deepEqual(skills[0].also, ["03-skills-catalog/cards/custom/sample-skill.md"]);
  assert.deepEqual(skills[0].links, ["Security"]);
  assert.equal(skills[0].preview, "Review a change for the defects a careful reader would catch first.");
});

test("the galaxy export refuses an index without its tables", needsSqlite, async (t) => {
  const fixture = setUp(t);
  fs.mkdirSync(path.dirname(fixture.indexPath), { recursive: true });
  const db = openDatabase(fixture.indexPath);
  t.after(() => db.close());
  assert.throws(() => exportGalaxy(db), /predates the galaxy export\. Rebuild it first/);
});

test("the galaxy preview skips frontmatter, the title and markup", () => {
  const body = "---\ncard_kind: skill-card\nname: x\n---\n# Title\n\nFirst **bold** [[a/b|line]].\n- Second `code`.\n";
  assert.equal(galaxyPreview(body, "stored"), "First bold line. Second code.");
  assert.equal(galaxyPreview("", "stored"), "stored");
  assert.equal(galaxyPreview("# Only a title", "stored"), "stored");
  const registryBody = "name\ncustom\nA description long enough to be the line a reader wants.\nshort";
  assert.equal(galaxyPreview(registryBody, "stored", false), "A description long enough to be the line a reader wants.");
  assert.equal(galaxyPreview("name\ncustom", "stored", false), "stored");
});

test("a semantic row ignores dimensions outside the space", () => {
  const row = new Float32Array(SEMANTIC_DIMENSIONS);
  semanticRow(JSON.stringify({ 3: 0.5, "-1": 1.0, 99999: 1.0, x: 1.0 }), row);
  assert.equal(row[3], 0.5);
  assert.equal(row.filter((value) => value).length, 1);
  const empty = new Float32Array(SEMANTIC_DIMENSIONS);
  semanticRow("not json", empty);
  assert.equal(empty.reduce((sum, value) => sum + value, 0), 0);
});
