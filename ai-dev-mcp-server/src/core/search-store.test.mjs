import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDocumentCache } from "./search-documents.mjs";
import { densePlan, indexStatus, rebuildIndex, storeDenseVectors } from "./search-store.mjs";
import { DEFAULT_REBUILD_LOCK_TIMEOUT_SECONDS, rebuildLockTimeoutMs, setAside } from "./search-writer.mjs";
import { createIndexReader, isBusyError, isCorruptError, loadSqlite, openDatabase, sqliteSupport, wholeText } from "./search-sqlite.mjs";
import { removeAfterAll } from "../../test/fixtures/temp-folder.mjs";

const supported = sqliteSupport().available;
const needsSqlite = { skip: !supported && sqliteSupport().reason };

function tempRoot(t, prefix = "search-store-") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  removeAfterAll(root);
  return root;
}

function write(root, rel, content) {
  const target = path.join(root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

/** A vault of `notes` notes and `skills` registry entries, every third of them Membrane's. */
function buildVault(root, { notes = 12, skills = 30 } = {}) {
  for (let index = 0; index < notes; index += 1) {
    write(root, `02-knowledge/topic-${index}.md`, `# Topic ${index}\n\nNotes about deployment ${index} and database migration rollback.\n`);
  }
  write(root, "07-quality-gates/release gate.md", "# Release gate\n\nRun the tests before shipping.");
  write(root, "03-skills-catalog/registries/skills.index.json", JSON.stringify(Array.from({ length: skills }, (_, index) => ({
    name: `skill-${index}`,
    source: index % 3 === 0 ? "external/membrane" : "custom",
    categories: ["testing", `group-${index % 4}`],
    description: `Skill ${index} reviews code and writes tests.`,
    path: `sources/custom/skill-${index}/SKILL.md`
  }))));
}

/** Every row of every table, rowids and the build time aside. */
function dump(indexPath) {
  const db = openDatabase(indexPath);
  try {
    const rows = (sql) => db.prepare(sql).all().map((row) => JSON.stringify(Object.values(row).map((value) => (value instanceof Uint8Array ? Buffer.from(value).toString("hex") : value))));
    return {
      documents: rows("SELECT id, scope, title, path, source, categories, preview, mtime, content_hash FROM documents ORDER BY id"),
      docs_fts: rows("SELECT id, title, CAST(body AS BLOB), path, source, categories FROM docs_fts ORDER BY id"),
      semantic_vectors: rows("SELECT id, vector, norm FROM semantic_vectors ORDER BY id"),
      dense_vectors: rows("SELECT id, vector, dimensions, model, backend, revision, dtype, content_hash, mtime FROM dense_vectors ORDER BY id"),
      meta: rows("SELECT key, value FROM meta WHERE key != 'built_at' ORDER BY key")
    };
  } finally {
    db.close();
  }
}

/** Synthetic vectors for every passage of a plan, deterministic per id. */
function vectorsFor(plan) {
  return plan.records.map((record, index) => ({
    id: record.id,
    content_hash: record.content_hash,
    vector: Array.from({ length: 1024 }, (_, position) => ((index * 31 + position) % 97) / 97 - 0.5)
  }));
}

test("node:sqlite loads without its ExperimentalWarning, and other warnings still print", needsSqlite, async () => {
  const moduleUrl = new URL("./search-sqlite.mjs", import.meta.url).href;
  const source = `const m = await import(${JSON.stringify(moduleUrl)}); m.sqliteSupport(); process.emitWarning("still here", "ExperimentalWarning");`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve) => child.on("exit", resolve));
  assert.equal(code, 0, stderr);
  assert.doesNotMatch(stderr, /SQLite is an experimental feature/);
  assert.match(stderr, /ExperimentalWarning: still here/);
  assert.ok(loadSqlite());
});

test("a built index is current, and every kind of change makes it stale with the paths", needsSqlite, async (t) => {
  const vault = tempRoot(t);
  const indexPath = path.join(tempRoot(t), "index", "ai-dev-search.sqlite");
  buildVault(vault);
  const missing = await indexStatus({ vaultRoot: vault, indexPath });
  assert.deepEqual([missing.index_exists, missing.stale, missing.reasons], [false, true, ["index_missing"]]);
  assert.equal(missing.added.length, 20);

  const summary = await rebuildIndex({ vaultRoot: vault, indexPath });
  assert.equal(summary.document_count, 43);
  assert.equal(summary.semantic_documents, 43);
  assert.deepEqual(summary.by_scope, { knowledge: 12, quality: 1, skills: 30 });
  assert.equal(summary.write_mode, "full");
  const current = await indexStatus({ vaultRoot: vault, indexPath });
  assert.deepEqual([current.stale, current.reasons, current.schema_version, current.indexed_document_count], [false, [], 2, 43]);
  assert.equal(current.indexed_fingerprint, current.source_fingerprint);

  write(vault, "02-knowledge/new.md", "# New");
  write(vault, "02-knowledge/topic-1.md", "# Topic 1\n\nRewritten.");
  fs.rmSync(path.join(vault, "02-knowledge", "topic-2.md"));
  const stale = await indexStatus({ vaultRoot: vault, indexPath });
  assert.deepEqual(stale.reasons, ["sources_added", "sources_changed", "sources_deleted"]);
  assert.deepEqual([stale.added, stale.changed, stale.deleted], [["02-knowledge/new.md"], ["02-knowledge/topic-1.md"], ["02-knowledge/topic-2.md"]]);
});

