/**
 * What the Knowledge Galaxy is drawn from, read out of the search index: one
 * node per entity — a skill's registry entry and its card folded into one, as
 * search folds them — with its sparse vector as a float32 row, its BGE-M3 vector
 * when the index has one, a preview, and the wikilinks of its notes.
 *
 * A port of `galaxy_export` from `search-index/search_cli.py`. The helper wrote
 * a manifest and two float32 files for the server to read back; this hands the
 * same manifest and the same bytes over in memory, in the shape
 * `parseGalaxyExport` reads (`src/core/galaxy.mjs`).
 */
import { GALAXY_EXPORT_SCHEMA } from "./galaxy.mjs";
import { cleanPreview } from "./search-documents.mjs";
import { canonicalResultKey, resultEntityPriority } from "./search-query.mjs";
import { SEMANTIC_DIMENSIONS } from "./search-semantic.mjs";
import { codePointLength, isPythonWhitespace, PYTHON_WHITESPACE_CLASS, pythonStrip, splitLines } from "./python-compat.mjs";
import { tableExists, wholeText } from "./search-sqlite.mjs";

/** Most wikilinks one node keeps. */
export const GALAXY_MAX_LINKS_PER_NOTE = 200;

/** Width of a BGE-M3 vector; a row of any other width is left out, not padded. */
const DENSE_DIMENSIONS = 1024;

