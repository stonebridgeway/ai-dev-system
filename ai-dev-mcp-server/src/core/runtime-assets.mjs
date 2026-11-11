/**
 * Where the runtime's helper trees are, in a vault and in a plain checkout.
 *
 * Two things the server runs rather than reads: the search-eval cases and the
 * Frontend QA runner. (The Python search helper `search-index/` and the Python
 * embedding scripts `embeddings/` are gone: search and the model run in Node.)
 * In an Obsidian vault they live under `09-mcp/`, next to the server itself,
 * and every path in the runtime was written for that layout.
 *
 * A standalone checkout of this repository has both — at `search-eval/` and
 * `frontend-qa/` in the root — and no `09-mcp/` at all. `resolveVaultRoot` falls back to the bundled
 * `docker/public-seed` tree, which carries the notes and the skill catalogue
 * but not the helpers, so a cloned repository reported "Search helper not
 * found: …/docker/public-seed/09-mcp/search-index/search_cli.py" — a path that
 * can never exist there — and semantic search, the search smokes and Frontend
 * QA were unreachable without an Obsidian vault.
 *
 * So each tree is resolved in its own right: the vault layout first, because a
 * real vault is what a deployment has, then the repository layout. When neither
 * exists the vault path is returned, so the message a caller prints keeps
 * naming the layout the deployment was meant to have.
 */
import { existsSync } from "node:fs";
import path from "node:path";

/**
 * The helper trees, by the name the runtime knows them under: where each sits
 * in a vault, and where it sits in a checkout of this repository.
 */
export const RUNTIME_ASSET_TREES = Object.freeze({
  searchEval: Object.freeze({ vault: ["09-mcp", "search-eval"], repository: ["search-eval"] }),
  frontendQa: Object.freeze({ vault: ["09-mcp", "frontend-qa"], repository: ["frontend-qa"] })
});

/**
 * The notes a healthy system carries, and where each one is in a checkout.
 *
 * `null` means the note belongs to a vault and a checkout has no equivalent: an
 * Obsidian entry page is not something a cloned repository can be missing, and
 * reporting it as missing taught a new user that their install was broken when
 * it was not.
 */
export const RUNTIME_NOTE_LAYOUTS = Object.freeze({
  "09-mcp/README.md": Object.freeze(["README.md"]),
  "09-mcp/ai-dev-mcp-server/README.md": Object.freeze(["ai-dev-mcp-server", "README.md"]),
  "09-mcp/ai-dev-mcp-server/docs/ARCHITECTURE.md": Object.freeze(["ai-dev-mcp-server", "docs", "ARCHITECTURE.md"])
});

/**
 * Notes that exist only in an Obsidian vault. A checkout has no entry page and
 * is not missing one.
 */
export const VAULT_ONLY_NOTES = Object.freeze(["00-start-here.md"]);

/**
 * The file the public seed carries into every tree it seeds.
 *
 * A container's `/data` volume is seeded from `docker/public-seed` and then has
 * the runtime trees symlinked into `09-mcp/`, which made it look exactly like a
 * hand-made Obsidian vault to the check below — so it was held to the whole
 * note list, including the entry page no distribution ships, and a correct
 * container reported missing notes forever. The seed
 * says what it is; the marker is in `public-seed.manifest.json` and lands at
 * the root of whatever it seeds.
 */
export const SEEDED_DISTRIBUTION_MARKER = "PUBLIC_SEED.md";

/**
 * Whether this root was seeded from the public distribution rather than built
 * by hand in Obsidian.
 *
 * @param {string} vaultRoot
 * @param {(target: string) => boolean} [exists]
 * @returns {boolean}
 */
export function seededDistribution(vaultRoot, exists = existsSync) {
  return exists(path.join(path.resolve(vaultRoot), SEEDED_DISTRIBUTION_MARKER));
}