test("an index without vectors names no backend for them, one written before 3.0 included", needsSqlite, async (t) => {
  const vault = tempRoot(t);
  const indexPath = path.join(tempRoot(t), "index", "ai-dev-search.sqlite");
  buildVault(vault, { notes: 2, skills: 2 });
  await rebuildIndex({ vaultRoot: vault, indexPath });
  const meta = () => {
    const db = openDatabase(indexPath);
    try {
      return Object.fromEntries(db.prepare("SELECT key, value FROM meta WHERE key LIKE 'dense_%'").all().map((row) => [row.key, row.value]));
    } finally {
      db.close();
    }
  };
  assert.deepEqual([meta().dense_enabled, meta().dense_backend, meta().dense_revision, meta().dense_dtype], ["false", "", "", ""]);
  const status = await indexStatus({ vaultRoot: vault, indexPath });
  assert.deepEqual([status.dense_enabled, status.dense_backend, status.dense_revision, status.dense_dtype], [false, "", "", ""]);

  // What 2.x — and 3.0 before this — wrote for an index without vectors.
  const db = openDatabase(indexPath);
  try {
    const upsert = db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)");
    for (const [key, value] of [["dense_backend", "python"], ["dense_revision", "unpinned"], ["dense_dtype", "fp32"]]) upsert.run(key, value);
  } finally {
    db.close();
  }
  const old = await indexStatus({ vaultRoot: vault, indexPath });
  assert.deepEqual([old.dense_backend, old.dense_revision, old.dense_dtype], ["", "", ""]);
});

test("an index names the vault it was built from, and is stale for any other — the same notes included", needsSqlite, async (t) => {
  const vault = tempRoot(t);
  const copy = tempRoot(t);
  const indexPath = path.join(tempRoot(t), "index", "ai-dev-search.sqlite");
  buildVault(vault, { notes: 2, skills: 2 });
  buildVault(copy, { notes: 2, skills: 2 });
  await rebuildIndex({ vaultRoot: vault, indexPath });
  const own = await indexStatus({ vaultRoot: vault, indexPath });
  assert.deepEqual([own.stale, own.vault_root], [false, path.resolve(vault)]);
  const other = await indexStatus({ vaultRoot: copy, indexPath });
  assert.deepEqual([other.stale, other.reasons], [true, ["vault_changed"]]);
  await rebuildIndex({ vaultRoot: copy, indexPath, inPlace: true });
  assert.deepEqual((await indexStatus({ vaultRoot: copy, indexPath })).reasons, []);
});

test("writing in place leaves exactly what a full rebuild writes", needsSqlite, async (t) => {
  const vault = tempRoot(t);
  const indexDir = tempRoot(t);
  const inPlace = path.join(indexDir, "in-place.sqlite");
  const full = path.join(indexDir, "full.sqlite");
  buildVault(vault);
  await rebuildIndex({ vaultRoot: vault, indexPath: inPlace });
  write(vault, "02-knowledge/new.md", "# New note\n\nAbout rollbacks.");
  write(vault, "02-knowledge/topic-3.md", "# Topic 3\n\nChanged.");
  fs.rmSync(path.join(vault, "02-knowledge", "topic-4.md"));
  const old = new Date(Date.now() - 3_600_000);
  fs.utimesSync(path.join(vault, "02-knowledge", "topic-5.md"), old, old);
  const updated = await rebuildIndex({ vaultRoot: vault, indexPath: inPlace, inPlace: true });
  assert.equal(updated.write_mode, "in_place");
  assert.equal(updated.rewritten_documents, 4, "one added, one changed (out and in), one deleted");
  await rebuildIndex({ vaultRoot: vault, indexPath: full });
  assert.deepEqual(dump(inPlace), dump(full));
  assert.equal((await indexStatus({ vaultRoot: vault, indexPath: inPlace })).stale, false);
});

