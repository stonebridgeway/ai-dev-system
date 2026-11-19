import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createExtensionTools } from "../tool-extensions.mjs";
import { GALAXY_OUTPUT_PATH } from "../core/galaxy.mjs";
import { exportGalaxy } from "../core/galaxy-export.mjs";
import { openDatabase, sqliteSupport } from "../core/search-sqlite.mjs";
import { rebuildIndex } from "../core/search-store.mjs";
import { createGalaxyTools } from "./galaxy.mjs";

const needsSqlite = { skip: !sqliteSupport().available && sqliteSupport().reason };

/** A host whose search half is the real Node index on a throwaway vault. */
async function hostFor(root) {
  const vault = path.join(root, "My Vault");
  const index = path.join(root, "cache", "index.sqlite");
  const notes = {
    "02-knowledge/Postgres Vacuum.md": "# Postgres Vacuum\n\nAutovacuum, bloat and dead tuples in postgres tables. See [[Postgres Indexes]].\n",
    "02-knowledge/Postgres Indexes.md": "# Postgres Indexes\n\nB-tree and GIN indexes in postgres, and when the planner uses them.\n",
    "02-knowledge/Postgres Locks.md": "# Postgres Locks\n\nRow locks, deadlocks and lock queues in postgres.\n",
    "02-knowledge/React Hooks.md": "# React Hooks\n\nuseEffect, useMemo and the rules of hooks in React components.\n",
    "02-knowledge/React State.md": "# React State\n\nLifting state, reducers and context in React components.\n",
    "02-knowledge/React Suspense.md": "# React Suspense\n\nSuspense boundaries and lazy React components.\n"
  };
  for (const [relative, text] of Object.entries(notes)) {
    await fs.mkdir(path.dirname(path.join(vault, relative)), { recursive: true });
    await fs.writeFile(path.join(vault, relative), text, "utf8");
  }
  await fs.mkdir(path.join(vault, "03-skills-catalog", "registries"), { recursive: true });
  await fs.writeFile(path.join(vault, "03-skills-catalog", "registries", "skills.index.json"), "[]\n", "utf8");
  const calls = { ensureFresh: 0, exports: 0 };
  const writes = new Map();
  return {
    calls,
    writes,
    vault,
    host: {
      vaultRoot: vault,
      searchIndexPath: index,
      search: {
        ensureFresh: async () => {
          calls.ensureFresh += 1;
          await fs.mkdir(path.dirname(index), { recursive: true });
          await rebuildIndex({ vaultRoot: vault, indexPath: index });
          return { action: "rebuilt" };
        },
        exportGalaxy: async () => {
          calls.exports += 1;
          const db = openDatabase(index);
          try {
            return exportGalaxy(db);
          } finally {
            db.close();
          }
        }
      },
      safePath: (relative) => path.join(vault, relative),
      writeText: async (relative, text) => {
        writes.set(relative, text);
        await fs.mkdir(path.dirname(path.join(vault, relative)), { recursive: true });
        await fs.writeFile(path.join(vault, relative), text, "utf8");
      }
    }
  };
}

test("render_knowledge_galaxy draws the vault exported from the search index", needsSqlite, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "galaxy-tool-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { host, calls, writes, vault } = await hostFor(root);
  const tools = createExtensionTools(host, [createGalaxyTools]);
  assert.deepEqual(tools.readOnly, [], "it writes a file into the vault");

  const result = await tools.handlers.get("render_knowledge_galaxy")({ neighbors: 3 });
  assert.equal(result.status, "written");
  assert.equal(result.vault_path, GALAXY_OUTPUT_PATH);
  assert.equal(result.path, path.join(vault, GALAXY_OUTPUT_PATH));
  assert.ok(result.url.startsWith("file://"));
  assert.equal(result.index, "rebuilt");
  assert.equal(result.documents, 6);
  assert.equal(result.space, "sparse");
  assert.equal(result.link_edges, 1);
  assert.equal(result.isolated_documents, 0);
  assert.equal(calls.ensureFresh, 1);
  assert.equal(calls.exports, 1, "read once, in memory: no scratch files");

  const html = writes.get(GALAXY_OUTPUT_PATH);
  assert.equal(Buffer.byteLength(html, "utf8"), result.bytes);
  assert.match(html, /<title>Knowledge Galaxy — My Vault<\/title>/);
  assert.match(html, /export function bootGalaxy\(/);
  const model = JSON.parse(html.match(/id="galaxy-data">([\s\S]*?)<\/script>/)[1]);
  assert.equal(model.obsidian_vault, "My Vault");
  assert.deepEqual(model.nodes.title.slice().sort(), [
    "Postgres Indexes", "Postgres Locks", "Postgres Vacuum", "React Hooks", "React State", "React Suspense"
  ]);
  // Two topics, two constellations, and no note in the wrong one.
  const byTopic = new Map();
  model.nodes.title.forEach((title, index) => {
    const topic = title.split(" ")[0];
    byTopic.set(topic, new Set([...(byTopic.get(topic) ?? []), model.nodes.cluster[index]]));
  });
  assert.equal(byTopic.get("Postgres").size, 1);
  assert.equal(byTopic.get("React").size, 1);
  assert.notDeepEqual([...byTopic.get("Postgres")], [...byTopic.get("React")]);

  const again = await tools.handlers.get("render_knowledge_galaxy")({
    refresh_index: false,
    scopes: ["knowledge"],
    obsidian_vault: "Work"
  });
  assert.equal(again.index, "skipped");
  assert.equal(calls.ensureFresh, 1);
  assert.equal(JSON.parse(writes.get(GALAXY_OUTPUT_PATH).match(/id="galaxy-data">([\s\S]*?)<\/script>/)[1]).obsidian_vault, "Work");
  await assert.rejects(
    tools.handlers.get("render_knowledge_galaxy")({ refresh_index: false, scopes: ["skills"] }),
    /No documents to draw/
  );
});

test("an export of another schema is refused before anything is written", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "galaxy-tool-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const host = {
    vaultRoot: root,
    searchIndexPath: path.join(root, "index.sqlite"),
    search: {
      ensureFresh: async () => ({ action: "current" }),
      exportGalaxy: async () => ({ manifest: { schema: 99 }, semanticBytes: new Uint8Array(0), denseBytes: new Uint8Array(0) })
    },
    safePath: (relative) => path.join(root, relative),
    writeText: async () => assert.fail("nothing is written when the export is wrong")
  };
  const tools = createExtensionTools(host, [createGalaxyTools]);
  await assert.rejects(tools.handlers.get("render_knowledge_galaxy")({}), /schema 99/);
});
