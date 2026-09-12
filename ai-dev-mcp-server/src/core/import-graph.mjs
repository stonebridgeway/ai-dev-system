/**
 * Which module depends on which, read out of the source (PLAN.md, stage 3.8).
 *
 * The project map already says what a repository is made of. What it could not
 * say is where the weight sits: which module half the codebase imports, which
 * two import each other, and which files nothing imports at all. Those three
 * answers are what a person needs before touching an unfamiliar tree, and they
 * are also what tells an agent that a "small" change to one file reaches
 * forty others.
 *
 * Scope, stated rather than implied: JavaScript/TypeScript and Python, and only
 * imports that resolve to a file inside the repository. A bare specifier is
 * counted as an external dependency and never becomes a node — the graph is
 * about this codebase, and `react` is not part of it. Go, Rust and the rest are
 * not read, so a repository in those languages gets an empty graph rather than
 * a wrong one.
 *
 * The scan is lazy: {@link loadImportGraph} fingerprints the source files by
 * path, size and mtime — which costs a directory walk — and only reads and
 * parses them when the fingerprint has moved. `prepare_project` and
 * `refresh_project_context` therefore re-render the map on every call and
 * re-parse the tree only when it changed.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { atomicWriteFile } from "./atomic-files.mjs";

/** Where the cached graph is kept, relative to the project root. */
export const IMPORT_GRAPH_CACHE_PATH = ".ai-dev/cache/import-graph.json";

/** Files the scan reads. */
export const IMPORT_GRAPH_EXTENSIONS = Object.freeze([".mjs", ".cjs", ".js", ".jsx", ".ts", ".tsx", ".mts", ".cts", ".py"]);

/** Directories never walked: build output, dependencies, virtual environments. */
export const IMPORT_GRAPH_SKIP = Object.freeze([
  ".git", ".hg", ".svn", "node_modules", ".venv", "venv", "env", "__pycache__",
  "dist", "build", "out", "coverage", ".next", ".nuxt", ".svelte-kit", ".turbo", ".cache", ".mypy_cache", ".pytest_cache", "vendor"
]);

/** How many files one scan reads, so an enormous repository cannot stall a map render. */
export const IMPORT_GRAPH_MAX_FILES = 4_000;

/** File names that are an entry point by convention, whoever imports them. */
const ENTRY_NAMES = /^(?:index|main|app|server|cli|__main__|manage|setup|conftest)\.[a-z]+$/i;

// `import x from "y"`, `export * from "y"`, `import("y")`, `require("y")`.
const JS_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["']([^"'\n]+)["']|\bimport\s+["']([^"'\n]+)["']/g;
// `from a.b import c`, `import a.b`, `from . import c`, `from .a import b`.
const PY_FROM = /^[ \t]*from[ \t]+([.\w]+)[ \t]+import\b/gm;
const PY_IMPORT = /^[ \t]*import[ \t]+([\w.]+(?:[ \t]*,[ \t]*[\w.]+)*)/gm;

const JS_SUFFIXES = [".mjs", ".cjs", ".js", ".jsx", ".ts", ".tsx", ".mts", ".cts"];
const JS_INDEXES = JS_SUFFIXES.map((suffix) => `index${suffix}`);

function posix(value) {
  return String(value ?? "").replaceAll("\\", "/");
}

/**
 * Every source file the scan would read, with what the fingerprint is made of.
 *
 * @param {string} root
 * @param {{ extensions?: string[], skip?: string[], maxFiles?: number }} [options]
 * @returns {Promise<Array<{ relative: string, absolute: string, size: number, mtime: number }>>}
 */