test("a rebuild cancelled while it writes leaves the index as it was, and says how far it got", needsSqlite, async (t) => {
  const vault = tempRoot(t);
  const indexPath = path.join(tempRoot(t), "index", "ai-dev-search.sqlite");
  buildVault(vault, { notes: 300, skills: 30 });
  await rebuildIndex({ vaultRoot: vault, indexPath });
  const before = dump(indexPath);
  // Eighty new notes: few enough that `inPlace` writes only them, enough for a slice of 64.
  for (let index = 0; index < 80; index += 1) write(vault, `02-knowledge/new-${index}.md`, `# New ${index}\n\nWritten after the first build.`);
  for (const inPlace of [false, true]) {
    const controller = new AbortController();
    const heard = [];
    await assert.rejects(rebuildIndex({
      vaultRoot: vault,
      indexPath,
      inPlace,
      signal: controller.signal,
      onProgress: (event) => {
        heard.push(event);
        controller.abort();
      }
    }), (error) => error.name === "AbortError" && /cancelled; the index is as it was/.test(error.message));
    assert.deepEqual(dump(indexPath), before, inPlace ? "in place" : "full");
    assert.deepEqual(heard, [{ phase: "indexing", done: 64, total: inPlace ? 80 : 411 }]);
  }
  const stale = await indexStatus({ vaultRoot: vault, indexPath });
  assert.equal(stale.added_count, 80, "the new notes wait for the next rebuild");
  // A signal already raised stops it before it starts; nothing is held after.
  await assert.rejects(rebuildIndex({ vaultRoot: vault, indexPath, signal: AbortSignal.abort() }), /cancelled/);
  const progress = [];
  const summary = await rebuildIndex({ vaultRoot: vault, indexPath, onProgress: (event) => progress.push(event.done) });
  assert.equal(summary.document_count, 411);
  assert.deepEqual(progress, [64, 128, 192, 256, 320, 384]);
});

test("most of a vault changed, or an index of another schema, is rewritten whole", needsSqlite, async (t) => {
  const vault = tempRoot(t);
  const indexPath = path.join(tempRoot(t), "index.sqlite");
  buildVault(vault, { notes: 4, skills: 4 });
  await rebuildIndex({ vaultRoot: vault, indexPath });
  for (let index = 0; index < 4; index += 1) write(vault, `02-knowledge/topic-${index}.md`, `# Changed ${index}`);
  write(vault, "02-knowledge/extra.md", "# Extra");
  assert.equal((await rebuildIndex({ vaultRoot: vault, indexPath, inPlace: true })).write_mode, "full");

  const db = openDatabase(indexPath);
  db.exec("UPDATE meta SET value = '1' WHERE key = 'schema_version'");
  db.close();
  assert.equal((await rebuildIndex({ vaultRoot: vault, indexPath, inPlace: true })).write_mode, "full");
});

test("status names an outdated schema, a missing table and a fingerprint that drifted", needsSqlite, async (t) => {
  const vault = tempRoot(t);
  const indexDir = tempRoot(t);
  buildVault(vault, { notes: 2, skills: 2 });
  const empty = path.join(indexDir, "empty.sqlite");
  openDatabase(empty).close();
  assert.deepEqual((await indexStatus({ vaultRoot: vault, indexPath: empty })).reasons, ["documents_table_missing"]);

  const old = path.join(indexDir, "old.sqlite");
  const db = openDatabase(old);
  db.exec("CREATE TABLE documents(id TEXT PRIMARY KEY, path TEXT, mtime REAL)");
  db.close();
  const outdated = await indexStatus({ vaultRoot: vault, indexPath: old });
  assert.equal(outdated.schema_current, false);
  assert.deepEqual(outdated.reasons, ["schema_outdated", "sources_added"]);

  const drifted = path.join(indexDir, "drifted.sqlite");
  await rebuildIndex({ vaultRoot: vault, indexPath: drifted });
  const handle = openDatabase(drifted);
  handle.exec("UPDATE meta SET value = 'other' WHERE key = 'source_fingerprint'");
  handle.close();
  assert.deepEqual((await indexStatus({ vaultRoot: vault, indexPath: drifted })).reasons, ["source_fingerprint_mismatch"]);
});

test("a file that is not a database is reported, set aside and rebuilt (\u0414-116)", needsSqlite, async (t) => {
  const vault = tempRoot(t);
  const indexDir = tempRoot(t);
  const indexPath = path.join(indexDir, "index.sqlite");
  buildVault(vault, { notes: 2, skills: 2 });
  fs.writeFileSync(indexPath, Buffer.alloc(4096, 7));
  const status = await indexStatus({ vaultRoot: vault, indexPath });
  assert.deepEqual([status.index_exists, status.stale, status.reasons], [true, true, ["index_unreadable"]]);
  assert.match(status.error, /not a database/);
  const summary = await rebuildIndex({ vaultRoot: vault, indexPath, inPlace: true });
  assert.equal(summary.document_count, 5);
  assert.equal(fs.readFileSync(`${indexPath}.corrupt`).length, 4096, "the damaged file is kept once, beside the index");
  assert.equal((await indexStatus({ vaultRoot: vault, indexPath })).stale, false);
});

