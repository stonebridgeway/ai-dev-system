/**
 * An index 2.0.0 wrote with dense vectors: `dense_vectors` has no backend,
 * revision or dtype, which later 2.x added. Every
 * vector in it is the Python backend's — the only one 2.x had then — and is
 * counted, kept and compared as such: another model's, waiting for
 * `setup -- --model`, as later 2.x's Python vectors are.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { hybridSearch } from "./search-hybrid.mjs";
import { densePlan, indexStatus, rebuildIndex } from "./search-store.mjs";
import { openDatabase, sqliteSupport, tableColumns } from "./search-sqlite.mjs";
import { removeAfterAll } from "../../test/fixtures/temp-folder.mjs";

const needsSqlite = { skip: !sqliteSupport().available && sqliteSupport().reason };
const PYTHON = { backend: "python", revision: "unpinned", dtype: "fp32" };
const ONNX = { backend: "onnx", revision: "abc123", dtype: "int8" };

/** Three notes, indexed with a vector each, then left as 2.0.0 left an index: its table, its meta. */
async function indexOf200(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "search-unrecorded-"));
  removeAfterAll(root);
  const vault = path.join(root, "vault");
  fs.mkdirSync(path.join(vault, "02-knowledge"), { recursive: true });
  for (const [name, text] of [["deploy", "How to deploy and roll back."], ["review", "What a reviewer checks."], ["gate", "Tests pass before a release."]]) {
    fs.writeFileSync(path.join(vault, "02-knowledge", `${name}.md`), `# ${name}\n\n${text}\n`);
  }
  const indexPath = path.join(root, "index.sqlite");
  await rebuildIndex({ vaultRoot: vault, indexPath });
  const plan = await densePlan({ vaultRoot: vault, indexPath, provenance: PYTHON });
  const vectors = plan.records.map((record, index) => ({
    id: record.id,
    content_hash: record.content_hash,
    vector: Array.from({ length: 1024 }, (_, position) => (position === index ? 1 : 0))
  }));
  await rebuildIndex({ vaultRoot: vault, indexPath, denseEmbeddings: true, suppliedVectors: vectors, denseBackend: "python" });
  const db = openDatabase(indexPath);
  db.exec(`CREATE TABLE old_dense(id TEXT PRIMARY KEY, vector BLOB NOT NULL, dimensions INTEGER NOT NULL, model TEXT NOT NULL,
      content_hash TEXT NOT NULL, mtime REAL NOT NULL);
    INSERT INTO old_dense SELECT id, vector, dimensions, model, content_hash, mtime FROM dense_vectors;
    DROP TABLE dense_vectors;
    ALTER TABLE old_dense RENAME TO dense_vectors;
    CREATE INDEX dense_vectors_hash_idx ON dense_vectors(content_hash);
    DELETE FROM meta WHERE key IN ('dense_backend', 'dense_revision', 'dense_dtype');`);
  const before = db.prepare("SELECT id, vector, content_hash FROM dense_vectors ORDER BY id").all();
  db.close();
  return { vault, indexPath, before, documents: plan.records.length };
}

test("2.0.0's vectors are counted as the Python backend's, and a status call leaves its table as it is", needsSqlite, async (t) => {
  const { vault, indexPath, documents } = await indexOf200(t);
  const status = await indexStatus({ vaultRoot: vault, indexPath });
  assert.equal(status.stale, false);
  assert.deepEqual(status.dense_models, [{ ...PYTHON, documents }]);
  const db = openDatabase(indexPath);
  t.after(() => db.close());
  assert.equal(tableColumns(db, "dense_vectors").has("backend"), false, "nothing rewritten by a status call");
});

test("a question embedded by the model 3.0 runs leaves 2.0.0's vectors out instead of failing on the table", needsSqlite, async (t) => {
  const { indexPath } = await indexOf200(t);
  const db = openDatabase(indexPath);
  t.after(() => db.close());
  const query = Array.from({ length: 1024 }, (_, position) => (position === 0 ? 1 : 0));
  const without = hybridSearch(db, { query: "release", limit: 10 });
  for (const denseProvenance of [ONNX, null]) {
    const answer = hybridSearch(db, { query: "release", limit: 10, denseQueryVector: query, denseProvenance });
    assert.equal(answer.dense_unmatched, true, `provenance ${JSON.stringify(denseProvenance)}`);
    assert.deepEqual(answer.map((item) => [item.path, item.score]), without.map((item) => [item.path, item.score]));
  }
});

test("a rebuild keeps 2.0.0's vectors byte for byte, recorded as the Python backend's; the new model's replace them", needsSqlite, async (t) => {
  const { vault, indexPath, before, documents } = await indexOf200(t);
  const kept = await rebuildIndex({ vaultRoot: vault, indexPath, preserveDense: true });
  assert.deepEqual([kept.dense_preserved, kept.dense_documents, kept.dense_pending_documents, kept.dense_backend], [true, documents, 0, "python"]);
  const db = openDatabase(indexPath);
  const after = db.prepare("SELECT id, vector, content_hash, backend, revision, dtype FROM dense_vectors ORDER BY id").all();
  db.close();
  assert.deepEqual(after.map(({ id, vector, content_hash: hash }) => [id, Buffer.from(vector).toString("hex"), hash]),
    before.map(({ id, vector, content_hash: hash }) => [id, Buffer.from(vector).toString("hex"), hash]));
  assert.ok(after.every((row) => row.backend === PYTHON.backend && row.revision === PYTHON.revision && row.dtype === PYTHON.dtype));

  const plan = await densePlan({ vaultRoot: vault, indexPath, provenance: ONNX });
  assert.equal(plan.records.length, documents, "every document waits for the new model");
  const vectors = plan.records.map((record) => ({ id: record.id, content_hash: record.content_hash, vector: Array.from({ length: 1024 }, () => 0.5) }));
  await rebuildIndex({ vaultRoot: vault, indexPath, denseEmbeddings: true, suppliedVectors: vectors, denseBackend: "onnx", denseRevision: "abc123", denseDtype: "int8" });
  const status = await indexStatus({ vaultRoot: vault, indexPath });
  assert.deepEqual(status.dense_models, [{ ...ONNX, documents }]);
});
