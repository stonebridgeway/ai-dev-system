/**
 * Text primitives shared by the runtime and the extracted skill modules.
 *
 * Nothing here touches the vault, the clock or the process: every function maps
 * a value to a string. They live in `src/core` so `mcp-stdio.mjs` and the
 * modules pulled out of it (`skill-cards.mjs`, `skill-registry-docs.mjs`, the
 * skills extension) share one definition instead of each carrying a copy.
 */

/** Drop a UTF-8 byte order mark so `JSON.parse` and Markdown parsing behave. */
export function stripBom(text) {
  return text.replace(/^\uFEFF/, "");
}

/** Collapse whitespace to single spaces and trim, for one-line descriptions. */
export function cleanDescription(value) {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

/**
 * One-line, table-safe excerpt: whitespace collapsed, pipes neutralised so the
 * value cannot break a Markdown table, truncated with an ellipsis.
 */
export function shorten(value, max) {
  const cleaned = cleanDescription(value).replaceAll("|", "/");
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, max - 3)}...`;
}

/** Lowercase, hyphenated, filesystem-safe path segment. */
export function slugPart(value, fallback = "item") {
  const slug = String(value || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (slug || fallback).slice(0, 90);
}

/** Quote a value for a YAML frontmatter scalar. JSON quoting is valid YAML. */
export function yamlString(value) {
  return JSON.stringify(String(value ?? ""));
}

/**
 * Escape one value for a Markdown table cell: pipes escaped so they cannot end
 * the cell, newlines folded so they cannot end the row.
 */
export function mdCell(value) {
  return String(value ?? "").replaceAll("|", "\\|").replace(/\r?\n/g, " ");
}

/**
 * Flatten a list-or-string argument into the comma-separated form the search
 * helpers take on the command line.
 */
export function csvValue(value) {
  if (Array.isArray(value)) return value.filter(Boolean).join(",");
  return String(value ?? "");
}

/**
 * Render a titled Markdown table.
 *
 * @param {string} title - Heading placed above the table.
 * @param {Iterable<*>} rows - One row per item.
 * @param {Array<{ title: string, value: (row: *) => string }>} columns
 * @returns {string}
 */
export function markdownTable(title, rows, columns) {
  const output = [`# ${title}`, ""];
  output.push(`| ${columns.map((column) => column.title).join(" | ")} |`);
  output.push(`| ${columns.map(() => "---").join(" | ")} |`);
  for (const row of rows) {
    output.push(`| ${columns.map((column) => column.value(row)).join(" | ")} |`);
  }
  output.push("");
  return output.join("\n");
}

/**
 * Keyword match score for a query against a set of fields.
 *
 * One point per query term found anywhere in the joined text, plus three when a
 * single field contains the whole query. Zero means "no match at all", which
 * every caller uses as its filter.
 *
 * @param {string} query
 * @param {string[]} fields
 * @returns {number}
 */
export function scoreText(query, fields) {
  const q = query.toLowerCase().trim();
  if (!q) return 0;
  const terms = q.split(/\s+/).filter(Boolean);
  const text = fields.join(" ").toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (text.includes(term)) score += 1;
  }
  if (fields.some((field) => field.toLowerCase().includes(q))) score += 3;
  return score;
}

/**
 * Coerce a tool argument to a list of non-empty strings. Accepts an array or a
 * comma-separated string, so a client may send either.
 *
 * @param {string[]|string|null|undefined} value
 * @returns {string[]}
 */
export function toStringList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item ?? "").trim()).filter(Boolean);
  if (value === undefined || value === null || value === "") return [];
  return String(value).split(",").map((item) => item.trim()).filter(Boolean);
}