test("the index is in WAL mode, and readers see the old index or the new one, never half", needsSqlite, async (t) => {
  const vault = tempRoot(t);
  const indexPath = path.join(tempRoot(t), "index.sqlite");
  buildVault(vault, { notes: 10, skills: 10 });
  await rebuildIndex({ vaultRoot: vault, indexPath });
  const db = openDatabase(indexPath);
  assert.equal(db.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
  db.close();

  buildVault(vault, { notes: 10, skills: 400 });
  const reader = createIndexReader(indexPath);
  t.after(() => reader.close());
  const seen = new Set();
  let done = false;
  const rebuilding = rebuildIndex({ vaultRoot: vault, indexPath }).finally(() => { done = true; });
  while (!done) {
    seen.add(await reader.read((handle) => handle.prepare("SELECT count(*) AS n FROM documents").get().n));
    await new Promise((resolve) => setImmediate(resolve));
  }
  await rebuilding;
  seen.add(await reader.read((handle) => handle.prepare("SELECT count(*) AS n FROM documents").get().n));
  assert.ok([...seen].every((count) => count === 21 || count === 411), `counts seen: ${[...seen]}`);
  assert.ok(seen.has(411));
});

test("rebuilds wait for each other, across processes, and all succeed", needsSqlite, async (t) => {
  const vault = tempRoot(t);
  const indexPath = path.join(tempRoot(t), "index.sqlite");
  buildVault(vault, { notes: 30, skills: 60 });
  const storeUrl = new URL("./search-store.mjs", import.meta.url).href;
  const source = `const { rebuildIndex } = await import(${JSON.stringify(storeUrl)});
    const [vaultRoot, indexPath] = process.argv.slice(1);
    for (let i = 0; i < 3; i += 1) await rebuildIndex({ vaultRoot, indexPath, inPlace: i % 2 === 1 });`;
  const children = Array.from({ length: 3 }, () => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source, "--", vault, indexPath], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    return new Promise((resolve) => child.on("exit", (code) => resolve({ code, stderr })));
  });
  const [inProcess, ...results] = await Promise.all([rebuildIndex({ vaultRoot: vault, indexPath }), ...children]);
  for (const { code, stderr } of results) assert.equal(code, 0, stderr);
  assert.equal(inProcess.document_count, 91);
  assert.equal((await indexStatus({ vaultRoot: vault, indexPath })).stale, false);
  assert.equal(fs.existsSync(`${indexPath}.lock`), false, "every lock released");
});

test("a rebuild that cannot get the lock in time says so", needsSqlite, async (t) => {
  const vault = tempRoot(t);
  const indexPath = path.join(tempRoot(t), "index.sqlite");
  buildVault(vault, { notes: 1, skills: 1 });
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  fs.writeFileSync(`${indexPath}.lock`, JSON.stringify({ pid: process.pid, host: os.hostname(), token: "held", acquired_at: Date.now() }));
  await assert.rejects(
    rebuildIndex({ vaultRoot: vault, indexPath, env: { AI_DEV_SEARCH_REBUILD_LOCK_TIMEOUT: "0.2" } }),
    /Timed out waiting for search-index rebuild lock: .*index\.sqlite\.lock/
  );
  fs.rmSync(`${indexPath}.lock`);
  assert.equal((await rebuildIndex({ vaultRoot: vault, indexPath })).document_count, 3);
});

test("the lock timeout is seconds from the environment, 600 by default", () => {
  assert.equal(DEFAULT_REBUILD_LOCK_TIMEOUT_SECONDS, 600);
  assert.equal(rebuildLockTimeoutMs({}), 600_000);
  assert.equal(rebuildLockTimeoutMs({ AI_DEV_SEARCH_REBUILD_LOCK_TIMEOUT: "2.5" }), 2500);
  assert.equal(rebuildLockTimeoutMs({ AI_DEV_SEARCH_REBUILD_LOCK_TIMEOUT: "0" }), 0);
  assert.equal(rebuildLockTimeoutMs({ AI_DEV_SEARCH_REBUILD_LOCK_TIMEOUT: "-3" }), 0);
  assert.equal(rebuildLockTimeoutMs({ AI_DEV_SEARCH_REBUILD_LOCK_TIMEOUT: "soon" }), 600_000);
  assert.equal(rebuildLockTimeoutMs({ AI_DEV_SEARCH_REBUILD_LOCK_TIMEOUT: "" }), 600_000);
});

