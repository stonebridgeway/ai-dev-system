/**
 * The files a target ships, read from the one allowlist every target shares.
 *
 * `npm run dist` (the folder the npm package and the Windows installer are
 * made from) and `npm run docker:prepare` (the image's build context) used to
 * list their files in their own code, and the lists drifted: a file one target
 * needed was missing from another until a user hit it.
 * `distribution.allowlist.json` names the groups once; each
 * target maps a group to the folder it lands in, or leaves it out.
 *
 * No dependency beyond Node: the image's publish job and `bootstrap.sh` build
 * the context before any `npm ci`.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DISTRIBUTION_MARKER } from "./install-layout.mjs";

/** Where the allowlist sits, relative to the repository root. */
export const ALLOWLIST_PATH = path.join("ai-dev-mcp-server", "distribution.allowlist.json");

/**
 * A glob as a regular expression over `/`-separated relative paths: `**`
 * spans folders, `*` and `?` stay within one name.
 *
 * @param {string} pattern
 * @returns {RegExp}
 */
export function globToRegExp(pattern) {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*" && pattern[index + 1] === "*") {
      // `**/` matches no folder too: `**/*.test.mjs` takes `a.test.mjs` at the top.
      if (pattern[index + 2] === "/") {
        source += "(?:.*/)?";
        index += 2;
      } else {
        source += ".*";
        index += 1;
      }
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

const GLOB = /[*?]/;

/**
 * Every file under `directory`, as `/`-separated paths relative to `root`.
 * Links are refused, not followed; folders `skip` says yes to are not entered.
 */
async function walk(root, directory, found, skip = () => false) {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    const relative = path.relative(root, full).split(path.sep).join("/");
    if (entry.isSymbolicLink()) throw new Error(`${full} is a link; a distribution ships files, not links.`);
    if (entry.isDirectory()) {
      if (!skip(relative)) await walk(root, full, found, skip);
      continue;
    }
    if (entry.isFile()) found.push(relative);
  }
}

async function isFile(file) {
  return fs.stat(file).then((stat) => stat.isFile(), () => false);
}

/**
 * The files of one group, relative to its `from`.
 *
 * @param {string} root - The group's `from`, absolute.
 * @param {{ name: string, include?: string[], exclude?: string[], manifest?: string }} group
 * @returns {Promise<string[]>}
 */
async function groupFiles(root, group) {
  if (group.manifest) {
    const manifest = JSON.parse(await fs.readFile(path.join(root, group.manifest), "utf8"));
    const listed = Array.isArray(manifest.files) ? manifest.files.map((item) => String(item.path)) : [];
    return [group.manifest, ...listed];
  }
  const exclude = (group.exclude ?? []).map(globToRegExp);
  const files = new Set();
  for (const pattern of group.include ?? []) {
    const matched = [];
    if (!GLOB.test(pattern)) {
      if (await isFile(path.join(root, pattern))) matched.push(pattern);
    } else {
      // Walk only the folder the pattern starts with, not the whole tree.
      const segments = pattern.split("/");
      const fixed = segments.slice(0, segments.findIndex((segment) => GLOB.test(segment))).join("/");
      const listed = [];
      await walk(root, path.join(root, fixed), listed);
      const regex = globToRegExp(pattern);
      matched.push(...listed.filter((relative) => regex.test(relative)));
    }
    const kept = matched.filter((relative) => !exclude.some((regex) => regex.test(relative)));
    // A pattern that matches nothing is a file renamed or moved out from under
    // the allowlist: the target would ship without it, so the build stops.
    if (!kept.length) throw new Error(`The ${group.name} pattern "${pattern}" matches no file under ${root}.`);
    for (const relative of kept) files.add(relative);
  }
  return [...files];
}

/**
 * Read the allowlist.
 *
 * @param {string} repositoryRoot
 * @returns {Promise<{ schema_version: number, groups: object[] }>}
 */
export async function readAllowlist(repositoryRoot) {
  return JSON.parse(await fs.readFile(path.join(repositoryRoot, ALLOWLIST_PATH), "utf8"));
}

