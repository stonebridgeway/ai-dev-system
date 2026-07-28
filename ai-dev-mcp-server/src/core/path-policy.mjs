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

export function relativeWithin(root, candidate) {
  const rootAbsolute = path.resolve(root);
  const candidateAbsolute = path.resolve(candidate);
  assertLexicalContainment(rootAbsolute, candidateAbsolute, { allowRoot: true });
  return path.relative(rootAbsolute, candidateAbsolute).replaceAll(path.sep, "/");
}
