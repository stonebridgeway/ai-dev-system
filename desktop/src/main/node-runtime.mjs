/**
 * The Node.js the daemon runs on. The desktop app is not Node — its own
 * executable is Electron — and the daemon's build includes the Node it runs
 * on, so the app must start and reach the daemon with the same Node the AI
 * clients' `ai-dev mcp` uses, or it would get a daemon of its own.
 *
 * Looked for in this order: `AI_DEV_NODE`; the Node the Windows installer
 * ships, which the clients it connects run too; the Node an AI client's
 * ai-dev entry runs (what `ai-dev clients install` wrote); `PATH`; the places
 * installers put Node, which a GUI app on macOS does not have on its PATH.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** The oldest Node the server runs on (`engines` in ai-dev-mcp-server/package.json). */
export const MINIMUM_NODE = Object.freeze([22, 16, 0]);

function executable(file, platform) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return false;
    if (platform === "win32") return true;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Where installers and version managers put Node, newest first where there are several. */
function wellKnown({ env, platform, home }) {
  const places = [];
  if (platform === "win32") {
    for (const base of [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Programs")]) {
      if (base) places.push(path.join(base, "nodejs", "node.exe"));
    }
    if (env.NVM_SYMLINK) places.push(path.join(env.NVM_SYMLINK, "node.exe"));
    if (env.VOLTA_HOME) places.push(path.join(env.VOLTA_HOME, "bin", "node.exe"));
    return places;
  }
  places.push("/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node");
  places.push(path.join(home, ".volta", "bin", "node"));
  const nvm = path.join(env.NVM_DIR || path.join(home, ".nvm"), "versions", "node");
  try {
    const versions = fs.readdirSync(nvm).filter((name) => /^v\d+\.\d+\.\d+$/.test(name));
    versions.sort((left, right) => compareVersions(parseVersion(right), parseVersion(left)));
    for (const version of versions) places.push(path.join(nvm, version, "bin", "node"));
  } catch {
    // no nvm
  }
  return places;
}

function onPath({ env, platform }) {
  const names = platform === "win32" ? ["node.exe"] : ["node"];
  const value = env.PATH ?? env.Path ?? "";
  const separator = platform === "win32" ? ";" : ":";
  return value.split(separator).filter(Boolean).flatMap((folder) => names.map((name) => path.join(folder, name)));
}

/** `v22.16.0` → `[22, 16, 0]`; null when it is not a version. */
export function parseVersion(text) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(text ?? "").trim());
  return match ? match.slice(1, 4).map(Number) : null;
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

/** Whether a Node version runs the server: 22.16 and later, not the 23 line (no FTS5 in its node:sqlite). */
export function supportedVersion(version) {
  if (!version) return false;
  if (version[0] === 23) return false;
  return compareVersions(version, MINIMUM_NODE) >= 0;
}

/**
 * Find the Node to run the daemon with. Without one, `problem` says why in
 * English and `reason` names the same words in the page's dictionary
 * (`node.problem.*`), so the window says it in its language.
 *
 * @param {{ env?: NodeJS.ProcessEnv, platform?: string, home?: string, bundled?: string[], clientNodes?: string[], versionOf?: (file: string) => string | null }} [options]
 *   `bundled` — the Node the Windows installer ships, through its stable link;
 *   `clientNodes` — the executables AI clients' ai-dev entries run, when known.
 * @returns {{ path: string, version: string, source: string } | { path: null, problem: string, reason: { key: string, params?: object }, tried: string[] }}
 */
export function findNode({ env = process.env, platform = process.platform, home = os.homedir(), bundled = [], clientNodes = [], versionOf = nodeVersion } = {}) {
  const candidates = [];
  if (env.AI_DEV_NODE) candidates.push({ file: env.AI_DEV_NODE, source: "AI_DEV_NODE", only: true });
  for (const file of bundled) candidates.push({ file, source: "bundled" });
  for (const file of clientNodes) candidates.push({ file, source: "client" });
  for (const file of onPath({ env, platform })) candidates.push({ file, source: "PATH" });
  for (const file of wellKnown({ env, platform, home })) candidates.push({ file, source: "installed" });
  const tried = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const file = path.resolve(candidate.file);
    if (seen.has(file)) continue;
    seen.add(file);
    tried.push(file);
    if (!executable(file, platform)) {
      if (candidate.only) return { path: null, problem: `AI_DEV_NODE names ${file}, which is not an executable file.`, reason: { key: "node.problem.notExecutable", params: { path: file } }, tried };
      continue;
    }
    const version = versionOf(file);
    if (supportedVersion(parseVersion(version))) return { path: file, version, source: candidate.source };
    if (candidate.only) {
      const problem = `AI_DEV_NODE names Node ${version ?? "of an unknown version"}; AI Dev needs 22.16 or newer (not 23).`;
      return { path: null, problem, reason: { key: version ? "node.problem.version" : "node.problem.unknownVersion", params: { path: file, version } }, tried };
    }
  }
  return { path: null, problem: "No Node.js 22.16 or newer was found.", reason: { key: "node.problem.none" }, tried };
}

/** `node --version` of an executable, or null. */
export function nodeVersion(file) {
  const result = spawnSync(file, ["--version"], { encoding: "utf8", timeout: 5000, windowsHide: true, shell: false });
  return result.status === 0 ? result.stdout.trim() : null;
}