export async function collectSourceFiles(root, {
  extensions = IMPORT_GRAPH_EXTENSIONS,
  skip = IMPORT_GRAPH_SKIP,
  maxFiles = IMPORT_GRAPH_MAX_FILES
} = {}) {
  const skipped = new Set(skip);
  const wanted = new Set(extensions);
  const files = [];
  async function walk(directory) {
    if (files.length >= maxFiles) return;
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (files.length >= maxFiles) return;
      if (entry.name.startsWith(".") && entry.isDirectory() && !skipped.has(entry.name) && entry.name !== ".ai-dev") continue;
      if (skipped.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile() && wanted.has(path.extname(entry.name).toLowerCase())) {
        const stats = await fs.stat(absolute).catch(() => null);
        if (!stats) continue;
        files.push({ relative: posix(path.relative(root, absolute)), absolute, size: stats.size, mtime: Math.round(stats.mtimeMs) });
      }
    }
  }
  await walk(path.resolve(root));
  return files;
}

/**
 * The fingerprint the lazy recompute compares. Path, size and mtime of every
 * source file: an edit moves it, a rename moves it, and reading file contents
 * is not needed to compute it.
 *
 * @param {Array<{ relative: string, size: number, mtime: number }>} files
 * @returns {string}
 */
export function sourceFingerprint(files) {
  const hash = crypto.createHash("sha256");
  for (const file of files) hash.update(`${file.relative}:${file.size}:${file.mtime}\n`);
  return `${files.length}-${hash.digest("hex").slice(0, 32)}`;
}

/** Import specifiers one file states, in source order. */
export function parseImportSpecifiers(relativePath, source) {
  const text = String(source ?? "");
  const specifiers = [];
  if (relativePath.toLowerCase().endsWith(".py")) {
    for (const match of text.matchAll(PY_FROM)) specifiers.push(match[1]);
    for (const match of text.matchAll(PY_IMPORT)) {
      for (const part of match[1].split(",")) specifiers.push(part.trim());
    }
    return specifiers.filter(Boolean);
  }
  for (const match of text.matchAll(JS_IMPORT)) specifiers.push(match[1] ?? match[2]);
  return specifiers.filter(Boolean);
}

/**
 * The file a JavaScript/TypeScript specifier names, or "" when it leaves the
 * repository.
 *
 * @param {string} fromRelative - The importing file.
 * @param {string} specifier
 * @param {Set<string>} known - Relative paths in the repository.
 * @returns {string}
 */
export function resolveJsSpecifier(fromRelative, specifier, known) {
  if (!specifier.startsWith(".")) return "";
  const base = posix(path.posix.normalize(path.posix.join(path.posix.dirname(fromRelative), specifier)));
  if (known.has(base)) return base;
  // TypeScript imports `./x.js` and means `./x.ts`; both spellings resolve.
  const withoutExtension = base.replace(/\.(?:m|c)?js$/i, "");
  for (const candidate of [
    ...JS_SUFFIXES.map((suffix) => `${base}${suffix}`),
    ...JS_SUFFIXES.map((suffix) => `${withoutExtension}${suffix}`),
    ...JS_INDEXES.map((index) => path.posix.join(base, index))
  ]) {
    if (known.has(candidate)) return candidate;
  }
  return "";
}

/**
 * The file a Python import names, or "" when it is not in the repository.
 *
 * @param {string} fromRelative
 * @param {string} specifier
 * @param {Set<string>} known
 * @returns {string}
 */
export function resolvePySpecifier(fromRelative, specifier, known) {
  const directory = path.posix.dirname(fromRelative);
  let module = specifier;
  let base = "";
  if (module.startsWith(".")) {
    const dots = /^\.+/.exec(module)[0].length;
    module = module.slice(dots);
    base = directory;
    for (let level = 1; level < dots; level += 1) base = path.posix.dirname(base);
    if (base === ".") base = "";
  }
  const segments = module.split(".").filter(Boolean);
  const candidates = [];
  const prefixes = base ? [base] : ["", directory, "src"];
  for (const prefix of prefixes) {
    const joined = [prefix, ...segments].filter(Boolean).join("/");
    if (!joined) continue;
    candidates.push(`${joined}.py`, `${joined}/__init__.py`);
  }
  return candidates.find((candidate) => known.has(candidate)) ?? "";
}