test("supplied vectors are stored where their passage still matches, and kept by later rebuilds", needsSqlite, async (t) => {
  const vault = tempRoot(t);
  const indexDir = tempRoot(t);
  const indexPath = path.join(indexDir, "index.sqlite");
  buildVault(vault);
  const provenance = { backend: "onnx", revision: "abc123", dtype: "int8" };
  const plan = await densePlan({ vaultRoot: vault, indexPath, provenance });
  assert.equal(plan.eligible, 33, "Membrane's ten are left out");
  assert.deepEqual(plan.provenance, { model: "BAAI/bge-m3", dimensions: 1024, ...provenance });
  const vectors = vectorsFor(plan);
  vectors[0] = { ...vectors[0], content_hash: "edited since the plan" };
  vectors[2] = { ...vectors[2], vector: [1, 2] };
  vectors.push({ id: "nobody", content_hash: "x", vector: vectors[1].vector });
  const embedded = await rebuildIndex({ vaultRoot: vault, indexPath, denseEmbeddings: true, suppliedVectors: vectors, denseBackend: "onnx", denseRevision: "abc123", denseDtype: "int8" });
  assert.deepEqual(
    [embedded.dense_documents, embedded.dense_encoded_documents, embedded.dense_pending_documents, embedded.dense_skipped_documents],
    [31, 31, 2, 10]
  );
  const replan = await densePlan({ vaultRoot: vault, indexPath, provenance });
  assert.equal(replan.reusable, 31);
  assert.deepEqual(replan.records.map((record) => record.id).sort(), [plan.records[0].id, plan.records[2].id].sort());

  const before = dump(indexPath).dense_vectors;
  // A note that has a vector: record 5 is one of the notes, which are collected before the skills.
  const withVector = /Path: (\S+)/.exec(plan.records[5].text)[1];
  write(vault, withVector, "# Rewritten\n\nSo its vector no longer fits.");
  const kept = await rebuildIndex({ vaultRoot: vault, indexPath, preserveDense: true, inPlace: true });
  assert.deepEqual([kept.dense_preserved, kept.dense_backend, kept.dense_documents, kept.dense_reused_documents], [true, "onnx", 30, 30]);
  const after = dump(indexPath).dense_vectors;
  assert.equal(after.length, 30);
  assert.ok(after.every((row) => before.includes(row)), "the kept vectors are byte for byte the stored ones");

  const dropped = await rebuildIndex({ vaultRoot: vault, indexPath, preserveDense: false });
  assert.deepEqual([dropped.dense_enabled, dropped.dense_documents], [false, 0]);
});

test("vectors stored a slice at a time are in the index at once, and a later rebuild keeps them", needsSqlite, async (t) => {
  const vault = tempRoot(t);
  const indexPath = path.join(tempRoot(t), "index.sqlite");
  buildVault(vault);
  await assert.rejects(storeDenseVectors({ indexPath, vectors: [] }), /has no documents yet/);
  // A 2.x index: everything embedded by the Python backend.
  await rebuildIndex({ vaultRoot: vault, indexPath });
  const legacy = { backend: "python", revision: "unpinned", dtype: "fp32" };
  const legacyPlan = await densePlan({ vaultRoot: vault, indexPath, provenance: legacy });
  await rebuildIndex({ vaultRoot: vault, indexPath, denseEmbeddings: true, suppliedVectors: vectorsFor(legacyPlan), denseBackend: "python", denseRevision: "unpinned", denseDtype: "fp32" });

  const provenance = { backend: "onnx", revision: "abc123", dtype: "int8" };
  const plan = await densePlan({ vaultRoot: vault, indexPath, provenance });
  assert.equal(plan.records.length, 33, "another model's vectors are all to be made again");
  const vectors = vectorsFor(plan);
  const first = await storeDenseVectors({
    indexPath,
    vectors: [...vectors.slice(0, 10), { id: "nobody", content_hash: "x", vector: vectors[0].vector }, { ...vectors[11], vector: [1, 2] }],
    provenance,
    eligible: plan.eligible
  });
  assert.deepEqual(first, { stored: 10, documents: 10, pending: 23 }, "an unknown document and a wrong width are skipped");
  const status = await indexStatus({ vaultRoot: vault, indexPath });
  assert.deepEqual([status.dense_backend, status.dense_documents, status.dense_pending_documents], ["onnx", 10, 23]);
  assert.equal((await densePlan({ vaultRoot: vault, indexPath, provenance })).records.length, 23, "the next run starts where this one stopped");

  // A cancelled run, then an ordinary refresh: the stored slice survives,
  // and the Python vectors that were never redone go.
  const kept = await rebuildIndex({ vaultRoot: vault, indexPath, preserveDense: true, inPlace: true });
  assert.deepEqual([kept.dense_backend, kept.dense_documents, kept.dense_pending_documents], ["onnx", 10, 23]);
  const rows = dump(indexPath).dense_vectors.map((row) => JSON.parse(row));
  assert.ok(rows.every((row) => row[4] === "onnx"), "one vector space in the index");

  await storeDenseVectors({ indexPath, vectors: vectors.slice(10), provenance, eligible: plan.eligible });
  const closing = await rebuildIndex({ vaultRoot: vault, indexPath, denseEmbeddings: true, suppliedVectors: [], denseIncremental: true, denseBackend: "onnx", denseRevision: "abc123", denseDtype: "int8" });
  assert.deepEqual([closing.dense_documents, closing.dense_reused_documents, closing.dense_pending_documents], [33, 33, 0]);
});

