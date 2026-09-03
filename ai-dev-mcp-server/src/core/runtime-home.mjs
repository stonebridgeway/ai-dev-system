import os from "node:os";
import path from "node:path";

/**
 * The home directory that hosts the AI Dev runtime's `~/.ai-dev` tree.
 *
 * This is the single definition of that fallback chain: modules that know
 * `vaultRoot` pass it so its parent is the last resort; modules that do not
 * (e.g. project-identity) fall back to `os.homedir()`. Keeping one function
 * means the runtime-state directory is computed identically everywhere, so
 * project-boundary detection never mistakes the runtime `.ai-dev` for a
 * project.
 *
 * @param {string} [vaultRoot] - Absolute vault root, when the caller knows it.
 * @returns {string} Absolute home directory.
 */
export function resolveRuntimeHome(vaultRoot = "") {
  return process.env.AI_DEV_HOME
    || process.env.USERPROFILE
    || process.env.HOME
    || (vaultRoot ? path.dirname(path.resolve(vaultRoot)) : os.homedir());
}

/**
 * Absolute path of the runtime state root (`<home>/.ai-dev`).
 *
 * @param {string} [vaultRoot]
 * @returns {string}
 */
export function resolveRuntimeStateRoot(vaultRoot = "") {
  return path.join(resolveRuntimeHome(vaultRoot), ".ai-dev");
}
