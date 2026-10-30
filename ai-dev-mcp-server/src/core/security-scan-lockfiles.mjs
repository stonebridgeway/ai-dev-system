/**
 * Where a project's dependency trees are.
 *
 * A package manager's audit reads the lockfile in the directory it runs in, so
 * a repository whose `frontend/` and `backend/` each have one — and nothing at
 * the root — used to get no dependency scan at all.
 * This module finds those directories, and says which Yarn a directory uses,
 * because Yarn 1 and Yarn 2+ audit with different commands.
 */
import fs from "node:fs/promises";
import path from "node:path";

/** How far below the root a package manager's lockfile is looked for. */
export const LOCKFILE_SEARCH_DEPTH = 2;

/**
 * Directories never searched for lockfiles: installed trees, build output,
 * and fixtures that are lockfiles on purpose.
 */
export const LOCKFILE_SEARCH_SKIP = new Set(["node_modules", "dist", "build", "out", "coverage", "vendor", "fixtures", "__fixtures__", "bower_components"]);

async function pathExists(target) {
  return fs.stat(target).then(() => true).catch(() => false);
}

/**
 * Yarn 1 and Yarn 2+ audit with different commands and print different
 * reports. The project says which it is: a `packageManager` of `yarn@2` or
 * later, or a `.yarnrc.yml`, is Yarn 2+; anything else is Yarn 1.
 *
 * @param {string} directory
 * @returns {Promise<string[]>}
 */
export async function yarnAuditArgs(directory) {
  const manifest = await fs.readFile(path.join(directory, "package.json"), "utf8").then(JSON.parse).catch(() => ({}));
  const declared = /^yarn@(\d+)/.exec(String(manifest?.packageManager ?? ""));
  const berry = declared ? Number(declared[1]) >= 2 : await pathExists(path.join(directory, ".yarnrc.yml"));
  return berry ? ["npm", "audit", "--all", "--recursive", "--json"] : ["audit", "--json"];
}

/**
 * Every directory, from the root down {@link LOCKFILE_SEARCH_DEPTH} levels,
 * that holds one of the markers. Hidden directories, installed trees, build
 * output and fixtures are not searched; symbolic links are not followed.
 *
 * @param {string} projectRoot
 * @param {string[]} markers
 * @param {number} [depth]
 * @returns {Promise<string[]>}
 */
export async function markerDirectories(projectRoot, markers, depth = LOCKFILE_SEARCH_DEPTH) {
  const found = [];
  async function visit(directory, level) {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    if (entries.some((entry) => entry.isFile() && markers.includes(entry.name))) found.push(directory);
    if (level >= depth) return;
    const children = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !LOCKFILE_SEARCH_SKIP.has(entry.name))
      .map((entry) => entry.name)
      .sort();
    for (const name of children) await visit(path.join(directory, name), level + 1);
  }
  await visit(projectRoot, 0);
  return found;
}

/** Which package manager a lockfile belongs to, by its name. */
export const LOCKFILE_MANAGERS = Object.freeze({
  "package-lock.json": "npm",
  "npm-shrinkwrap.json": "npm",
  "pnpm-lock.yaml": "pnpm",
  "yarn.lock": "yarn",
  "bun.lock": "bun",
  "bun.lockb": "bun"
});

/**
 * @typedef {object} LockfileFacts
 * @property {string} manager - npm, pnpm, yarn or bun.
 * @property {boolean} readable - Whether the lockfile could be read at all.
 * @property {Map<string, Set<string>>} installed - Package name to installed versions.
 * @property {Map<string, string[]> | null} requested - Package name to the ranges
 *   its dependents ask for, or null when this format does not record them (pnpm).
 */

function addTo(map, key, value) {
  if (!key || !value) return;
  const set = map.get(key) ?? new Set();
  set.add(value);
  map.set(key, set);
}

function addRange(map, key, value) {
  if (!key || value === undefined || value === null) return;
  const list = map.get(key) ?? [];
  list.push(String(value).replace(/^npm:/, ""));
  map.set(key, list);
}