/**
 * Strongly connected components of more than one node, plus self-imports:
 * every import cycle, each reported once. Tarjan's algorithm, iterative so a
 * deep tree cannot overflow the stack.
 *
 * @param {Map<string, string[]>} edges
 * @returns {string[][]}
 */
export function findImportCycles(edges) {
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const cycles = [];
  let counter = 0;
  for (const start of edges.keys()) {
    if (index.has(start)) continue;
    const work = [{ node: start, next: 0 }];
    index.set(start, counter);
    low.set(start, counter);
    counter += 1;
    stack.push(start);
    onStack.add(start);
    while (work.length) {
      const frame = work.at(-1);
      const neighbours = edges.get(frame.node) ?? [];
      if (frame.next < neighbours.length) {
        const neighbour = neighbours[frame.next];
        frame.next += 1;
        if (!index.has(neighbour)) {
          index.set(neighbour, counter);
          low.set(neighbour, counter);
          counter += 1;
          stack.push(neighbour);
          onStack.add(neighbour);
          work.push({ node: neighbour, next: 0 });
        } else if (onStack.has(neighbour)) {
          low.set(frame.node, Math.min(low.get(frame.node), index.get(neighbour)));
        }
        continue;
      }
      work.pop();
      if (work.length) {
        const parent = work.at(-1).node;
        low.set(parent, Math.min(low.get(parent), low.get(frame.node)));
      }
      if (low.get(frame.node) === index.get(frame.node)) {
        const component = [];
        let member;
        do {
          member = stack.pop();
          onStack.delete(member);
          component.push(member);
        } while (member !== frame.node);
        if (component.length > 1) cycles.push(component.sort());
        else if ((edges.get(frame.node) ?? []).includes(frame.node)) cycles.push(component);
      }
    }
  }
  return cycles.sort((left, right) => right.length - left.length || left[0].localeCompare(right[0]));
}

/**
 * Read the graph by parsing every source file.
 *
 * @param {string} projectRoot
 * @param {object} [options] - Passed to {@link collectSourceFiles}.
 * @returns {Promise<object>}
 */
export async function scanImportGraph(projectRoot, options = {}) {
  const root = path.resolve(projectRoot);
  const files = await collectSourceFiles(root, options);
  const known = new Set(files.map((file) => file.relative));
  const edges = new Map(files.map((file) => [file.relative, []]));
  const dependents = new Map(files.map((file) => [file.relative, []]));
  const external = new Map();
  let unresolved = 0;
  for (const file of files) {
    const source = await fs.readFile(file.absolute, "utf8").catch(() => "");
    const python = file.relative.toLowerCase().endsWith(".py");
    for (const specifier of parseImportSpecifiers(file.relative, source)) {
      const target = python
        ? resolvePySpecifier(file.relative, specifier, known)
        : resolveJsSpecifier(file.relative, specifier, known);
      if (!target) {
        const bare = specifier.startsWith(".") ? "" : specifier.split("/")[0].split(".")[0];
        if (bare) external.set(bare, (external.get(bare) ?? 0) + 1);
        else unresolved += 1;
        continue;
      }
      if (target === file.relative) continue;
      if (!edges.get(file.relative).includes(target)) edges.get(file.relative).push(target);
      if (!dependents.get(target).includes(file.relative)) dependents.get(target).push(file.relative);
    }
  }
  const modules = files.map((file) => ({
    path: file.relative,
    imports: edges.get(file.relative).length,
    dependents: dependents.get(file.relative).length
  }));
  const entryPoints = modules
    .filter((module) => module.dependents === 0 && (module.imports > 0 || ENTRY_NAMES.test(path.posix.basename(module.path))))
    .map((module) => module.path);
  return {
    generated_at: new Date().toISOString(),
    fingerprint: sourceFingerprint(files),
    scanned_files: files.length,
    truncated: files.length >= (options.maxFiles ?? IMPORT_GRAPH_MAX_FILES),
    edges: Object.fromEntries([...edges].filter(([, targets]) => targets.length).map(([from, targets]) => [from, targets.sort()])),
    modules: modules.sort((left, right) => right.dependents - left.dependents || left.path.localeCompare(right.path)),
    entry_points: entryPoints.sort(),
    cycles: findImportCycles(edges),
    external_dependencies: [...external].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).slice(0, 20).map(([name, count]) => ({ name, imports: count })),
    unresolved
  };
}

