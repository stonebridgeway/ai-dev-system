import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { runProcess } from "./process-runner.mjs";
import { resolveRuntimeStateRoot } from "./runtime-home.mjs";

const PROJECT_ID_VERSION = 1;
const BOUNDARY_MARKERS = [
  ".ai-dev",
  ".git",
  "package.json",
  "pyproject.toml",
  "go.mod",
  "Cargo.toml",
  "pom.xml",
  "build.gradle",
  "Gemfile",
  "composer.json"
];

// The host (mcp-stdio) knows `vaultRoot`; project-identity does not. It sets this
// once at startup so the runtime-state directory is identified consistently.
let configuredRuntimeStateRoot = "";

/**
 * Pin the absolute runtime-state root (`AI_DEV_HOME`, else `<home>/.ai-dev`) so
 * project-boundary detection never treats it as a project. Call once during
 * host startup.
 *
 * @param {string} stateRoot
 * @returns {string} the root it pinned
 */
export function configureRuntimeStateRoot(stateRoot) {
  configuredRuntimeStateRoot = stateRoot ? String(stateRoot) : "";
  return configuredRuntimeStateRoot;
}

function hash(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function normalizePath(value) {
  return comparablePath(value, process.platform);
}

/**
 * Normalise a path for comparison the way a given platform does: POSIX
 * separators, no trailing slash, case-folded on Windows. The platform is a
 * parameter so the branch a machine will never take is still testable — and so
 * a Windows layout can be decided on a POSIX host.
 *
 * @param {string} value
 * @param {string} platform - `process.platform` value.
 * @returns {string}
 */
function comparablePath(value, platform) {
  const impl = platform === "win32" ? path.win32 : path.posix;
  const resolved = impl.resolve(String(value ?? "")).replaceAll("\\", "/").replace(/\/+$/, "");
  return platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * The user's home directory, as the platform spells it: `USERPROFILE` on
 * Windows, `HOME` elsewhere, each falling back to the other. Empty when neither
 * is set, and the home rule below then does not apply at all.
 *
 * `AI_DEV_HOME` is deliberately not read here: it moves the runtime tree, not
 * the user, and pointing the runtime somewhere else must not change which
 * directories can be projects.
 *
 * @param {{ platform?: string, env?: Record<string, string | undefined> }} [options]
 * @returns {string} Absolute home directory, or "" when unknown.
 */
export function userHomeDirectory(options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const value = platform === "win32" ? (env.USERPROFILE || env.HOME) : (env.HOME || env.USERPROFILE);
  return String(value || "").trim();
}

/**
 * Whether a directory carrying a marker may be read as a project boundary.
 *
 * The walk used to run to the root of the filesystem and stop at the first
 * marker, so a single `package.json` in `~` — and anyone who has once run npm
 * from their home directory has one — made every project below it collapse
 * onto one memory key: the session handoffs, instincts and context of one
 * project served to an agent working in another, silently.
 * So a marker sitting in the home directory itself, or
 * anywhere above it, is not a boundary. Below the home directory, and outside
 * it entirely (`/srv/app`, `C:\work\app`), nothing changes.
 *
 * Pass canonical (realpath) values, as the walk does, so a home reached through
 * a symlink still compares equal to the walked path.
 *
 * @param {string} directory - Absolute candidate directory.
 * @param {{ platform?: string, homeDir?: string, env?: Record<string, string | undefined> }} [options]
 * @returns {boolean}
 */
export function isProjectBoundaryCandidate(directory, options = {}) {
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? userHomeDirectory({ platform, env: options.env });
  if (!homeDir) return true;
  const candidate = comparablePath(directory, platform);
  const home = comparablePath(homeDir, platform);
  return candidate !== home && !home.startsWith(`${candidate}/`);
}

function uniquePaths(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    if (!value) continue;
    const resolved = path.resolve(value);
    const key = normalizePath(resolved);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(resolved);
  }
  return result;
}

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function git(cwd, args) {
  try {
    return await runProcess({
      executable: "git",
      args: ["-C", cwd, ...args],
      cwd,
      timeoutMs: 15_000,
      maxOutputBytes: 256 * 1024
    });
  } catch {
    return { ok: false, exitCode: null, stdout: "", stderr: "" };
  }
}

/** The user's home directory as the walk reads paths: canonical, or "". */
async function canonicalHomeDirectory() {
  const homeDir = userHomeDirectory();
  if (!homeDir) return "";
  return fs.realpath(homeDir).catch(() => path.resolve(homeDir));
}

async function nearestProjectBoundary(start, homeDir) {
  let current = start;
  // Canonical, for the same reason the hook's copy is: `start` is already a
  // realpath, and on a machine that reaches its home through a symlink — every
  // macOS temp directory, via /var/folders -> /private/var — an unresolved
  // runtime root never equals the walked one, so `.ai-dev` counts as a project
  // marker and the walk stops on the runtime directory itself.
  const configured = configuredRuntimeStateRoot || resolveRuntimeStateRoot();
  const runtimeRoot = normalizePath(await fs.realpath(configured).catch(() => path.resolve(configured)));
  while (true) {
    // Once the walk reaches the home directory every remaining ancestor is
    // above it too, so there is nothing left that may be a boundary: the start
    // directory stands for itself.
    if (!isProjectBoundaryCandidate(current, { homeDir })) return null;
    for (const marker of BOUNDARY_MARKERS) {
      const markerPath = path.join(current, marker);
      if (marker === ".ai-dev" && normalizePath(markerPath) === runtimeRoot) continue;
      if (await pathExists(markerPath)) return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function sanitizeRemote(raw) {
  const value = String(raw || "").trim();
  if (!value) return "";
  const scpLike = value.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/);
  if (scpLike && !/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    return `${scpLike[1].toLowerCase()}/${scpLike[2].replace(/\.git$/i, "").replace(/^\/+/, "")}`;
  }
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    const pathname = url.pathname.replace(/\.git$/i, "").replace(/\/+$/, "");
    return `${url.hostname.toLowerCase()}${pathname}`;
  } catch {
    return value
      .replace(/\/\/[^/@\s]+@/g, "//")
      .replace(/\.git$/i, "")
      .replace(/\/+$/, "");
  }
}

async function canonicalGitPath(cwd, raw) {
  const absolute = path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
  return fs.realpath(absolute).catch(() => path.resolve(absolute));
}

/**
 * Hash the clone (its `--git-common-dir`, shared by every linked worktree) plus
 * the project's path inside its own worktree, which reads the same in the main
 * checkout and in any worktree of that clone.
 *
 * @param {string} commonDir - Canonical `--git-common-dir`.
 * @param {string} subPath - Project root relative to its worktree root.
 * @returns {string}
 */
function repositoryKey(commonDir, subPath) {
  // A path that escapes the worktree is not a sub-project of it: key on the
  // clone alone rather than inventing a scope out of `..` segments.
  const scope = String(subPath || "").replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  const key = `git-common:${normalizePath(commonDir)}${!scope || scope.startsWith("..") ? "" : `#${scope}`}`;
  return `repository-${hash(process.platform === "win32" ? key.toLowerCase() : key).slice(0, 20)}`;
}

/**
 * Identity of the Git clone a project belongs to. `git rev-parse
 * --git-common-dir` resolves to the same directory in the main checkout and in
 * every linked worktree, so memory keyed by this id (session handoffs,
 * instincts, context extras) survives `begin_task_in_worktree` and the
 * "task = worktree" scheme, while tasks stay keyed by `project_id`. Packages of
 * a monorepo keep their own id: the key carries the project's path inside its
 * worktree too.
 *
 * @param {string} projectRoot - Absolute path inside a Git working tree.
 * @returns {Promise<string | null>} `repository-<hash>`, or null outside Git.
 */
export async function repositoryId(projectRoot) {
  const root = path.resolve(projectRoot);
  const [commonDirResult, toplevelResult] = await Promise.all([
    git(root, ["rev-parse", "--git-common-dir"]),
    git(root, ["rev-parse", "--show-toplevel"])
  ]);
  const rawCommonDir = commonDirResult.ok ? commonDirResult.stdout.trim() : "";
  if (!rawCommonDir) return null;
  const canonicalRoot = await fs.realpath(root).catch(() => root);
  const worktreeRoot = toplevelResult.ok && toplevelResult.stdout.trim()
    ? await canonicalGitPath(root, toplevelResult.stdout.trim())
    : canonicalRoot;
  const commonDir = await canonicalGitPath(root, rawCommonDir);
  return repositoryKey(commonDir, path.relative(worktreeRoot, canonicalRoot));
}

/**
 * Derive a stable identity for a project directory: canonical (realpath) root,
 * git detection, sanitised `origin` remote (credentials and `.git` stripped),
 * a content-hashed `project_id` (this working tree) and `repository_id` (the
 * clone behind it, see {@link repositoryId}), and every known path alias.
 *
 * @param {string} projectPath - Absolute path to a project directory.
 * @returns {Promise<{ schema_version: number, project_id: string, repository_id: string | null, kind: "git" | "filesystem", project_root: string, canonical_path: string, requested_path: string, aliases: string[], git: { detected: boolean, root: string | null, common_dir: string | null, remote: string | null } }>}
 */
export async function resolveProjectIdentity(projectPath) {
  if (!projectPath || typeof projectPath !== "string" || !path.isAbsolute(projectPath)) {
    throw new Error("projectPath must be an absolute directory path.");
  }

  const requestedPath = path.resolve(projectPath);
  const stats = await fs.stat(requestedPath).catch(() => null);
  if (!stats?.isDirectory()) throw new Error(`Project directory does not exist: ${projectPath}`);

  const requestedRealPath = await fs.realpath(requestedPath);
  const gitRootResult = await git(requestedRealPath, ["rev-parse", "--show-toplevel"]);
  const rawGitRoot = gitRootResult.ok ? gitRootResult.stdout.trim() : "";
  // A nested package or explicit .ai-dev directory remains its own project even
  // when it lives inside a larger Git worktree. The closest boundary wins.
  const homeDir = await canonicalHomeDirectory();
  const boundary = await nearestProjectBoundary(requestedRealPath, homeDir);
  const isGit = Boolean(rawGitRoot);
  const gitRoot = isGit
    ? await fs.realpath(rawGitRoot).catch(() => path.resolve(rawGitRoot))
    : null;
  // A dotfiles clone in `~` answers `--show-toplevel` with the home directory
  // for every project below it, so the rule that keeps a marker there from
  // being a boundary keeps it out of this fallback too.
  const gitFallback = gitRoot && isProjectBoundaryCandidate(gitRoot, { homeDir }) ? gitRoot : "";
  const projectRoot = await fs.realpath(path.resolve(boundary || gitFallback || requestedRealPath));

  let remote = "";
  let commonGitDir = "";
  if (isGit) {
    const [remoteResult, commonDirResult] = await Promise.all([
      git(projectRoot, ["config", "--get", "remote.origin.url"]),
      git(projectRoot, ["rev-parse", "--git-common-dir"])
    ]);
    remote = remoteResult.ok ? sanitizeRemote(remoteResult.stdout) : "";
    if (commonDirResult.ok && commonDirResult.stdout.trim()) {
      const rawCommonDir = commonDirResult.stdout.trim();
      commonGitDir = await canonicalGitPath(projectRoot, rawCommonDir);
    }
  }

  const canonicalKey = `${isGit ? "git" : "filesystem"}:${normalizePath(projectRoot)}`;
  return {
    schema_version: PROJECT_ID_VERSION,
    project_id: `project-${hash(canonicalKey).slice(0, 20)}`,
    repository_id: commonGitDir ? repositoryKey(commonGitDir, path.relative(gitRoot, projectRoot)) : null,
    kind: isGit ? "git" : "filesystem",
    project_root: projectRoot,
    canonical_path: projectRoot,
    requested_path: requestedPath,
    aliases: uniquePaths([requestedPath, requestedRealPath, gitRoot, projectRoot]),
    git: {
      detected: isGit,
      root: gitRoot,
      common_dir: commonGitDir || null,
      remote: remote || null
    }
  };
}

/**
 * Compare two identities (or identity/path values) by `project_id` when both
 * have one, otherwise by normalised canonical path.
 *
 * @param {object | string} left
 * @param {object | string} right
 * @returns {boolean}
 */
export function sameProjectIdentity(left, right) {
  if (!left || !right) return false;
  if (left.project_id && right.project_id) return left.project_id === right.project_id;
  return normalizePath(left.canonical_path || left.project_root || left)
    === normalizePath(right.canonical_path || right.project_root || right);
}

/**
 * Return a stable storage key for an identity object (its `project_id`) or,
 * given a bare path, a filesystem-derived `project-<hash>` key.
 *
 * @param {{ project_id?: string } | string} identityOrPath
 * @returns {string}
 */
export function projectIdentityKey(identityOrPath) {
  if (identityOrPath && typeof identityOrPath === "object" && identityOrPath.project_id) {
    return identityOrPath.project_id;
  }
  return `project-${hash(`filesystem:${normalizePath(identityOrPath)}`).slice(0, 20)}`;
}

/**
 * Storage keys for cross-worktree memory, in read order: the `repository_id`
 * every worktree of one clone shares, then the `project_id` records were
 * written under before repository ids existed. A write uses the first key and
 * migrates the rest into it; a read merges all of them.
 *
 * Accepts an identity object (`repository_id` / `project_id`), the camelCase
 * form the stores take, or a bare key.
 *
 * @param {{ repositoryId?: string | null, repository_id?: string | null, projectId?: string | null, project_id?: string | null } | string} scope
 * @returns {string[]}
 */
export function memoryScopeKeys(scope) {
  const candidates = scope && typeof scope === "object"
    ? [scope.repositoryId ?? scope.repository_id, scope.projectId ?? scope.project_id]
    : [scope];
  const keys = [];
  for (const candidate of candidates) {
    const key = String(candidate ?? "").trim();
    if (key && !keys.includes(key)) keys.push(key);
  }
  return keys;
}
