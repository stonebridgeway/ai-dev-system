/**
 * What the search index is built from: the vault's notes, the skill registry,
 * and the project files the project cards point at — collected, identified and
 * hashed exactly as `search-index/search_cli.py` did.
 *
 * Exactly, because three things outlive the writer that made them. A document's
 * id keys its stored dense vector; the passage hash decides whether that vector
 * is reused or embedded again; and the content hash and the fingerprint decide
 * whether an index 2.x built is current. A Node collector that disagreed on any
 * of them would make every upgraded install rebuild and re-embed from scratch.
 * The order is Python's too — `os.walk` takes directories in the order the file
 * system lists them, which `fs.opendirSync` reproduces and `readdirSync` (sorted)
 * does not — so ties in ranking break the same way.
 *
 * Two departures, both where the Python helper failed outright: a document id
 * seen twice keeps its first document instead of aborting the rebuild on the
 * primary key, and a file that cannot be read is
 * skipped instead of ending the walk.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  collapseWhitespace,
  encodeUtf8,
  isPythonWhitespace,
  parsePythonJson,
  pythonStr,
  pythonStrip,
  pythonTruthy,
  PYTHON_WHITESPACE_CLASS,
  readPythonText,
  sliceCodePoints,
  splitLines
} from "./python-compat.mjs";

/** Directories the walk never enters, by exact name. */
export const SKIP_DIRS = new Set([
  ".git", ".obsidian", "node_modules", "dist", "build", ".next", ".nuxt", ".svelte-kit",
  ".venv", "venv", "env", "__pycache__"
]);

/** Characters of a document kept as its preview. */
export const PREVIEW_LIMIT = 360;

/** Characters of a passage embedded for a dense vector, unless the index says otherwise. */
export const DEFAULT_DENSE_TEXT_LIMIT = 1200;

const SKILL_REGISTRY = ["03-skills-catalog", "registries", "skills.index.json"];
const PROJECTS_DIR = ["02-knowledge", "Projects"];

/** The files of a project the index reads, with how each is filed. */
const PROJECT_FILES = [
  [[".ai-dev", "project-brief.md"], "project-brief", "project, handoff"],
  [[".ai-dev", "project-map.md"], "project-map", "project"],
  [[".ai-dev", "quality-gate.md"], "project-quality-gate", "project, quality"],
  [["AGENTS.md"], "project-agents", "project, rules"]
];

/** Sources of the documents read from project repositories rather than the vault. */
export const PROJECT_FILE_SOURCES = new Set(PROJECT_FILES.map(([, source]) => source));

/** Folders whose notes are generated from other notes, or are the index's own files. */
const SKIPPED_PREFIXES = [
  "03-skills-catalog/groups/all-skills/",
  "03-skills-catalog/sources/",
  "03-skills-catalog/registries/",
  "09-mcp/search-index/"
];

