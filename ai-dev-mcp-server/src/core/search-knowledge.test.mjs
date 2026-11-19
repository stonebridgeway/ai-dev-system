import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createKnowledgeCache, KNOWLEDGE_PREVIEW_LIMIT, KNOWLEDGE_TEXT_LIMIT, knowledgeSearch } from "./search-knowledge.mjs";
import { rebuildIndex } from "./search-store.mjs";
import { openDatabase, sqliteSupport } from "./search-sqlite.mjs";
import { removeAfterAll } from "../../test/fixtures/temp-folder.mjs";

const needsSqlite = { skip: !sqliteSupport().available && sqliteSupport().reason };

function write(root, rel, content) {
  const target = path.join(root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

/**
 * Notes, a project card whose repository has an AGENTS.md, a custom skill and
 * a Membrane connector — every kind of document the index holds.
 */
async function buildFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "search-knowledge-"));
  removeAfterAll(root);
  const vault = path.join(root, "vault");
  const project = path.join(root, "demo-repo");
  write(vault, "02-knowledge/code-review.md", "# Code review checklist\n\nWhat a reviewer checks:   code review\n\nis about tests.");
  write(vault, "02-knowledge/naming.md", "# Naming\n\nGood code has clear names. A review of names.");
  write(vault, "02-knowledge/far.md", `# Far\n\n${"filler ".repeat(Math.ceil(KNOWLEDGE_TEXT_LIMIT / 7))}zebra quokka`);
  write(vault, "02-knowledge/Projects/demo.md", `---\nproject_path: ${project}\n---\n# Demo project\n`);
  write(project, "AGENTS.md", "# Agents\n\nRules for code review in this repository.");
  write(vault, "03-skills-catalog/registries/skills.index.json", JSON.stringify([
    { name: "code-reviewer", source: "custom", categories: ["quality"], description: "Code review for pull requests.", use_when: "a change needs review", path: "sources/custom/code-reviewer/SKILL.md" },
    { name: "review-bot", source: "external/membrane", categories: ["integration"], description: "Code review bot connector.", use_when: "connect a review bot", path: "sources/external/membrane/skills/review-bot/SKILL.md" }
  ]));
  const indexPath = path.join(root, "index.sqlite");
  await rebuildIndex({ vaultRoot: vault, indexPath });
  const db = openDatabase(indexPath);
  t.after(() => db.close());
  return { vault, project, indexPath, db };
}

test("each word found scores 1, the whole question 3 more; best first, ties by path", needsSqlite, async (t) => {
  const { db } = await buildFixture(t);
  const results = knowledgeSearch(db, { query: "Code Review", limit: 10 });
  const scores = Object.fromEntries(results.map((item) => [item.path, item.score]));
  assert.equal(scores["02-knowledge/code-review.md"], 5, "both words and the phrase");
  assert.equal(scores["02-knowledge/naming.md"], 2, "both words, never side by side");
  assert.deepEqual(results.map((item) => item.score), [...results.map((item) => item.score)].sort((a, b) => b - a));
  for (let index = 1; index < results.length; index += 1) {
    if (results[index].score === results[index - 1].score) {
      assert.ok(results[index - 1].path.localeCompare(results[index].path) < 0, "ties by path");
    }
  }
  assert.deepEqual(Object.keys(results[0]).sort(), ["path", "preview", "score"], "the answer keeps its 2.x shape");
});

test("Membrane connectors and the files of projects outside the vault stay out", needsSqlite, async (t) => {
  const { db, project } = await buildFixture(t);
  const paths = knowledgeSearch(db, { query: "code review", limit: 50 }).map((item) => item.path);
  assert.ok(paths.length >= 3);
  assert.ok(!paths.some((item) => /membrane|review-bot/i.test(item)), paths.join(", "));
  assert.ok(!paths.some((item) => item.includes("AGENTS.md") || item.startsWith(project)), paths.join(", "));
  assert.ok(paths.some((item) => item.includes("code-reviewer")), "a custom skill is the vault's knowledge");
});

test("only the first 8,000 characters are read, the preview is one line of 240, and limit holds", needsSqlite, async (t) => {
  const { db } = await buildFixture(t);
  assert.deepEqual(knowledgeSearch(db, { query: "quokka" }), [], "past the limit");
  const [far] = knowledgeSearch(db, { query: "filler" });
  assert.equal(far.path, "02-knowledge/far.md");
  assert.ok(far.preview.length <= KNOWLEDGE_PREVIEW_LIMIT && !/\s{2}|\n/.test(far.preview));
  const [review] = knowledgeSearch(db, { query: "reviewer checks" });
  assert.match(review.preview, /^# Code review checklist What a reviewer checks: code review is about tests\.$/);
  assert.equal(knowledgeSearch(db, { query: "code review", limit: 1 }).length, 1);
  for (const empty of ["", "   ", undefined, null]) assert.deepEqual(knowledgeSearch(db, { query: empty }), []);
});

test("the cache follows the index: a changed note is read again, a deleted one forgotten", needsSqlite, async (t) => {
  const { db, vault, indexPath } = await buildFixture(t);
  const cache = createKnowledgeCache();
  const first = knowledgeSearch(db, { query: "names", cache });
  assert.deepEqual(first.map((item) => item.path), ["02-knowledge/naming.md"]);
  const cached = cache.size;
  assert.ok(cached >= 4);
  assert.deepEqual(knowledgeSearch(db, { query: "names", cache }), first, "a second call answers the same from the cache");
  assert.equal(cache.size, cached);

  write(vault, "02-knowledge/naming.md", "# Naming\n\nIdentifiers say what they hold.");
  fs.rmSync(path.join(vault, "02-knowledge", "far.md"));
  await rebuildIndex({ vaultRoot: vault, indexPath, inPlace: true });
  assert.deepEqual(knowledgeSearch(db, { query: "names", cache }), [], "the old text is not served from the cache");
  assert.deepEqual(knowledgeSearch(db, { query: "identifiers", cache }).map((item) => item.path), ["02-knowledge/naming.md"]);
  assert.equal(cache.size, cached - 1, "the deleted note left the cache");
});
