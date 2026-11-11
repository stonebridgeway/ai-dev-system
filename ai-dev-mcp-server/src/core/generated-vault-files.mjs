/**
 * What the server writes into a vault itself, as opposed to what a person or
 * the seed puts there: the skill registry and the notes rendered from it, the
 * project cards a vault-less server keeps, the dashboards. A standalone
 * checkout's git ignores them and a full vault commits some of them; either
 * way they are output, written anew by each generation. So the seed check
 * does not count them as drift (`scripts/verify-public-seed.mjs`), and a 2.x
 * index is not told by them whose vault it was built from
 * (`search-index-owner.mjs`).
 */

/** Folders whose files are all generated, vault-relative with `/`. */
export const GENERATED_PREFIXES = Object.freeze([
  "03-skills-catalog/registries/",
  "03-skills-catalog/cards/",
  "03-skills-catalog/groups/",
  // A server without an Obsidian vault runs against the seed and writes its
  // project cards here. Git ignores them; so does the seed.
  "02-knowledge/Projects/"
]);

/**
 * Dashboards rendered on demand by `validate_skill_library`,
 * `rebuild_system_dashboard` and `render_knowledge_galaxy`.
 */
export const GENERATED_FILES = Object.freeze([
  "03-skills-catalog/Skill Quality Dashboard.md",
  "01-system/System Dashboard.md",
  "01-system/system-dashboard.json",
  "01-system/Knowledge Galaxy.html"
]);

/**
 * Whether a vault-relative path is one the server generates.
 *
 * @param {string} relativePath - With `/`.
 * @param {{ ignoreCase?: boolean }} [options] - `ignoreCase`: as a file system that ignores case finds it.
 * @returns {boolean}
 */
export function isGeneratedVaultFile(relativePath, { ignoreCase = false } = {}) {
  const fold = (text) => (ignoreCase ? text.toLowerCase() : text);
  const wanted = fold(String(relativePath));
  return GENERATED_FILES.some((file) => fold(file) === wanted)
    || GENERATED_PREFIXES.some((prefix) => wanted.startsWith(fold(prefix)));
}
