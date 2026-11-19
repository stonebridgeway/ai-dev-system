/**
 * The search index file: its schema, whether it is current, and writing it.
 *
 * A port of `status`, `rebuild` and `dense-plan` from
 * `search-index/search_cli.py` onto `node:sqlite` that keeps the file what it
 * was — the same tables, columns, meta keys and rows — because the Python
 * hybrid search still reads it and every 2.x install already has one.
 * `search-documents.mjs` and `search-semantic.mjs` make the rows equal; this
 * module makes the file equal. What it adds:
 *
 * - writing in place: a refresh after a few notes changed rewrites those
 *   documents, not all of them (a rebuild asked for by name, a schema change
 *   or a vault that mostly changed still rewrite everything);
 * - dense vectors are reconciled where they are — kept while their passage and
 *   provenance still match, dropped otherwise — rather than read out and
 *   written back, so a rebuild never holds every stored vector in memory;
 * - WAL, so a rebuild in one process never blocks a search in another;
 * - a cross-process rebuild lock honouring `AI_DEV_SEARCH_REBUILD_LOCK_TIMEOUT`
 *   (seconds, 600 by default) like the helper's — a lock file in this
 *   package's protocol (`file-lock.mjs`), since Node has no `flock`;
 * - a file that is no longer a database is set aside and built again instead
 *   of failing every search.
 *
 * The lock, the write transaction's start and the checkpoint live in
 * `search-writer.mjs`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pythonRound } from "./python-compat.mjs";
import {
  collectDocuments,
  collectDocumentsYielding,
  DEFAULT_DENSE_TEXT_LIMIT,
  denseDocRecords,
  pythonPath,
  sourceFingerprint
} from "./search-documents.mjs";
import { buildSemanticVector, SEMANTIC_DIMENSIONS, semanticVectorJson } from "./search-semantic.mjs";
import { createIndexReader, isCorruptError, openDatabase, tableColumns, tableExists, wholeText } from "./search-sqlite.mjs";
import { beginImmediate, checkpoint, setAside, withRebuildLock } from "./search-writer.mjs";
import { canonicalFolder } from "./session-env.mjs";

/** `meta.schema_version` of the format this module reads and writes. */
export const INDEX_SCHEMA_VERSION = 2;
export const DENSE_MODEL_NAME = "BAAI/bge-m3";
export const DENSE_DIMENSIONS = 1024;
export const LEGACY_DENSE_BACKEND = "python";
export const LEGACY_DENSE_DTYPE = "fp32";
export const UNPINNED_REVISION = "unpinned";

/** Above this share of documents changed, rewriting everything is as cheap. */
const IN_PLACE_LIMIT = 0.5;

/** Documents written between two turns of the event loop. */
const YIELD_EVERY = 64;

const DENSE_COLUMNS = ["id", "vector", "dimensions", "model", "backend", "revision", "dtype", "content_hash", "mtime"];
// 2.0.0's `dense_vectors`, from before a vector recorded its provenance: every one is the Python backend's, the only one
// 2.x had then.
const UNRECORDED_COLUMNS = ["id", "vector", "dimensions", "model", "content_hash", "mtime"];
const unrecorded = (columns) => columns.size === UNRECORDED_COLUMNS.length && UNRECORDED_COLUMNS.every((column) => columns.has(column));

const CREATE_DOCUMENT_TABLES = `
  CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE documents(
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    title TEXT NOT NULL,
    path TEXT NOT NULL,
    source TEXT NOT NULL,
    categories TEXT NOT NULL,
    preview TEXT NOT NULL,
    mtime REAL NOT NULL,
    content_hash TEXT NOT NULL
  );
  CREATE VIRTUAL TABLE docs_fts USING fts5(
    id UNINDEXED,
    title,
    body,
    path,
    source,
    categories,
    tokenize='unicode61'
  );
  CREATE TABLE semantic_vectors(
    id TEXT PRIMARY KEY,
    vector TEXT NOT NULL,
    norm REAL NOT NULL
  );
`;

const CREATE_DENSE_TABLE = `
  CREATE TABLE dense_vectors(
    id TEXT PRIMARY KEY,
    vector BLOB NOT NULL,
    dimensions INTEGER NOT NULL,
    model TEXT NOT NULL,
    backend TEXT NOT NULL,
    revision TEXT NOT NULL,
    dtype TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    mtime REAL NOT NULL
  );
  CREATE INDEX dense_vectors_hash_idx ON dense_vectors(content_hash);
`;

const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve));