/** Whether a note is left out of the index. */
export function shouldSkipMarkdown(rel) {
  const lower = rel.toLowerCase();
  return SKIPPED_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

const WS = PYTHON_WHITESPACE_CLASS;
const QA_WORD = new RegExp(`(^|[${WS}._-])qa($|[${WS}._-])`);

/**
 * The scope a note is searched under, from where it lives and what it is called.
 *
 * @param {string} rel - Vault-relative, with forward slashes.
 * @returns {"projects"|"workflows"|"quality"|"skills"|"knowledge"}
 */
export function inferScope(rel) {
  const lower = rel.toLowerCase();
  const name = rel.slice(rel.lastIndexOf("/") + 1).toLowerCase();
  if (lower.startsWith("02-knowledge/projects/")) return "projects";
  if (lower.startsWith("04-agent-workflows/") || lower.startsWith("06-prompts/")) return "workflows";
  if (lower.startsWith("07-quality-gates/") || name.includes("quality") || name.includes("gate") || QA_WORD.test(name)) return "quality";
  if (lower.startsWith("03-skills-catalog/")) return "skills";
  return "knowledge";
}

/**
 * The text of the first `# ` heading, or `fallback`.
 *
 * @param {string} text
 * @param {string} fallback
 * @returns {string}
 */
export function firstHeading(text, fallback) {
  for (const line of splitLines(text)) {
    const stripped = pythonStrip(line);
    if (stripped.length > 1 && stripped[0] === "#" && isPythonWhitespace(stripped.charCodeAt(1))) {
      let start = 2;
      while (isPythonWhitespace(stripped.charCodeAt(start))) start += 1;
      return stripped.slice(start);
    }
  }
  return fallback;
}

/** The first {@link PREVIEW_LIMIT} characters, whitespace collapsed. */
export function cleanPreview(text, limit = PREVIEW_LIMIT) {
  return sliceCodePoints(pythonStrip(collapseWhitespace(text)), limit);
}

const sha = (algorithm, text) => crypto.createHash(algorithm).update(encodeUtf8(text)).digest("hex");

/** `sha_id(*parts)`: SHA-1 of the parts joined by U+001F. */
export function shaId(...parts) {
  return sha("sha1", parts.map(pythonStr).join("\x1f"));
}

/** What a document says, as one hash: every field a search reads. */
export function documentContentHash(doc) {
  return sha("sha256", [doc.scope, doc.title, doc.path, doc.source, doc.categories, doc.body].map(pythonStr).join("\x1f"));
}

/**
 * One hash over every document's id and content, in id order: the index is
 * current when its stored fingerprint is this one.
 *
 * @param {Array<{ id: string, content_hash: string }>} docs
 * @returns {string}
 */
export function sourceFingerprint(docs) {
  const hash = crypto.createHash("sha256");
  const sorted = [...docs].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  for (const doc of sorted) {
    hash.update(encodeUtf8(doc.id));
    hash.update("\x1f");
    hash.update(doc.content_hash, "ascii");
    hash.update("\n");
  }
  return hash.digest("hex");
}

/** `os.stat(path).st_mtime`: seconds plus nanoseconds, as CPython adds them. */
function pythonMtime(filePath) {
  const { mtimeNs } = fs.statSync(filePath, { bigint: true });
  return Number(mtimeNs / 1_000_000_000n) + Number(mtimeNs % 1_000_000_000n) * 1e-9;
}

/** How recently a file may have changed and still be trusted by its stat alone. */
const RACY_WINDOW_MS = 2_000;

/**
 * A memory of what each source file produced, keyed by its stat, for status
 * checks: those run every second or so while searches come in and need only
 * ids and hashes, and re-reading every note and the 9 MB skill registry for
 * them is most of their cost. A file whose inode, size, mtime and ctime are all
 * unchanged has not changed — except within one timestamp tick, so a file
 * whose mtime or ctime is in the last two seconds is not remembered.
 *
 * @param {{ now?: () => number }} [options] - The clock the two seconds are measured on.
 * @returns {{ entries: Map<string, { key: string, value: unknown }>, visited: Set<string>, now: () => number }}
 */
export function createDocumentCache({ now = Date.now } = {}) {
  return { entries: new Map(), visited: new Set(), now };
}

/**
 * `(kind, filePath, compute) => compute()`, through `cache` when there is one.
 * The kind keeps apart what one file is read as: a project card is a note too.
 */
function memoFor(cache) {
  if (!cache) return (_kind, _filePath, compute) => compute();
  return (kind, filePath, compute) => {
    const entry = `${kind}:${filePath}`;
    cache.visited.add(entry);
    let stat;
    try {
      stat = fs.statSync(filePath, { bigint: true });
    } catch {
      return compute();
    }
    const key = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    const hit = cache.entries.get(entry);
    if (hit?.key === key) return hit.value;
    const value = compute();
    // Both times have to be out of the window: a file rewritten to the same
    // size with its old mtime put back differs from the cached one only by
    // ctime, and where ctime moves in coarse ticks (Linux before 6.13, NTFS)
    // a rewrite inside one tick would otherwise keep the old content.
    const newest = stat.mtimeNs > stat.ctimeNs ? stat.mtimeNs : stat.ctimeNs;
    if ((cache.now ?? Date.now)() - Number(newest / 1_000_000n) > RACY_WINDOW_MS) cache.entries.set(entry, { key, value });
    else cache.entries.delete(entry);
    return value;
  };
}

const direct = (_kind, _filePath, compute) => compute();
const asIs = (doc) => doc;

/** A document without its body: what a status check keeps. */
function withoutBody(doc) {
  const { body: _body, ...light } = doc;
  return light;
}

/** A document as collected: its fields, then the hash of them. */
function finished(doc) {
  doc.content_hash = documentContentHash(doc);
  return doc;
}

/** `Path(name).stem`. */
function stem(name) {
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(0, dot) : name;
}

/** Whether a directory entry is a directory, a symlink to one counting as one (`DirEntry.is_dir()`). */
function entryIsDirectory(entry, fullPath) {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return fs.statSync(fullPath).isDirectory();
  } catch {
    return false;
  }
}

