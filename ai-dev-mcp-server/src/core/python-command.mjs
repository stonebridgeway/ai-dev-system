/**
 * Which Python interpreter runs the optional Python helpers — the UI UX Pro Max
 * script behind `query_ui_ux_knowledge` and the legacy dense backend. Search
 * does not need one.
 *
 * The server and the client installer used to decide separately: the server
 * fell back to `python` on Windows, the installer to `python3` everywhere, and
 * a client configured on Windows overrode a working interpreter with one that
 * is not there. This is the only place that picks it.
 */
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { locateExecutable, runProcess } from "./process-runner.mjs";

/** How long `python --version` may take; a first start on Windows can take a second. */
export const PYTHON_PROBE_TIMEOUT_MS = 10_000;

/**
 * The interpreter a bundled runtime ships beside Node:
 * `<runtime>/node/bin/node` next to `<runtime>/python/…`.
 *
 * @param {{ platform?: string, execPath?: string }} [options]
 * @returns {string}
 */
export function bundledPythonPath({ platform = process.platform, execPath = process.execPath } = {}) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const runtimeRoot = paths.resolve(paths.dirname(execPath), "..", "..");
  return platform === "win32"
    ? paths.join(runtimeRoot, "python", "python.exe")
    : paths.join(runtimeRoot, "python", "bin", "python");
}

/**
 * `AI_DEV_PYTHON` when set, else a bundled interpreter, else the name the
 * platform's own installers provide: `python3` off Windows — macOS dropped
 * `python` with Python 2 — and `python` on Windows, where the python.org
 * installer and the Store alias give that name and `python3.exe` is, where it
 * exists at all, often the Store's placeholder.
 *
 * @param {{ env?: NodeJS.ProcessEnv, platform?: string, execPath?: string, exists?: (file: string) => boolean }} [options]
 * @returns {string}
 */
export function resolvePythonCommand({
  env = process.env,
  platform = process.platform,
  execPath = process.execPath,
  exists = existsSync
} = {}) {
  const explicit = String(env.AI_DEV_PYTHON ?? "").trim();
  if (explicit) return explicit;
  const bundled = bundledPythonPath({ platform, execPath });
  if (exists(bundled)) return bundled;
  return platform === "win32" ? "python" : "python3";
}

/**
 * Whether `command` is a Python 3 that runs: found where a spawn would look,
 * and answering `--version` as one. Finding the file is not enough — an
 * explicit path that moved is returned by the locator as given, and on Windows
 * the Store's `python.exe` alias is a file that opens the Store instead.
 *
 * @param {string} command
 * @param {{ locate?: (command: string) => Promise<string>, runner?: typeof runProcess, timeoutMs?: number }} [options]
 * @returns {Promise<{ command: string, version?: string, missing?: true, failure?: string }>}
 */
export async function probePython(command, {
  locate = locateExecutable,
  runner = runProcess,
  timeoutMs = PYTHON_PROBE_TIMEOUT_MS
} = {}) {
  const binary = await locate(command).catch(() => "");
  if (!binary) return { command, missing: true };
  let answer;
  try {
    answer = await runner({ executable: binary, args: ["--version"], cwd: os.tmpdir(), timeoutMs });
  } catch (error) {
    if (error?.code === "ENOENT") return { command, missing: true };
    return { command, failure: String(error?.message ?? error).split(/\r?\n/)[0] };
  }
  const said = `${answer?.stdout ?? ""}\n${answer?.stderr ?? ""}`;
  const version = /^Python (3\.\d+\S*)/m.exec(said)?.[1];
  if (answer?.ok && version) return { command, version };
  const first = said.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
  if (answer?.timedOut) return { command, failure: "it did not answer in time" };
  return { command, failure: first ? first.slice(0, 160) : `it exited with ${answer?.exitCode}` };
}
