/**
 * The Knowledge Galaxy page: one self-contained HTML file.
 *
 * The page carries its own data, its own viewer and its own styles, and loads
 * nothing: it opens from disk, works offline, and a Content-Security-Policy
 * made of the hashes of its two inline blocks forbids it any request at all —
 * the same promise the server makes, kept by the browser. Vault text reaches
 * the page only as JSON inside a data block, escaped so that no title can close
 * it, and the viewer writes it with `textContent`, never as markup.
 *
 * The viewer is the modules under `src/galaxy/`, read by the caller and joined
 * here into the one inline module the page runs (`inlineModules`); this module
 * only assembles.
 */
import { createHash } from "node:crypto";
import { EDGE_LINK } from "./galaxy-graph.mjs";

/** Version of the data block the viewer reads. */
export const GALAXY_FORMAT = 1;

/** Longest preview the page carries per document. */
const PREVIEW_LIMIT = 240;

/**
 * Whether Obsidian can open a document: a Markdown file inside the vault. A
 * project file the index reads from outside the vault has an absolute path.
 */
export function isVaultMarkdown(value) {
  const text = String(value || "");
  return /\.md$/i.test(text) && !text.startsWith("/") && !text.startsWith("\\") && !/^[A-Za-z]:[\\/]/.test(text);
}

/** Base64 of a typed array's bytes. */
function base64(typed) {
  return Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength).toString("base64");
}

/** Index of each distinct value, in order of first appearance. */
function lookup(values) {
  const table = [];
  const index = new Map();
  const codes = values.map((value) => {
    const key = String(value || "");
    if (!index.has(key)) {
      index.set(key, table.length);
      table.push(key);
    }
    return index.get(key);
  });
  return { table, codes };
}

/**
 * The data block the viewer reads: columns rather than objects, and the
 * numbers as base64 typed arrays, so a large vault stays a few megabytes.
 *
 * @param {object} input
 * @param {Array<{ id: string, title: string, path: string, scope: string, source: string, preview?: string }>} input.nodes
 * @param {{ source: Uint32Array, target: Uint32Array, weight: Float32Array, kind: Uint8Array }} input.edges
 * @param {Float32Array} input.positions - nodes × 3.
 * @param {ArrayLike<number>} input.community
 * @param {Array<{ label: string, size: number }>} input.clusters
 * @param {object} [input.meta] - `title`, `vault`, `obsidian_vault`, `generated_at`, `space`, `counts`.
 * @returns {object}
 */
export function buildGalaxyModel({ nodes, edges, positions, community, clusters, meta = {} }) {
  const scopes = lookup(nodes.map((node) => node.scope));
  const sources = lookup(nodes.map((node) => node.source));
  const pairs = new Uint32Array(edges.source.length * 2);
  const weights = new Uint8Array(edges.source.length);
  for (let e = 0; e < edges.source.length; e += 1) {
    pairs[e * 2] = edges.source[e];
    pairs[e * 2 + 1] = edges.target[e];
    weights[e] = Math.round(Math.max(0, Math.min(1, edges.weight[e])) * 255);
  }
  return {
    format: GALAXY_FORMAT,
    title: String(meta.title || "Knowledge Galaxy"),
    vault: String(meta.vault || ""),
    obsidian_vault: String(meta.obsidian_vault || ""),
    generated_at: String(meta.generated_at || ""),
    space: String(meta.space || ""),
    counts: meta.counts ?? {},
    scopes: scopes.table,
    sources: sources.table,
    nodes: {
      id: nodes.map((node) => String(node.id || "").slice(0, 12)),
      title: nodes.map((node) => String(node.title || "")),
      path: nodes.map((node) => String(node.path || "")),
      scope: scopes.codes,
      source: sources.codes,
      cluster: Array.from(community),
      preview: nodes.map((node) => String(node.preview || "").slice(0, PREVIEW_LIMIT)),
      note: nodes.map((node) => (isVaultMarkdown(node.path) ? 1 : 0))
    },
    positions: base64(Float32Array.from(positions)),
    edges: {
      pairs: base64(pairs),
      weight: base64(weights),
      kind: base64(Uint8Array.from(edges.kind)),
      link_kind: EDGE_LINK
    },
    clusters: clusters.map((cluster) => ({ label: String(cluster.label || ""), size: Number(cluster.size) || 0 }))
  };
}

/**
 * JSON that is safe inside a `<script type="application/json">` block: nothing
 * in it can end the block or open a comment, and the two line separators that
 * JavaScript once refused are escaped too.
 */
export function embedJson(value) {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll(" ", "\\u2028")
    .replaceAll(" ", "\\u2029");
}