function realPathOrEmpty(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return "";
  }
}

/**
 * `os.walk(root)` top-down, pruning {@link SKIP_DIRS}: each directory's files
 * in listing order, then its subdirectories, never through a symlink.
 *
 * On Windows `os.walk` does go through an NTFS junction — Python counts only
 * true symlinks as links — while Node reports junctions and symlinks alike as
 * links. Leaving them out would drop the notes of a vault that links folders
 * in with `mklink /J`, vectors and all, on the first refresh after an upgrade;
 * so on Windows a linked folder is entered too. A real folder always is, as
 * `os.walk` enters it, so a junction to a folder of the vault never takes the
 * folder's own notes away from it; both paths are
 * indexed, as they were by Python. The one link not followed is one into its
 * own ancestry, which `os.walk` would follow until the path grew too long. A
 * true directory symlink is entered too — Node cannot tell it from a
 * junction; Python would not.
 *
 * A directory every note of which {@link shouldSkipMarkdown} would drop is not
 * entered at all. The result is the same, and the vendored skill sources —
 * thousands of folders, not one of them indexed as a note — are not listed.
 *
 * @param {string} root
 * @param {{ platform?: string }} [options]
 * @returns {Generator<[string, string]>} each non-directory entry, as its directory and name
 */
function* walk(root, { platform = process.platform } = {}) {
  const followLinks = platform === "win32";
  // With links followed, each directory carries the real paths of the
  // directories it was reached through, to see a link back into them.
  const stack = [{ directory: root, ancestry: followLinks ? [realPathOrEmpty(root)] : [] }];
  while (stack.length) {
    const { directory, ancestry } = stack.pop();
    const directories = [];
    const files = [];
    let handle;
    try {
      handle = fs.opendirSync(directory);
      for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
        (entryIsDirectory(entry, path.join(directory, entry.name)) ? directories : files).push(entry.name);
      }
    } catch {
      // os.walk skips a directory it cannot list, and one it fails partway through.
      continue;
    } finally {
      handle?.closeSync();
    }
    for (const name of files) yield [directory, name];
    for (let index = directories.length - 1; index >= 0; index -= 1) {
      const name = directories[index];
      if (SKIP_DIRS.has(name)) continue;
      const child = path.join(directory, name);
      if (shouldSkipMarkdown(`${path.relative(root, child).split(path.sep).join("/")}/`)) continue;
      const isLink = fs.lstatSync(child, { throwIfNoEntry: false })?.isSymbolicLink();
      if (!followLinks) {
        if (!isLink) stack.push({ directory: child, ancestry });
        continue;
      }
      const real = realPathOrEmpty(child);
      if (!real || (isLink && ancestry.includes(real))) continue;
      stack.push({ directory: child, ancestry: [...ancestry, real] });
    }
  }
}

