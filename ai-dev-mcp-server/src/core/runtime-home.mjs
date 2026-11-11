import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The user's home directory: where `.ai-dev` lives when `AI_DEV_HOME` is not set.
 *
 * Modules that know `vaultRoot` pass it so its parent is the last resort;
 * modules that do not (e.g. project-identity) fall back to `os.homedir()`.
 *
 * @param {string} [vaultRoot] - Absolute vault root, when the caller knows it.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} Absolute home directory.
 */
export function resolveUserHome(vaultRoot = "", env = process.env) {
  return env.USERPROFILE
    || env.HOME
    || (vaultRoot ? path.dirname(path.resolve(vaultRoot)) : os.homedir());
}

/** As `realpathOf` in hooks/lib.mjs: libuv's resolution, then the JavaScript one, then the path as given. */
function realpathOrSelf(value) {
  try {
    return fs.realpathSync.native(value);
  } catch {
    /* fall through */
  }
  try {
    return fs.realpathSync(value);
  } catch {
    return value;
  }
}

/**
 * Whether two paths name the same directory: through symlinks, and without
 * regard to case where the filesystem ignores it by default (Windows, macOS).
 * Comparing the strings let `c:\users\me` or a symlinked home pass for a
 * different folder than `C:\Users\Me`.
 *
 * @param {string} left
 * @param {string} right
 * @param {{ platform?: string, realpath?: (value: string) => string }} [options]
 * @returns {boolean}
 */
export function sameDirectory(left, right, { platform = process.platform, realpath = realpathOrSelf } = {}) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const canonical = (value) => {
    const resolved = paths.resolve(realpath(paths.resolve(value)));
    return platform === "win32" || platform === "darwin" ? resolved.toLowerCase() : resolved;
  };
  return canonical(left) === canonical(right);
}

/**
 * `AI_DEV_HOME`, when it names a runtime folder rather than the home itself.
 *
 * `AI_DEV_HOME` is the runtime folder. One value cannot mean that: the home
 * directory itself, which some 2.x setups used because 2.x appended `.ai-dev`
 * to the variable. Taken at its word it would scatter `state/`, `cache/` and
 * `models/` across the home, so it keeps meaning what 2.x made of it —
 * `<home>/.ai-dev`.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ platform?: string, realpath?: (value: string) => string }} [options] - for tests
 * @returns {string} absolute path, or "" when the variable is unset or names the home
 */
export function explicitRuntimeHome(env = process.env, options = {}) {
  const raw = String(env.AI_DEV_HOME ?? "").trim();
  if (!raw) return "";
  const homes = [env.USERPROFILE, env.HOME, os.homedir()].filter(Boolean);
  return homes.some((home) => sameDirectory(home, raw, options)) ? "" : path.resolve(raw);
}

/**
 * Absolute path of the runtime state root: `AI_DEV_HOME` itself, else `<home>/.ai-dev`.
 *
 * This is the single definition; the hooks carry a copy (`runtimeStateRoot` in
 * `hooks/lib.mjs`) that must give the same answer (AGENTS.md, rule 3). The copy
 * has one source more, read only when `AI_DEV_HOME` is not in the hook's own
 * environment: the folder this server ran with, recorded beside the hooks when
 * it installed them (`.ai-dev-home`) — a client started
 * from the Dock gives its server the variable from its config, not its hooks.
 *
 * @param {string} [vaultRoot]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolveRuntimeStateRoot(vaultRoot = "", env = process.env) {
  return explicitRuntimeHome(env) || path.join(resolveUserHome(vaultRoot, env), ".ai-dev");
}

/**
 * Where 2.x put the runtime tree for someone who set `AI_DEV_HOME`:
 * `<AI_DEV_HOME>/.ai-dev`. Empty when the variable is unset.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function legacyDoubledRuntimeRoot(env = process.env) {
  const explicit = explicitRuntimeHome(env);
  return explicit ? path.join(explicit, ".ai-dev") : "";
}