/** `int(value or 0)` for a meta value; a value Python could not read counts as `fallback`. */
function metaInt(value, fallback = 0) {
  const text = String(value ?? "").trim();
  return /^[-+]?\d+$/.test(text) ? Number(text) : fallback;
}

const isTrue = (value) => String(value ?? "false").toLowerCase() === "true";

/** Every meta row, as strings. */
function readMeta(db) {
  if (!tableExists(db, "meta")) return {};
  return Object.fromEntries(db.prepare("SELECT key, value FROM meta").all().map((row) => [String(row.key), String(row.value)]));
}

/** What the index file holds, for a status check. */
function readIndexState(db) {
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')").all().map((row) => row.name));
  if (!tables.has("documents")) return { hasDocuments: false };
  const schemaCurrent = tableColumns(db, "documents").has("content_hash");
  const rows = db.prepare(`SELECT id, CAST(path AS BLOB) AS path, ${schemaCurrent ? "content_hash" : "'' AS content_hash"} FROM documents`).all();
  return { hasDocuments: true, schemaCurrent, rows, meta: tables.has("meta") ? readMeta(db) : {}, denseModels: readDenseModels(db) };
}

/**
 * How many stored vectors each model made: a 2.x index can hold another
 * model's, which hybrid search does not compare.
 */
function readDenseModels(db) {
  if (!tableExists(db, "dense_vectors")) return [];
  const columns = tableColumns(db, "dense_vectors");
  if (unrecorded(columns)) {
    const documents = Number(db.prepare("SELECT count(*) AS n FROM dense_vectors").get().n);
    return documents ? [{ backend: LEGACY_DENSE_BACKEND, revision: UNPINNED_REVISION, dtype: LEGACY_DENSE_DTYPE, documents }] : [];
  }
  if (!DENSE_COLUMNS.every((column) => columns.has(column))) return [];
  return db.prepare("SELECT backend, revision, dtype, count(*) AS documents FROM dense_vectors GROUP BY backend, revision, dtype").all()
    .map((row) => ({ backend: String(row.backend), revision: String(row.revision), dtype: String(row.dtype), documents: Number(row.documents) }));
}

/**
 * Whether the index reflects the vault, and if not why — the helper's
 * `status`, key for key.
 *
 * @param {object} options
 * @param {string} options.vaultRoot
 * @param {string} options.indexPath
 * @param {boolean} [options.includeExternalProjectFiles]
 * @param {object} [options.cache] - From `createDocumentCache()`; the status is the same without it.
 * @param {ReturnType<typeof createIndexReader>} [options.reader] - A long-lived connection to reuse.
 * @returns {Promise<object>}
 */