/**
 * What a target ships: each file's source and where it lands, sorted by the
 * latter. Two groups landing one file at the same place stop the plan.
 *
 * @param {object} input
 * @param {string} input.repositoryRoot
 * @param {"dist"|"docker"} input.target
 * @param {{ groups: object[] }} [input.allowlist]
 * @returns {Promise<Array<{ group: string, source: string, destination: string }>>}
 */
export async function planDistribution({ repositoryRoot, target, allowlist }) {
  const list = allowlist ?? await readAllowlist(repositoryRoot);
  const plan = [];
  const seen = new Map();
  for (const group of list.groups ?? []) {
    const to = group.to?.[target];
    if (to === undefined) continue;
    const root = path.resolve(repositoryRoot, group.from);
    for (const relative of await groupFiles(root, group)) {
      const destination = path.posix.normalize(path.posix.join(to, relative));
      if (destination.startsWith("../") || path.posix.isAbsolute(destination)) {
        throw new Error(`The ${group.name} file ${relative} would land outside the ${target} folder.`);
      }
      if (seen.has(destination)) throw new Error(`${destination} comes from both the ${seen.get(destination)} and the ${group.name} groups.`);
      seen.set(destination, group.name);
      plan.push({ group: group.name, source: path.join(root, ...relative.split("/")), destination });
    }
  }
  return plan.sort((left, right) => (left.destination < right.destination ? -1 : left.destination > right.destination ? 1 : 0));
}

/**
 * Whether `npm pack` leaves a file out of the tarball, whatever `files` says
 * (npm-packlist's fixed rules, measured on npm 11.17). A `.gitignore` is also
 * read as ignore rules for its folder. A seed file npm drops would be missing
 * from every installed package, and the vault sync would stop on it.
 *
 * @param {string} relative - `/`-separated path inside the package.
 * @returns {boolean}
 */
export function npmLeavesOut(relative) {
  const parts = String(relative).split("/");
  const name = parts.at(-1);
  const folders = parts.slice(0, -1);
  const vcs = ["CVS", ".svn", ".hg", ".git"];
  // Measured on npm 10.9.4 and 11.17 (`npm pack --dry-run` over 26 names).
  return folders.some((part) => vcs.includes(part) || part === "archived-packages")
    || vcs.includes(name)
    || [".gitignore", ".npmignore", ".npmrc", ".DS_Store", "npm-debug.log", ".lock-wscript"].includes(name)
    || (name === "config.gypi" && folders.at(-1) === "build")
    || /^\._/.test(name)
    || /^\..*\.swp$/.test(name)
    || /^\.wafpickle-\d+$/.test(name)
    || name.endsWith(".orig");
}

/** The repository the package is published from. */
const REPOSITORY_URL = "https://github.com/stonebridgeway/ai-dev-system";

/**
 * The package's own `package.json`: the server's name for itself is
 * `ai-dev-mcp-server`, private; the package is `ai-dev-system`,
 * with the server's dependencies and the CLI as its bin.
 *
 * @param {object} input
 * @param {object} input.server - The server's package.json.
 * @param {string[]} input.entries - The top-level names the package ships.
 * @param {string} input.name
 * @returns {object}
 */
export function packageManifest({ server, entries, name }) {
  return {
    name,
    version: server.version,
    description: "Local MCP server for AI coding agents: task lifecycle, skill routing, hybrid search and a local model. "
      + "Set up with one command: npx " + name + " setup",
    license: "PolyForm-Noncommercial-1.0.0",
    type: "module",
    bin: { "ai-dev": "ai-dev-mcp-server/bin/ai-dev.mjs" },
    engines: server.engines,
    dependencies: server.dependencies,
    optionalDependencies: server.optionalDependencies,
    files: [...entries].sort(),
    scripts: { prepack: "node ai-dev-mcp-server/scripts/verify-distribution.mjs" },
    repository: { type: "git", url: `git+${REPOSITORY_URL}.git` },
    homepage: `${REPOSITORY_URL}#readme`,
    bugs: { url: `${REPOSITORY_URL}/issues` },
    keywords: ["mcp", "model-context-protocol", "ai-agents", "claude", "cursor", "codex", "skills", "search"]
  };
}