test("2.0.0's vectors whose passage has changed since are dropped, and the table gains this format's columns", needsSqlite, async (t) => {
  const vault = tempRoot(t);
  const indexPath = path.join(tempRoot(t), "index.sqlite");
  buildVault(vault, { notes: 2, skills: 2 });
  await rebuildIndex({ vaultRoot: vault, indexPath });
  const db = openDatabase(indexPath);
  db.exec(`DROP TABLE dense_vectors;
    CREATE TABLE dense_vectors(id TEXT PRIMARY KEY, vector BLOB NOT NULL, dimensions INTEGER NOT NULL, model TEXT NOT NULL, content_hash TEXT NOT NULL, mtime REAL NOT NULL);
    UPDATE meta SET value = 'true' WHERE key = 'dense_enabled';`);
  for (const { id } of db.prepare("SELECT id FROM documents").all()) {
    db.prepare("INSERT INTO dense_vectors VALUES (?, ?, 1024, 'BAAI/bge-m3', 'x', 0)").run(id, new Uint8Array(4096));
  }
  db.close();
  const summary = await rebuildIndex({ vaultRoot: vault, indexPath, preserveDense: true });
  assert.deepEqual([summary.dense_enabled, summary.dense_documents, summary.dense_pending_documents], [true, 0, 4]);
  const handle = openDatabase(indexPath);
  assert.ok(handle.prepare("PRAGMA table_info(dense_vectors)").all().some((column) => column.name === "backend"), "in this format now");
  handle.close();
});

test("two cards for one project no longer break the rebuild (\u0414-114)", needsSqlite, async (t) => {
  const vault = tempRoot(t);
  const project = fs.realpathSync(tempRoot(t, "search-project-"));
  write(project, "AGENTS.md", "# Agents");
  write(vault, "02-knowledge/Projects/one.md", `project_path: "${project}"\n`);
  write(vault, "02-knowledge/Projects/two.md", `- Root: \`${project}\`\n`);
  const indexPath = path.join(tempRoot(t), "index.sqlite");
  const summary = await rebuildIndex({ vaultRoot: vault, indexPath });
  assert.equal(summary.document_count, 3);
  assert.equal((await indexStatus({ vaultRoot: vault, indexPath })).stale, false);
});

test("a status cache gives the same answer as reading everything", needsSqlite, async (t) => {
  const vault = tempRoot(t);
  const indexPath = path.join(tempRoot(t), "index.sqlite");
  buildVault(vault);
  await rebuildIndex({ vaultRoot: vault, indexPath });
  const old = new Date(Date.now() - 3_600_000);
  for (const name of fs.readdirSync(path.join(vault, "02-knowledge"))) fs.utimesSync(path.join(vault, "02-knowledge", name), old, old);
  await rebuildIndex({ vaultRoot: vault, indexPath, inPlace: true });
  const cache = createDocumentCache();
  const reader = createIndexReader(indexPath);
  t.after(() => reader.close());
  const plain = await indexStatus({ vaultRoot: vault, indexPath });
  for (let round = 0; round < 2; round += 1) {
    const cached = await indexStatus({ vaultRoot: vault, indexPath, cache, reader });
    assert.deepEqual(cached, plain);
  }
});

test("text with NUL bytes is written whole and read whole", needsSqlite, async (t) => {
  const vault = tempRoot(t);
  const indexPath = path.join(tempRoot(t), "index.sqlite");
  write(vault, "notes/nul.md", "# Nul\nbefore\u0000after words");
  await rebuildIndex({ vaultRoot: vault, indexPath });
  const db = openDatabase(indexPath);
  try {
    // node:sqlite cuts TEXT at a NUL in Node 22.16 … 22.23, 24.0 … 24.15, 25.0, 25.9 and 26.0 (\u0414-113) and keeps it whole in 24.16 … 24.22 and 26.12, the x.y.0 releases measured (\u0414-471, \u0414-493, \u0414-512); the BLOB read is whole either way.
    assert.ok(["# Nul\nbefore", "# Nul\nbefore\u0000after words"].includes(db.prepare("SELECT body FROM docs_fts").get().body), "TEXT is cut at the NUL, or whole");
    assert.equal(wholeText(db.prepare("SELECT CAST(body AS BLOB) AS body FROM docs_fts").get().body), "# Nul\nbefore\u0000after words");
  } finally {
    db.close();
  }
});

