/**
 * `search_knowledge` over the search index instead of over the disk.
 *
 * The tool read every Markdown file of the vault on every call — 2.5 s on the
 * 2.x catalogue. The index already holds the vault's
 * notes, its skills and their cards, kept fresh by the search runtime, so the
 * same scoring runs over what it holds: each word of the question found in the
 * path or the first 8,000 characters scores 1, the whole question found in
 * either scores 3 more; Membrane's connectors and the files of the projects
 * outside the vault stay out, as they did. The answer keeps its shape —
 * `{ path, score, preview }`, best first, ties by path.
 *
 * What changes is what counts as the vault's text, and it is narrower:
 * a skill is its registry entry and its card, not
 * every file under `sources/` — its references are read with `read_skill` —
 * and whatever the index leaves out is left out here too: the generated
 * registries' Markdown, the all-skills group pages, and notes in folders named
 * `build`, `dist`, `env`, `venv`, `.venv`, `.next`, `.nuxt`, `.svelte-kit` or
 * `__pycache__` (`SKIP_DIRS`). On the seed that is 149 of the 515 files the
 * old scan read. A change made outside the server is seen within a second, as
 * by every other search tool.
 */
import { isMembraneSource, PROJECT_FILE_SOURCES } from "./search-documents.mjs";
import { wholeText } from "./search-sqlite.mjs";

/** Characters of a document's text the score reads, as the file scan did. */
export const KNOWLEDGE_TEXT_LIMIT = 8000;

/** Characters of the preview each result carries. */
export const KNOWLEDGE_PREVIEW_LIMIT = 240;

/**
 * Lowered texts and previews kept between calls, keyed by document id and
 * checked against its content hash.
 *
 * @returns {Map<string, { key: string, path: string, joined: string, pathLower: string, textLower: string, preview: string }>}
 */
export function createKnowledgeCache() {
  return new Map();
}

function entryFor(row, body) {
  const path = wholeText(row.path);
  const text = body.slice(0, KNOWLEDGE_TEXT_LIMIT);
  return {
    key: String(row.content_hash),
    path,
    joined: [path, text].join(" ").toLowerCase(),
    pathLower: path.toLowerCase(),
    textLower: text.toLowerCase(),
    preview: body.replace(/\s+/g, " ").slice(0, KNOWLEDGE_PREVIEW_LIMIT)
  };
}

/** `scoreText(query, [path, text])` (`text-format.mjs`) over the cached lowered fields. */
function score(question, terms, entry) {
  let total = 0;
  for (const term of terms) if (entry.joined.includes(term)) total += 1;
  if (entry.pathLower.includes(question) || entry.textLower.includes(question)) total += 3;
  return total;
}

/**
 * Score every document of the index against the question.
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {{ query: string, limit?: number, cache?: ReturnType<typeof createKnowledgeCache> }} options
 * @returns {Array<{ path: string, score: number, preview: string }>}
 */
export function knowledgeSearch(db, { query, limit = 10, cache = createKnowledgeCache() }) {
  const question = String(query ?? "").toLowerCase().trim();
  if (!question) return [];
  const terms = question.split(/\s+/).filter(Boolean);
  const rows = db.prepare(`
    SELECT d.id AS id, d.content_hash AS content_hash, CAST(d.path AS BLOB) AS path, CAST(d.source AS BLOB) AS source
    FROM documents d
  `).all();
  const bodyOf = db.prepare("SELECT CAST(body AS BLOB) AS body FROM docs_fts WHERE id = ?");
  const present = new Set();
  const matches = [];
  for (const row of rows) {
    const source = wholeText(row.source);
    if (isMembraneSource(source) || PROJECT_FILE_SOURCES.has(source)) continue;
    present.add(row.id);
    let entry = cache.get(row.id);
    if (entry?.key !== String(row.content_hash)) {
      entry = entryFor(row, wholeText(bodyOf.get(row.id)?.body));
      cache.set(row.id, entry);
    }
    const value = score(question, terms, entry);
    if (value > 0) matches.push({ path: entry.path, score: value, preview: entry.preview });
  }
  for (const id of cache.keys()) if (!present.has(id)) cache.delete(id);
  return matches.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path)).slice(0, limit);
}
