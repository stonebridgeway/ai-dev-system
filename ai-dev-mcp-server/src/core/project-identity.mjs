import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { runProcess } from "./process-runner.mjs";
import { resolveRuntimeStateRoot } from "./runtime-home.mjs";

const PROJECT_ID_VERSION = 1;

// The host (mcp-stdio) knows `vaultRoot`; project-identity does not. It sets this
// once at startup so the runtime-state directory is identified consistently.
let configuredRuntimeStateRoot = "";

/**
 * Pin the absolute runtime-state root (`<home>/.ai-dev`) so project-boundary
 * detection never treats it as a project. Call once during host startup.
 *
 * @param {string} stateRoot
 */
export function configureRuntimeStateRoot(stateRoot) {
  configuredRuntimeStateRoot = stateRoot ? String(stateRoot) : "";
}

function hash(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function normalizePath(value) {
  const resolved = path.resolve(value).replaceAll("\\", "/").replace(/\/+$/, "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
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

async function nearestProjectBoundary(start) {
  let current = start;
  const runtimeRoot = normalizePath(configuredRuntimeStateRoot || resolveRuntimeStateRoot());
  while (true) {
    if (
      (normalizePath(path.join(current, ".ai-dev")) !== runtimeRoot && await pathExists(path.join(current, ".ai-dev")))
      || await pathExists(path.join(current, ".git"))
    ) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return start;
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

/**
 * Derive a stable identity for a project directory: canonical (realpath) root,
 * git detection, sanitised `origin` remote (credentials and `.git` stripped),
 * a content-hashed `project_id` / `repository_id`, and every known path alias.
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
  const boundary = rawGitRoot || await nearestProjectBoundary(requestedRealPath);
  const projectRoot = await fs.realpath(path.resolve(boundary));
  const isGit = Boolean(rawGitRoot);

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
      const absoluteCommonDir = path.isAbsolute(rawCommonDir)
        ? rawCommonDir
        : path.resolve(projectRoot, rawCommonDir);
      commonGitDir = await fs.realpath(absoluteCommonDir).catch(() => path.resolve(absoluteCommonDir));
    }
  }

  const canonicalKey = `${isGit ? "git" : "filesystem"}:${normalizePath(projectRoot)}`;
  return {
    schema_version: PROJECT_ID_VERSION,
    project_id: `project-${hash(canonicalKey).slice(0, 20)}`,
    repository_id: remote ? `repository-${hash(remote).slice(0, 20)}` : null,
    kind: isGit ? "git" : "filesystem",
    project_root: projectRoot,
    canonical_path: projectRoot,
    requested_path: requestedPath,
    aliases: uniquePaths([requestedPath, requestedRealPath, rawGitRoot, projectRoot]),
    git: {
      detected: isGit,
      root: isGit ? projectRoot : null,
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