test("errors are told apart: a lock to wait for, a file to replace", () => {
  assert.equal(isBusyError({ errcode: 5, message: "database is locked" }), true);
  assert.equal(isBusyError({ errcode: 262, message: "x" }), true, "extended codes keep their primary code");
  assert.equal(isBusyError({ errcode: 1, message: "no such table: x" }), false);
  assert.equal(isCorruptError({ errcode: 26, message: "file is not a database" }), true);
  assert.equal(isCorruptError({ errcode: 11, message: "database disk image is malformed" }), true);
  assert.equal(isCorruptError({ errcode: 5, message: "database is locked" }), false);
  assert.equal(wholeText(null), "");
  assert.equal(wholeText("plain"), "plain");
});

test("a changed document rewritten in place keeps its rowid, so ties come back in the same order", needsSqlite, async (t) => {
  const vault = tempRoot(t);
  const indexPath = path.join(tempRoot(t), "index.sqlite");
  for (let index = 1; index <= 5; index += 1) write(vault, `02-knowledge/tie${index}.md`, "# Tie\n\nThe same words in every note.");
  write(vault, "03-skills-catalog/registries/skills.index.json", "[]");
  await rebuildIndex({ vaultRoot: vault, indexPath });
  const rowids = () => {
    const db = openDatabase(indexPath);
    try {
      return db.prepare("SELECT d.rowid AS r, d.id AS id, f.rowid AS f FROM documents d JOIN docs_fts f ON f.id = d.id ORDER BY d.path").all()
        .map((row) => [row.r, row.f]);
    } finally {
      db.close();
    }
  };
  const before = rowids();
  write(vault, "02-knowledge/tie2.md", "# Tie\n\nThe same words in every note, and two more.");
  const updated = await rebuildIndex({ vaultRoot: vault, indexPath, inPlace: true });
  assert.equal(updated.write_mode, "in_place");
  assert.deepEqual(rowids(), before, "documents and their text stay at the rowids a full rebuild gave them");
});

test("a refresh that changes the newest note and adds one walked before it stays in place", needsSqlite, async (t) => {
  const vault = tempRoot(t);
  const indexPath = path.join(tempRoot(t), "index.sqlite");
  for (let index = 0; index < 20; index += 1) write(vault, `02-knowledge/n${String(index).padStart(2, "0")}.md`, `# Note ${index}\n\nbody ${index}`);
  write(vault, "03-skills-catalog/registries/skills.index.json", "[]");
  await rebuildIndex({ vaultRoot: vault, indexPath });
  // Added by an in-place refresh, so it holds the highest rowid.
  write(vault, "02-knowledge/session.md", "# Session\n\nfirst draft");
  assert.equal((await rebuildIndex({ vaultRoot: vault, indexPath, inPlace: true })).write_mode, "in_place");
  write(vault, "02-knowledge/session.md", "# Session\n\nsecond draft");
  write(vault, "02-knowledge/a-new.md", "# New\n\nanother note");
  const updated = await rebuildIndex({ vaultRoot: vault, indexPath, inPlace: true });
  assert.deepEqual([updated.write_mode, updated.rewritten_documents], ["in_place", 3]);
  const db = openDatabase(indexPath);
  try {
    const rows = db.prepare("SELECT d.rowid AS r, f.rowid AS f, d.path AS path FROM documents d JOIN docs_fts f ON f.id = d.id").all();
    assert.equal(rows.length, 22);
    assert.ok(rows.every((row) => row.r === row.f), "every document's text sits at its rowid");
    const session = rows.find((row) => row.path === "02-knowledge/session.md");
    const added = rows.find((row) => row.path === "02-knowledge/a-new.md");
    assert.equal(session.r, 21, "the changed note kept its rowid");
    assert.equal(added.r, 22, "the new one was appended after it");
  } finally {
    db.close();
  }
  assert.deepEqual(dump(indexPath), await (async () => {
    const fresh = path.join(tempRoot(t), "fresh.sqlite");
    await rebuildIndex({ vaultRoot: vault, indexPath: fresh });
    return dump(fresh);
  })(), "and it holds exactly what a full rebuild writes");
});