/** The CSP source expression for an inline block. */
function hashSource(text) {
  return `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;
}

/** Escape text for an HTML text node or a double-quoted attribute. */
function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}

const STYLES = `
:root {
  color-scheme: dark;
  --space: #04050a;
  --panel: rgba(12, 15, 26, 0.86);
  --panel-edge: rgba(148, 163, 214, 0.18);
  --text: #e6e9f2;
  --muted: #8d95ab;
  --accent: #9ec5ff;
  --focus: #ffd166;
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; overflow: hidden; background: var(--space); color: var(--text); }
canvas#scene { position: fixed; inset: 0; width: 100%; height: 100%; display: block; outline: none; cursor: grab; }
canvas#scene.dragging { cursor: grabbing; }
canvas#scene.steering { cursor: crosshair; }
#labels { position: fixed; inset: 0; pointer-events: none; overflow: hidden; }
.star-label, .cluster-label { position: absolute; left: 0; top: 0; white-space: nowrap; will-change: transform; }
.star-label { font-size: 11px; color: rgba(230, 233, 242, 0.82); text-shadow: 0 0 3px #000, 0 0 6px #000; padding-left: 7px; }
.star-label.focus { color: var(--focus); font-weight: 600; font-size: 12px; }
.cluster-label { font-size: 13px; letter-spacing: 0.14em; text-transform: uppercase; font-weight: 600; text-shadow: 0 0 6px #000; transform-origin: 0 0; }
.panel { position: fixed; background: var(--panel); border: 1px solid var(--panel-edge); border-radius: 10px; backdrop-filter: blur(6px); }
#search-panel { top: 16px; left: 16px; width: min(360px, calc(100vw - 32px)); padding: 8px; }
#search { width: 100%; background: transparent; border: 0; color: var(--text); font-size: 15px; padding: 6px 8px; outline: none; }
#search::placeholder { color: var(--muted); }
#search-count { color: var(--muted); font-size: 12px; padding: 0 8px 4px; }
#results { list-style: none; margin: 0; padding: 0; max-height: 50vh; overflow-y: auto; }
#results li { padding: 6px 8px; border-radius: 6px; cursor: pointer; display: flex; gap: 8px; align-items: baseline; }
#results li[aria-selected="true"], #results li:hover { background: rgba(158, 197, 255, 0.12); }
.dot { width: 8px; height: 8px; border-radius: 50%; flex: none; display: inline-block; }
.result-path { color: var(--muted); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.result-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#toolbar { top: 16px; right: 16px; padding: 6px; display: flex; gap: 4px; flex-wrap: wrap; justify-content: flex-end; max-width: calc(100vw - 32px); }
#toolbar button, #details button, #details a.button { background: rgba(158, 197, 255, 0.08); color: var(--text); border: 1px solid var(--panel-edge); border-radius: 6px; padding: 5px 9px; font: inherit; font-size: 12px; cursor: pointer; text-decoration: none; }
#toolbar button[aria-pressed="true"] { border-color: var(--accent); color: var(--accent); }
#toolbar button:focus-visible, #details button:focus-visible, #details a.button:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
#stats { position: fixed; top: 60px; right: 18px; color: var(--muted); font-size: 11px; text-align: right; text-shadow: 0 0 4px #000; pointer-events: none; }
#hint { position: fixed; left: 16px; bottom: 14px; color: var(--muted); font-size: 12px; text-shadow: 0 0 4px #000; pointer-events: none; }
#speed { position: fixed; right: 16px; bottom: 14px; color: var(--muted); font-size: 12px; text-shadow: 0 0 4px #000; pointer-events: none; }
#details { top: 104px; right: 16px; width: min(380px, calc(100vw - 32px)); max-height: calc(100vh - 150px); overflow-y: auto; padding: 14px 16px; }
#details h2 { font-size: 17px; margin: 0 28px 8px 0; line-height: 1.3; overflow-wrap: anywhere; }
#details .close { position: absolute; top: 8px; right: 8px; padding: 2px 8px; font-size: 14px; }
#details .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
#details .chip { font-size: 11px; color: var(--muted); border: 1px solid var(--panel-edge); border-radius: 999px; padding: 2px 8px; display: inline-flex; gap: 6px; align-items: center; }
#details .path { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; color: var(--muted); overflow-wrap: anywhere; margin-bottom: 8px; user-select: text; }
#details p { font-size: 13px; line-height: 1.5; margin: 0 0 10px; color: #c7ccda; overflow-wrap: anywhere; }
#details .actions { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 12px; }
#details h3 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.1em; color: var(--muted); margin: 12px 0 6px; }
#details ul { list-style: none; margin: 0; padding: 0; }
#details li { padding: 4px 6px; border-radius: 6px; cursor: pointer; display: flex; gap: 8px; align-items: baseline; font-size: 13px; }
#details li:hover, #details li:focus-visible { background: rgba(158, 197, 255, 0.12); outline: none; }
#details li .score { margin-left: auto; color: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
#tooltip { position: fixed; pointer-events: none; padding: 4px 8px; background: var(--panel); border: 1px solid var(--panel-edge); border-radius: 6px; font-size: 12px; max-width: 360px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#help { top: 50%; left: 50%; transform: translate(-50%, -50%); padding: 18px 22px; width: min(560px, calc(100vw - 32px)); max-height: calc(100vh - 32px); overflow-y: auto; }
#help h2 { margin: 0 0 10px; font-size: 16px; }
#help table { border-collapse: collapse; width: 100%; font-size: 13px; }
#help td { padding: 4px 6px; vertical-align: top; }
#help kbd { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; border: 1px solid var(--panel-edge); border-bottom-width: 2px; border-radius: 4px; padding: 1px 6px; background: rgba(255,255,255,0.04); white-space: nowrap; }
#help p { color: var(--muted); font-size: 12px; line-height: 1.5; margin: 10px 0 0; }
#steer { position: fixed; inset: 0; pointer-events: none; }
#fallback { position: fixed; inset: 0; display: grid; place-items: center; padding: 24px; text-align: center; color: var(--muted); }
[hidden] { display: none !important; }
@media (max-width: 640px) {
  #search-panel { top: 12px; left: 12px; right: 12px; width: auto; }
  #toolbar { top: 66px; left: 12px; right: 12px; max-width: none; justify-content: flex-start; }
  #toolbar button { font-size: 11px; padding: 4px 7px; }
  #hint { display: none; }
  #details { top: auto; left: 12px; right: 12px; bottom: 12px; width: auto; max-height: 45vh; }
  #stats { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  * { scroll-behavior: auto !important; }
}
`;

/** A static import of a sibling module: `import { a, b } from "./file.mjs";`, on one line or several. */
const SIBLING_IMPORT = /^import\s*\{[^}]*\}\s*from\s*"\.\/([\w.-]+)";[ \t]*$/gm;

/**
 * Join the viewer's modules into one module source.
 *
 * Each module imports its siblings, so each can be read and tested on its own;
 * the page cannot fetch a second file, so the imports come out and the bodies
 * go in one after another. That is sound only while every import names a
 * module in the list and every top-level name is unique — a clash is a syntax
 * error the viewer test catches with `node --check` — and while a module comes
 * after the ones it uses.
 *
 * @param {Array<{ name: string, source: string }>} modules - Dependencies first.
 * @returns {string}
 */
export function inlineModules(modules) {
  const names = modules.map((module) => module.name);
  return modules.map(({ name, source }, position) => {
    const body = String(source).replace(SIBLING_IMPORT, (statement, target) => {
      const at = names.indexOf(target);
      if (at < 0) throw new Error(`${name} imports ${target}, which is not part of the viewer.`);
      if (at >= position) throw new Error(`${name} imports ${target}, which must come before it.`);
      return "";
    });
    if (/^\s*import[\s{*"']/m.test(body)) throw new Error(`${name} has an import the page cannot inline.`);
    return `// ${name}\n${body.trim()}\n`;
  }).join("\n");
}

/**
 * The whole page.
 *
 * @param {{ model: object, clientSource: string }} input - `clientSource` is
 *   one module, as `inlineModules` returns it.
 * @returns {{ html: string, bytes: number }}
 */
export function renderGalaxyPage({ model, clientSource }) {
  const source = String(clientSource || "");
  if (!source.trim()) throw new Error("Galaxy viewer source is empty.");
  // The viewer is inlined verbatim; a closing tag inside it would end the
  // block early and leave the rest as markup.
  if (/<\/script/i.test(source) || /<!--/.test(source)) {
    throw new Error("Galaxy viewer source contains a script or comment delimiter.");
  }
  const script = `${source}\nbootGalaxy(document.getElementById("galaxy-data"));\n`;
  const policy = [
    "default-src 'none'",
    `script-src ${hashSource(script)}`,
    `style-src ${hashSource(STYLES)}`,
    "base-uri 'none'",
    "form-action 'none'"
  ].join("; ");
  const title = model.vault ? `${model.title} — ${model.vault}` : model.title;
  const html = [
    "<!doctype html>",
    "<html lang=\"en\">",
    "<head>",
    "<meta charset=\"utf-8\">",
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
    `<meta http-equiv="Content-Security-Policy" content="${escapeHtml(policy)}">`,
    "<meta name=\"color-scheme\" content=\"dark\">",
    `<title>${escapeHtml(title)}</title>`,
    `<style>${STYLES}</style>`,
    "</head>",
    "<body>",
    `<script type="application/json" id="galaxy-data">${embedJson(model)}</script>`,
    `<script type="module">${script}</script>`,
    "</body>",
    "</html>",
    ""
  ].join("\n");
  return { html, bytes: Buffer.byteLength(html, "utf8") };
}
