/**
 * Hybrid search over the index: a keyword rank, the sparse "semantic" vectors
 * and, when the index has them and the caller embedded the question, the dense
 * BGE-M3 vectors — weighted, combined, nudged and collapsed into one ranking.
 *
 * A port of `hybrid_search` and its helpers from `search-index/search_cli.py`,
 * kept to the same candidates, arithmetic and order so the same index answers
 * the same question the same way (`scripts/search-parity.mjs` compares them on
 * every golden case). Two things are deliberately not ported: the helper
 * loaded the model itself when it was handed no query vector — here the
 * caller embeds the question or the dense half does not run — and the keyword
 * half takes the question's words as words, so a capital AND, OR, NOT or NEAR
 * no longer empties it.
 *
 * The helper parsed every document's sparse vector on every question. Here a
 * {@link createHybridCache} keeps them parsed, keyed by what they are a
 * function of — a document's content hash — so a warm search reads ids and
 * hashes from the index and nothing else it already has.
 */
import { isMembraneSource } from "./search-documents.mjs";
import { buildSemanticVector, tokenizeSemantic } from "./search-semantic.mjs";
import { collapseSearchResults, commonFilters, ftsQuery } from "./search-query.mjs";
import { pythonRound, pythonStrip, pythonSum } from "./python-compat.mjs";
import { isBusyError, isCorruptError, tableColumns, tableExists, wholeText } from "./search-sqlite.mjs";

/** Candidates each signal contributes, whatever the caller's limit: a fixed pool keeps the ranking prefix stable. */
export const HYBRID_CANDIDATE_LIMIT = 500;

/** Most results a hybrid search returns. */
export const HYBRID_MAX_RESULTS = 50;

/** Weights when the caller gives none, before they are scaled to sum to one. */
export const HYBRID_DEFAULT_WEIGHTS = Object.freeze({ keyword: 0.45, semantic: 0.20, dense: 0.35 });

const APP_WORDS = [
  "gmail", "google sheets", "google drive", "slack", "notion", "linear", "jira",
  "figma", "github", "stripe", "shopify", "salesforce", "hubspot", "discord",
  "почта", "таблица", "таблицы", "фигма"
];
const INTENT_WORDS = [
  "integrat", "connect", "sync", "import", "export", "webhook", "oauth", "send",
  "read from", "write to", "интеграц", "подключ", "синхрон", "импорт", "экспорт",
  "вебхук", "отправ", "прочит"
];
const MEMBRANE_EXCLUSION = /(без|exclude|filter|hide|noise|noisy|шум|скры|фильтр|не\s+показыв|не\s+тащ)/;

/** A weight in [0, 1]; anything that is not a number is `fallback`. */
export function clampWeight(value, fallback) {
  const number = typeof value === "string" ? Number(value.trim() || NaN) : Number(value);
  if (Number.isNaN(number) || value === null || value === undefined || typeof value === "boolean") return fallback;
  return Math.max(0, Math.min(1, number));
}

/** Whether a question asks to connect, sync or move data with a named application. */
export function queryHasAppIntegrationIntent(query) {
  const lowered = query.toLowerCase();
  if (APP_WORDS.some((word) => lowered.includes(word)) && INTENT_WORDS.some((word) => lowered.includes(word))) return true;
  return lowered.includes("app integration") || lowered.includes("application skill");
}

/** Whether a question asks to keep the Membrane connectors out. */
export function queryExcludesMembrane(query) {
  const lowered = query.toLowerCase();
  if (!lowered.includes("membrane") && !lowered.includes("мембран")) return false;
  return MEMBRANE_EXCLUSION.test(lowered);
}

/**
 * Up to 0.15 for the share of the question's words found anywhere in a result's
 * title, path, source, categories or preview.
 *
 * @param {string[]} queryTerms - Distinct tokens of the question.
 * @param {{ title: string, path: string, source: string, categories: string, preview: string }} row
 * @returns {number}
 */
