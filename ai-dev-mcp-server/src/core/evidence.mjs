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

export function evidenceMatchesState(evidence, projectState) {
  return Boolean(
    evidence?.source_state_fingerprint
    && evidence.source_state_fingerprint === projectState?.fingerprint
  );
}
