import crypto from "node:crypto";
import path from "node:path";
import { runProcess } from "./process-runner.mjs";

function hash(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

async function git(projectRoot, args) {
  try {
    return await runProcess({
      executable: "git",
      args: ["-C", path.resolve(projectRoot), ...args],
      cwd: projectRoot,
      timeoutMs: 15_000,
      maxOutputBytes: 1024 * 1024
    });
  } catch {
    return { ok: false, exitCode: null, stdout: "", stderr: "" };
  }
}

/**
 * Snapshot a project's verification state. For a git repo this is HEAD + branch
 * + full porcelain status, hashed into a `fingerprint` (strength `"strong"`);
 * for a non-git directory only the path is fingerprinted (strength `"weak"`).
 *
 * @param {string} projectRoot - Repository or directory path.
 * @returns {Promise<{ kind: "git" | "filesystem", project_root: string, git: boolean, head?: string, branch?: string, dirty?: boolean, dirty_files?: string[], status_hash?: string, fingerprint: string, captured_at: string, strength: "strong" | "weak" }>}
 */
export async function captureProjectState(projectRoot) {
  const rootResult = await git(projectRoot, ["rev-parse", "--show-toplevel"]);
  if (!rootResult.ok) {
    return {
      kind: "filesystem",
      project_root: path.resolve(projectRoot),
      git: false,
      fingerprint: hash(`filesystem:${path.resolve(projectRoot)}`),
      captured_at: new Date().toISOString(),
      strength: "weak"
    };
  }
  const gitRoot = rootResult.stdout.trim();
  const [head, branch, status] = await Promise.all([
    git(gitRoot, ["rev-parse", "HEAD"]),
    git(gitRoot, ["branch", "--show-current"]),
    git(gitRoot, ["status", "--porcelain=v1", "--untracked-files=all"])
  ]);
  const statusText = status.stdout.replace(/\r\n/g, "\n").trimEnd();
  const dirtyFiles = statusText
    ? statusText.split("\n").map((line) => line.slice(3).trim()).filter(Boolean)
    : [];
  const headValue = head.ok ? head.stdout.trim() : "";
  return {
    kind: "git",
    project_root: gitRoot,
    git: true,
    head: headValue,
    branch: branch.ok ? branch.stdout.trim() : "",
    dirty: dirtyFiles.length > 0,
    dirty_files: dirtyFiles,
    status_hash: hash(statusText),
    fingerprint: hash(`${headValue}\n${statusText}`),
    captured_at: new Date().toISOString(),
    strength: "strong"
  };
}

/**
 * Bind a check result to the project state it was produced from, so completion
 * can later prove the evidence is still current.
 *
 * @param {{ type: string, result?: { status?: string, gate?: string, ok?: boolean }, projectState: { fingerprint: string, head?: string }, details?: Record<string, unknown> }} input
 * @returns {{ type: string, status: string, source_state_fingerprint: string, source_head: string | null, captured_at: string, details: Record<string, unknown> }}
 */
export function bindEvidence({ type, result, projectState, details = {} }) {
  return {
    type,
    status: result?.status || result?.gate || (result?.ok ? "passed" : "unknown"),
    source_state_fingerprint: projectState.fingerprint,
    source_head: projectState.head || null,
    captured_at: new Date().toISOString(),
    details
  };
}

/**
 * True when `evidence` was captured against the exact `projectState` fingerprint
 * (i.e. nothing has changed since the check ran).
 *
 * @param {{ source_state_fingerprint?: string } | null | undefined} evidence
 * @param {{ fingerprint?: string } | null | undefined} projectState
 * @returns {boolean}
 */
export function evidenceMatchesState(evidence, projectState) {
  return Boolean(
    evidence?.source_state_fingerprint
    && evidence.source_state_fingerprint === projectState?.fingerprint
  );
}