test("a rebuild waits for another writer without stopping the event loop", needsSqlite, async (t) => {
  const vault = tempRoot(t);
  const indexPath = path.join(tempRoot(t), "index.sqlite");
  buildVault(vault, { notes: 3, skills: 3 });
  await rebuildIndex({ vaultRoot: vault, indexPath });
  // Another process's writer, as the Python helper is: it holds the write lock.
  const other = openDatabase(indexPath);
  other.exec("BEGIN IMMEDIATE");
  let ticks = 0;
  const ticker = setInterval(() => { ticks += 1; }, 10);
  setTimeout(() => other.exec("COMMIT"), 400);
  const started = Date.now();
  const summary = await rebuildIndex({ vaultRoot: vault, indexPath, inPlace: true });
  clearInterval(ticker);
  other.close();
  assert.ok(Date.now() - started >= 350, "it did wait for the other writer");
  assert.ok(ticks >= 15, `the loop kept turning while it waited (${ticks} ticks)`);
  assert.equal(summary.document_count, 7);
});

test("a full rewrite does not wait for a reader holding an old snapshot", needsSqlite, async (t) => {
  const vault = tempRoot(t);
  const indexPath = path.join(tempRoot(t), "index.sqlite");
  buildVault(vault, { notes: 20, skills: 20 });
  await rebuildIndex({ vaultRoot: vault, indexPath });
  // A hybrid search or galaxy export in another client, mid-read.
  const reader = openDatabase(indexPath);
  reader.exec("BEGIN");
  reader.prepare("SELECT count(*) AS n FROM documents").get();
  buildVault(vault, { notes: 20, skills: 200 });
  const started = Date.now();
  const summary = await rebuildIndex({ vaultRoot: vault, indexPath });
  const took = Date.now() - started;
  reader.exec("COMMIT");
  reader.close();
  assert.equal(summary.write_mode, "full");
  assert.ok(took < 5_000, `the checkpoint gave way to the reader instead of waiting out busy_timeout (${took} ms)`);
});

test("a damaged index another process holds open is set aside once it lets go, and reported if it never does", async () => {
  const calls = [];
  const fake = (busyRenames) => ({
    existsSync: () => true,
    rmSync: (target) => calls.push(["rm", path.basename(target)]),
    renameSync: () => {
      calls.push(["rename"]);
      if (busyRenames-- > 0) throw Object.assign(new Error("resource busy or locked"), { code: "EBUSY" });
    }
  });
  await setAside("/x/index.sqlite", { fsImpl: fake(2), delays: [1, 1, 1] });
  assert.equal(calls.filter(([name]) => name === "rename").length, 3, "two refusals, then the rename");
  calls.length = 0;
  await assert.rejects(
    setAside("/x/index.sqlite", { fsImpl: fake(99), delays: [1, 1] }),
    /damaged and another process still has it open \(EBUSY\)/
  );
  assert.equal(calls.filter(([name]) => name === "rename").length, 3);
  await assert.rejects(setAside("/x/index.sqlite", {
    fsImpl: { existsSync: () => true, rmSync: () => {}, renameSync: () => { throw Object.assign(new Error("no space"), { code: "ENOSPC" }); } },
    delays: [1]
  }), /no space/, "anything but a file in use is not waited for");
});

test("a reader lets go of the file when idle, and at once when the file is damaged", needsSqlite, async (t) => {
  const vault = tempRoot(t);
  const indexPath = path.join(tempRoot(t), "index.sqlite");
  buildVault(vault, { notes: 2, skills: 2 });
  await rebuildIndex({ vaultRoot: vault, indexPath });
  const reader = createIndexReader(indexPath, { idleMs: 50 });
  t.after(() => reader.close());
  assert.equal(await reader.read((db) => db.prepare("SELECT count(*) AS n FROM documents").get().n), 5);
  assert.equal(reader.isOpen(), true);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(reader.isOpen(), false, "closed after the idle time");
  assert.equal(await reader.read((db) => db.prepare("SELECT count(*) AS n FROM documents").get().n), 5, "and opened again on the next read");
  await new Promise((resolve) => setTimeout(resolve, 120));

  // A read that fails with an ordinary SQL error lets go of the file too.
  await assert.rejects(reader.read((db) => db.prepare("SELECT no_such_column FROM documents").all()), /no such column/);
  assert.equal(reader.isOpen(), true);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(reader.isOpen(), false, "closed after the idle time, after a failed read as well");

  const damaged = path.join(tempRoot(t), "damaged.sqlite");
  fs.writeFileSync(damaged, Buffer.alloc(4096, 9));
  const broken = createIndexReader(damaged, { idleMs: 60_000 });
  await assert.rejects(broken.read((db) => db.prepare("SELECT 1 FROM sqlite_master").get()), (error) => isCorruptError(error));
  assert.equal(broken.isOpen(), false, "a damaged file is not held open for someone else to fail to replace");
});

