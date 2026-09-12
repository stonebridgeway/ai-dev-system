import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  RUNTIME_ASSET_TREES,
  VAULT_ONLY_NOTES,
  resolveAssetTree,
  resolveRuntimeAssets,
  resolveRuntimeNote,
  vaultCarriesRuntime
} from "./runtime-assets.mjs";

/** An `exists` that answers from a list of paths instead of a disk. */
function fakeExists(present) {
  const set = new Set(present.map((item) => path.resolve(item)));
  return (target) => set.has(path.resolve(target));
}

test("a vault keeps its own layout, and nothing else is consulted", () => {
  const assets = resolveRuntimeAssets({
    vaultRoot: "/vault",
    repositoryRoot: "/repo",
    exists: fakeExists([
      "/vault/09-mcp/search-index",
      "/vault/09-mcp/search-eval",
      "/vault/09-mcp/embeddings",
      "/vault/09-mcp/frontend-qa",
      // Also present in the checkout, and not used: a deployment with a vault
      // runs the vault's copies.
      "/repo/search-index",
      "/repo/embeddings"
    ])
  });
  assert.equal(assets.searchIndexDir, path.join("/vault", "09-mcp", "search-index"));
  assert.equal(assets.embeddingsDir, path.join("/vault", "09-mcp", "embeddings"));
  assert.deepEqual(assets.sources, {
    searchIndex: "vault",
    searchEval: "vault",
    embeddings: "vault",
    frontendQa: "vault"
  });
});

test("a checkout with no vault answers from the repository root", () => {
  // What a clone of this repository actually looks like: the helper trees are
  // in the root, and the seed the vault falls back to has no 09-mcp at all
  // (docs/ecc-upgrades/DEBTS.md — the search helper could never be found).
  const assets = resolveRuntimeAssets({
    vaultRoot: "/repo/docker/public-seed",
    repositoryRoot: "/repo",
    exists: fakeExists(["/repo/search-index", "/repo/search-eval", "/repo/embeddings", "/repo/frontend-qa"])
  });
  assert.equal(assets.searchIndexDir, path.join("/repo", "search-index"));
  assert.equal(assets.searchEvalDir, path.join("/repo", "search-eval"));
  assert.equal(assets.embeddingsDir, path.join("/repo", "embeddings"));
  assert.equal(assets.frontendQaDir, path.join("/repo", "frontend-qa"));
  assert.deepEqual(Object.values(assets.sources), ["repository", "repository", "repository", "repository"]);
});

test("one tree can come from the vault and another from the checkout", () => {
  const assets = resolveRuntimeAssets({
    vaultRoot: "/vault",
    repositoryRoot: "/repo",
    exists: fakeExists(["/vault/09-mcp/search-index", "/repo/embeddings", "/repo/frontend-qa"])
  });
  assert.equal(assets.sources.searchIndex, "vault");
  assert.equal(assets.sources.embeddings, "repository");
  assert.equal(assets.sources.searchEval, "missing");
});

test("when a tree is nowhere, the answer names the layout the deployment expected", () => {
  const missing = resolveAssetTree({
    tree: RUNTIME_ASSET_TREES.searchIndex,
    vaultRoot: "/vault",
    repositoryRoot: "/repo",
    exists: fakeExists([])
  });
  assert.equal(missing.source, "missing");
  assert.equal(missing.dir, path.join("/vault", "09-mcp", "search-index"));
});

test("over a real checkout every helper tree resolves to a directory that is there", async () => {
  const repositoryRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "..");
  const assets = resolveRuntimeAssets({
    vaultRoot: path.join(repositoryRoot, "docker", "public-seed"),
    repositoryRoot
  });
  for (const [name, dir] of Object.entries({
    searchIndex: assets.searchIndexDir,
    searchEval: assets.searchEvalDir,
    embeddings: assets.embeddingsDir,
    frontendQa: assets.frontendQaDir
  })) {
    const stat = await fs.stat(dir).catch(() => null);
    assert.ok(stat?.isDirectory(), `${name} resolved to ${dir}, which is not a directory`);
  }
  // The files the runtime actually runs.
  for (const file of [
    path.join(assets.searchIndexDir, "search_cli.py"),
    path.join(assets.searchEvalDir, "search_eval_cases.json"),
    path.join(assets.embeddingsDir, "bge_m3_worker.py"),
    path.join(assets.frontendQaDir, "frontend_qa_runner.mjs")
  ]) {
    assert.ok(await fs.stat(file).then(() => true).catch(() => false), `missing: ${file}`);
  }
});

test("a directory that is neither answers as missing rather than throwing", async (t) => {
  const empty = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-assets-"));
  t.after(() => fs.rm(empty, { recursive: true, force: true }));
  const assets = resolveRuntimeAssets({ vaultRoot: empty, repositoryRoot: empty });
  assert.deepEqual(Object.values(assets.sources), ["missing", "missing", "missing", "missing"]);
  assert.equal(assets.searchIndexDir, path.join(empty, "09-mcp", "search-index"));
});

test("an expected note is read through whichever layout this install has", () => {
  const note = (relative, present) => resolveRuntimeNote({
    relative,
    vaultRoot: "/repo/docker/public-seed",
    repositoryRoot: "/repo",
    exists: fakeExists(present)
  });

  // A checkout: the server's own documents are in the repository, and the
  // Obsidian entry page has no place here at all.
  assert.deepEqual(
    note("09-mcp/ai-dev-mcp-server/docs/ARCHITECTURE.md", ["/repo/ai-dev-mcp-server/docs/ARCHITECTURE.md"]),
    { path: path.join("/repo", "ai-dev-mcp-server", "docs", "ARCHITECTURE.md"), source: "repository" }
  );
  assert.equal(note("00-start-here.md", []).source, "not-applicable");
  assert.deepEqual(VAULT_ONLY_NOTES, ["00-start-here.md"]);

  // A note the runtime generates is missing until it is generated — not excused.
  assert.equal(note("03-skills-catalog/registries/SKILL_CARDS.md", []).source, "missing");
  assert.equal(
    note("03-skills-catalog/registries/SKILL_CARDS.md", ["/repo/docker/public-seed/03-skills-catalog/registries/SKILL_CARDS.md"]).source,
    "vault"
  );
});

test("a real vault is held to the whole list, layout excuses and all", () => {
  const exists = fakeExists(["/vault/09-mcp", "/repo/ai-dev-mcp-server/README.md"]);
  assert.equal(vaultCarriesRuntime("/vault", exists), true);
  assert.equal(vaultCarriesRuntime("/repo/docker/public-seed", exists), false);
  // The repository has this file, but a vault install is not allowed to borrow it.
  const resolved = resolveRuntimeNote({
    relative: "09-mcp/ai-dev-mcp-server/README.md",
    vaultRoot: "/vault",
    repositoryRoot: "/repo",
    exists
  });
  assert.equal(resolved.source, "missing");
  assert.equal(resolved.path, path.join("/vault", "09-mcp", "ai-dev-mcp-server", "README.md"));
});
