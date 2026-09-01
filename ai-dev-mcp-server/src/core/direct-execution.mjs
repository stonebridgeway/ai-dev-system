import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

function asFilePath(value) {
  if (value instanceof URL) return fileURLToPath(value);
  const text = String(value || "");
  return text.startsWith("file:") ? fileURLToPath(text) : text;
}

function comparablePath(value) {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/**
 * Resolve a path, `file:` URL, or `URL` to its real (symlink-followed),
 * normalised, case-folded form so two references to the same file compare equal.
 *
 * @param {string | URL} value - Path or file URL.
 * @returns {Promise<string>} Canonical comparable path.
 */
export async function canonicalExecutablePath(value) {
  const resolved = path.resolve(asFilePath(value));
  const canonical = await fs.realpath(resolved).catch(() => resolved);
  return comparablePath(canonical);
}

/**
 * Report whether the current module is the process entry point (the ESM
 * equivalent of `require.main === module`), tolerant of symlinked launchers.
 *
 * @param {string | URL} moduleUrl - Usually `import.meta.url` of the caller.
 * @param {string} [argvEntry=process.argv[1]] - Overridable entry path (for tests).
 * @returns {Promise<boolean>} True when the module was run directly.
 */
export async function isDirectExecution(moduleUrl, argvEntry = process.argv[1]) {
  if (!argvEntry) return false;
  const [entryPath, modulePath] = await Promise.all([
    canonicalExecutablePath(argvEntry),
    canonicalExecutablePath(moduleUrl)
  ]);
  return entryPath === modulePath;
}
