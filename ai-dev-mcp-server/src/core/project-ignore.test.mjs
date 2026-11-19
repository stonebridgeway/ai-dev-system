import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { IMPORT_GRAPH_CACHE_PATH, loadImportGraph } from "./import-graph.mjs";
import { MACHINE_FOLDERS, ignoreMachineFiles } from "./project-ignore.mjs";

async function project(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-project-ignore-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return root;
}

test("the folders one machine writes for itself are named in .ai-dev/.gitignore, once, beside what a person wrote there", async (t) => {
  const root = await project(t);
  assert.equal(await ignoreMachineFiles(root), true);
  const file = path.join(root, ".ai-dev", ".gitignore");
  assert.match(await fs.readFile(file, "utf8"), /^# Written by AI Dev: .*\ncache\/\nsecurity\/\n$/);
  assert.equal(await ignoreMachineFiles(root), false, "nothing to add the second time");
  // A file of the person's own: kept, and only what it lacks is added.
  await fs.writeFile(file, "notes.local\n/cache");
  assert.equal(await ignoreMachineFiles(root), true);
  assert.equal(await fs.readFile(file, "utf8"), "notes.local\n/cache\nsecurity/\n");
  assert.deepEqual(MACHINE_FOLDERS, ["cache/", "security/"]);
});

test("the import graph's cache, written into a repository, is one git ignores", { skip: spawnSync("git", ["--version"]).status !== 0 && "no git" }, async (t) => {
  const root = await project(t);
  await fs.writeFile(path.join(root, "index.js"), "import './lib.js';\n");
  await fs.writeFile(path.join(root, "lib.js"), "export const x = 1;\n");
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: root }).status, 0);
  await loadImportGraph(root);
  const cache = path.join(root, ...IMPORT_GRAPH_CACHE_PATH.split("/"));
  await fs.access(cache);
  const status = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: root, encoding: "utf8" }).stdout;
  assert.doesNotMatch(status, /import-graph\.json/);
  assert.match(status, /\.ai-dev\/\.gitignore/, "the ignore file itself is the project's, to commit");
});