export function lexicalBoost(queryTerms, row) {
  if (!queryTerms.length) return 0;
  const haystack = [row.title, row.path, row.source, row.categories, row.preview].join(" ").toLowerCase();
  let matches = 0;
  for (const term of queryTerms) if (haystack.includes(term)) matches += 1;
  return Math.min(0.15, 0.15 * (matches / Math.max(1, queryTerms.length)));
}

/**
 * A stored sparse vector, `{"dim":weight,...}`, in the order it was written —
 * which is the order Python iterated it in. Anything else parses as empty, as
 * the helper's `json.loads` failure did.
 *
 * @param {string} text
 * @returns {{ dims: Uint16Array, weights: Float64Array }}
 */
export function parseSparseVector(text) {
  const source = String(text ?? "").trim();
  const dims = [];
  const weights = [];
  if (source.startsWith("{") && source.endsWith("}")) {
    const body = source.slice(1, -1).trim();
    if (body) {
      for (const pair of body.split(",")) {
        const match = /^\s*"(\d{1,4})"\s*:\s*(-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*$/.exec(pair);
        if (!match) return { dims: new Uint16Array(0), weights: new Float64Array(0) };
        dims.push(Number(match[1]));
        weights.push(Number(match[2]));
      }
    }
  }
  return { dims: Uint16Array.from(dims), weights: Float64Array.from(weights) };
}

const scratch = new Float64Array(1 << 16);

/**
 * `sparse_dot`: the sum over the shorter vector, in its own order, of each
 * weight times the other vector's weight for that dimension.
 *
 * @param {{ dims: ArrayLike<number>, weights: ArrayLike<number> }} left - The question.
 * @param {{ dims: ArrayLike<number>, weights: ArrayLike<number> }} right - A document.
 * @returns {number}
 */
export function sparseDot(left, right) {
  if (!left.dims.length || !right.dims.length) return 0;
  const [outer, inner] = left.dims.length > right.dims.length ? [right, left] : [left, right];
  for (let index = 0; index < inner.dims.length; index += 1) scratch[inner.dims[index]] = inner.weights[index];
  let score = 0;
  for (let index = 0; index < outer.dims.length; index += 1) score += outer.weights[index] * scratch[outer.dims[index]];
  for (let index = 0; index < inner.dims.length; index += 1) scratch[inner.dims[index]] = 0;
  return score;
}

/**
 * The question's sparse vector, built as a document whose title and body are
 * the question.
 *
 * @param {string} query
 * @returns {{ dims: Uint16Array, weights: Float64Array }}
 */
export function queryVector(query) {
  const { entries } = buildSemanticVector({ title: query, categories: "", source: "", path: "", body: query });
  return { dims: Uint16Array.from(entries.map(([dim]) => dim)), weights: Float64Array.from(entries.map(([, weight]) => weight)) };
}

/**
 * `dense_dot`: the dot product of two float32 vectors, summed as Python's
 * `sum()` sums floats. Vectors of different lengths score 0.
 *
 * @param {Float32Array} query
 * @param {Float32Array} vector
 * @returns {number}
 */
export function denseDot(query, vector) {
  if (!query?.length || !vector?.length || query.length !== vector.length) return 0;
  const products = new Array(query.length);
  for (let index = 0; index < query.length; index += 1) products[index] = query[index] * vector[index];
  return pythonSum(products);
}

/** A float32 BLOB (little-endian, as the helper's `array("f")` wrote it) as numbers. */
export function denseBlobToVector(blob) {
  if (!blob) return new Float32Array(0);
  const bytes = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
  const count = Math.floor(bytes.byteLength / 4);
  const view = new DataView(bytes.buffer, bytes.byteOffset, count * 4);
  const vector = new Float32Array(count);
  for (let index = 0; index < count; index += 1) vector[index] = view.getFloat32(index * 4, true);
  return vector;
}

/**
 * Parsed vectors and display fields, kept between searches.
 *
 * A document's sparse vector and fields are a function of its content, so they
 * are keyed by its content hash and stay right whatever writes the index; a
 * dense vector is keyed by everything its row records about where it came
 * from. Entries the index no longer has are dropped on the next search that
 * sees every document.
 *
 * @returns {{ documents: Map<string, object>, dense: Map<string, Float32Array> }}
 */
export function createHybridCache() {
  return { documents: new Map(), dense: new Map() };
}

/** Which document a result row is, carried through collapsing and dropped before it is returned. */
const DOCUMENT_ID = Symbol("document id");

/** Above this many uncached documents a search reads the vector table in one pass. */
const BULK_READ_THRESHOLD = 64;

const DOCUMENT_FIELDS = `
  CAST(d.scope AS BLOB) AS scope,
  CAST(d.title AS BLOB) AS title,
  CAST(d.path AS BLOB) AS path,
  CAST(d.source AS BLOB) AS source,
  CAST(d.categories AS BLOB) AS categories,
  CAST(d.preview AS BLOB) AS preview`;

function fieldsOf(row) {
  return {
    scope: wholeText(row.scope),
    title: wholeText(row.title),
    path: wholeText(row.path),
    source: wholeText(row.source),
    categories: wholeText(row.categories),
    preview: wholeText(row.preview)
  };
}

function whereClause(filters) {
  return filters.where.length ? `WHERE ${filters.where.join(" AND ")}` : "";
}

/** The documents a filter admits, in the order the helper's query returned them, with their sparse vectors. */
function semanticCandidates(db, filters, cache) {
  const rows = db.prepare(`
    SELECT d.id AS id, d.content_hash AS content_hash, octet_length(v.vector) AS vector_length
    FROM documents d
    JOIN semantic_vectors v ON v.id = d.id
    ${whereClause(filters)}
  `).all(...filters.params);
  const keyOf = (row) => `${row.content_hash}:${row.vector_length}`;
  const missing = rows.filter((row) => cache.documents.get(row.id)?.key !== keyOf(row));
  const remember = (row, full) => cache.documents.set(row.id, {
    key: keyOf(row),
    fields: fieldsOf(full),
    vector: parseSparseVector(wholeText(full.vector))
  });
  if (missing.length > BULK_READ_THRESHOLD) {
    // A cold cache: one pass over the table instead of a statement per document.
    const wanted = new Map(missing.map((row) => [row.id, row]));
    for (const full of db.prepare(`
      SELECT d.id AS id, ${DOCUMENT_FIELDS}, CAST(v.vector AS BLOB) AS vector
      FROM documents d JOIN semantic_vectors v ON v.id = d.id
    `).iterate()) {
      const row = wanted.get(full.id);
      if (row) remember(row, full);
    }
  } else if (missing.length) {
    const read = db.prepare(`SELECT ${DOCUMENT_FIELDS}, CAST(v.vector AS BLOB) AS vector FROM documents d JOIN semantic_vectors v ON v.id = d.id WHERE d.id = ?`);
    for (const row of missing) {
      const full = read.get(row.id);
      if (full) remember(row, full);
    }
  }
  if (!filters.where.length && cache.documents.size > rows.length) {
    const present = new Set(rows.map((row) => row.id));
    for (const id of cache.documents.keys()) if (!present.has(id)) cache.documents.delete(id);
  }
  return rows.map((row) => ({ id: row.id, entry: cache.documents.get(row.id) })).filter((row) => row.entry);
}

/**
 * The documents a filter admits that have a dense vector, with it — only
 * vectors from the model that embedded the question, when the caller says
 * which: a 2.x index holds the Python backend's fp32 vectors, and a dot
 * product across two models ranks by nothing. Those wait for
 * `npm run setup -- --model` to embed them again.
 */
function denseCandidates(db, filters, cache, provenance = null) {
  const where = [...filters.where];
  const params = [...filters.params];
  if (provenance) {
    where.push("v.backend = ?", "v.revision = ?", "v.dtype = ?");
    params.push(String(provenance.backend), String(provenance.revision), String(provenance.dtype));
  }
  const rows = db.prepare(`
    SELECT d.id AS id, v.content_hash AS dense_hash, v.backend AS backend, v.revision AS revision,
      v.dtype AS dtype, v.mtime AS mtime, v.dimensions AS dimensions, octet_length(v.vector) AS bytes
    FROM documents d
    JOIN dense_vectors v ON v.id = d.id
    ${whereClause({ where })}
  `).all(...params);
  const read = db.prepare("SELECT vector FROM dense_vectors WHERE id = ?");
  const result = [];
  for (const row of rows) {
    const key = `${row.id}\u001f${row.dense_hash}\u001f${row.backend}\u001f${row.revision}\u001f${row.dtype}\u001f${row.mtime}\u001f${row.bytes}`;
    let vector = cache.dense.get(key);
    if (!vector) {
      vector = denseBlobToVector(read.get(row.id)?.vector);
      cache.dense.set(key, vector);
    }
    result.push({ id: row.id, key, vector });
  }
  if (!filters.where.length && cache.dense.size > rows.length) {
    const present = new Set(result.map((row) => row.key));
    for (const key of cache.dense.keys()) if (!present.has(key)) cache.dense.delete(key);
  }
  return result;
}

/**
 * Ids in BM25 order over the FTS table, best first. Empty when FTS5 refuses the
 * query, as in the helper.
 */
function keywordCandidates(db, match, filters, limit) {
  if (!match) return [];
  try {
    return db.prepare(`
      SELECT d.id AS id, bm25(docs_fts) AS raw_score
      FROM docs_fts
      JOIN documents d ON d.id = docs_fts.id
      WHERE ${["docs_fts MATCH ?", ...filters.where].join(" AND ")}
      ORDER BY raw_score ASC
      LIMIT ?
    `).all(match, ...filters.params, limit).map((row) => row.id);
  } catch (error) {
    if (isBusyError(error) || isCorruptError(error) || error?.code !== "ERR_SQLITE_ERROR") throw error;
    return [];
  }
}

/**
 * The FTS snippets of the documents a search shows. A snippet depends on the
 * document and the query only, so asking for the shown ones is asking for
 * what the helper computed for all 500 candidates and threw away.
 */
function snippetsFor(db, match, ids) {
  if (!match || !ids.length) return new Map();
  const rows = db.prepare(`
    SELECT id, CAST(snippet(docs_fts, 2, '[', ']', '...', 18) AS BLOB) AS snippet
    FROM docs_fts
    WHERE docs_fts MATCH ? AND id IN (${ids.map(() => "?").join(", ")})
  `).all(match, ...ids);
  return new Map(rows.map((row) => [row.id, wholeText(row.snippet)]));
}

/** Python's `str` order: by code point, which UTF-16 order is not for characters past U+FFFF. */
export function comparePythonStrings(left, right) {
  if (left === right) return 0;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left.charCodeAt(index);
    const b = right.charCodeAt(index);
    if (a === b) continue;
    const aSurrogate = a >= 0xd800 && a <= 0xdfff;
    const bSurrogate = b >= 0xd800 && b <= 0xdfff;
    if (aSurrogate !== bSurrogate) return aSurrogate ? 1 : -1;
    return a - b;
  }
  return left.length - right.length;
}