const WS = PYTHON_WHITESPACE_CLASS;
const WIKILINK = /\[\[([^[\]|#^\n]+)/g;
const FRONTMATTER = new RegExp(`^\\uFEFF?---[${WS}]*\\n[\\s\\S]*?\\n---[${WS}]*(?:\\n|$)`, "u");
// Python's `^` under MULTILINE starts a line after "\n" only, and its `\d` is any decimal digit.
const MARKDOWN_CLEANUPS = [
  [/!?\[\[([^\]|]*\|)?([^\]]*)\]\]/g, (_match, _alias, text) => text.split("/").at(-1)],
  [/!?\[([^\]]*)\]\([^)]*\)/g, (_match, text) => text],
  [new RegExp(`(?<=^|\\n)[${WS}]{0,3}(?:#{1,6}|>|[-*+]|\\p{Nd}+\\.)[${WS}]+`, "gu"), () => ""],
  [/(\*\*|__|`|~~)/g, () => ""]
];

/** Markdown as a reader sees it: link text, no emphasis marks or bullets. */
export function markdownToText(text) {
  let result = text;
  for (const [pattern, replace] of MARKDOWN_CLEANUPS) result = result.replace(pattern, replace);
  return result;
}

function pythonLstrip(text) {
  let start = 0;
  while (start < text.length && isPythonWhitespace(text.charCodeAt(start))) start += 1;
  return text.slice(start);
}

/**
 * What a document says, in a line or two. A note's stored preview starts with
 * its frontmatter, so it is read again from the body without it; a registry
 * skill's body is its metadata one field per line, and the longest line — its
 * description or its use-when — says the most.
 *
 * @param {string} body
 * @param {string} stored - The index's own preview, the fallback.
 * @param {boolean} isNote
 * @returns {string}
 */
export function galaxyPreview(body, stored, isNote = true) {
  if (!body) return stored;
  if (!isNote) {
    const lines = splitLines(body).map(pythonStrip).filter((line) => codePointLength(line) >= 40);
    if (!lines.length) return stored;
    const longest = lines.reduce((best, line) => (codePointLength(line) > codePointLength(best) ? line : best));
    return cleanPreview(markdownToText(longest), 240);
  }
  let text = pythonLstrip(body.replace(FRONTMATTER, ""));
  // The title is shown beside the preview already.
  if (text.startsWith("# ")) text = text.includes("\n") ? text.slice(text.indexOf("\n") + 1) : "";
  return cleanPreview(markdownToText(text), 240) || stored;
}

/**
 * Distinct `[[target]]` names in order of first appearance, at most
 * {@link GALAXY_MAX_LINKS_PER_NOTE}.
 *
 * @param {string} body
 * @returns {string[]}
 */
export function noteWikilinks(body) {
  const seen = [];
  for (const match of String(body ?? "").matchAll(WIKILINK)) {
    const target = pythonStrip(match[1]);
    if (target && !seen.includes(target)) {
      seen.push(target);
      if (seen.length >= GALAXY_MAX_LINKS_PER_NOTE) break;
    }
  }
  return seen;
}

/** `int(text)` for the decimal integers Python reads: signs, padding whitespace, digit underscores. */
function pythonInt(text) {
  const match = /^([+-]?)(\d+(?:_\d+)*)$/.exec(pythonStrip(text));
  return match ? Number(`${match[1]}${match[2].replaceAll("_", "")}`) : null;
}

/**
 * The stored sparse vector as a float32 row of {@link SEMANTIC_DIMENSIONS}, key
 * by key as the helper's `semantic_row` read it: a key that is not an integer,
 * or a dimension outside the space, is passed over and the rest kept; text
 * that is not JSON is an empty row.
 *
 * @param {string} vectorJson
 * @param {Float32Array} row - Zeroed, {@link SEMANTIC_DIMENSIONS} long.
 */
export function semanticRow(vectorJson, row) {
  let features;
  try {
    features = JSON.parse(vectorJson || "{}");
  } catch {
    return;
  }
  if (!features || typeof features !== "object" || Array.isArray(features)) return;
  for (const [key, weight] of Object.entries(features)) {
    const dimension = pythonInt(key);
    if (dimension !== null && dimension >= 0 && dimension < SEMANTIC_DIMENSIONS) row[dimension] = Number(weight);
  }
}

/** Documents grouped as search collapses them, the preferred one first, the rest in order. */
export function galaxyEntities(documents) {
  const groups = new Map();
  for (const item of documents) {
    const key = canonicalResultKey(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return [...groups.values()].map((members) => {
    let best = 0;
    for (let index = 1; index < members.length; index += 1) {
      if (resultEntityPriority(members[index]) > resultEntityPriority(members[best])) best = index;
    }
    return [members[best], ...members.filter((_, index) => index !== best)];
  });
}

/**
 * The export, read in one pass over the index.
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @returns {{ manifest: object, semanticBytes: Uint8Array, denseBytes: Uint8Array, summary: object }}
 */
export function exportGalaxy(db) {
  if (!tableExists(db, "documents") || !tableExists(db, "semantic_vectors")) {
    throw new Error("The search index predates the galaxy export. Rebuild it first.");
  }
  const documents = db.prepare(`
    SELECT id, CAST(scope AS BLOB) AS scope, CAST(title AS BLOB) AS title, CAST(path AS BLOB) AS path,
      CAST(source AS BLOB) AS source, CAST(categories AS BLOB) AS categories, CAST(preview AS BLOB) AS preview
    FROM documents ORDER BY path, id
  `).all().map((row) => ({
    id: String(row.id),
    scope: wholeText(row.scope),
    title: wholeText(row.title),
    path: wholeText(row.path),
    source: wholeText(row.source),
    categories: wholeText(row.categories),
    preview: wholeText(row.preview)
  }));
  const semantic = new Map(db.prepare("SELECT id, vector FROM semantic_vectors").all().map((row) => [String(row.id), wholeText(row.vector)]));
  const dense = new Map();
  if (tableExists(db, "dense_vectors")) {
    for (const row of db.prepare("SELECT id, vector, dimensions FROM dense_vectors").all()) {
      const blob = row.vector instanceof Uint8Array ? row.vector : new Uint8Array(row.vector ?? []);
      if (Number(row.dimensions || 0) === DENSE_DIMENSIONS && blob.byteLength === 4 * DENSE_DIMENSIONS) dense.set(String(row.id), blob);
    }
  }
  const bodies = new Map();
  if (tableExists(db, "docs_fts")) {
    for (const row of db.prepare("SELECT id, CAST(body AS BLOB) AS body FROM docs_fts").all()) bodies.set(String(row.id), wholeText(row.body));
  }
  const denseModel = tableExists(db, "meta")
    ? String(db.prepare("SELECT value FROM meta WHERE key = 'dense_model'").get()?.value ?? "")
    : "";

  const entities = galaxyEntities(documents);
  const semanticRows = new Float32Array(entities.length * SEMANTIC_DIMENSIONS);
  const denseRows = [];
  const nodes = [];
  let collapsed = 0;
  let linkCount = 0;
  entities.forEach((members, position) => {
    const head = members[0];
    collapsed += members.length - 1;
    semanticRow(semantic.get(head.id), semanticRows.subarray(position * SEMANTIC_DIMENSIONS, (position + 1) * SEMANTIC_DIMENSIONS));
    // The preferred document's vector when it has one; a card's when only the
    // card was embedded, since that places the skill too.
    const owner = members.find((member) => dense.has(member.id));
    let denseIndex = -1;
    if (owner) {
      denseIndex = denseRows.length;
      denseRows.push(dense.get(owner.id));
    }
    const links = [];
    for (const member of members) {
      if (member.source !== "vault-note") continue;
      for (const link of noteWikilinks(bodies.get(member.id) ?? "")) if (!links.includes(link)) links.push(link);
    }
    links.length = Math.min(links.length, GALAXY_MAX_LINKS_PER_NOTE);
    linkCount += links.length;
    nodes.push({
      id: head.id,
      title: head.title,
      path: head.path,
      scope: head.scope,
      source: head.source,
      categories: head.categories,
      preview: galaxyPreview(bodies.get(head.id) ?? "", head.preview, head.source === "vault-note"),
      also: members.slice(1).map((member) => member.path),
      dense: denseIndex,
      links
    });
  });

  const denseBytes = new Uint8Array(denseRows.length * 4 * DENSE_DIMENSIONS);
  denseRows.forEach((blob, index) => denseBytes.set(blob, index * 4 * DENSE_DIMENSIONS));
  const manifest = {
    schema: GALAXY_EXPORT_SCHEMA,
    document_count: nodes.length,
    collapsed_documents: collapsed,
    semantic_dimensions: SEMANTIC_DIMENSIONS,
    dense_dimensions: denseRows.length ? DENSE_DIMENSIONS : 0,
    dense_documents: denseRows.length,
    dense_model: denseRows.length ? denseModel : "",
    nodes
  };
  return {
    manifest,
    semanticBytes: new Uint8Array(semanticRows.buffer),
    denseBytes,
    summary: {
      schema: GALAXY_EXPORT_SCHEMA,
      document_count: nodes.length,
      collapsed_documents: collapsed,
      dense_documents: denseRows.length,
      wikilinks: linkCount
    }
  };
}
