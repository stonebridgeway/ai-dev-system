import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export class PathPolicyError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "PathPolicyError";
    this.code = "PATH_POLICY_VIOLATION";
    this.details = details;
  }
}

function comparable(value) {
  const normalized = path.resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/**
 * Lexical containment check: is `candidate` at or below `root` without any `..`
 * escape? Case-insensitive on Windows. Does not touch the filesystem.
 *
 * @param {string} root - Directory that must contain the candidate.
 * @param {string} candidate - Path to test.
 * @param {{ allowRoot?: boolean }} [options] - Whether `candidate === root` counts as inside (default true).
 * @returns {boolean}
 */
export function isPathInside(root, candidate, { allowRoot = true } = {}) {
  const rootValue = comparable(root);
  const candidateValue = comparable(candidate);
  const relative = path.relative(rootValue, candidateValue);
  if (relative === "") return allowRoot;
  return relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function assertLexicalContainment(root, candidate, options = {}) {
  if (!isPathInside(root, candidate, options)) {
    throw new PathPolicyError("Path escapes the allowed root.", {
      root: path.resolve(root),
      candidate: path.resolve(candidate)
    });
  }
}

function nearestExistingAncestorSync(candidate) {
  let current = path.resolve(candidate);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      throw new PathPolicyError("No existing ancestor found.", { candidate });
    }
    current = parent;
  }
  return current;
}

async function nearestExistingAncestor(candidate) {
  let current = path.resolve(candidate);
  while (true) {
    try {
      await fsp.lstat(current);
      return current;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) {
        throw new PathPolicyError("No existing ancestor found.", { candidate });
      }
      current = parent;
    }
  }
}

/**
 * Resolve `requestedPath` against `root` and prove — both lexically and via
 * `realpath` (symlink-aware) — that the result stays inside `root`. For writes
 * the check walks to the nearest existing ancestor so new files are allowed.
 * Throws {@link PathPolicyError} on any violation.
 *
 * @param {string} root - Trusted root directory.
 * @param {string} requestedPath - Relative (or, with `allowAbsolute`, absolute) path.
 * @param {{ mode?: "read" | "write", allowAbsolute?: boolean, allowRoot?: boolean }} [options]
 * @returns {string} Absolute, containment-checked path.
 */
export function resolveWithinSync(
  root,
  requestedPath,
  { mode = "read", allowAbsolute = false, allowRoot = false } = {}
) {
  if (typeof requestedPath !== "string" || requestedPath.trim() === "") {
    throw new PathPolicyError("A non-empty path is required.");
  }
  const rootAbsolute = path.resolve(root);
  const candidate = path.isAbsolute(requestedPath)
    ? path.resolve(requestedPath)
    : path.resolve(rootAbsolute, requestedPath);
  if (path.isAbsolute(requestedPath) && !allowAbsolute) {
    throw new PathPolicyError("Absolute paths are not allowed.", { requestedPath });
  }
  assertLexicalContainment(rootAbsolute, candidate, { allowRoot });

  const rootReal = fs.realpathSync.native(rootAbsolute);
  if (mode === "read" || fs.existsSync(candidate)) {
    const candidateReal = fs.realpathSync.native(candidate);
    assertLexicalContainment(rootReal, candidateReal, { allowRoot });
  } else {
    const ancestor = nearestExistingAncestorSync(candidate);
    const ancestorReal = fs.realpathSync.native(ancestor);
    assertLexicalContainment(rootReal, ancestorReal, { allowRoot: true });
  }
  return candidate;
}

/**
 * Async counterpart of {@link resolveWithinSync} using `fs.promises.realpath`.
 *
 * @param {string} root - Trusted root directory.
 * @param {string} requestedPath - Relative (or, with `allowAbsolute`, absolute) path.
 * @param {{ mode?: "read" | "write", allowAbsolute?: boolean, allowRoot?: boolean }} [options]
 * @returns {Promise<string>} Absolute, containment-checked path.
 */
export async function resolveWithin(
  root,
  requestedPath,
  { mode = "read", allowAbsolute = false, allowRoot = false } = {}
) {
  if (typeof requestedPath !== "string" || requestedPath.trim() === "") {
    throw new PathPolicyError("A non-empty path is required.");
  }
  const rootAbsolute = path.resolve(root);
  const candidate = path.isAbsolute(requestedPath)
    ? path.resolve(requestedPath)
    : path.resolve(rootAbsolute, requestedPath);
  if (path.isAbsolute(requestedPath) && !allowAbsolute) {
    throw new PathPolicyError("Absolute paths are not allowed.", { requestedPath });
  }
  assertLexicalContainment(rootAbsolute, candidate, { allowRoot });

  const rootReal = await fsp.realpath(rootAbsolute);
  if (mode === "read") {
    const candidateReal = await fsp.realpath(candidate);
    assertLexicalContainment(rootReal, candidateReal, { allowRoot });
  } else {
    const ancestor = await nearestExistingAncestor(candidate);
    const ancestorReal = await fsp.realpath(ancestor);
    assertLexicalContainment(rootReal, ancestorReal, { allowRoot: true });
  }
  return candidate;
}

/**
 * POSIX-style (`/`-separated) path of `candidate` relative to `root`, after
 * asserting lexical containment. Throws {@link PathPolicyError} if it escapes.
 *
 * @param {string} root - Base directory.
 * @param {string} candidate - Path at or below `root`.
 * @returns {string} Forward-slash relative path.
 */
export function relativeWithin(root, candidate) {
  const rootAbsolute = path.resolve(root);
  const candidateAbsolute = path.resolve(candidate);
  assertLexicalContainment(rootAbsolute, candidateAbsolute, { allowRoot: true });
  return path.relative(rootAbsolute, candidateAbsolute).replaceAll(path.sep, "/");
}
