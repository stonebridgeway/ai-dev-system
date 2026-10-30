/**
 * What AI Dev keeps in a project for this machine alone — the import graph's
 * cache, the last security scan's stamp — stays out of the project's history:
 * `.ai-dev/.gitignore` names those folders. The rest of `.ai-dev/` (the
 * project brief, the quality gate, the policy, the hooks) is the team's and
 * is not ignored. A `.gitignore` already there is added to, never replaced.
 */
import fs from "node:fs/promises";
import path from "node:path";

/** The folders under `.ai-dev/` that one machine writes for itself. */
export const MACHINE_FOLDERS = Object.freeze(["cache/", "security/"]);

const HEADER = "# Written by AI Dev: what this machine keeps for itself, not part of the project.";

/**
 * Make `.ai-dev/.gitignore` name {@link MACHINE_FOLDERS}. Best effort: a
 * project this process cannot write to (a container's read-only mount) is
 * left as it is.
 *
 * @param {string} projectRoot
 * @returns {Promise<boolean>} whether the file was written
 */
export async function ignoreMachineFiles(projectRoot) {
  const file = path.join(path.resolve(projectRoot), ".ai-dev", ".gitignore");
  let existing = null;
  try {
    existing = await fs.readFile(file, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") return false;
  }
  const lines = new Set(String(existing ?? "").split(/\r?\n/).map((line) => line.trim().replace(/^\//, "")));
  const missing = MACHINE_FOLDERS.filter((entry) => !lines.has(entry) && !lines.has(entry.slice(0, -1)));
  if (!missing.length) return false;
  const text = existing === null
    ? `${HEADER}\n${missing.join("\n")}\n`
    : `${existing}${existing.endsWith("\n") || !existing ? "" : "\n"}${missing.join("\n")}\n`;
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text, "utf8");
    return true;
  } catch {
    return false;
  }
}
