/**
 * Keyword search over the index: the FTS5 query the helper made of a question,
 * its filters, BM25 order and snippets, the LIKE search it fell back to when
 * FTS5 refused the query, and how the copies of one skill fold into one result.
 *
 * A port of `search`, `fts_query`, the filter builders and
 * `collapse_search_results` from `search-index/search_cli.py`, kept to the
 * same SQL so the same index answers the same question the same way — the
 * parity script (`scripts/search-parity.mjs`) checks that on every golden case.
 */
import { codePointLength, collapseWhitespace, pythonCasefold, pythonStrip } from "./python-compat.mjs";
import { isBusyError, isCorruptError, wholeText } from "./search-sqlite.mjs";

/** Most results a search returns, whatever the caller asks for. */
export const MAX_RESULTS = 50;

const WORD = /[\p{L}\p{N}_]+/gu;

/**
 * The FTS5 query for a question: its words, each over two characters long
 * searched as a prefix, all of them required.
 *
 * Every word is quoted. The helper passed them bare, and to FTS5 a bare
 * `AND`, `OR`, `NOT` or `NEAR` is an operator: "frontend AND backend testing"
 * was a syntax error and found nothing. Quoted, a
 * word is a word; for every other word the query means what it meant.
 *
 * @param {string} query
 * @returns {string} "" when the question has no words
 */