export async function indexStatus({ vaultRoot, indexPath, includeExternalProjectFiles = true, cache = null, reader = null }) {
  const { docs } = collectDocuments({ vaultRoot, includeExternalProjectFiles, cache });
  const current = new Map(docs.map((doc) => [doc.id, doc]));
  const fingerprint = sourceFingerprint(docs);
  const unbuilt = (reasons, indexExists, extra = {}) => ({
    index_path: indexPath,
    index_exists: indexExists,
    stale: true,
    schema_current: false,
    reasons,
    built_at: "",
    indexed_document_count: 0,
    current_document_count: docs.length,
    added_count: docs.length,
    changed_count: 0,
    deleted_count: 0,
    added: docs.slice(0, 20).map((doc) => doc.path),
    changed: [],
    deleted: [],
    source_fingerprint: fingerprint,
    indexed_fingerprint: "",
    vault_root: "",
    dense_enabled: false,
    dense_documents: 0,
    dense_pending_documents: 0,
    ...extra
  });
  if (!fs.existsSync(indexPath)) return unbuilt(["index_missing"], false);

  const connection = reader ?? createIndexReader(indexPath);
  let state;
  try {
    state = await connection.read(readIndexState);
  } catch (error) {
    if (!isCorruptError(error)) throw error;
    return unbuilt(["index_unreadable"], true, { error: String(error.message) });
  } finally {
    if (!reader) connection.close();
  }
  if (state === null) return unbuilt(["index_missing"], false);
  if (!state.hasDocuments) return unbuilt(["documents_table_missing"], true);

  const { schemaCurrent, meta } = state;
  const indexed = new Map(state.rows.map((row) => [String(row.id), row]));
  const addedIds = [...current.keys()].filter((id) => !indexed.has(id)).sort();
  const deletedIds = [...indexed.keys()].filter((id) => !current.has(id)).sort();
  const changedIds = [...current.keys()]
    .filter((id) => indexed.has(id) && (!schemaCurrent || String(indexed.get(id).content_hash || "") !== current.get(id).content_hash))
    .sort();
  const reasons = [];
  if (!schemaCurrent) reasons.push("schema_outdated");
  if (addedIds.length) reasons.push("sources_added");
  if (changedIds.length) reasons.push("sources_changed");
  if (deletedIds.length) reasons.push("sources_deleted");
  // Built from another vault: a file two vaults shared before 3.0, or one
  // copied from elsewhere.
  const builtFrom = meta.vault_root ?? "";
  if (builtFrom && canonicalFolder(builtFrom) !== canonicalFolder(vaultRoot)) reasons.push("vault_changed");
  const indexedFingerprint = meta.source_fingerprint ?? "";
  if (schemaCurrent && !reasons.length && indexedFingerprint && indexedFingerprint !== fingerprint) {
    reasons.push("source_fingerprint_mismatch");
  }
  return {
    index_path: indexPath,
    index_exists: true,
    stale: reasons.length > 0,
    schema_current: schemaCurrent,
    schema_version: metaInt(meta.schema_version),
    reasons,
    built_at: meta.built_at ?? "",
    indexed_document_count: indexed.size,
    current_document_count: docs.length,
    added_count: addedIds.length,
    changed_count: changedIds.length,
    deleted_count: deletedIds.length,
    added: addedIds.slice(0, 20).map((id) => current.get(id).path),
    changed: changedIds.slice(0, 20).map((id) => current.get(id).path),
    deleted: deletedIds.slice(0, 20).map((id) => wholeText(indexed.get(id).path)),
    source_fingerprint: fingerprint,
    indexed_fingerprint: indexedFingerprint,
    vault_root: builtFrom,
    dense_enabled: isTrue(meta.dense_enabled),
    // An index written before 3.0 without vectors still names a backend for them.
    dense_backend: isTrue(meta.dense_enabled) ? meta.dense_backend ?? "" : "",
    dense_revision: isTrue(meta.dense_enabled) ? meta.dense_revision ?? "" : "",
    dense_dtype: isTrue(meta.dense_enabled) ? meta.dense_dtype ?? "" : "",
    dense_documents: metaInt(meta.dense_documents),
    dense_pending_documents: metaInt(meta.dense_pending_documents),
    dense_eligible_documents: metaInt(meta.dense_eligible_documents),
    dense_models: state.denseModels ?? []
  };
}

/** The provenance a run's vectors are written with, defaults filled as the helper fills them. */
function fullProvenance({ backend, revision, dtype }) {
  return {
    model: DENSE_MODEL_NAME,
    dimensions: DENSE_DIMENSIONS,
    backend: backend || LEGACY_DENSE_BACKEND,
    revision: revision || UNPINNED_REVISION,
    dtype: dtype || LEGACY_DENSE_DTYPE
  };
}

/** Whether a stored vector may stand for this passage, unchanged. */
function denseCacheHit(row, record, provenance) {
  if (!row || row.content_hash !== record.content_hash || row.model !== provenance.model) return false;
  if (Number(row.dimensions || 0) !== provenance.dimensions) return false;
  return ["backend", "revision", "dtype"].every((column) => row[column] === provenance[column]);
}

/** The stored vectors' provenance and passage hashes, without the vectors; empty when unusable. */
function readDenseRows(db) {
  if (!tableExists(db, "dense_vectors")) return new Map();
  const columns = tableColumns(db, "dense_vectors");
  if (!DENSE_COLUMNS.every((column) => columns.has(column))) return new Map();
  const rows = db.prepare("SELECT id, dimensions, model, backend, revision, dtype, content_hash, mtime FROM dense_vectors").all();
  return new Map(rows.map((row) => [String(row.id), row]));
}

/** `str(Path(value).expanduser())`. */
function expandedPath(value) {
  const text = String(value ?? "");
  const expanded = text === "~" || text.startsWith("~/") || text.startsWith("~\\") ? os.homedir() + text.slice(1) : text;
  return pythonPath(expanded).text;
}

/** Plain JSON-compatible numbers from a vector, as float32 bytes. */
function vectorBlob(values) {
  const floats = Float32Array.from(values, Number);
  return new Uint8Array(floats.buffer, floats.byteOffset, floats.byteLength);
}

/**
 * The settings of a rebuild, filled from the previous index where the helper
 * did: a refresh that keeps vectors also keeps how they were made.
 */