/** A regular file, following symlinks; FIFOs and devices would block or lie. */
function isReadableFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/** The document of one note, or null when it cannot be read. */
function noteDoc(filePath, rel, name) {
  if (!isReadableFile(filePath)) return null;
  let text;
  let mtime;
  try {
    text = readPythonText(filePath);
    mtime = pythonMtime(filePath);
  } catch {
    return null;
  }
  return finished({
    id: shaId("note", rel),
    scope: inferScope(rel),
    title: firstHeading(text, stem(name)),
    path: rel,
    source: "vault-note",
    categories: "",
    body: text,
    preview: cleanPreview(text),
    mtime
  });
}

/**
 * A note as an index records it — its content hash and modification time —
 * or null when it is not there or cannot be read. `search-index-owner.mjs`
 * compares them with an index's rows to tell the vault it was built from.
 *
 * @param {string} vaultRoot
 * @param {string} rel - The note's path in the vault, with `/`.
 * @returns {{ contentHash: string, mtime: number } | null}
 */
export function noteIdentity(vaultRoot, rel) {
  const doc = noteDoc(path.join(vaultRoot, ...rel.split("/")), rel, rel.slice(rel.lastIndexOf("/") + 1));
  return doc ? { contentHash: doc.content_hash, mtime: doc.mtime } : null;
}

/**
 * Every Markdown note of the vault, as `iter_markdown_docs` yields them.
 *
 * @param {string} vaultRoot
 * @param {Function} [memo] - From {@link memoFor}.
 * @param {(doc: object) => object} [finish]
 * @param {string} [platform] - Decides whether linked folders are entered (see `walk`).
 * @returns {object[]}
 */
export function loadNoteDocs(vaultRoot, memo = direct, finish = asIs, platform = process.platform) {
  return [...noteDocs(vaultRoot, memo, finish, platform)];
}

/** {@link loadNoteDocs}, one note at a time. */
function* noteDocs(vaultRoot, memo, finish, platform) {
  for (const [directory, name] of walk(vaultRoot, { platform })) {
    if (!name.toLowerCase().endsWith(".md")) continue;
    const filePath = path.join(directory, name);
    const rel = path.relative(vaultRoot, filePath).split(path.sep).join("/");
    if (shouldSkipMarkdown(rel)) continue;
    const doc = memo("note", filePath, () => {
      const built = noteDoc(filePath, rel, name);
      return built && finish(built);
    });
    if (doc) yield doc;
  }
}

/** What `for value in x` iterates for a JSON value; nothing where Python would raise. */
function pythonIterable(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return Array.from(value);
  if (value && typeof value === "object" && value.constructor === Object) return Object.keys(value);
  return [];
}

/** `" ".join(str(v) for v in item.get(key) or [])`, or with another separator. */
function joined(value, separator = " ") {
  return pythonTruthy(value) ? pythonIterable(value).map(pythonStr).join(separator) : "";
}

/** `str(item.get(key) or fallback)`. */
function field(value, fallback = "") {
  return pythonStr(pythonTruthy(value) ? value : fallback);
}

/** The text a registry entry is searched by, one fact per line, as `load_skill_docs` builds it. */
function skillBody(item, name, source, categories) {
  const present = (value) => value !== null && value !== undefined;
  return [
    name,
    source,
    field(item.type),
    field(item.primary_group),
    field(item.primary_group_label),
    joined(item.subgroups),
    joined(item.task_types),
    joined(item.platforms),
    joined(item.related_skills),
    joined(item.frameworks),
    joined(item.languages),
    joined(item.conflicts),
    field(item.maturity),
    field(item.trust_level),
    field(item.quality_status),
    field(item.quality_grade),
    present(item.quality_score) ? `quality score ${pythonStr(item.quality_score)}` : "",
    present(item.skill_schema_version) ? `skill schema ${pythonStr(item.skill_schema_version)}` : "",
    categories,
    field(item.description),
    field(item.use_when),
    joined(item.requires),
    field(item.compatibility),
    field(item.path)
  ].filter(Boolean).join("\n");
}