function sortByScore(ranked) {
  // Python's sort is stable and so is this one: equal scores keep the order
  // the rows were read in.
  return ranked.sort((left, right) => right.score - left.score);
}

/**
 * Hybrid search, as the helper's `hybrid` command answered it.
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {object} options
 * @param {string} options.query
 * @param {string} [options.scope]
 * @param {number} [options.limit] - 1 to {@link HYBRID_MAX_RESULTS}.
 * @param {string} [options.project]
 * @param {string} [options.source] - Comma-separated.
 * @param {string} [options.categories] - Comma-separated.
 * @param {string} [options.folders] - Comma-separated path prefixes.
 * @param {number} [options.semanticWeight]
 * @param {number} [options.keywordWeight]
 * @param {number} [options.denseWeight]
 * @param {ArrayLike<number>|null} [options.denseQueryVector] - The question embedded by the caller; without it the dense half does not run.
 * @param {{ backend: string, revision: string, dtype: string }|null} [options.denseProvenance] - The model that embedded the question; only its vectors are compared.
 * @param {ReturnType<typeof createHybridCache>} [options.cache]
 * @returns {object[]} results with `score`, `keyword_score`, `semantic_score`, `dense_score` and `mode: "hybrid"`
 */
export function hybridSearch(db, options) {
  db.exec("BEGIN");
  try {
    const results = rankHybrid(db, options);
    db.exec("COMMIT");
    return results;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // The failure ended the transaction already.
    }
    throw error;
  }
}