function denseSettings(options, previousMeta) {
  const preserve = Boolean(options.preserveDense && isTrue(previousMeta.dense_enabled));
  const settings = {
    embeddings: Boolean(options.denseEmbeddings),
    preserve,
    textLimit: options.denseTextLimit ?? DEFAULT_DENSE_TEXT_LIMIT,
    includeMembrane: Boolean(options.denseIncludeMembrane),
    incremental: options.denseIncremental !== false,
    backend: options.denseBackend ?? LEGACY_DENSE_BACKEND,
    revision: options.denseRevision ?? "",
    dtype: options.denseDtype ?? ""
  };
  if (preserve && !settings.embeddings) {
    settings.textLimit = metaInt(previousMeta.dense_text_limit, settings.textLimit) || settings.textLimit;
    settings.includeMembrane = isTrue(previousMeta.dense_include_membrane);
    settings.backend = previousMeta.dense_backend || LEGACY_DENSE_BACKEND;
    settings.revision = previousMeta.dense_revision || UNPINNED_REVISION;
    settings.dtype = previousMeta.dense_dtype || LEGACY_DENSE_DTYPE;
  }
  settings.active = settings.embeddings || preserve;
  settings.provenance = fullProvenance(settings);
  return settings;
}

/** `dense_vectors` with the columns this format needs: 2.0.0's gains them, recorded as what its vectors are; any other is recreated empty. */
function ensureDenseTable(db) {
  if (tableExists(db, "dense_vectors")) {
    const columns = tableColumns(db, "dense_vectors");
    if (columns.size === DENSE_COLUMNS.length && DENSE_COLUMNS.every((column) => columns.has(column))) return;
    if (unrecorded(columns)) {
      for (const [column, value] of [["backend", LEGACY_DENSE_BACKEND], ["revision", UNPINNED_REVISION], ["dtype", LEGACY_DENSE_DTYPE]]) {
        db.exec(`ALTER TABLE dense_vectors ADD COLUMN ${column} TEXT NOT NULL DEFAULT '${value}'`);
      }
      return;
    }
    db.exec("DROP TABLE dense_vectors");
  }
  db.exec(CREATE_DENSE_TABLE);
}

/**
 * Leave in `dense_vectors` exactly the rows the helper's rebuild would have
 * written: stored vectors still valid for their passage and provenance, plus
 * supplied vectors for passages they were embedded from.
 */