/**
 * The graph, from cache when the source files have not moved.
 *
 * @param {string} projectRoot
 * @param {{ cachePath?: string, force?: boolean } & object} [options]
 * @returns {Promise<object & { from_cache: boolean }>}
 */
export async function loadImportGraph(projectRoot, { cachePath = IMPORT_GRAPH_CACHE_PATH, force = false, ...options } = {}) {
  const root = path.resolve(projectRoot);
  const cacheFile = path.join(root, ...cachePath.split("/"));
  const files = await collectSourceFiles(root, options);
  const fingerprint = sourceFingerprint(files);
  if (!force) {
    const cached = await fs.readFile(cacheFile, "utf8").then((text) => JSON.parse(text)).catch(() => null);
    if (cached?.fingerprint === fingerprint) return { ...cached, from_cache: true };
  }
  const graph = await scanImportGraph(root, options);
  await fs.mkdir(path.dirname(cacheFile), { recursive: true }).catch(() => undefined);
  await atomicWriteFile(cacheFile, `${JSON.stringify(graph, null, 2)}\n`, "utf8").catch(() => undefined);
  return { ...graph, from_cache: false };
}

/**
 * The graph as the project-map section.
 *
 * @param {object} graph - From {@link loadImportGraph} or {@link scanImportGraph}.
 * @param {{ limit?: number }} [options]
 * @returns {string}
 */
export function renderImportGraphMarkdown(graph, { limit = 10 } = {}) {
  if (!graph || !graph.scanned_files) {
    return "- No JavaScript, TypeScript or Python sources were read, so there is no import graph for this project.";
  }
  const lines = [
    `- Files read: ${graph.scanned_files}${graph.truncated ? " (the scan stopped at its file limit, so the graph is partial)" : ""}, from cache: ${graph.from_cache ? "yes" : "no"}.`,
    `- Internal edges: ${Object.values(graph.edges ?? {}).reduce((total, targets) => total + targets.length, 0)}.`,
    ""
  ];
  const depended = (graph.modules ?? []).filter((module) => module.dependents > 0).slice(0, limit);
  lines.push("Most depended on:");
  if (depended.length) {
    for (const module of depended) {
      lines.push(`- \`${module.path}\` — ${module.dependents} dependent(s), imports ${module.imports}.`);
    }
  } else {
    lines.push("- Nothing in this project imports anything else in it.");
  }
  lines.push("", "Cycles:");
  if (graph.cycles?.length) {
    for (const cycle of graph.cycles.slice(0, limit)) {
      lines.push(`- ${cycle.length === 1 ? "self-import" : `${cycle.length} modules`}: ${cycle.map((item) => `\`${item}\``).join(" → ")}`);
    }
    if (graph.cycles.length > limit) lines.push(`- …and ${graph.cycles.length - limit} more.`);
  } else {
    lines.push("- None.");
  }
  lines.push("", "Entry points (nothing in the project imports them):");
  const entries = (graph.entry_points ?? []).slice(0, limit);
  lines.push(...(entries.length ? entries.map((item) => `- \`${item}\``) : ["- None: every module is imported by another one."]));
  if (graph.entry_points?.length > limit) lines.push(`- …and ${graph.entry_points.length - limit} more.`);
  if (graph.external_dependencies?.length) {
    lines.push("", `Most imported external packages: ${graph.external_dependencies.slice(0, 8).map((item) => `\`${item.name}\` (${item.imports})`).join(", ")}.`);
  }
  return lines.join("\n");
}