/** One document per entry of the registry file, or none when it cannot be read. */
function skillDocs(registry, finish) {
  let items;
  let mtime;
  try {
    items = parsePythonJson(readPythonText(registry));
    mtime = pythonMtime(registry);
  } catch {
    return [];
  }
  if (!Array.isArray(items)) return [];
  const docs = [];
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const name = field(item.name, "unnamed-skill");
    const source = field(item.source);
    const categories = joined(item.categories, ", ");
    const body = skillBody(item, name, source, categories);
    docs.push(finish(finished({
      id: shaId("skill", source, name),
      scope: "skills",
      title: name,
      path: `03-skills-catalog/${field(item.path)}`.replace(/\/+$/, ""),
      source,
      categories,
      body,
      preview: cleanPreview(body),
      mtime
    })));
  }
  return docs;
}

/**
 * One document per skill-registry entry, as `load_skill_docs` builds them.
 *
 * @param {string} vaultRoot
 * @param {Function} [memo] - From {@link memoFor}.
 * @param {(doc: object) => object} [finish]
 * @returns {object[]}
 */
export function loadSkillDocs(vaultRoot, memo = direct, finish = asIs) {
  const registry = path.join(vaultRoot, ...SKILL_REGISTRY);
  if (!fs.existsSync(registry)) return [];
  return memo("registry", registry, () => skillDocs(registry, finish));
}

const PROJECT_PATH_PATTERNS = [
  new RegExp(`project_path:[${WS}]*["']?([^"'\\r\\n]+)`, "iu"),
  new RegExp(`-[${WS}]+Real git root:[${WS}]*\`([^\`]+)\``, "iu"),
  new RegExp(`-[${WS}]+Repository path:[${WS}]*\`([^\`]+)\``, "iu"),
  new RegExp(`-[${WS}]+Root:[${WS}]*\`([^\`]+)\``, "iu")
];

/**
 * The repository a project card points at: its `project_path`, or the first
 * `Real git root`, `Repository path` or `Root` line.
 *
 * @param {string} text
 * @returns {string} "" when the card names none
 */
export function parseProjectPath(text) {
  for (const pattern of PROJECT_PATH_PATTERNS) {
    const value = pythonStrip(pattern.exec(text)?.[1] ?? "");
    if (value) return value;
  }
  return "";
}

/**
 * A path as `pathlib` prints it on this platform: separators collapsed, `.`
 * dropped, `..` kept, no trailing separator, and on Windows `/` read as `\`.
 *
 * @param {string} value
 * @param {string} platform
 * @returns {{ text: string, name: string, absolute: boolean, separator: string }}
 */
export function pythonPath(value, platform = process.platform) {
  if (platform !== "win32") {
    const root = value.startsWith("//") && !value.startsWith("///") ? "//" : value.startsWith("/") ? "/" : "";
    const parts = value.split("/").filter((part) => part && part !== ".");
    return { text: root + parts.join("/") || ".", name: parts.at(-1) ?? "", absolute: Boolean(root), separator: "/" };
  }
  const normalized = value.replace(/\//g, "\\");
  const unc = /^\\\\[^\\]+\\[^\\]+/.exec(normalized);
  const drive = unc ? unc[0] : /^[A-Za-z]:/.exec(normalized)?.[0] ?? "";
  const rest = normalized.slice(drive.length);
  const root = rest.startsWith("\\") || unc ? "\\" : "";
  const parts = rest.split("\\").filter((part) => part && part !== ".");
  return {
    text: drive + root + parts.join("\\") || ".",
    name: parts.at(-1) ?? "",
    absolute: Boolean(drive && root),
    separator: "\\"
  };
}

/** Whether `child` resolves inside `root`, both through their real paths. */
function insideRealRoot(root, child, platform) {
  try {
    const fold = (value) => (platform === "win32" ? value.toLowerCase() : value);
    const realRoot = fold(fs.realpathSync.native(root));
    const realChild = fold(fs.realpathSync.native(child));
    const prefix = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
    return realChild === realRoot || realChild.startsWith(prefix);
  } catch {
    return false;
  }
}

/** Project cards in listing order, as `Path.glob("*.md")` matches them. */
function projectCards(projectsDir, platform) {
  let handle;
  const names = [];
  try {
    handle = fs.opendirSync(projectsDir);
    for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) names.push(entry.name);
  } catch {
    return [];
  } finally {
    handle?.closeSync();
  }
  const matches = platform === "win32" ? (name) => name.toLowerCase().endsWith(".md") : (name) => name.endsWith(".md");
  return names.filter(matches).map((name) => path.join(projectsDir, name));
}