export function ftsQuery(query) {
  return (query.match(WORD) ?? [])
    .map((term) => term.replace(/"/g, ""))
    .filter(Boolean)
    .map((term) => (codePointLength(term) > 2 ? `"${term}"*` : `"${term}"`))
    .join(" ");
}

/** `"a, b,,c"` → `["a", "b", "c"]`. */
export function splitCsv(value) {
  if (!value) return [];
  return String(value).split(",").map(pythonStrip).filter(Boolean);
}

function addScopeFilter(where, params, scope) {
  if (!scope || scope === "all") return;
  if (scope === "quality") {
    where.push("(d.scope = ? OR d.categories LIKE ? OR d.source LIKE ?)");
    params.push("quality", "%quality%", "%quality%");
    return;
  }
  where.push("d.scope = ?");
  params.push(scope);
}

function addLikeFilter(where, params, field, values) {
  if (!values.length) return;
  where.push(`(${values.map(() => `d.${field} LIKE ?`).join(" OR ")})`);
  params.push(...values.map((value) => `%${value}%`));
}

/** The scope, project, source, category and folder filters, as SQL. */
export function commonFilters({ scope = "all", project = "", source = "", categories = "", folders = "" }) {
  const where = [];
  const params = [];
  addScopeFilter(where, params, scope);
  if (project) {
    const value = `%${project}%`;
    where.push("(d.title LIKE ? OR d.path LIKE ? OR d.source LIKE ?)");
    params.push(value, value, value);
  }
  addLikeFilter(where, params, "source", splitCsv(source));
  addLikeFilter(where, params, "categories", splitCsv(categories));
  for (const folder of splitCsv(folders)) {
    where.push("d.path LIKE ?");
    params.push(`${folder.replace(/\/+$/, "")}%`);
  }
  return { where, params };
}

/** Free-text columns come back as BLOBs (see `wholeText`); this makes the result the helper printed. */
function rowToResult(row) {
  const snippet = wholeText(row.snippet);
  return {
    scope: wholeText(row.scope),
    title: wholeText(row.title),
    path: wholeText(row.path),
    source: wholeText(row.source),
    categories: wholeText(row.categories),
    score: row.score,
    preview: snippet || wholeText(row.preview)
  };
}

const RESULT_COLUMNS = `
  CAST(d.scope AS BLOB) AS scope,
  CAST(d.title AS BLOB) AS title,
  CAST(d.path AS BLOB) AS path,
  CAST(d.source AS BLOB) AS source,
  CAST(d.categories AS BLOB) AS categories,
  CAST(d.preview AS BLOB) AS preview`;

/**
 * The key two results share when they are the same thing: a skill's registry
 * entry and its card, or one path indexed twice.
 *
 * @param {{ scope?: string, title?: string, path?: string }} item
 * @returns {string}
 */
export function canonicalResultKey(item) {
  const title = pythonCasefold(pythonStrip(collapseWhitespace(String(item.title || ""))));
  const resultPath = pythonCasefold(String(item.path || "").replace(/\\/g, "/"));
  const isSkillEntity = String(item.scope || "") === "skills"
    && (resultPath.startsWith("03-skills-catalog/cards/") || (resultPath.includes("/sources/") && resultPath.endsWith("/skill.md")));
  return isSkillEntity && title ? `skill:${title}` : `path:${resultPath}`;
}

/** Which copy of a skill a collapsed result shows: a custom source, any source, a card, anything. */
export function resultEntityPriority(item) {
  const resultPath = pythonCasefold(String(item.path || "").replace(/\\/g, "/"));
  const source = pythonCasefold(String(item.source || ""));
  if (resultPath.includes("/sources/custom/") && resultPath.endsWith("/skill.md")) return 40;
  if (resultPath.includes("/sources/") && resultPath.endsWith("/skill.md") && source !== "vault-note") return 30;
  if (resultPath.startsWith("03-skills-catalog/cards/")) return 20;
  return 10;
}

const RANKING_FIELDS = ["score", "keyword_score", "semantic_score", "dense_score", "mode"];

/**
 * Fold the copies of one thing into the first result for it, keeping that
 * result's rank and score but showing the preferred copy, and list the paths
 * folded away.
 *
 * @param {object[]} results - In rank order.
 * @returns {object[]}
 */
export function collapseSearchResults(results) {
  const collapsed = new Map();
  for (const item of results) {
    const key = canonicalResultKey(item);
    const current = collapsed.get(key);
    if (!current) {
      collapsed.set(key, { ...item, collapsed_duplicates: [] });
      continue;
    }
    const duplicates = [...(current.collapsed_duplicates ?? []), current.path, item.path];
    if (resultEntityPriority(item) > resultEntityPriority(current)) {
      const replacement = { ...item };
      for (const name of RANKING_FIELDS) if (name in current) replacement[name] = current[name];
      replacement.collapsed_duplicates = duplicates;
      collapsed.set(key, replacement);
    } else {
      current.collapsed_duplicates = duplicates;
    }
  }
  return [...collapsed.values()].map((item) => {
    const { collapsed_duplicates: folded = [], ...rest } = item;
    const unique = [...new Set(folded.filter((value) => value && value !== rest.path))];
    return unique.length ? { ...rest, duplicate_count: unique.length, collapsed_duplicates: unique } : rest;
  });
}

/**
 * Keyword search: BM25 over the FTS5 table, filtered, snippets marked with
 * `[` `]`, copies collapsed. A query FTS5 cannot parse (`AND*`, a stray
 * operator) is searched as a LIKE substring instead, filtered by scope only —
 * as the helper did.
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {object} options
 * @param {string} options.query
 * @param {string} [options.scope]
 * @param {number} [options.limit]
 * @param {string} [options.project]
 * @param {string} [options.source] - Comma-separated.
 * @param {string} [options.categories] - Comma-separated.
 * @param {string} [options.folders] - Comma-separated path prefixes.
 * @returns {object[]}
 */
export function keywordSearch(db, { query, scope = "all", limit = 10, project = "", source = "", categories = "", folders = "" }) {
  const question = pythonStrip(String(query ?? ""));
  if (!question) return [];
  const match = ftsQuery(question);
  if (!match) return [];
  const capped = Math.max(1, Math.min(Math.trunc(Number(limit)) || 10, MAX_RESULTS));
  const candidates = Math.max(50, Math.min(250, capped * 5));
  const filters = commonFilters({ scope, project, source, categories, folders });
  let rows;
  try {
    rows = db.prepare(`
      SELECT ${RESULT_COLUMNS},
        bm25(docs_fts) AS score,
        CAST(snippet(docs_fts, 2, '[', ']', '...', 18) AS BLOB) AS snippet
      FROM docs_fts
      JOIN documents d ON d.id = docs_fts.id
      WHERE ${["docs_fts MATCH ?", ...filters.where].join(" AND ")}
      ORDER BY score ASC
      LIMIT ?
    `).all(match, ...filters.params, candidates);
  } catch (error) {
    if (isBusyError(error) || isCorruptError(error) || error?.code !== "ERR_SQLITE_ERROR") throw error;
    const like = `%${question}%`;
    const fallback = { where: [], params: [] };
    addScopeFilter(fallback.where, fallback.params, scope);
    rows = db.prepare(`
      SELECT ${RESULT_COLUMNS},
        0.0 AS score,
        CAST(d.preview AS BLOB) AS snippet
      FROM docs_fts
      JOIN documents d ON d.id = docs_fts.id
      WHERE (docs_fts.title LIKE ? OR docs_fts.body LIKE ? OR d.path LIKE ? OR d.source LIKE ?)
      ${fallback.where.length ? `AND ${fallback.where.join(" AND ")}` : ""}
      LIMIT ?
    `).all(like, like, like, like, ...fallback.params, candidates);
  }
  return collapseSearchResults(rows.map(rowToResult)).slice(0, capped);
}