function rankHybrid(db, {
  query,
  scope = "all",
  limit = 10,
  project = "",
  source = "",
  categories = "",
  folders = "",
  semanticWeight = HYBRID_DEFAULT_WEIGHTS.semantic,
  keywordWeight = HYBRID_DEFAULT_WEIGHTS.keyword,
  denseWeight = HYBRID_DEFAULT_WEIGHTS.dense,
  denseQueryVector = null,
  denseProvenance = null,
  cache = createHybridCache()
}) {
  const question = pythonStrip(String(query ?? ""));
  if (!question) return [];
  const capped = Math.max(1, Math.min(Math.trunc(Number(limit)) || 10, HYBRID_MAX_RESULTS));
  let semantic = clampWeight(semanticWeight, HYBRID_DEFAULT_WEIGHTS.semantic);
  let keyword = clampWeight(keywordWeight, HYBRID_DEFAULT_WEIGHTS.keyword);
  let dense = clampWeight(denseWeight, HYBRID_DEFAULT_WEIGHTS.dense);
  const appIntegration = queryHasAppIntegrationIntent(question);
  const excludesMembrane = queryExcludesMembrane(question);
  const filters = commonFilters({ scope: scope || "all", project, source, categories, folders });

  const denseAvailable = tableExists(db, "dense_vectors") && tableExists(db, "meta")
    && String(db.prepare("SELECT value FROM meta WHERE key = 'dense_enabled'").get()?.value ?? "false") === "true";
  let denseQuery = denseAvailable && dense > 0 && denseQueryVector?.length ? Float32Array.from(denseQueryVector) : null;
  // Not one stored vector of the question's model: the dense half has nothing
  // to compare, so it is left out of the weights rather than scoring everyone
  // zero, and the caller is told. 2.0.0's table records no model: its vectors are the
  // Python backend's, never the question's.
  const unmatched = Boolean(denseQuery && (!tableColumns(db, "dense_vectors").has("backend") || (denseProvenance && !hasDenseVectorsOf(db, denseProvenance))));
  if (unmatched) denseQuery = null;
  if (!denseQuery) dense = 0;

  let total = keyword + semantic + dense;
  if (total <= 0) {
    keyword = HYBRID_DEFAULT_WEIGHTS.keyword;
    semantic = HYBRID_DEFAULT_WEIGHTS.semantic;
    dense = denseQuery ? HYBRID_DEFAULT_WEIGHTS.dense : 0;
    total = keyword + semantic + dense;
  }
  keyword /= total;
  semantic /= total;
  dense /= total;

  // The sparse pass reads every admitted document and fills the cache, so it
  // runs first; the helper's order of first sight — keyword, sparse, dense —
  // is kept below, because equal scores keep it.
  const asked = queryVector(question);
  const admitted = semanticCandidates(db, filters, cache);
  const semanticRanked = [];
  for (const { id, entry } of admitted) {
    const score = sparseDot(asked, entry.vector);
    if (score > 0) semanticRanked.push({ id, score });
  }
  const match = ftsQuery(question);

  /** id → display fields, in the order the helper first saw each document. */
  const rows = new Map();
  const keywordScores = new Map();
  const semanticScores = new Map();
  const denseScores = new Map();
  const fieldsFor = (id) => cache.documents.get(id)?.fields
    ?? fieldsOf(db.prepare(`SELECT ${DOCUMENT_FIELDS} FROM documents d WHERE d.id = ?`).get(id) ?? {});

  keywordCandidates(db, match, filters, HYBRID_CANDIDATE_LIMIT).forEach((id, rank) => {
    rows.set(id, fieldsFor(id));
    keywordScores.set(id, 1 / (rank + 1));
  });
  for (const { id, score } of sortByScore(semanticRanked).slice(0, HYBRID_CANDIDATE_LIMIT)) {
    if (!rows.has(id)) rows.set(id, fieldsFor(id));
    semanticScores.set(id, Math.max(0, Math.min(1, score)));
  }

  if (denseQuery && dense > 0) {
    const denseRanked = [];
    for (const { id, vector } of denseCandidates(db, filters, cache, denseProvenance)) {
      const score = denseDot(denseQuery, vector);
      if (score > 0) denseRanked.push({ id, score });
    }
    for (const { id, score } of sortByScore(denseRanked).slice(0, HYBRID_CANDIDATE_LIMIT)) {
      if (!rows.has(id)) rows.set(id, fieldsFor(id));
      denseScores.set(id, Math.max(0, Math.min(1, score)));
    }
  }

  const queryTerms = [...new Set(tokenizeSemantic(question))];
  const combined = [];
  for (const [id, row] of rows) {
    const keywordScore = keywordScores.get(id) ?? 0;
    const semanticScore = semanticScores.get(id) ?? 0;
    const denseScore = denseScores.get(id) ?? 0;
    let score = keyword * keywordScore + semantic * semanticScore + dense * denseScore + lexicalBoost(queryTerms, row);
    if (isMembraneSource(row.source)) {
      if (excludesMembrane) score *= 0.12;
      else if (!appIntegration) score *= 0.35;
    } else if (row.source === "vault-note") {
      score += 0.04;
    }
    if (score <= 0) continue;
    combined.push({
      scope: row.scope,
      title: row.title,
      path: row.path,
      source: row.source,
      categories: row.categories,
      score: pythonRound(score, 6),
      keyword_score: pythonRound(keywordScore, 6),
      semantic_score: pythonRound(semanticScore, 6),
      dense_score: pythonRound(denseScore, 6),
      mode: "hybrid",
      preview: row.preview,
      [DOCUMENT_ID]: id
    });
  }
  combined.sort((left, right) => right.score - left.score || comparePythonStrings(left.path, right.path));
  const shown = collapseSearchResults(combined).slice(0, capped);
  const snippets = snippetsFor(db, match, shown.map((item) => item[DOCUMENT_ID]).filter((id) => keywordScores.has(id)));
  const answer = shown.map(({ [DOCUMENT_ID]: id, ...item }) => (snippets.get(id) ? { ...item, preview: snippets.get(id) } : item));
  if (unmatched) Object.defineProperty(answer, "dense_unmatched", { value: true, enumerable: false });
  return answer;
}

/** Whether any stored vector was made by this model. */
function hasDenseVectorsOf(db, provenance) {
  return Boolean(db.prepare("SELECT 1 FROM dense_vectors WHERE backend = ? AND revision = ? AND dtype = ? LIMIT 1")
    .get(String(provenance.backend), String(provenance.revision), String(provenance.dtype)));
}