/**
 * The server's lockfile as the package's `npm-shrinkwrap.json`: npm installs a
 * package's shrinkwrap exactly, so every user gets the tree the gates ran on.
 * (`package-lock.json` never leaves a project: npm does not pack it.)
 *
 * @param {object} lock - The server's package-lock.json.
 * @param {object} manifest - From {@link packageManifest}.
 * @returns {object}
 */
export function shrinkwrapFrom(lock, manifest) {
  const packages = {};
  for (const [key, value] of Object.entries(lock.packages ?? {})) {
    if (!key || value.dev) continue;
    packages[key] = value;
  }
  const root = {
    name: manifest.name,
    version: manifest.version,
    license: manifest.license,
    dependencies: manifest.dependencies,
    optionalDependencies: manifest.optionalDependencies,
    bin: manifest.bin,
    engines: manifest.engines
  };
  return { name: manifest.name, version: manifest.version, lockfileVersion: lock.lockfileVersion, requires: true, packages: { "": root, ...packages } };
}

/**
 * Check a built distribution against its `distribution.json`: every listed
 * file there with its size and sha256, nothing beside them but installed
 * dependencies, and nothing npm would leave out of the tarball. The package's
 * `prepack` runs this, so a tarball is never made from a folder that changed
 * after it was built.
 *
 * @param {string} root - The distribution's folder.
 * @returns {Promise<{ ok: boolean, name: string, version: string, files: number, bytes: number, missing: string[], changed: string[], extra: string[], dropped: string[] }>}
 */
export async function verifyDistribution(root) {
  const marker = JSON.parse(await fs.readFile(path.join(root, DISTRIBUTION_MARKER), "utf8"));
  const files = Array.isArray(marker.files) ? marker.files : [];
  const listed = new Set(files.map((file) => file.path));
  const missing = [];
  const changed = [];
  for (const file of files) {
    let content;
    try {
      content = await fs.readFile(path.join(root, ...String(file.path).split("/")));
    } catch {
      missing.push(file.path);
      continue;
    }
    if (content.length !== file.bytes || crypto.createHash("sha256").update(content).digest("hex") !== file.sha256) changed.push(file.path);
  }
  const found = [];
  // Installed dependencies — the package's own, Frontend QA's — are not part of
  // the build; the seed's vendored ones, deeper down, are.
  await walk(root, root, found, (relative) => /^(?:[^/]+\/)?node_modules$/.test(relative));
  const extra = found.filter((relative) => relative !== DISTRIBUTION_MARKER && !listed.has(relative)).sort();
  const dropped = files.map((file) => file.path).filter(npmLeavesOut);
  return {
    ok: !missing.length && !changed.length && !extra.length && !dropped.length,
    name: String(marker.name ?? ""),
    version: String(marker.version ?? ""),
    files: files.length,
    bytes: files.reduce((sum, file) => sum + Number(file.bytes || 0), 0),
    missing,
    changed,
    extra,
    dropped
  };
}

/**
 * Stop when a seed file is not what the seed's manifest says. Every installed
 * vault judges its files by that manifest: a note edited without the manifest
 * recomputed would look changed by the user in all of them, and never be
 * updated again.
 *
 * @param {string} seedRoot - A staged seed folder holding `public-seed.manifest.json`.
 * @returns {Promise<number>} The number of files checked.
 */
export async function assertSeedMatchesManifest(seedRoot) {
  const manifest = JSON.parse(await fs.readFile(path.join(seedRoot, "public-seed.manifest.json"), "utf8"));
  const drifted = [];
  for (const file of manifest.files ?? []) {
    const content = await fs.readFile(path.join(seedRoot, ...String(file.path).split("/"))).catch(() => null);
    if (!content || crypto.createHash("sha256").update(content).digest("hex") !== file.sha256) drifted.push(String(file.path));
  }
  if (drifted.length) {
    throw new Error(`The seed differs from its manifest in ${drifted.length} file(s) (${drifted.slice(0, 3).join(", ")}). `
      + "Recompute the manifest with `node scripts/verify-public-seed.mjs --write`, or put the files back.");
  }
  return (manifest.files ?? []).length;
}