/** The document of one project file, or null when it cannot be read. */
function projectFileDoc(projectRoot, segments, source, categories, filePath, relative) {
  let body;
  let mtime;
  try {
    body = readPythonText(filePath);
    mtime = pythonMtime(filePath);
  } catch {
    return null;
  }
  return finished({
    id: shaId("project-file", filePath),
    scope: "projects",
    title: `${projectRoot.name} / ${segments.join("/")}`,
    // Python builds this one with the separator of the OS, not of the path.
    path: `${projectRoot.text}${path.sep}${relative}`,
    source,
    categories,
    body,
    preview: cleanPreview(body),
    mtime
  });
}

/**
 * The brief, map, quality gate and `AGENTS.md` of every project a card points
 * at, as `load_project_file_docs` collects them.
 *
 * @param {string} vaultRoot
 * @param {{ platform?: string, memo?: Function, finish?: (doc: object) => object }} [options]
 * @returns {object[]}
 */
export function loadProjectFileDocs(vaultRoot, { platform = process.platform, memo = direct, finish = asIs } = {}) {
  return [...projectFileDocs(vaultRoot, { platform, memo, finish })];
}

/** {@link loadProjectFileDocs}, one file at a time. */
function* projectFileDocs(vaultRoot, { platform, memo, finish }) {
  const projectsDir = path.join(vaultRoot, ...PROJECTS_DIR);
  if (!fs.existsSync(projectsDir)) return;
  for (const card of projectCards(projectsDir, platform)) {
    if (path.basename(card).toLowerCase() === "projects index.md") continue;
    const declared = memo("card", card, () => {
      if (!isReadableFile(card)) return "";
      try {
        return parseProjectPath(readPythonText(card));
      } catch {
        return "";
      }
    });
    if (!declared) continue;
    const projectRoot = pythonPath(declared, platform);
    if (!projectRoot.absolute || !fs.existsSync(projectRoot.text)) continue;
    for (const [segments, source, categories] of PROJECT_FILES) {
      const relative = segments.join(projectRoot.separator);
      const filePath = projectRoot.text.endsWith(projectRoot.separator)
        ? projectRoot.text + relative
        : projectRoot.text + projectRoot.separator + relative;
      if (!fs.existsSync(filePath) || !insideRealRoot(projectRoot.text, filePath, platform) || !isReadableFile(filePath)) continue;
      const doc = memo("project-file", filePath, () => {
        const built = projectFileDoc(projectRoot, segments, source, categories, filePath, relative);
        return built && finish(built);
      });
      if (doc) yield doc;
    }
  }
}

/**
 * Everything the index holds, each document with its `content_hash`, in the
 * order the Python helper collected them, one document per id.
 *
 * With a `cache` ({@link createDocumentCache}) the documents come without
 * their bodies, which is all a status check needs; they are shared with the
 * cache and must not be changed.
 *
 * @param {object} options
 * @param {string} options.vaultRoot
 * @param {boolean} [options.includeExternalProjectFiles]
 * @param {string} [options.platform]
 * @param {ReturnType<typeof createDocumentCache>} [options.cache]
 * @returns {{ docs: object[], duplicates: number }}
 */
export function collectDocuments({ vaultRoot, includeExternalProjectFiles = true, platform = process.platform, cache = null }) {
  return settleDocuments([...documentsOf({ vaultRoot, includeExternalProjectFiles, platform, cache })], cache);
}

