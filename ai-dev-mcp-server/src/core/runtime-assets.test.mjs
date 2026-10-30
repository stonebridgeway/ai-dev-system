import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  RUNTIME_ASSET_TREES,
  VAULT_ONLY_NOTES,
  resolveAssetTree,
  resolveRuntimeAssets,
  resolveRuntimeNote,
  seededDistribution,
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
      "/vault/09-mcp/search-eval",
      "/vault/09-mcp/frontend-qa",
      // Also present in the checkout, and not used: a deployment with a vault
      // runs the vault's copies.
      "/repo/search-eval",
      "/repo/frontend-qa"
    ])
  });
  assert.equal(assets.searchEvalDir, path.resolve("/vault", "09-mcp", "search-eval"));
  assert.equal(assets.frontendQaDir, path.resolve("/vault", "09-mcp", "frontend-qa"));
  assert.deepEqual(assets.sources, {
    searchEval: "vault",
    frontendQa: "vault"
  });
});

test("a checkout with no vault answers from the repository root", () => {
  // What a clone of this repository actually looks like: the helper trees are
  // in the root, and the seed the vault falls back to has no 09-mcp at all
  // (the search helper could never be found).
  const assets = resolveRuntimeAssets({
    vaultRoot: "/repo/docker/public-seed",
    repositoryRoot: "/repo",
    exists: fakeExists(["/repo/search-eval", "/repo/frontend-qa"])
  });
  assert.equal(assets.searchEvalDir, path.resolve("/repo", "search-eval"));
  assert.equal(assets.frontendQaDir, path.resolve("/repo", "frontend-qa"));
  assert.deepEqual(Object.values(assets.sources), ["repository", "repository"]);
  assert.equal("embeddingsDir" in assets, false, "the Python embedding scripts are gone");
});

test("one tree can come from the vault and another from the checkout", () => {
  const assets = resolveRuntimeAssets({
    vaultRoot: "/vault",
    repositoryRoot: "/repo",
    exists: fakeExists(["/vault/09-mcp/search-eval", "/repo/frontend-qa"])
  });
  assert.equal(assets.sources.searchEval, "vault");
  assert.equal(assets.sources.frontendQa, "repository");
});

test("when a tree is nowhere, the answer names the layout the deployment expected", () => {
  const missing = resolveAssetTree({
    tree: RUNTIME_ASSET_TREES.searchEval,
    vaultRoot: "/vault",
    repositoryRoot: "/repo",
    exists: fakeExists([])
  });
  assert.equal(missing.source, "missing");
  assert.equal(missing.dir, path.resolve("/vault", "09-mcp", "search-eval"));
});

test("over a real checkout every helper tree resolves to a directory that is there", async () => {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const assets = resolveRuntimeAssets({
    vaultRoot: path.join(repositoryRoot, "docker", "public-seed"),
    repositoryRoot
  });
  for (const [name, dir] of Object.entries({
    searchEval: assets.searchEvalDir,
    frontendQa: assets.frontendQaDir
  })) {
    const stat = await fs.stat(dir).catch(() => null);
    assert.ok(stat?.isDirectory(), `${name} resolved to ${dir}, which is not a directory`);
  }
  // The files the runtime actually runs.
  for (const file of [
    path.join(assets.searchEvalDir, "search_eval_cases.json"),
    path.join(assets.frontendQaDir, "frontend_qa_runner.mjs")
  ]) {
    assert.ok(await fs.stat(file).then(() => true).catch(() => false), `missing: ${file}`);
  }
});

test("a directory that is neither answers as missing rather than throwing", async (t) => {
  const empty = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-assets-"));
  t.after(() => fs.rm(empty, { recursive: true, force: true }));
  const assets = resolveRuntimeAssets({ vaultRoot: empty, repositoryRoot: empty });
  assert.deepEqual(Object.values(assets.sources), ["missing", "missing"]);
  assert.equal(assets.searchEvalDir, path.resolve(empty, "09-mcp", "search-eval"));
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
    { path: path.resolve("/repo", "ai-dev-mcp-server", "docs", "ARCHITECTURE.md"), source: "repository" }
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
  assert.equal(resolved.path, path.resolve("/vault", "09-mcp", "ai-dev-mcp-server", "README.md"));
});

test("a seeded container volume is not held to a private vault's notes", () => {
  // `/data/ai-dev-system` is seeded from `docker/public-seed` and then
  // has the runtime trees symlinked into `09-mcp/`, which made it look like a
  // hand-made Obsidian vault — so it was held to the entry page no
  // distribution ships and reported it missing on every start.
  const exists = fakeExists([
    "/data/ai-dev-system/09-mcp",
    "/data/ai-dev-system/PUBLIC_SEED.md",
    "/opt/ai-dev/README.md"
  ]);
  assert.equal(seededDistribution("/data/ai-dev-system", exists), true);

  const entryPage = resolveRuntimeNote({
    relative: "00-start-here.md",
    vaultRoot: "/data/ai-dev-system",
    repositoryRoot: "/opt/ai-dev",
    exists
  });
  assert.equal(entryPage.source, "not-applicable");

  // What the distribution does ship is still read, through the layout it has.
  const mcpReadme = resolveRuntimeNote({
    relative: "09-mcp/README.md",
    vaultRoot: "/data/ai-dev-system",
    repositoryRoot: "/opt/ai-dev",
    exists
  });
  // Resolved like the neighbours: on Windows the container path lands on a drive.
  assert.deepEqual(mcpReadme, { path: path.resolve("/opt/ai-dev", "README.md"), source: "repository" });
});

test("a hand-made vault without the seed marker is still held to the whole list", () => {
  const exists = fakeExists(["/vault/09-mcp", "/repo/README.md"]);
  assert.equal(seededDistribution("/vault", exists), false);
  for (const relative of ["00-start-here.md", "09-mcp/README.md"]) {
    const resolved = resolveRuntimeNote({
      relative,
      vaultRoot: "/vault",
      repositoryRoot: "/repo",
      exists
    });
    assert.equal(resolved.source, "missing", `${relative} is genuinely missing from a real vault`);
  }
});