/** `name@range` — the last `@` that is not the scope's. */
function splitSpec(spec) {
  const text = String(spec ?? "").trim().replace(/^["']|["']$/g, "");
  const at = text.lastIndexOf("@");
  if (at <= 0) return { name: text, range: "" };
  return { name: text.slice(0, at), range: text.slice(at + 1).replace(/^npm:/, "") };
}

function readNpmLock(text) {
  const lock = JSON.parse(text);
  const packages = lock?.packages;
  if (!packages || typeof packages !== "object") return null;
  const installed = new Map();
  const requested = new Map();
  for (const [key, entry] of Object.entries(packages)) {
    const match = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)$/.exec(key);
    if (match && !entry?.link) addTo(installed, entry?.name ?? match[1], entry?.version);
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      for (const [name, range] of Object.entries(entry?.[field] ?? {})) addRange(requested, name, range);
    }
  }
  return { installed, requested };
}

function readYarnLock(text) {
  const installed = new Map();
  const requested = new Map();
  let current = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(line) && line.trimEnd().endsWith(":")) {
      const header = line.trimEnd().slice(0, -1);
      current = header === "__metadata" ? [] : header.split(/,\s*/).map(splitSpec).filter((item) => item.name);
      for (const { name, range } of current) addRange(requested, name, range);
      continue;
    }
    const version = /^\s+version:?\s+"?([^"\s]+)"?\s*$/.exec(line);
    if (version) for (const { name } of current) addTo(installed, name, version[1]);
  }
  return { installed, requested };
}

function readBunLock(text) {
  // bun.lock is JSON with trailing commas.
  const lock = JSON.parse(text.replace(/,(\s*[}\]])/g, "$1"));
  const installed = new Map();
  const requested = new Map();
  for (const workspace of Object.values(lock?.workspaces ?? {})) {
    for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      for (const [name, range] of Object.entries(workspace?.[field] ?? {})) addRange(requested, name, range);
    }
  }
  for (const entry of Object.values(lock?.packages ?? {})) {
    if (!Array.isArray(entry)) continue;
    const { name, range: version } = splitSpec(entry[0]);
    addTo(installed, name, version);
    const meta = entry.find((item) => item && typeof item === "object" && !Array.isArray(item)) ?? {};
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      for (const [dependency, range] of Object.entries(meta[field] ?? {})) addRange(requested, dependency, range);
    }
  }
  return { installed, requested };
}

function readPnpmLock(text) {
  const installed = new Map();
  let inPackages = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\S/.test(line)) {
      inPackages = /^packages:\s*$/.test(line);
      continue;
    }
    if (!inPackages) continue;
    // `  name@1.2.3:`, `  '@scope/name@1.2.3':`, `  /name@1.2.3(peer@1.0.0):` (v6).
    const match = /^ {2}['"]?\/?((?:@[^/@\s]+\/)?[^@\s'"/]+)@([^('":\s]+)/.exec(line);
    if (match) addTo(installed, match[1], match[2]);
  }
  // pnpm records what it resolved, not the range each dependent asked for.
  return { installed, requested: null };
}

/**
 * What a lockfile says about installed versions and requested ranges, in one
 * shape for all four package managers. A lockfile that cannot be read — or
 * Bun's binary `bun.lockb` — is `readable: false`, and a plan built on it says
 * it could not tell rather than guessing.
 *
 * @param {string} file - Absolute path to the lockfile.
 * @returns {Promise<LockfileFacts>}
 */
export async function readLockfileFacts(file) {
  const manager = LOCKFILE_MANAGERS[path.basename(file)] ?? "";
  const empty = { manager, readable: false, installed: new Map(), requested: null };
  if (!manager || file.endsWith(".lockb")) return empty;
  const text = await fs.readFile(file, "utf8").catch(() => null);
  if (text === null) return empty;
  try {
    const readers = { npm: readNpmLock, yarn: readYarnLock, bun: readBunLock, pnpm: readPnpmLock };
    const facts = readers[manager](text);
    return facts ? { manager, readable: true, ...facts } : empty;
  } catch {
    return empty;
  }
}