function reconcileDenseVectors(db, docs, settings, supplied) {
  ensureDenseTable(db);
  if (!settings.active) {
    db.exec("DELETE FROM dense_vectors");
    return { eligible: 0, reused: 0, encoded: 0, pending: 0, documents: 0 };
  }
  const records = denseDocRecords(docs, { textLimit: settings.textLimit, includeMembrane: settings.includeMembrane });
  const reuse = !settings.embeddings || settings.incremental;
  const stored = reuse ? readDenseRows(db) : new Map();
  if (!reuse) db.exec("DELETE FROM dense_vectors");
  const touch = db.prepare("UPDATE dense_vectors SET mtime = ? WHERE id = ?");
  const replace = db.prepare(`INSERT OR REPLACE INTO dense_vectors(${DENSE_COLUMNS.join(", ")}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const remove = db.prepare("DELETE FROM dense_vectors WHERE id = ?");
  const { provenance } = settings;
  const kept = new Set();
  let reused = 0;
  let encoded = 0;
  for (const record of records) {
    const row = stored.get(record.id);
    if (denseCacheHit(row, record, provenance)) {
      if (row.mtime !== record.mtime) touch.run(record.mtime, record.id);
      kept.add(record.id);
      reused += 1;
      continue;
    }
    const offered = settings.embeddings ? supplied?.get(record.id) : undefined;
    if (offered && offered.content_hash === record.content_hash) {
      replace.run(record.id, offered.blob, DENSE_DIMENSIONS, DENSE_MODEL_NAME, provenance.backend, provenance.revision,
        provenance.dtype, record.content_hash, record.mtime);
      kept.add(record.id);
      encoded += 1;
    }
  }
  for (const id of stored.keys()) if (!kept.has(id)) remove.run(id);
  return { eligible: records.length, reused, encoded, pending: records.length - reused - encoded, documents: kept.size };
}

/**
 * Insert one document's rows: `documents`, `docs_fts` at the same rowid,
 * `semantic_vectors`. Given a rowid, the document goes back where it was:
 * results that tie on score come back in rowid order, and a document rewritten
 * in place keeps the place a full rebuild gives it.
 */
function documentWriter(db) {
  const insertDocument = db.prepare(
    "INSERT INTO documents(id, scope, title, path, source, categories, preview, mtime, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  const insertDocumentAt = db.prepare(
    "INSERT INTO documents(rowid, id, scope, title, path, source, categories, preview, mtime, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  const insertText = db.prepare("INSERT INTO docs_fts(rowid, id, title, body, path, source, categories) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const insertVector = db.prepare("INSERT INTO semantic_vectors(id, vector, norm) VALUES (?, ?, ?)");
  return (doc, rowid = null) => {
    const fields = [doc.id, doc.scope, doc.title, doc.path, doc.source, doc.categories, doc.preview, doc.mtime, doc.content_hash];
    const { lastInsertRowid } = rowid === null ? insertDocument.run(...fields) : insertDocumentAt.run(rowid, ...fields);
    insertText.run(lastInsertRowid, doc.id, doc.title, doc.body, doc.path, doc.source, doc.categories);
    const { entries, norm } = buildSemanticVector(doc);
    insertVector.run(doc.id, semanticVectorJson(entries), norm);
  };
}

/**
 * Between two slices of a write: let the event loop turn, say how far the write
 * is, and stop if the caller cancelled — the transaction around the write is
 * rolled back, so a cancelled rebuild leaves the index as it was.
 */
async function between(done, total, { signal, onProgress } = {}) {
  await yieldToEventLoop();
  if (signal?.aborted) throw cancelled();
  onProgress?.({ phase: "indexing", done, total });
}

/** The error a cancelled write ends with. */
function cancelled() {
  return Object.assign(new Error("The rebuild was cancelled; the index is as it was before it."), { name: "AbortError", cancelled: true });
}

/** Rewrite every document: the helper's rebuild. */
async function writeAllDocuments(db, docs, watch) {
  db.exec(`
    DROP TABLE IF EXISTS documents;
    DROP TABLE IF EXISTS docs_fts;
    DROP TABLE IF EXISTS semantic_vectors;
    DROP TABLE IF EXISTS meta;
    ${CREATE_DOCUMENT_TABLES}
  `);
  const write = documentWriter(db);
  for (let index = 0; index < docs.length; index += 1) {
    write(docs[index]);
    if (index % YIELD_EVERY === YIELD_EVERY - 1) await between(index + 1, docs.length, watch);
  }
  return docs.length;
}

/** Whether the file is this format, complete, so documents can be rewritten one by one. */
function updatableInPlace(db, previousMeta) {
  if (String(previousMeta.schema_version) !== String(INDEX_SCHEMA_VERSION)) return false;
  if (!["documents", "docs_fts", "semantic_vectors", "meta"].every((name) => tableExists(db, name))) return false;
  return tableColumns(db, "documents").has("content_hash");
}

/**
 * Rewrite only the documents that were added, changed or deleted since the
 * index was built, or return -1 to have everything rewritten instead: when
 * most of the vault changed, or when `docs_fts` is not row for row beside
 * `documents` (an index this module did not write, or a damaged one).
 */
async function writeChangedDocuments(db, docs, previousMeta, watch) {
  if (!updatableInPlace(db, previousMeta)) return -1;
  const indexed = new Map(db.prepare("SELECT rowid, id, content_hash, mtime FROM documents").all().map((row) => [String(row.id), row]));
  const current = new Map(docs.map((doc) => [doc.id, doc]));
  const removed = [...indexed.keys()].filter((id) => !current.has(id) || indexed.get(id).content_hash !== current.get(id).content_hash);
  const written = docs.filter((doc) => !indexed.has(doc.id) || indexed.get(doc.id).content_hash !== doc.content_hash);
  if (removed.length + written.length > IN_PLACE_LIMIT * Math.max(docs.length, 1)) return -1;
  const textAt = db.prepare("SELECT id FROM docs_fts WHERE rowid = ?");
  if (removed.some((id) => textAt.get(indexed.get(id).rowid)?.id !== id)) return -1;

  const deleteText = db.prepare("DELETE FROM docs_fts WHERE rowid = ?");
  const deleteDocument = db.prepare("DELETE FROM documents WHERE id = ?");
  const deleteVector = db.prepare("DELETE FROM semantic_vectors WHERE id = ?");
  for (const id of removed) {
    deleteText.run(indexed.get(id).rowid);
    deleteDocument.run(id);
    deleteVector.run(id);
  }
  const write = documentWriter(db);
  // A changed document goes back to its own rowid; only a new one is appended.
  // The changed ones go first: appended before them, a new document could take
  // the rowid one of them is coming back to.
  const ordered = [
    ...written.filter((doc) => indexed.has(doc.id)),
    ...written.filter((doc) => !indexed.has(doc.id))
  ];
  for (let index = 0; index < ordered.length; index += 1) {
    write(ordered[index], indexed.get(ordered[index].id)?.rowid ?? null);
    if (index % YIELD_EVERY === YIELD_EVERY - 1) await between(index + 1, ordered.length, watch);
  }
  const touch = db.prepare("UPDATE documents SET mtime = ? WHERE id = ?");
  for (const doc of docs) {
    const row = indexed.get(doc.id);
    if (row && row.content_hash === doc.content_hash && row.mtime !== doc.mtime) touch.run(doc.mtime, doc.id);
  }
  db.exec("DELETE FROM meta");
  return removed.length + written.length;
}

/** Write `meta`, key for key and in the helper's order. */
function writeMeta(db, values) {
  const insert = db.prepare("INSERT INTO meta(key, value) VALUES (?, ?)");
  for (const [key, value] of Object.entries(values)) insert.run(key, String(value));
}

/** A writer connection in WAL mode, the file set aside first if it is not a database. */
async function openWriter(indexPath) {
  let db = openDatabase(indexPath);
  try {
    db.prepare("SELECT count(*) AS n FROM sqlite_master").get();
  } catch (error) {
    db.close();
    if (!isCorruptError(error)) throw error;
    await setAside(indexPath);
    db = openDatabase(indexPath);
  }
  const mode = String(db.prepare("PRAGMA journal_mode = WAL").get()?.journal_mode ?? "").toLowerCase();
  if (mode === "wal") db.exec("PRAGMA synchronous = NORMAL");
  // Without WAL a spilled write transaction locks readers out; this
  // process's own searches would wait on a writer that waits on them.
  else db.exec("PRAGMA cache_spill = OFF");
  return db;
}

/**
 * The write itself, inside one transaction: readers see the old index until
 * it commits and the whole new one after.
 */
async function writeIndex(db, docs, options) {
  const watch = { signal: options.signal, onProgress: typeof options.onProgress === "function" ? options.onProgress : null };
  await beginImmediate(db);
  try {
    const previousMeta = readMeta(db);
    const settings = denseSettings(options, previousMeta);
    let rewritten = -1;
    if (options.inPlace) {
      // Anything unexpected while rewriting in place — a row already at the
      // rowid a new one needs, say — undoes just that and rewrites everything.
      db.exec("SAVEPOINT in_place");
      try {
        rewritten = await writeChangedDocuments(db, docs, previousMeta, watch);
        db.exec("RELEASE in_place");
      } catch (error) {
        db.exec("ROLLBACK TO in_place");
        db.exec("RELEASE in_place");
        if (isCorruptError(error) || error?.cancelled) throw error;
        rewritten = -1;
      }
    }
    const mode = rewritten < 0 ? "full" : "in_place";
    if (rewritten < 0) rewritten = await writeAllDocuments(db, docs, watch);

    const denseStarted = performance.now();
    const supplied = new Map();
    for (const entry of options.suppliedVectors ?? []) {
      if (Array.isArray(entry?.vector) && entry.vector.length === DENSE_DIMENSIONS) {
        supplied.set(entry.id, { content_hash: entry.content_hash ?? "", blob: vectorBlob(entry.vector) });
      }
    }
    const dense = reconcileDenseVectors(db, docs, settings, supplied);
    const denseSeconds = settings.active ? pythonRound((performance.now() - denseStarted) / 1000, 3) : 0;

    const semanticDocuments = db.prepare("SELECT count(*) AS n FROM semantic_vectors WHERE vector != '{}'").get().n;
    const fingerprint = sourceFingerprint(docs);
    const eligible = settings.active ? dense.eligible : 0;
    const pending = Math.max(0, dense.pending);
    const { provenance } = settings;
    writeMeta(db, {
      schema_version: INDEX_SCHEMA_VERSION,
      built_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      source_fingerprint: fingerprint,
      vault_root: path.resolve(options.vaultRoot),
      document_count: docs.length,
      semantic_dimensions: SEMANTIC_DIMENSIONS,
      semantic_documents: semanticDocuments,
      dense_enabled: settings.active ? "true" : "false",
      dense_model: DENSE_MODEL_NAME,
      dense_model_dir: expandedPath(options.denseModelDir ?? ""),
      dense_dimensions: DENSE_DIMENSIONS,
      // How the vectors were made, and nothing when there are none: until 3.0
      // an index without vectors said they came from Python.
      dense_backend: settings.active ? provenance.backend : "",
      dense_revision: settings.active ? provenance.revision : "",
      dense_dtype: settings.active ? provenance.dtype : "",
      dense_documents: dense.documents,
      dense_reused_documents: dense.reused,
      dense_encoded_documents: dense.encoded,
      dense_eligible_documents: eligible,
      dense_pending_documents: pending,
      dense_skipped_documents: Math.max(0, docs.length - eligible),
      dense_include_membrane: settings.includeMembrane ? "true" : "false",
      dense_incremental: settings.incremental ? "true" : "false",
      dense_text_limit: settings.textLimit
    });
    if (watch.signal?.aborted) throw cancelled();
    db.exec("COMMIT");

    const byScope = {};
    for (const doc of docs) byScope[doc.scope] = (byScope[doc.scope] ?? 0) + 1;
    return {
      index_path: options.indexPath,
      document_count: docs.length,
      semantic_documents: semanticDocuments,
      semantic_dimensions: SEMANTIC_DIMENSIONS,
      schema_version: INDEX_SCHEMA_VERSION,
      source_fingerprint: fingerprint,
      dense_enabled: settings.active,
      dense_documents: dense.documents,
      dense_reused_documents: dense.reused,
      dense_encoded_documents: dense.encoded,
      dense_eligible_documents: eligible,
      dense_pending_documents: pending,
      dense_skipped_documents: settings.active ? Math.max(0, docs.length - eligible) : docs.length,
      dense_preserved: settings.preserve && !settings.embeddings,
      dense_include_membrane: settings.includeMembrane,
      dense_incremental: settings.incremental,
      dense_dimensions: settings.active ? DENSE_DIMENSIONS : 0,
      dense_seconds: denseSeconds,
      dense_model: settings.active ? DENSE_MODEL_NAME : "",
      dense_backend: settings.active ? provenance.backend : "",
      dense_revision: settings.active ? provenance.revision : "",
      dense_dtype: settings.active ? provenance.dtype : "",
      by_scope: byScope,
      write_mode: mode,
      rewritten_documents: rewritten
    };
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // The transaction is already gone.
    }
    throw error;
  }
}

/**
 * Build the index from the vault — the helper's `rebuild`, plus writing in
 * place when asked to.
 *
 * @param {object} options
 * @param {string} options.vaultRoot
 * @param {string} options.indexPath
 * @param {boolean} [options.includeExternalProjectFiles]
 * @param {boolean} [options.inPlace] - Rewrite only what changed when the file allows it.
 * @param {boolean} [options.preserveDense] - Keep stored vectors that still fit.
 * @param {boolean} [options.denseEmbeddings] - Store `suppliedVectors` (embedded elsewhere).
 * @param {Array<{ id: string, content_hash: string, vector: number[] }>} [options.suppliedVectors]
 * @param {string} [options.denseModelDir] - Recorded in `meta`.
 * @param {number} [options.denseTextLimit]
 * @param {boolean} [options.denseIncludeMembrane]
 * @param {boolean} [options.denseIncremental] - Reuse stored vectors when embedding.
 * @param {string} [options.denseBackend]
 * @param {string} [options.denseRevision]
 * @param {string} [options.denseDtype]
 * @param {NodeJS.ProcessEnv} [options.env] - For the lock timeout.
 * @param {AbortSignal} [options.signal] - Stops the write between slices; nothing of it is kept.
 * @param {(event: { phase: "indexing", done: number, total: number }) => void} [options.onProgress]
 * @returns {Promise<object>} The helper's summary, plus `write_mode` and `rewritten_documents`.
 */
export async function rebuildIndex(options) {
  return withRebuildLock(options.indexPath, async () => {
    if (options.signal?.aborted) throw cancelled();
    const { docs } = await collectDocumentsYielding({
      vaultRoot: options.vaultRoot,
      includeExternalProjectFiles: options.includeExternalProjectFiles !== false
    });
    let db = await openWriter(options.indexPath);
    try {
      let summary;
      try {
        summary = await writeIndex(db, docs, options);
      } catch (error) {
        if (!isCorruptError(error)) throw error;
        // Damage the first read did not reach (a malformed page under a
        // table) surfaces here; the file is a cache, so it is replaced.
        db.close();
        db = null;
        await setAside(options.indexPath);
        db = await openWriter(options.indexPath);
        summary = await writeIndex(db, docs, { ...options, inPlace: false });
      }
      if (summary.write_mode === "full") checkpoint(db);
      return summary;
    } finally {
      db?.close();
    }
  }, { env: options.env });
}

/**
 * Store vectors for documents already in the index, and nothing else: no
 * document is rewritten and no other vector is touched.
 *
 * Embedding a vault takes minutes, and a rebuild writes once at the end — so
 * a cancel, a crash or a closed laptop lost every vector of the run. This is
 * the write in between: a batch at a time, each committed, with `meta` saying
 * what the vectors are, so a later rebuild keeps them and the next embedding
 * run starts where this one stopped. A vector for a
 * document the index does not have is skipped; the closing rebuild drops any
 * whose passage has changed since.
 *
 * @param {object} options
 * @param {string} options.indexPath
 * @param {Array<{ id: string, content_hash: string, vector: number[] }>} options.vectors
 * @param {{ backend?: string, revision?: string, dtype?: string }} options.provenance
 * @param {number} [options.textLimit] - Of the plan the vectors came from.
 * @param {boolean} [options.includeMembrane]
 * @param {number} [options.eligible] - Documents the plan wants a vector for.
 * @param {NodeJS.ProcessEnv} [options.env]
 * @returns {Promise<{ stored: number, documents: number, pending: number }>}
 */
export async function storeDenseVectors({ indexPath, vectors, provenance = {}, textLimit = DEFAULT_DENSE_TEXT_LIMIT, includeMembrane = false, eligible = 0, env }) {
  return withRebuildLock(indexPath, async () => {
    const db = await openWriter(indexPath);
    try {
      if (!tableExists(db, "documents") || !tableExists(db, "meta")) throw new Error(`Search index has no documents yet: ${indexPath}. Rebuild it first.`);
      await beginImmediate(db);
      try {
        ensureDenseTable(db);
        const full = fullProvenance(provenance);
        const documentAt = db.prepare("SELECT mtime FROM documents WHERE id = ?");
        const replace = db.prepare(`INSERT OR REPLACE INTO dense_vectors(${DENSE_COLUMNS.join(", ")}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        let stored = 0;
        for (const entry of vectors) {
          const document = documentAt.get(String(entry?.id ?? ""));
          if (!document || !Array.isArray(entry.vector) || entry.vector.length !== DENSE_DIMENSIONS) continue;
          replace.run(String(entry.id), vectorBlob(entry.vector), DENSE_DIMENSIONS, DENSE_MODEL_NAME, full.backend, full.revision, full.dtype,
            String(entry.content_hash ?? ""), Number(document.mtime) || 0);
          stored += 1;
        }
        const documents = db.prepare("SELECT count(*) AS n FROM dense_vectors WHERE backend = ? AND revision = ? AND dtype = ?")
          .get(full.backend, full.revision, full.dtype).n;
        const pending = Math.max(0, Number(eligible) - documents);
        const upsert = db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)");
        for (const [key, value] of Object.entries({
          dense_enabled: "true",
          dense_backend: full.backend,
          dense_revision: full.revision,
          dense_dtype: full.dtype,
          dense_text_limit: textLimit,
          dense_include_membrane: includeMembrane ? "true" : "false",
          dense_documents: documents,
          dense_eligible_documents: eligible,
          dense_pending_documents: pending
        })) upsert.run(key, String(value));
        db.exec("COMMIT");
        return { stored, documents, pending };
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // The transaction is already gone.
        }
        throw error;
      }
    } finally {
      db.close();
    }
  }, { env });
}