/**
 * Whether this root is a real vault rather than the bundled seed a checkout
 * falls back to. The MCP tree is the thing a vault has and a checkout does not.
 *
 * @param {string} vaultRoot
 * @param {(target: string) => boolean} [exists]
 * @returns {boolean}
 */
export function vaultCarriesRuntime(vaultRoot, exists = existsSync) {
  return exists(path.join(path.resolve(vaultRoot), "09-mcp"));
}

/**
 * Where one expected note is, in whichever layout this install has.
 *
 * @param {object} input
 * @param {string} input.relative - Vault-relative path, as the health check names it.
 * @param {string} input.vaultRoot
 * @param {string} input.repositoryRoot
 * @param {(target: string) => boolean} [input.exists]
 * @returns {{ path: string, source: "vault" | "repository" | "missing" | "not-applicable" }}
 */
export function resolveRuntimeNote({ relative, vaultRoot, repositoryRoot, exists = existsSync }) {
  const inVault = path.join(path.resolve(vaultRoot), ...String(relative).split("/"));
  if (exists(inVault)) return { path: inVault, source: "vault" };
  // A real vault is held to the whole list; a checkout and a seeded container
  // volume are read through the repository layout instead, and only for the
  // notes that have a place in it.
  if (vaultCarriesRuntime(vaultRoot, exists) && !seededDistribution(vaultRoot, exists)) {
    return { path: inVault, source: "missing" };
  }
  if (VAULT_ONLY_NOTES.includes(relative)) return { path: inVault, source: "not-applicable" };
  const mapped = RUNTIME_NOTE_LAYOUTS[relative];
  // Not mapped and not vault-only: a note the runtime generates into whichever
  // tree it reads. Missing means missing — it is waiting to be built, not
  // impossible here.
  if (!mapped) return { path: inVault, source: "missing" };
  const inRepository = path.join(path.resolve(repositoryRoot), ...mapped);
  return exists(inRepository)
    ? { path: inRepository, source: "repository" }
    : { path: inRepository, source: "missing" };
}

/**
 * One tree's directory, and where it was found.
 *
 * @param {object} input
 * @param {{ vault: string[], repository: string[] }} input.tree - From {@link RUNTIME_ASSET_TREES}.
 * @param {string} input.vaultRoot
 * @param {string} input.repositoryRoot
 * @param {(target: string) => boolean} [input.exists] - Injected by tests.
 * @returns {{ dir: string, source: "vault" | "repository" | "missing" }}
 */
export function resolveAssetTree({ tree, vaultRoot, repositoryRoot, exists = existsSync }) {
  const inVault = path.join(path.resolve(vaultRoot), ...tree.vault);
  if (exists(inVault)) return { dir: inVault, source: "vault" };
  const inRepository = path.join(path.resolve(repositoryRoot), ...tree.repository);
  if (exists(inRepository)) return { dir: inRepository, source: "repository" };
  return { dir: inVault, source: "missing" };
}

/**
 * Every helper tree at once, plus where each one came from.
 *
 * `sources` is the part worth reporting: a runtime answering from the
 * repository is a checkout without a vault, which is a supported way to run and
 * a useful thing to see in a diagnostic.
 *
 * @param {object} input
 * @param {string} input.vaultRoot
 * @param {string} input.repositoryRoot
 * @param {(target: string) => boolean} [input.exists]
 * @returns {{ searchEvalDir: string, frontendQaDir: string, sources: Record<string, string> }}
 */
export function resolveRuntimeAssets({ vaultRoot, repositoryRoot, exists = existsSync }) {
  const resolved = Object.fromEntries(Object.entries(RUNTIME_ASSET_TREES).map(([name, tree]) => [
    name,
    resolveAssetTree({ tree, vaultRoot, repositoryRoot, exists })
  ]));
  return {
    searchEvalDir: resolved.searchEval.dir,
    frontendQaDir: resolved.frontendQa.dir,
    sources: Object.fromEntries(Object.entries(resolved).map(([name, item]) => [name, item.source]))
  };
}