/**
 * {@link collectDocuments} for a rebuild, without a cache, that gives the
 * event loop a turn every `sliceMs`. In the daemon one rebuild reads every
 * note while other clients search; read in one go, 13 000 notes held their
 * searches for 1.7 s.
 *
 * @param {{ vaultRoot: string, includeExternalProjectFiles?: boolean, platform?: string }} options
 * @param {{ sliceMs?: number }} [pace]
 * @returns {Promise<{ docs: object[], duplicates: number }>}
 */
export async function collectDocumentsYielding({ vaultRoot, includeExternalProjectFiles = true, platform = process.platform }, { sliceMs = 15 } = {}) {
  const all = [];
  let since = performance.now();
  for (const doc of documentsOf({ vaultRoot, includeExternalProjectFiles, platform, cache: null })) {
    all.push(doc);
    if (performance.now() - since < sliceMs) continue;
    await new Promise((resolve) => setImmediate(resolve));
    since = performance.now();
  }
  return settleDocuments(all, null);
}

/** Every document of the vault in collection order, duplicates included. */
function* documentsOf({ vaultRoot, includeExternalProjectFiles, platform, cache }) {
  const root = path.resolve(vaultRoot);
  const memo = memoFor(cache);
  const finish = cache ? withoutBody : asIs;
  yield* noteDocs(root, memo, finish, platform);
  yield* loadSkillDocs(root, memo, finish);
  if (includeExternalProjectFiles) yield* projectFileDocs(root, { platform, memo, finish });
}

/** One document per id, the first one collected; and the cache cut to what this collection saw. */
function settleDocuments(all, cache) {
  if (cache) {
    for (const entry of cache.entries.keys()) if (!cache.visited.has(entry)) cache.entries.delete(entry);
    cache.visited.clear();
  }
  const seen = new Set();
  const docs = all.filter((doc) => !seen.has(doc.id) && seen.add(doc.id));
  return { docs, duplicates: all.length - docs.length };
}

/** Whether a source is the Membrane catalogue, in either layout. */
export function isMembraneSource(source) {
  return pythonStr(pythonTruthy(source) ? source : "").toLowerCase().includes("membrane");
}

/**
 * The passage a document is embedded from: its fields and the start of its
 * body, whitespace collapsed, `limit` characters, with the BGE-M3 prefix.
 *
 * @param {object} doc
 * @param {number} [limit]
 * @returns {string}
 */
export function densePassageText(doc, limit = DEFAULT_DENSE_TEXT_LIMIT) {
  const text = [
    `Title: ${pythonStr(doc.title ?? "")}`,
    `Scope: ${pythonStr(doc.scope ?? "")}`,
    `Source: ${pythonStr(doc.source ?? "")}`,
    `Categories: ${pythonStr(doc.categories ?? "")}`,
    `Path: ${pythonStr(doc.path ?? "")}`,
    "",
    pythonStr(doc.body ?? "")
  ].join("\n");
  return `passage: ${sliceCodePoints(pythonStrip(collapseWhitespace(text)), limit)}`;
}

/** The hash a stored dense vector carries: SHA-256 of its passage. */
export function denseContentHash(text) {
  return sha("sha256", text);
}

/**
 * The documents that get a dense vector, each with its passage and hash.
 * Membrane's connectors are left out unless asked for: 3 074 of them would
 * outrank everything else on any query that mentions an app.
 *
 * @param {object[]} docs
 * @param {{ textLimit?: number, includeMembrane?: boolean }} [options]
 * @returns {Array<{ id: string, text: string, content_hash: string, mtime: number }>}
 */
export function denseDocRecords(docs, { textLimit = DEFAULT_DENSE_TEXT_LIMIT, includeMembrane = false } = {}) {
  const records = [];
  for (const doc of docs) {
    if (!includeMembrane && isMembraneSource(doc.source)) continue;
    const text = densePassageText(doc, textLimit);
    records.push({ id: doc.id, text, content_hash: denseContentHash(text), mtime: Number(doc.mtime) || 0 });
  }
  return records;
}