/**
 * Which documents still need a dense vector for this backend, revision and
 * dtype — the helper's `dense-plan`, for an embedder that lives elsewhere.
 *
 * @param {object} options
 * @param {string} options.vaultRoot
 * @param {string} options.indexPath
 * @param {boolean} [options.includeExternalProjectFiles]
 * @param {number} [options.textLimit]
 * @param {boolean} [options.includeMembrane]
 * @param {boolean} [options.incremental] - Count stored vectors that still fit as done.
 * @param {{ backend?: string, revision?: string, dtype?: string }} [options.provenance]
 * @returns {Promise<{ index_path: string, document_count: number, eligible: number, reusable: number, provenance: object, records: object[] }>}
 */
export async function densePlan({
  vaultRoot,
  indexPath,
  includeExternalProjectFiles = true,
  textLimit = DEFAULT_DENSE_TEXT_LIMIT,
  includeMembrane = false,
  incremental = true,
  provenance = {}
}) {
  const { docs } = await collectDocumentsYielding({ vaultRoot, includeExternalProjectFiles });
  const records = denseDocRecords(docs, { textLimit, includeMembrane });
  const full = fullProvenance(provenance);
  let stored = new Map();
  if (incremental && fs.existsSync(indexPath)) {
    const reader = createIndexReader(indexPath);
    try {
      stored = (await reader.read(readDenseRows)) ?? new Map();
    } catch (error) {
      if (!isCorruptError(error)) throw error;
    } finally {
      reader.close();
    }
  }
  const pending = records.filter((record) => !denseCacheHit(stored.get(record.id), record, full));
  return {
    index_path: indexPath,
    document_count: docs.length,
    eligible: records.length,
    reusable: records.length - pending.length,
    provenance: full,
    records: pending.map(({ id, text, content_hash }) => ({ id, text, content_hash }))
  };
}
